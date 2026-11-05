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

// Todos os workers dividem o mesmo IP: o ritmo de logins por worker é N vezes
// mais lento, pra o ritmo TOTAL ficar igual ao de um processo só.
const manager = new SessionManager({
  baseFolder: process.env.AUTH_FOLDER || './auth_session',
  isCardGroup: store.isCardGroupId,
  staggerMs: Number(process.env.SESSION_STAGGER_MS || 15000) * COUNT,
  pairingGapMs: Number(process.env.PAIRING_MIN_GAP_MS ?? 5000) * COUNT,
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
