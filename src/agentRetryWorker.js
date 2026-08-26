const agentRetryQueue = require('./agentRetryQueue');
const agentDispatch = require('./agentDispatch');
const store = require('./store');

/**
 * Reprocessa a fila de retry do Agente de IA (src/agentRetryQueue.js)
 * quando uma instância reconecta — chamado por src/server.js dentro
 * de `onStatus`, quando `status === 'online'`, mesmo padrão de
 * handleStatusForHealth já existente ali. RE-GERA a resposta do zero
 * pra cada pendente (nunca reenvia texto congelado) — usando a última
 * mensagem 'in' real do histórico daquela conversa, que pode ter
 * mudado enquanto a instância estava offline (ex: o lead mandou mais
 * mensagens nesse meio tempo).
 */

async function processRetryQueueForSession(sessionId) {
  const pending = await agentRetryQueue.listPendingForSession(sessionId);
  if (!pending.length) return;

  for (const item of pending) {
    try {
      const history = await store.getHistory(sessionId, item.phone);
      const lastIncoming = [...history].reverse().find((m) => m.direction === 'in');
      const leadMessageText = lastIncoming?.text || '';

      await agentDispatch.dispatchAgentReply({ sessionId, phone: item.phone, leadMessageText });
      await agentRetryQueue.markSent(item.id);
    } catch (err) {
      console.error(`[agent-retry-worker] falha ao reprocessar (${sessionId}/${item.phone}):`, err.message);
      await agentRetryQueue.markFailed(item.id, err.message);
    }
  }
}

module.exports = { processRetryQueueForSession };
