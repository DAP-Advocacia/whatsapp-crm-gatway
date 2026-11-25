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
const { monitorEventLoopDelay } = require('perf_hooks');

// Atraso do event loop (2026-11-10): o que derruba as sessões de um worker é uma travada de
// 35 s ou mais (keep-alive do Baileys), e até hoje não havia como saber o que a causou. Aqui:
// p99/máximo de cada janela na linha de memória e uma linha avisando de cada travada > 3 s.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let lastLoopTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - lastLoopTick - 1000;
  lastLoopTick = now;
  if (lag > 3000) {
    const line = `[worker ${process.env.SESSION_WORKER_INDEX}] event loop travou ${lag} ms`;
    console.warn(line);
    diagAppend(line);
  }
}, 1000).unref();

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
    const loopP99 = Math.round(loopDelay.percentile(99) / 1e6);
    const loopMax = Math.round(loopDelay.max / 1e6);
    loopDelay.reset();
    const line = `[worker ${INDEX}] memória: heap ${m.heapUsedMb}/${m.heapLimitMb} MB, loop p99 ${loopP99} ms max ${loopMax} ms, rss ${m.rssMb}, external ${m.externalMb}, arrayBuffers ${m.arrayBuffersMb} (${spaces}) | sessões ${sessions} (${online} online), contatos ${contacts}, grupos em cache ${groupsCached}, groupMeta ${groupMeta}, histórico de grupo ${groupHistory}, enviadas em cache ${sentCache}`;
    console.log(line);
    diagAppend(line);
  }
  checkHeapProfile(m.heapUsedMb);
}

// Diagnóstico do estouro de heap (2026-11-25). Os relatórios de --report-on-fatalerror saem
// sem pilha e o docker logs gira em ~2 dias, então: (1) a linha de memória (e as travadas do
// loop) vão também para um arquivo por worker em WORKER_DIAG_DIR; (2) o perfil de alocação por
// amostragem do V8 roda o tempo todo (1 amostra a cada ~128 KB alocados, custo baixo) e, quando
// o heap passa de WORKER_DIAG_HEAP_MB e depois a cada +WORKER_DIAG_STEP_MB, grava as funções
// que seguram mais memória VIVA no heap. É isso que diz o que enche o old_space.
const fs = require('fs');
const path = require('path');
const DIAG_DIR = process.env.WORKER_DIAG_DIR || process.env.WORKER_REPORT_DIR || '/tmp/node-reports';
const DIAG_HEAP_MB = Number(process.env.WORKER_DIAG_HEAP_MB || 1500); // 0 desliga o perfil
const DIAG_STEP_MB = Number(process.env.WORKER_DIAG_STEP_MB || 700);
const DIAG_MIN_GAP_MS = 10 * 60 * 1000;
try { fs.mkdirSync(DIAG_DIR, { recursive: true }); } catch { /* sem pasta, só não grava */ }

function diagAppend(line) {
  fs.appendFile(path.join(DIAG_DIR, `mem-w${INDEX}.log`), `${new Date().toISOString()} ${line}\n`, () => {});
}

let profiler = null;
if (DIAG_HEAP_MB > 0) {
  try {
    const inspector = require('inspector');
    profiler = new inspector.Session();
    profiler.connect();
    profiler.post('HeapProfiler.startSampling', { samplingInterval: 131072 }, (err) => {
      if (err) {
        console.warn(`[worker ${INDEX}] perfil de heap indisponível: ${err.message}`);
        profiler = null;
      }
    });
  } catch (err) {
    console.warn(`[worker ${INDEX}] perfil de heap indisponível: ${err.message}`);
    profiler = null;
  }
}

let nextDiagMb = DIAG_HEAP_MB;
let lastDiagAt = 0;
function checkHeapProfile(heapMb) {
  if (!profiler) return;
  // Heap voltou ao normal (GC) e já faz um tempo do último: rearma no primeiro degrau.
  if (heapMb < DIAG_HEAP_MB * 0.6 && Date.now() - lastDiagAt > DIAG_MIN_GAP_MS) nextDiagMb = DIAG_HEAP_MB;
  if (heapMb < nextDiagMb) return;
  nextDiagMb = heapMb + DIAG_STEP_MB;
  lastDiagAt = Date.now();
  dumpHeapProfile(heapMb);
}

function dumpHeapProfile(heapMb) {
  const t0 = Date.now();
  profiler.post('HeapProfiler.getSamplingProfile', (err, res) => {
    if (err || !res?.profile) return console.warn(`[worker ${INDEX}] falha ao ler perfil de heap: ${err?.message}`);
    const where = (cf) => `${cf.functionName || '(anônima)'} ${String(cf.url).replace(/^file:\/\/\/?app\//, '')}:${cf.lineNumber + 1}`;
    const byFn = new Map(); // função que alocou -> bytes vivos
    const byStack = new Map(); // função + 5 chamadores -> bytes vivos
    let total = 0;
    const walk = (node, stack) => {
      const s = stack.concat(where(node.callFrame));
      if (node.selfSize > 0) {
        total += node.selfSize;
        const fn = s[s.length - 1];
        byFn.set(fn, (byFn.get(fn) || 0) + node.selfSize);
        const key = s.slice(-6).reverse().join(' <- ');
        byStack.set(key, (byStack.get(key) || 0) + node.selfSize);
      }
      for (const c of node.children || []) walk(c, s.length > 40 ? s.slice(-40) : s);
    };
    walk(res.profile.head, []);
    const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => `${String(mb(v)).padStart(6)} MB  ${k}`).join('\n');
    const sessions = manager.listActive().length;
    const text = `# worker ${INDEX} ${new Date().toISOString()} heap ${heapMb} MB, amostrado vivo ${mb(total)} MB, sessões ${sessions}, leitura ${Date.now() - t0} ms\n`
      + `\n## por função\n${top(byFn, 30)}\n\n## por pilha (função <- chamadores)\n${top(byStack, 25)}\n`;
    const file = path.join(DIAG_DIR, `heap-w${INDEX}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    fs.writeFile(file, text, (e) => {
      if (e) console.warn(`[worker ${INDEX}] falha ao gravar perfil de heap: ${e.message}`);
      else console.log(`[worker ${INDEX}] perfil de heap gravado (heap ${heapMb} MB): ${file}`);
    });
  });
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
