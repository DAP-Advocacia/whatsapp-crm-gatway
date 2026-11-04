/*
 * Gerenciador de sessões com WORKERS (SESSION_WORKERS=N, N >= 1).
 *
 * Mesma interface pública do SessionManager (src/sessions.js) — get,
 * getActiveGateway, listActive, startAllExisting, remove — então o resto do
 * app (rotas, server.js) não muda. Só que, em vez de abrir os sockets do
 * Baileys neste processo, ele reparte as sessões entre N processos filhos
 * (src/sessionWorker.js) e conversa com eles por IPC:
 *
 *   - chamadas (sendMessage, sendMedia, createGroup...) viram RPC com resposta;
 *   - eventos (mensagem, status, reação...) chegam e disparam os MESMOS callbacks
 *     que o SessionManager chamaria (onMessage, onStatus...);
 *   - o estado que as rotas leem de forma síncrona (status, QR, flags) fica
 *     espelhado em cada RemoteGateway, atualizado por "fotos" que o worker envia.
 *
 * Se um worker cai, só as sessões do pedaço dele ficam offline; ele é recriado
 * sozinho e as sessões voltam pela fila de pareamento do próprio worker.
 */
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { EventEmitter } = require('events');
const { sanitize } = require('./sessions');
const { shardOf } = require('./shard');
const { refreshOwnNumber } = require('./ownNumbers');

const CALL_TIMEOUT_MS = Number(process.env.WORKER_CALL_TIMEOUT_MS || 120000);
const ENSURE_THROTTLE_MS = 3000;

class RemoteGateway extends EventEmitter {
  constructor(manager, sessionId) {
    super();
    this.manager = manager;
    this.sessionId = sessionId;
    // Espelho do estado do gateway real (atualizado por applyState).
    this.status = 'queued';
    this.loggedOut = false;
    this.needsAttention = false;
    this.lastDisconnectReason = null;
    this.sock = null; // só "tem ou não tem" interessa (ver listActive)
    this.idleUnpaired = false;
    this._qr = null;
    this._contactCount = 0;
    this.lastEnsureAt = 0;
  }

  applyState(s) {
    this.status = s.status;
    this.loggedOut = s.loggedOut;
    this.needsAttention = s.needsAttention;
    this.lastDisconnectReason = s.lastDisconnectReason;
    this.idleUnpaired = s.idleUnpaired;
    this._qr = s.qr;
    this._contactCount = s.contactCount;
    this.sock = s.hasSock ? {} : null;
  }

  getStatus() { return this.status; }
  getLastQr() { return this._qr; }
  getContactCount() { return this._contactCount; }

  _call(method, ...args) {
    return this.manager._call(this.sessionId, method, args);
  }

  sendMessage(...a) { return this._call('sendMessage', ...a); }
  sendReaction(...a) { return this._call('sendReaction', ...a); }
  sendPresence(...a) { return this._call('sendPresence', ...a); }
  subscribePresence(...a) { return this._call('subscribePresence', ...a); }
  sendMedia(...a) { return this._call('sendMedia', ...a); }
  createGroup(...a) { return this._call('createGroup', ...a); }
  promoteParticipant(...a) { return this._call('promoteParticipant', ...a); }
  getGroupParticipantPhones(...a) { return this._call('getGroupParticipantPhones', ...a); }
  getProfilePicture(...a) { return this._call('getProfilePicture', ...a); }
  resolveLidToPhone(...a) { return this._call('resolveLidToPhone', ...a); }
  syncConversation(...a) { return this._call('syncConversation', ...a); }
  getGroupCount() { return this._call('getGroupCount'); }
  retryManually() { return this._call('retryManually'); }
  requestFreshQr() { return this._call('requestFreshQr'); }

  // Usado só por SessionManager.remove (caminho local); aqui vira 'remove' no worker.
  disconnect() { return this._call('remove'); }
}

class RemoteSessionManager {
  constructor({ baseFolder, workers, onStatus, onMessage, onReaction, onMessageStatus, onPresence, onContact }) {
    this.baseFolder = baseFolder;
    this.count = Math.max(1, Number(workers) || 1);
    this.cb = { onStatus, onMessage, onReaction, onMessageStatus, onPresence, onContact };
    this.sessions = new Map(); // sessionId -> RemoteGateway
    this.nextRid = 1;
    this.heapMb = Number(process.env.WORKER_HEAP_MB || 2048);
    this.bootAll = false;
    this.workers = [];
    for (let i = 0; i < this.count; i++) this.workers.push({ index: i, child: null, ready: false, pending: new Map(), restarts: 0, queue: [] });
    for (const w of this.workers) this._spawn(w);
    console.log(`[sessions] modo com ${this.count} worker(s) de sessão (heap ${this.heapMb} MB cada)`);
  }

  _spawn(w) {
    const child = fork(path.join(__dirname, 'sessionWorker.js'), [], {
      env: {
        ...process.env,
        SESSION_WORKER_INDEX: String(w.index),
        SESSION_WORKER_COUNT: String(this.count),
        AUTH_FOLDER: this.baseFolder,
      },
      execArgv: [`--max-old-space-size=${this.heapMb}`],
      serialization: 'advanced', // Buffers (mídia) e Maps passam direto
      stdio: 'inherit',
    });
    w.child = child;
    w.ready = false;
    child.on('message', (msg) => this._onMessage(w, msg));
    child.on('error', (err) => console.error(`[sessions] erro no worker ${w.index}:`, err.message));
    child.on('exit', (code, signal) => this._onExit(w, child, code, signal));
  }

