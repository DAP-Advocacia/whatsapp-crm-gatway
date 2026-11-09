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

// Intervalo MÍNIMO entre dois logins de qualquer worker (ver _runLoginGate). É o mesmo
// valor de sempre (5 s, protege contra ban por login em massa); não baixar.
const LOGIN_GAP_MS = Number(process.env.PAIRING_MIN_GAP_MS ?? 5000);

// Reciclagem de worker antes de estourar o heap (ver _checkRecycle). Em 48 h de produção
// cada worker bateu no limite de 7 GB a cada ~20 h (SIGABRT), derrubando 1/4 das sessões
// sem aviso. Reciclar com desligamento limpo, de madrugada, troca isso por uma queda
// curta e planejada. WORKER_RECYCLE=off desliga.
const RECYCLE_ON = process.env.WORKER_RECYCLE !== 'off';
const RECYCLE_CONFIRM_SAMPLES = Number(process.env.WORKER_RECYCLE_CONFIRM || 3); // amostras seguidas acima do limite (1 por minuto)
const RECYCLE_MIN_GAP_MS = Number(process.env.WORKER_RECYCLE_GAP_MS || 25 * 60 * 1000); // entre duas reciclagens (o religamento de um worker leva ~18 min)
const RECYCLE_WINDOW_START = Number(process.env.WORKER_RECYCLE_HOUR_START ?? 2); // horário de Brasília, [início, fim)
const RECYCLE_WINDOW_END = Number(process.env.WORKER_RECYCLE_HOUR_END ?? 5);
const RECYCLE_KILL_AFTER_MS = 20000; // se o desligamento limpo não terminar, SIGKILL

function brasiliaHour() {
  return Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false })) % 24;
}

class RemoteGateway extends EventEmitter {
  constructor(manager, sessionId) {
    super();
    this.manager = manager;
    this.sessionId = sessionId;
    // Espelho do estado do gateway real (atualizado por applyState).
    this.status = 'queued';
    this.loggedOut = false;
    this.needsAttention = false;
    this.consecutiveFailures = 0;
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
    this.consecutiveFailures = s.consecutiveFailures || 0;
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
  editMessage(...a) { return this._call('editMessage', ...a); }
  deleteMessage(...a) { return this._call('deleteMessage', ...a); }
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
  forceFreshQr() { return this._call('forceFreshQr'); }

  // Usado só por SessionManager.remove (caminho local); aqui vira 'remove' no worker.
  disconnect() { return this._call('remove'); }
}

class RemoteSessionManager {
  constructor({ baseFolder, workers, onStatus, onMessage, onReaction, onMessageChange, onMessageStatus, onPresence, onContact, onCall }) {
    this.baseFolder = baseFolder;
    this.count = Math.max(1, Number(workers) || 1);
    this.cb = { onStatus, onMessage, onReaction, onMessageChange, onMessageStatus, onPresence, onContact, onCall };
    this.sessions = new Map(); // sessionId -> RemoteGateway
    this.nextRid = 1;
    this.heapMb = Number(process.env.WORKER_HEAP_MB || 2048);
    this.bootAll = false;
    this.stopping = false; // true depois de shutdown(): workers que saem não são recriados
    this.workers = [];
    for (let i = 0; i < this.count; i++) this.workers.push({ index: i, child: null, ready: false, pending: new Map(), restarts: 0, queue: [], mem: null, overCount: 0, recycling: false, recycleKill: null });
    // Trava global de logins: um pedido por vez, na ordem de chegada, no mínimo LOGIN_GAP_MS
    // entre dois logins de qualquer worker.
    this.loginWaiters = [];
    this.lastLoginGrantAt = 0;
    this.loginGateTimer = null;
    this.lastRecycleAt = 0;
    this.recycleSoftMb = Number(process.env.WORKER_RECYCLE_SOFT_MB || Math.round(this.heapMb * 0.70));
    this.recycleHardMb = Number(process.env.WORKER_RECYCLE_HARD_MB || Math.round(this.heapMb * 0.88));
    for (const w of this.workers) this._spawn(w);
    console.log(`[sessions] modo com ${this.count} worker(s) de sessão (heap ${this.heapMb} MB cada)`);
    if (RECYCLE_ON) console.log(`[sessions] reciclagem de worker ligada: acima de ${this.recycleSoftMb} MB entre ${RECYCLE_WINDOW_START}h e ${RECYCLE_WINDOW_END}h (Brasília), ou acima de ${this.recycleHardMb} MB a qualquer hora`);
  }

  // Estado de memória de cada worker (última amostra), pra diagnóstico.
  getWorkerStats() {
    return this.workers.map((w) => ({ index: w.index, ready: w.ready, recycling: w.recycling, restarts: w.restarts, mem: w.mem }));
  }

  _runLoginGate() {
    if (this.loginGateTimer || !this.loginWaiters.length) return;
    const wait = Math.max(0, this.lastLoginGrantAt + LOGIN_GAP_MS - Date.now());
    this.loginGateTimer = setTimeout(() => {
      this.loginGateTimer = null;
      // Pedido de worker que caiu nesse meio tempo não gasta a vaga.
      let waiter = this.loginWaiters.shift();
      while (waiter && !(waiter.w.child === waiter.child && waiter.w.ready)) waiter = this.loginWaiters.shift();
      if (waiter) {
        this.lastLoginGrantAt = Date.now();
        waiter.child.send({ t: 'loginGrant', rid: waiter.rid });
      }
      this._runLoginGate();
    }, wait);
  }

