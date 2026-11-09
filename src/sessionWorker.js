/*
 * Worker de sessões do WhatsApp (modo SESSION_WORKERS=N, ver
 * src/remoteSessions.js e docs/ARQUITETURA_WORKERS.md).
 *
 * Processo filho do servidor principal. Hospeda um PEDAÇO das sessões (as que
 * `shardOf(sessionId, N) === SESSION_WORKER_INDEX`) usando o mesmo
 * SessionManager/WhatsAppGateway de sempre — a diferença é só que os eventos
 * (status, mensagem, reação...) vão pro processo principal por IPC em vez de
 * chamarem as funções do server.js direto, e que as chamadas de envio chegam
 * por IPC também. Toda a parte pesada do Baileys (criptografia Signal,
 * decodificação de histórico, reconexão) roda AQUI, num núcleo e num heap
 * próprios: um worker travado ou sem memória derruba só o seu pedaço.
 */
require('dotenv').config();
// Pool de banco pequeno: cada worker abre o seu (isCardGroup consulta o banco).
process.env.DB_POOL_MAX = process.env.WORKER_DB_POOL_MAX || '4';

const { SessionManager, sanitize } = require('./sessions');
const store = require('./store');
const { shardOf } = require('./shard');

const INDEX = Number(process.env.SESSION_WORKER_INDEX);
const COUNT = Number(process.env.SESSION_WORKER_COUNT);
if (!process.send || !Number.isInteger(INDEX) || !Number.isInteger(COUNT) || COUNT < 1) {
  console.error('[worker] precisa ser iniciado pelo servidor principal (SESSION_WORKER_INDEX/COUNT)');
  process.exit(1);
}

process.on('uncaughtException', (err) => console.error(`[worker ${INDEX}] uncaughtException (mantido no ar):`, err));
process.on('unhandledRejection', (err) => console.error(`[worker ${INDEX}] unhandledRejection:`, err));
// Se o processo principal morrer, não fica órfão segurando as sessões.
process.on('disconnect', () => process.exit(0));

