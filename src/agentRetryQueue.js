const { pool } = require('./db');

/**
 * Fila de retry do Agente de IA — resiliência pedida explicitamente:
 * se TODAS as instâncias do usuário caírem no momento em que o lead
 * manda mensagem, a intenção de resposta fica registrada aqui em vez
 * de se perder. src/agentRetryWorker.js reprocessa quando a instância
 * reconectar. Nunca guarda a resposta já pronta — o worker RE-GERA do
 * zero no momento do reenvio (ver comentário em db/schema.sql).
 */

const MAX_ATTEMPTS = 3;

async function enqueue(sessionId, phone) {
  await pool.query(
    `insert into agent_retry_queue (session_id, phone) values ($1, $2)`,
    [sessionId, phone]
  );
}

async function listPendingForSession(sessionId) {
  const { rows } = await pool.query(
    `select id, session_id as "sessionId", phone, attempts
     from agent_retry_queue
     where session_id = $1 and status = 'pending'
     order by created_at asc`,
    [sessionId]
  );
  return rows;
}

async function markSent(id) {
  await pool.query(`update agent_retry_queue set status = 'sent', updated_at = now() where id = $1`, [id]);
}

// `attempts + 1 >= MAX_ATTEMPTS` -> 'failed' (nunca tenta pra sempre);
// senão continua 'pending', pra tentar de novo na próxima reconexão.
async function markFailed(id, errorMessage) {
  await pool.query(
    `update agent_retry_queue
     set attempts = attempts + 1,
         last_error = $2,
         status = case when attempts + 1 >= $3 then 'failed' else 'pending' end,
         updated_at = now()
     where id = $1`,
    [id, errorMessage, MAX_ATTEMPTS]
  );
}

module.exports = { enqueue, listPendingForSession, markSent, markFailed, MAX_ATTEMPTS };