  _onExit(w, child, code, signal) {
    if (w.child !== child) return;
    w.child = null;
    w.ready = false;
    console.error(`[sessions] worker ${w.index} encerrou (code=${code} signal=${signal}) — recriando; só as sessões dele ficam offline`);
    for (const { reject, timer } of w.pending.values()) {
      clearTimeout(timer);
      reject(new Error('worker de sessões reiniciando, tente de novo em instantes'));
    }
    w.pending.clear();
    // As sessões deste worker ficam offline até ele voltar.
    for (const gw of this.sessions.values()) {
      if (shardOf(gw.sessionId, this.count) !== w.index) continue;
      gw.sock = null;
      if (gw.status !== 'offline') {
        gw.status = 'offline';
        this.cb.onStatus?.(gw.sessionId, 'offline');
      }
    }
    w.restarts++;
    const delay = Math.min(2000 * 2 ** Math.min(w.restarts - 1, 5), 60000);
    setTimeout(() => this._spawn(w), delay);
  }

  _onMessage(w, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'ready': {
        w.ready = true;
        w.restarts = 0;
        // Retoma o que já era conhecido neste pedaço (restart do worker): o
        // worker enfileira e espaça os logins sozinho.
        if (this.bootAll && !w.queue.some((m) => m.t === 'bootAll')) w.child.send({ t: 'bootAll' });
        for (const gw of this.sessions.values()) {
          if (shardOf(gw.sessionId, this.count) === w.index) w.child.send({ t: 'ensure', id: gw.sessionId });
        }
        for (const m of w.queue.splice(0)) w.child.send(m);
        break;
      }
      case 'state': {
        const gw = this.sessions.get(msg.id) || this._mirror(msg.id);
        gw.applyState(msg.s);
        break;
      }
      case 'states': {
        for (const { id, s } of msg.list) (this.sessions.get(id) || this._mirror(id)).applyState(s);
        break;
      }
      case 'status': {
        const gw = this.sessions.get(msg.id) || this._mirror(msg.id);
        gw.status = msg.status;
        this.cb.onStatus?.(msg.id, msg.status);
        break;
      }
      case 'message': this.cb.onMessage?.(msg.id, ...msg.args); break;
      case 'reaction': this.cb.onReaction?.(msg.id, ...msg.args); break;
      case 'messageStatus': this.cb.onMessageStatus?.(msg.id, ...msg.args); break;
      case 'presence': this.cb.onPresence?.(msg.id, ...msg.args); break;
      case 'contact': this.cb.onContact?.(msg.id, ...msg.args); break;
      case 'res': {
        const p = w.pending.get(msg.rid);
        if (!p) break;
        w.pending.delete(msg.rid);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error));
        break;
      }
      default: break;
    }
  }

  // Cria o espelho de uma sessão que o worker conhece mas o processo principal
  // ainda não (ex: sessão subida pelo boot completo).
  _mirror(id) {
    const gw = new RemoteGateway(this, id);
    this.sessions.set(id, gw);
    return gw;
  }

  _post(w, msg) {
    if (w.ready && w.child) w.child.send(msg);
    else w.queue.push(msg); // worker ainda subindo: entrega quando ficar pronto
  }

  _call(sessionId, method, args) {
    const w = this.workers[shardOf(sessionId, this.count)];
    if (!w.ready || !w.child) return Promise.reject(new Error('serviço de sessões reiniciando, tente de novo em instantes'));
    const rid = this.nextRid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        w.pending.delete(rid);
        reject(new Error(`tempo esgotado em ${method}`));
      }, CALL_TIMEOUT_MS);
      w.pending.set(rid, { resolve, reject, timer });
      w.child.send({ t: 'call', rid, id: sessionId, method, args });
    });
  }

  /** Igual ao SessionManager.get: devolve na hora (síncrono) e garante que a sessão existe no worker. */
  get(sessionId) {
    const id = sanitize(sessionId);
    if (!id) throw new Error('sessão inválida');
    let gw = this.sessions.get(id);
    const isNew = !gw;
    if (!gw) gw = this._mirror(id);
    // Sessão nova, deslogada (precisa de QR novo) ou parada esperando alguém pedir o QR:
    // avisa o worker (com limite de frequência — get() é chamado a cada requisição da API).
    // status 'queued': a sessão espera na fila do worker; avisa que um usuário pediu pra
    // ela passar à frente das sessões do boot automático.
    const needsEnsure = isNew || gw.loggedOut || gw.idleUnpaired || gw.status === 'queued';
    const now = Date.now();
    if (needsEnsure && now - gw.lastEnsureAt >= ENSURE_THROTTLE_MS) {
      gw.lastEnsureAt = now;
      this._post(this.workers[shardOf(id, this.count)], { t: 'ensure', id });
    }
    return gw;
  }

  async remove(sessionId) {
    const id = sanitize(sessionId);
    const gw = this.sessions.get(id);
    try {
      await this._call(id, 'remove', []);
    } catch (err) {
      // Worker fora do ar: remove do disco aqui mesmo, o resultado final é o mesmo.
      console.error(`[sessions] remove(${id}) via worker falhou (${err.message}) — limpando a pasta direto`);
      const folder = path.join(this.baseFolder, id);
      if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
    }
    if (gw) this.sessions.delete(id);
    refreshOwnNumber(id);
  }

  async startAllExisting() {
    this.bootAll = true;
    for (const w of this.workers) this._post(w, { t: 'bootAll' });
  }

  listActive() {
    return Array.from(this.sessions.entries()).map(([id, gw]) => ({ sessionId: id, status: gw.getStatus(), hasSock: !!gw.sock }));
  }

  getActiveGateway(sessionId) {
    return this.sessions.get(sanitize(sessionId));
  }
}

module.exports = { RemoteSessionManager, RemoteGateway };
