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

// `instanceId`s já avisados NESTE episódio de banimento — diferente da
// 1ª versão desta feature (dedupe por id de linha de evento pontual),
// listBannedNow() agora retorna uma AGREGAÇÃO por instância (soma de
// várias janelas, ver src/instanceBanStore.js), sem id de linha único
// pra usar. Dedupe por instanceId, removido do Set assim que ela sair
// da lista de banidas (reconectou de vez e a soma caiu abaixo do
// limiar) — se for banida de novo no futuro, volta a avisar. Reseta a
// cada restart do processo — aceitável, mesmo raciocínio já usado em
// `lastHealthState` (src/server.js): na pior hipótese avisa de novo 1x
// extra depois de um deploy, nunca deixa de avisar.
const alreadyNotified = new Set();

async function runOnce({ sessions }) {
  const banned = await instanceBanStore.listBannedNow();
  const bannedIds = new Set(banned.map((ev) => ev.instanceId));
  // Esquece quem não está mais banida — próxima vez que banir de novo, avisa de novo.
  for (const id of alreadyNotified) {
    if (!bannedIds.has(id)) alreadyNotified.delete(id);
  }

  for (const ev of banned) {
    if (alreadyNotified.has(ev.instanceId)) continue;
    try {
      // Instância ÓRFÃ (removida da tabela `instances`, mas o histórico
      // de conexão sobreviveu — ver comentário de topo de
      // src/instanceHealthStore.js): não há dono real pra avisar.
      // instancesStore.ownerOf() tem um fallback deliberado (devolve o
      // próprio instanceId como "ownerId" quando órfã, ver src/instances.js)
      // que existe pra outros usos — aqui geraria notificação fantasma
      // pra ninguém de verdade, então pula sem marcar como notificado
      // (se um dia deixar de ser órfã, o que não deveria acontecer na
      // prática, ainda tentaria de novo no próximo tick).
      const inst = await instancesStore.get(ev.instanceId);
      if (!inst) {
        console.warn(`[instance-ban-poller] instância órfã ${ev.instanceId} com forbidden persistente — sem dono pra avisar, pulando.`);
        continue;
      }
      const ownerId = inst.ownerId;
      const delegates = await instancesStore.listDelegates(ev.instanceId);
      const recipients = [ownerId, ...delegates.map((d) => d.delegateOwnerId)];
      const label = inst.label || ev.instanceId;
      await alertDispatcher.notifyAttention({
        recipients,
        title: `Instância "${label}" foi banida pelo WhatsApp`,
        body: 'O WhatsApp recusou o acesso a esse número de forma persistente nas últimas 24h — provavelmente uma restrição/banimento da conta, não uma queda de conexão comum. Veja a aba Instâncias (categoria "Banida") pra mais detalhes.',
        target: { page: '/instances.html', sessionId: ev.instanceId },
        waSourceSessionId: ev.instanceId,
        sessions,
      });
      alreadyNotified.add(ev.instanceId);
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
