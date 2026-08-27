const { pool } = require('./db');

/**
 * Persistência do Copiloto Comercial (insights de IA em tempo real) —
 * mesmo padrão de src/store.js (funções de nota interna são o modelo
 * mais próximo). Diferente de addInternalNote, aqui NUNCA se cria uma
 * conversa nova — insightGenerator só roda depois que store.addMessage
 * já persistiu a mensagem (que por sua vez já criou/atualizou a
 * conversation via getOrCreateConversation), então a conversa sempre já
 * existe neste ponto do pipeline.
 */

// Resolve conversation_id por (sessionId, phone) — sem criar. `null` se
// a conversa ainda não existe (não deveria acontecer no fluxo normal,
// mas quem chama trata como "não gera insight" em vez de lançar).
async function getConversationId(sessionId, phone) {
  const { rows } = await pool.query(
    `select id from conversations where session_id = $1 and phone = $2`,
    [sessionId, phone]
  );
  return rows[0] ? rows[0].id : null;
}

function mapInsightRow(r) {
  return {
    ...r,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function listActiveInsights(sessionId, phone) {
  const { rows } = await pool.query(
    `select i.id, i.topic, i.title, i.body, i.confidence, i.status, i.feedback,
            i.created_at as "createdAt", i.updated_at as "updatedAt"
     from conversation_insights i
     join conversations c on c.id = i.conversation_id
     where c.session_id = $1 and c.phone = $2 and i.status = 'active'
     order by i.created_at asc`,
    [sessionId, phone]
  );
  return rows.map(mapInsightRow);
}

// Usado por insightGenerator pra montar o prompt "não repita o que já
// foi sugerido" — só os títulos dos insights ainda ativos (dismissed/
// sent não contam mais como "ativo na tela" do atendente).
async function listActiveInsightTitles(conversationId) {
  const { rows } = await pool.query(
    `select title from conversation_insights where conversation_id = $1 and status = 'active'`,
    [conversationId]
  );
  return rows.map((r) => r.title);
}

async function createInsight(conversationId, { topic, title, body, confidence, tokensUsed }) {
  const { rows } = await pool.query(
    `insert into conversation_insights (conversation_id, topic, title, body, confidence, tokens_used)
     values ($1, $2, $3, $4, $5, $6)
     returning id, created_at as "createdAt", updated_at as "updatedAt"`,
    [conversationId, topic, title, body, confidence || null, tokensUsed || null]
  );
  return mapInsightRow({
    id: rows[0].id, topic, title, body, confidence: confidence || null,
    status: 'active', feedback: null,
    createdAt: rows[0].createdAt, updatedAt: rows[0].updatedAt,
  });
}

// Dono (via conversa → instância) de um insight por id — não há
// "autor" pessoal aqui (é gerado por IA), então não existe um
// requireResourceOwner equivalente ao de nota interna; a autorização
// de rota já é feita por requireSession(session) nas rotas que
// recebem session+phone no body/query, e a query de update sempre
// escopa por id (sem checagem extra de posse por linha — mesmo nível
// de proteção que GET /internal-notes/:id/revisions já aceita).
async function setInsightStatus(id, status) {
  const { rows } = await pool.query(
    `update conversation_insights set status = $2, updated_at = now()
     where id = $1
     returning id, conversation_id as "conversationId", topic, title, body, confidence, status, feedback,
               created_at as "createdAt", updated_at as "updatedAt"`,
    [id, status]
  );
  return rows[0] ? mapInsightRow(rows[0]) : null;
}

async function setInsightFeedback(id, feedback) {
  const { rows } = await pool.query(
    `update conversation_insights set feedback = $2, updated_at = now()
     where id = $1
     returning id, conversation_id as "conversationId", topic, title, body, confidence, status, feedback,
               created_at as "createdAt", updated_at as "updatedAt"`,
    [id, feedback]
  );
  return rows[0] ? mapInsightRow(rows[0]) : null;
}

// Um insight por id, com session_id/phone da conversa dona — usado por
// POST /:id/send (rota precisa confirmar que o insight pertence à
// session/phone informados no body antes de disparar sendMessage).
async function getInsightWithConversation(id) {
  const { rows } = await pool.query(
    `select i.id, i.conversation_id as "conversationId", i.topic, i.title, i.body,
            i.confidence, i.status, i.feedback,
            c.session_id as "sessionId", c.phone
     from conversation_insights i
     join conversations c on c.id = i.conversation_id
     where i.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// --- Anti-flood (conversation_insight_state) ---

async function getInsightState(conversationId) {
  const { rows } = await pool.query(
    `select last_generated_at as "lastGeneratedAt", last_message_id_considered as "lastMessageIdConsidered"
     from conversation_insight_state where conversation_id = $1`,
    [conversationId]
  );
  if (!rows[0]) return { lastGeneratedAt: null, lastMessageIdConsidered: null };
  return {
    lastGeneratedAt: rows[0].lastGeneratedAt ? rows[0].lastGeneratedAt.toISOString() : null,
    lastMessageIdConsidered: rows[0].lastMessageIdConsidered,
  };
}

// Upsert — chamado logo que a checagem de anti-flood decide GERAR
// (antes de chamar a OpenAI), pra que uma segunda mensagem chegando
// durante a chamada em andamento já veja `lastGeneratedAt` recente
// (reduz, não elimina, a janela de corrida — ver HANDOFF sobre o
// trade-off aceito).
async function touchInsightState(conversationId, messageId) {
  await pool.query(
    `insert into conversation_insight_state (conversation_id, last_generated_at, last_message_id_considered)
     values ($1, now(), $2)
     on conflict (conversation_id) do update set
       last_generated_at = now(),
       last_message_id_considered = $2`,
    [conversationId, messageId || null]
  );
}

module.exports = {
  getConversationId,
  listActiveInsights,
  listActiveInsightTitles,
  createInsight,
  setInsightStatus,
  setInsightFeedback,
  getInsightWithConversation,
  getInsightState,
  touchInsightState,
};