// Desligamento limpo (deploy): o processo principal manda 'shutdown' (ou o worker recebe
// SIGTERM direto). Fecha os sockets sem deslogar e espera as gravações de credenciais
// terminarem antes de sair — sem isso o Swarm mata o processo no meio de um writeFile.
let shuttingDown = false;
async function gracefulExit(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker ${INDEX}] desligando (${why})`);
  // Trava de segurança: se algo pendurar, sai mesmo assim antes do Swarm dar SIGKILL.
  setTimeout(() => process.exit(0), Number(process.env.WORKER_SHUTDOWN_MS || 6000)).unref();
  try {
    await manager.shutdown(Number(process.env.WORKER_FLUSH_MS || 4000));
  } catch (err) {
    console.error(`[worker ${INDEX}] erro ao desligar:`, err.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulExit('SIGTERM'));
process.on('SIGINT', () => gracefulExit('SIGINT'));

const send = (msg) => {
  if (process.connected) process.send(msg);
};

// Foto do estado de uma sessão, o que o processo principal precisa ler de forma
// síncrona (status, QR, flags). Enviada a cada mudança e a cada 15s.
function snapshot(id, gw) {
  return {
    status: gw.getStatus(),
    loggedOut: !!gw.loggedOut,
    needsAttention: !!gw.needsAttention,
    consecutiveFailures: gw.consecutiveFailures || 0,
    lastDisconnectReason: gw.lastDisconnectReason || null,
    qr: gw.getLastQr() || null,
    contactCount: gw.getContactCount(),
    hasSock: !!gw.sock,
    idleUnpaired: !!gw.idleUnpaired,
  };
}

const pending = new Set(); // ids com envio de estado agendado (junta rajadas)
function pushState(id) {
  if (pending.has(id)) return;
  pending.add(id);
  // setImmediate: o handler de 'close' emite 'status' ANTES de ajustar
  // loggedOut/needsAttention na mesma execução — aqui já estão certos.
  setImmediate(() => {
    pending.delete(id);
    const gw = manager.getActiveGateway(id);
    if (gw) send({ t: 'state', id, s: snapshot(id, gw) });
  });
}

// Todos os workers dividem o mesmo IP. Com a trava global (padrão), cada login pede
// vaga ao processo principal, que libera um por vez com no mínimo PAIRING_MIN_GAP_MS
// entre dois logins de QUALQUER worker: o ritmo total é o de sempre, mas um worker
// religando sozinho (queda ou reciclagem) usa o ritmo inteiro em vez de 1/N dele.
// LOGIN_GATE=off volta ao jeito antigo: intervalo N vezes maior em cada worker.
const LOGIN_GATE = process.env.LOGIN_GATE !== 'off';
const GATE_TIMEOUT_MS = Number(process.env.LOGIN_GATE_TIMEOUT_MS || 180000);
let nextGateRid = 1;
const gateWaiting = new Map(); // rid -> { resolve, timer }

function requestLoginSlot() {
  return new Promise((resolve) => {
    const rid = nextGateRid++;
    // Sem resposta do principal (não deveria acontecer): depois de GATE_TIMEOUT_MS de
    // espera segue sozinho, o que nunca é mais rápido que o ritmo normal.
    const timer = setTimeout(() => {
      gateWaiting.delete(rid);
      console.warn(`[worker ${INDEX}] trava de logins sem resposta em ${GATE_TIMEOUT_MS} ms — seguindo`);
      resolve();
    }, GATE_TIMEOUT_MS);
    gateWaiting.set(rid, { resolve, timer });
    send({ t: 'loginReq', rid });
  });
}

const manager = new SessionManager({
  baseFolder: process.env.AUTH_FOLDER || './auth_session',
  isCardGroup: store.isCardGroupId,
  loginGate: LOGIN_GATE ? requestLoginSlot : null,
  // Com a trava o espaçamento já vem do principal; o boot só precisa enfileirar.
  staggerMs: LOGIN_GATE ? Number(process.env.SESSION_STAGGER_GATED_MS || 500) : Number(process.env.SESSION_STAGGER_MS || 15000) * COUNT,
  pairingGapMs: LOGIN_GATE ? 0 : Number(process.env.PAIRING_MIN_GAP_MS ?? 5000) * COUNT,
  shardFilter: (id) => shardOf(id, COUNT) === INDEX,
  onStatus: (id, status) => {
    send({ t: 'status', id, status });
    pushState(id);
  },
  onQr: (id) => pushState(id),
  onMessage: (id, phone, message, pushName, isHistory, senderPhone, senderName) =>
    send({ t: 'message', id, args: [phone, message, pushName, isHistory, senderPhone, senderName] }),
  onReaction: (id, phone, targetId, emoji, direction) => send({ t: 'reaction', id, args: [phone, targetId, emoji, direction] }),
  onMessageChange: (id, change) => send({ t: 'messageChange', id, args: [change] }),
  onMessageStatus: (id, phone, messageId, status) => send({ t: 'messageStatus', id, args: [phone, messageId, status] }),
  onPresence: (id, phone, state) => send({ t: 'presence', id, args: [phone, state] }),
  onContact: (id, phone, name) => send({ t: 'contact', id, args: [phone, name] }),
  onCall: (id, info) => send({ t: 'callEvent', id, args: [info] }),
});

setInterval(() => {
  const states = [];
  for (const { sessionId } of manager.listActive()) {
    const gw = manager.getActiveGateway(sessionId);
    if (gw) states.push({ id: sessionId, s: snapshot(sessionId, gw) });
  }
  if (states.length) send({ t: 'states', list: states });
}, 15000).unref();

// Telemetria de memória (2026-11-09). Em 48 h de produção os 4 workers estouraram o
// heap de 7 GB 11 vezes (SIGABRT, ~20 h de uso cada), derrubando 1/4 das sessões por
// vez. Esta amostra serve a duas coisas: o processo principal recicla o worker ANTES
// do limite (ver _checkRecycle em remoteSessions.js) e o log mostra o que cresce, já
// que não dá pra tirar heap snapshot de 7 GB em produção.
const v8 = require('v8');
const MEM_SAMPLE_MS = Number(process.env.WORKER_MEM_SAMPLE_MS || 60000);
const MEM_LOG_EVERY = Number(process.env.WORKER_MEM_LOG_EVERY || 5); // 1 linha de log a cada N amostras
const mb = (n) => Math.round(n / 1048576);
let memSamples = 0;

function sizeOf(x) {
  return x && typeof x.size === 'number' ? x.size : 0;
}

function memSample() {
  const hs = v8.getHeapStatistics();
  const mu = process.memoryUsage();
  let sessions = 0;
  let online = 0;
  let contacts = 0;
  let groupMeta = 0;
  let groupHistory = 0;
  let groupsCached = 0;
  let sentCache = 0;
  for (const { sessionId } of manager.listActive()) {
    const gw = manager.getActiveGateway(sessionId);
    if (!gw) continue;
    sessions++;
    if (gw.getStatus() === 'online') online++;
    contacts += sizeOf(gw.contactIds);
    groupMeta += sizeOf(gw.groupMetaTried);
    groupHistory += sizeOf(gw.groupHistoryCount);
    groupsCached += sizeOf(gw.groupsCache?.map);
    sentCache += sizeOf(gw.sentCache);
  }
  const m = {
    heapUsedMb: mb(hs.used_heap_size),
    heapLimitMb: mb(hs.heap_size_limit),
    rssMb: mb(mu.rss),
    externalMb: mb(mu.external),
    arrayBuffersMb: mb(mu.arrayBuffers),
    sessions,
    online,
  };
  send({ t: 'mem', m });
  memSamples++;
  if (memSamples === 1 || memSamples % MEM_LOG_EVERY === 0) {
    const spaces = v8.getHeapSpaceStatistics()
      .filter((s) => ['old_space', 'large_object_space', 'new_space', 'code_space'].includes(s.space_name))
      .map((s) => `${s.space_name}=${mb(s.space_used_size)}`)
      .join(' ');
    console.log(`[worker ${INDEX}] memória: heap ${m.heapUsedMb}/${m.heapLimitMb} MB, rss ${m.rssMb}, external ${m.externalMb}, arrayBuffers ${m.arrayBuffersMb} (${spaces}) | sessões ${sessions} (${online} online), contatos ${contacts}, grupos em cache ${groupsCached}, groupMeta ${groupMeta}, histórico de grupo ${groupHistory}, enviadas em cache ${sentCache}`);
  }
}
setInterval(memSample, MEM_SAMPLE_MS).unref();
setTimeout(memSample, 5000).unref();

// Métodos do WhatsAppGateway que o processo principal pode chamar.
const METHODS = new Set([
  'sendMessage', 'sendReaction', 'editMessage', 'deleteMessage', 'sendPresence', 'subscribePresence', 'sendMedia',
  'createGroup', 'promoteParticipant', 'getGroupParticipantPhones', 'getProfilePicture',
  'resolveLidToPhone', 'getGroupCount', 'retryManually', 'requestFreshQr', 'forceFreshQr', 'syncConversation',
]);

async function handleCall({ rid, id, method, args }) {
  try {
    let value;
    if (method === 'remove') {
      await manager.remove(id);
    } else if (METHODS.has(method)) {
      // get() cria a sessão se ainda não existir (igual ao processo único).
      const gw = manager.getActiveGateway(id) || manager.get(id);
      value = await gw[method](...(args || []));
      pushState(id);
    } else {
      throw new Error(`método não permitido: ${method}`);
    }
    send({ t: 'res', rid, ok: true, value });
  } catch (err) {
    send({ t: 'res', rid, ok: false, error: err?.message || String(err) });
  }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (shuttingDown) return;
  if (msg.t === 'shutdown') {
    gracefulExit('pedido do processo principal');
  } else if (msg.t === 'call') {
    handleCall(msg);
  } else if (msg.t === 'loginGrant') {
    const g = gateWaiting.get(msg.rid);
    if (g) {
      gateWaiting.delete(msg.rid);
      clearTimeout(g.timer);
      g.resolve();
    }
  } else if (msg.t === 'ensure') {
    const id = sanitize(msg.id);
    if (!id) return;
    manager.get(id, { wantQr: !!msg.wantQr }); // cria/inicia (fila de pareamento); QR novo só se pedido
    pushState(id);
  } else if (msg.t === 'bootAll') {
    manager.startAllExisting().catch((err) => console.error(`[worker ${INDEX}] falha no boot das sessões:`, err.message));
  }
});

console.log(`[worker ${INDEX}/${COUNT}] pronto (pid ${process.pid})`);
send({ t: 'ready' });
