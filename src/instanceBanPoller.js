const instanceBanStore = require('./instanceBanStore');
const instancesStore = require('./instances');
const alertDispatcher = require('./alertDispatcher');

/**
 * Alerta de instância BANIDA — diferente de handleStatusForHealth
 * (src/server.js), que só reage a EVENTOS de conexão (o Baileys emitindo
 * 'connection.update'), este poller detecta uma condição de TEMPO
 * decorrido em silêncio: uma instância pode ficar com `forbidden` aberto
 * por dias sem nenhum evento novo disparar, e nada avisaria sozinho
 * quando ela cruzasse o limiar de 24h (ver src/instanceBanStore.js) se
 * não houvesse essa varredura periódica.
 *
 * Mesmo esqueleto de src/dealStagePoller.js: runOnce() com try/catch por
 * item (erro numa instância nunca aborta o lote), startPolling(intervalMs)
 * chamado 1x no boot.
 */

// IDs (instance_connection_events.id, bigserial — identifica a JANELA de
// banimento de forma única) já avisados neste boot do processo. Reseta a
// cada restart — aceitável, mesmo raciocínio já usado em `lastHealthState`
// (src/server.js): na pior hipótese avisa de novo 1x extra depois de um
// deploy, nunca deixa de avisar.
const alreadyNotified = new Set();

async function runOnce({ sessions }) {
  const banned = await instanceBanStore.listBannedNow();
  for (const ev of banned) {
    if (alreadyNotified.has(ev.id)) continue;
    try {
      // Instância ÓRFÃ (removida da tabela `instances`, mas o evento de
      // conexão em aberto sobreviveu — ver comentário de topo de
      // src/instanceHealthStore.js): não há dono real pra avisar.
      // instancesStore.ownerOf() tem um fallback deliberado (devolve o
      // próprio instanceId como "ownerId" quando órfã, ver src/instances.js)
      // que existe pra outros usos — aqui geraria notificação fantasma
      // pra ninguém de verdade, então pula sem marcar como notificado
      // (se um dia a mesma janela deixar de ser órfã, o que não deveria
      // acontecer na prática, ainda tentaria de novo no próximo tick).
      const inst = await instancesStore.get(ev.instanceId);
      if (!inst) {
        console.warn(`[instance-ban-poller] instância órfã ${ev.instanceId} com forbidden > 24h — sem dono pra avisar, pulando.`);
        continue;
      }
      const ownerId = inst.ownerId;
      const delegates = await instancesStore.listDelegates(ev.instanceId);
      const recipients = [ownerId, ...delegates.map((d) => d.delegateOwnerId)];
      const label = inst.label || ev.instanceId;
      await alertDispatcher.notifyAttention({
        recipients,
        title: `Instância "${label}" foi banida pelo WhatsApp`,
        body: 'O WhatsApp recusou o acesso a esse número por mais de 24h — provavelmente uma restrição/banimento da conta, não uma queda de conexão comum. Veja a aba Instâncias (categoria "Banida") pra mais detalhes.',
        target: { page: '/instances.html', sessionId: ev.instanceId },
        waSourceSessionId: ev.instanceId,
        sessions,
      });
      alreadyNotified.add(ev.id);
    } catch (err) {
      console.error(`[instance-ban-poller] falha ao notificar banimento de ${ev.instanceId}:`, err.message);
    }
  }
}

// Granularidade de 20min é suficiente pra um limiar de 24h — mesmo
// intervalo padrão já usado por src/dealStagePoller.js.
function startPolling(sessions, intervalMs = 20 * 60 * 1000) {
  setInterval(() => {
    runOnce({ sessions }).catch((err) => console.error('[instance-ban-poller] falha no tick:', err.message));
  }, intervalMs);
}

module.exports = { startPolling, runOnce };
