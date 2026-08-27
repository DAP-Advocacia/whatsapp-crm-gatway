const { pool } = require('./db');

/**
 * Configuração do Copiloto Comercial (insights de IA em tempo real)
 * POR INSTÂNCIA — mesmo padrão exato de src/agentConfig.js (PK
 * session_id, upsert parcial). Distinto do Agente de IA: aqui é o
 * setor comercial (venda de precatórios) que liga o toggle pra
 * receber sugestões da IA durante o atendimento, não pra IA responder
 * sozinha. Ver db/schema.sql, tabela commercial_config, e
 * public/agente-ia.html (painel "Copiloto comercial", fora do wizard).
 */

const DEFAULT_TOPICS = [
  'Passo a passo de documento',
  'Análise de contraproposta',
  'Objeção de preço',
  'Qualificação do lead',
  'Próximo passo',
];

async function get(sessionId) {
  const { rows } = await pool.query(
    `select session_id as "sessionId", enabled, playbook, topics, updated_at as "updatedAt"
     from commercial_config where session_id = $1`,
    [sessionId]
  );
  if (rows[0]) return { ...rows[0], updatedAt: rows[0].updatedAt.toISOString() };
  // Sem linha ainda = instância nunca configurou o copiloto — estado
  // seguro por padrão (enabled:false), nunca um erro. `topics` default
  // já reflete o mesmo default do schema (duplicado aqui de propósito,
  // pra funcionar mesmo antes de qualquer upsert existir).
  return { sessionId, enabled: false, playbook: null, topics: DEFAULT_TOPICS, updatedAt: null };
}

// `enabled`/`playbook`/`topics` são todos opcionais no patch — só o
// que vier definido (não `undefined`) é atualizado; campo ausente
// preserva o valor já salvo (mesmo padrão de src/agentConfig.js).
// `enabled` aceita `false` como valor real.
async function upsert(sessionId, patch) {
  const hasEnabled = Object.prototype.hasOwnProperty.call(patch, 'enabled');
  const hasPlaybook = Object.prototype.hasOwnProperty.call(patch, 'playbook');
  const hasTopics = Object.prototype.hasOwnProperty.call(patch, 'topics');

  // `topics` no insert usa coalesce contra o default JSON literal (não dá
  // pra referenciar a palavra-chave `default` de dentro de coalesce com
  // bind parametrizado) — mesmo array default de DEFAULT_TOPICS acima,
  // espelhando o default da coluna no schema.
  await pool.query(
    `insert into commercial_config (session_id, enabled, playbook, topics)
     values ($1, coalesce($2, false), $3, coalesce($4::jsonb, $8::jsonb))
     on conflict (session_id) do update set
       enabled = case when $5 then $2 else commercial_config.enabled end,
       playbook = case when $6 then $3 else commercial_config.playbook end,
       topics = case when $7 then $4::jsonb else commercial_config.topics end,
       updated_at = now()`,
    [
      sessionId,
      hasEnabled ? !!patch.enabled : null,
      hasPlaybook ? (patch.playbook || null) : null,
      hasTopics && Array.isArray(patch.topics) ? JSON.stringify(patch.topics) : null,
      hasEnabled,
      hasPlaybook,
      hasTopics,
      JSON.stringify(DEFAULT_TOPICS),
    ]
  );
  return get(sessionId);
}

module.exports = { get, upsert, DEFAULT_TOPICS };
