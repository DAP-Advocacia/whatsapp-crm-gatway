const { pool } = require('./db');

/**
 * Acesso à Auditoria de Conversas (`/conversation-analysis.html`, ver
 * HANDOFF Parte DK) — tela DIFERENTE do dashboard "Análise de Conversas"
 * já existente (agregado só das PRÓPRIAS instâncias); esta lê o conteúdo
 * real de mensagens de QUALQUER owner do sistema, por isso o acesso é
 * restrito e concedido nominalmente pelo super admin, pessoa por pessoa
 * (nunca por hierarquia/departamento automática).
 *
 * Espelha src/blockedOwners.js na estrutura — mesma tabela simples
 * `owner_id primary key`, mesmo padrão de upsert/delete. Verificado a
 * cada request (não cacheado, ver requireConversationAnalysisAccess em
 * src/adminAuth.js) — revogação corta acesso na PRÓXIMA chamada, sem
 * esperar o token expirar sozinho.
 *
 * Super admin (SUPER_ADMIN_OWNER_IDS) sempre tem acesso e NÃO precisa de
 * linha aqui — essa checagem vive em adminAuth.js, não neste arquivo.
 */

async function grantAccess(ownerId, grantedBy) {
  await pool.query(
    `insert into conversation_analysis_grants (owner_id, granted_by)
     values ($1, $2)
     on conflict (owner_id) do update
       set granted_by = $2, granted_at = now()`,
    [ownerId, grantedBy]
  );
}

async function revokeAccess(ownerId) {
  const { rowCount } = await pool.query(
    `delete from conversation_analysis_grants where owner_id = $1`,
    [ownerId]
  );
  return rowCount > 0;
}

// Chamado em toda rota do painel (requireConversationAnalysisAccess) —
// lookup por primary key numa tabela pequena (só quem recebeu acesso
// explicitamente, não todo mundo).
async function hasAccess(ownerId) {
  const { rows } = await pool.query(
    `select 1 from conversation_analysis_grants where owner_id = $1`,
    [ownerId]
  );
  return rows.length > 0;
}

async function listGrants() {
  const { rows } = await pool.query(
    `select owner_id as "ownerId", granted_by as "grantedBy", granted_at as "grantedAt"
     from conversation_analysis_grants`
  );
  return rows.map((r) => ({ ...r, grantedAt: r.grantedAt.toISOString() }));
}

module.exports = { grantAccess, revokeAccess, hasAccess, listGrants };
