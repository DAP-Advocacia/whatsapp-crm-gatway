const { pool } = require('./db');

/**
 * Auditoria de acesso à Auditoria de Conversas (`/conversation-analysis.html`,
 * ver HANDOFF Parte DK) — DIFERENTE de src/actionLog.js (ações do PRÓPRIO
 * uso do app, deliberadamente sem conteúdo digitado) e de page_sessions
 * (navegação genérica, sem saber QUAL recurso foi olhado). Aqui: qual
 * conversa de qual dono foi aberta, ou com quais filtros uma busca/
 * insight foi gerado — `detail` é um objeto estruturado (persistido como
 * jsonb) e NUNCA guarda texto de mensagem nem o texto do insight gerado,
 * só o QUE foi acessado. É sobre rastreabilidade de acesso privilegiado
 * a dado sensível de terceiros, não sobre duplicar esse dado em outro
 * lugar.
 */

// Fire-and-forget, best-effort — chamado de dentro das rotas do router
// (src/routes/conversationAnalysis.js) já em andamento; uma falha aqui
// NUNCA deve impedir a resposta real de completar, só perde o registro
// (mesma filosofia de actionLog.logAction).
async function logAccess(ownerId, action, detail = null) {
  try {
    await pool.query(
      `insert into conversation_analysis_audit (owner_id, action, detail) values ($1, $2, $3)`,
      [ownerId, action, detail ? JSON.stringify(detail) : null]
    );
  } catch (err) {
    console.error('[conversationAnalysisAudit] falha ao registrar acesso (não bloqueia a resposta real):', err.message);
  }
}

module.exports = { logAccess };