  // Chamado a cada amostra de memória (1/min) de um worker.
  _checkRecycle(w) {
    if (!RECYCLE_ON || this.stopping || w.recycling || !w.ready || !w.child || !w.mem) return;
    const used = w.mem.heapUsedMb;
    if (used < this.recycleSoftMb) {
      w.overCount = 0;
      return;
    }
    w.overCount++;
    if (w.overCount < RECYCLE_CONFIRM_SAMPLES) return; // uma amostra alta sozinha pode ser lixo ainda não coletado
    const hard = used >= this.recycleHardMb;
    if (!hard) {
      const hour = brasiliaHour();
      if (hour < RECYCLE_WINDOW_START || hour >= RECYCLE_WINDOW_END) return; // espera a madrugada
      if (this.workers.some((o) => o !== w && (o.recycling || !o.ready))) return; // um worker de cada vez
      if (Date.now() - this.lastRecycleAt < RECYCLE_MIN_GAP_MS) return;
    }
    this._recycle(w, `heap ${used} MB${hard ? ' acima do limite duro' : ''}`);
  }

  // Desligamento limpo (fecha os sockets sem deslogar e grava as credenciais, o mesmo de um
  // deploy) e o _onExit recria o worker; as sessões dele voltam pela trava de logins.
  _recycle(w, why) {
    const child = w.child;
    w.recycling = true;
    w.ready = false;
    this.lastRecycleAt = Date.now();
    console.log(`[sessions] reciclando worker ${w.index} (${why}) — desligamento limpo; as sessões dele voltam pela fila de logins`);
    w.recycleKill = setTimeout(() => {
      if (w.child === child) {
        console.error(`[sessions] worker ${w.index} não saiu em ${RECYCLE_KILL_AFTER_MS} ms — SIGKILL`);
        child.kill('SIGKILL');
      }
    }, RECYCLE_KILL_AFTER_MS);
    try {
      child.send({ t: 'shutdown' });
    } catch {
      child.kill('SIGTERM');
    }
  }

  _spawn(w) {
    if (this.stopping) return;
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
    if (this.stopping) return; // desligamento pedido: sem recriar nem marcar as sessões como caídas
    this.lastWorkerRestartAt = Date.now(); // o monitor de desconexões fica quieto um tempo depois disto (todas as sessões do worker caem juntas)
    const planned = w.recycling;
    clearTimeout(w.recycleKill);
    w.recycling = false;
    w.overCount = 0;
    w.mem = null;
    this.loginWaiters = this.loginWaiters.filter((x) => x.w !== w);
    if (planned) {
      console.log(`[sessions] worker ${w.index} reciclado (code=${code} signal=${signal}) — recriando; só as sessões dele ficam offline`);
      w.restarts = 0; // saída planejada não conta pro backoff de quedas
    } else {
      console.error(`[sessions] worker ${w.index} encerrou (code=${code} signal=${signal}) — recriando; só as sessões dele ficam offline`);
    }
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
      case 'loginReq': {
        this.loginWaiters.push({ w, child: w.child, rid: msg.rid });
        this._runLoginGate();
        break;
      }
      case 'mem': {
        w.mem = { ...msg.m, at: Date.now() };
        this._checkRecycle(w);
        break;
      }
      case 'message': this.cb.onMessage?.(msg.id, ...msg.args); break;
      case 'reaction': this.cb.onReaction?.(msg.id, ...msg.args); break;
      case 'messageChange': this.cb.onMessageChange?.(msg.id, ...msg.args); break;
      case 'messageStatus': this.cb.onMessageStatus?.(msg.id, ...msg.args); break;
      case 'presence': this.cb.onPresence?.(msg.id, ...msg.args); break;
      case 'contact': this.cb.onContact?.(msg.id, ...msg.args); break;
      case 'callEvent': this.cb.onCall?.(msg.id, ...msg.args); break;
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
  get(sessionId, { wantQr = false } = {}) {
    const id = sanitize(sessionId);
    if (!id) throw new Error('sessão inválida');
    let gw = this.sessions.get(id);
    const isNew = !gw;
    if (!gw) gw = this._mirror(id);
    // Sessão nova, deslogada (precisa de QR novo) ou parada esperando alguém pedir o QR:
    // avisa o worker (com limite de frequência — get() é chamado a cada requisição da API).
    // status 'queued': a sessão espera na fila do worker; avisa que um usuário pediu pra
    // ela passar à frente das sessões do boot automático.
    // Deslogada/nunca pareada só volta a gerar QR quando alguém pede o QR (ver sessions.js).
    const needsEnsure = isNew || gw.status === 'queued' || (wantQr && (gw.loggedOut || gw.idleUnpaired));
    const now = Date.now();
    if (needsEnsure && now - gw.lastEnsureAt >= ENSURE_THROTTLE_MS) {
      gw.lastEnsureAt = now;
      this._post(this.workers[shardOf(id, this.count)], { t: 'ensure', id, wantQr: !!wantQr });
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

  /**
   * Desligamento limpo (SIGTERM): pede a cada worker que feche as sessões sem deslogar e
   * termine as gravações de credenciais, e espera eles saírem (até waitMs).
   */
  async shutdown(waitMs = 6500) {
    this.stopping = true;
    const exits = this.workers
      .filter((w) => w.child)
      .map((w) => new Promise((resolve) => {
        w.child.once('exit', resolve);
        try { w.child.send({ t: 'shutdown' }); } catch { resolve(); }
      }));
    await Promise.race([Promise.all(exits), new Promise((resolve) => setTimeout(resolve, waitMs))]);
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
