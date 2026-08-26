const { pool } = require('./db');

/**
 * Configuração do Agente de IA POR INSTÂNCIA (não por owner) — mesmo
 * padrão de upsert dinâmico de src/settings.js (paleta por usuário),
 * mas com PK em session_id em vez de owner_id. Ver db/schema.sql,
 * tabela agent_config, e public/agente-ia.html (tela que edita isto).
 */

async function get(sessionId) {
  const { rows } = await pool.query(
    `select session_id as "sessionId", active, system_message as "systemMessage",
            knowledge_text as "knowledgeText", updated_at as "updatedAt"
     from agent_config where session_id = $1`,
    [sessionId]
  );
  if (rows[0]) return { ...rows[0], updatedAt: rows[0].updatedAt.toISOString() };
  // Sem linha ainda = instância nunca configurou o agente — estado
  // seguro por padrão (active:false), nunca um erro.
  return { sessionId, active: false, systemMessage: null, knowledgeText: null, updatedAt: null };
}

// `active`/`systemMessage`/`knowledgeText` são todos opcionais no
// patch — só o que vier definido (não `undefined`) é atualizado;
// campo ausente preserva o valor já salvo (mesmo padrão de
// src/settings.js::update). `active` aceita `false` como valor real
// (diferente de "ausente") — quem chama (rota PUT /api/agent/config)
// só deve omitir a chave do body se quiser preservar o valor atual,
// nunca mandar `active: undefined` esperando esse efeito.
async function upsert(sessionId, patch) {
  const hasActive = Object.prototype.hasOwnProperty.call(patch, 'active');
  const hasSystemMessage = Object.prototype.hasOwnProperty.call(patch, 'systemMessage');
  const hasKnowledgeText = Object.prototype.hasOwnProperty.call(patch, 'knowledgeText');

  await pool.query(
    `insert into agent_config (session_id, active, system_message, knowledge_text)
     values ($1, coalesce($2, false), $3, $4)
     on conflict (session_id) do update set
       active = case when $5 then $2 else agent_config.active end,
       system_message = case when $6 then $3 else agent_config.system_message end,
       knowledge_text = case when $7 then $4 else agent_config.knowledge_text end,
       updated_at = now()`,
    [
      sessionId,
      hasActive ? !!patch.active : null,
      hasSystemMessage ? (patch.systemMessage || null) : null,
      hasKnowledgeText ? (patch.knowledgeText || null) : null,
      hasActive,
      hasSystemMessage,
      hasKnowledgeText,
    ]
  );
  return get(sessionId);
}

module.exports = { get, upsert };
