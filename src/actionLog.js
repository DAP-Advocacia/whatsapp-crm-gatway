const { pool } = require('./db');

/**
 * Histórico de AÇÕES reais por pessoa, pro Admin (modal Detalhado, tela
 * Usuários — ver HANDOFF Parte DB). Deliberadamente SEM conteúdo digitado
 * nem gravação de tela (decisão confirmada com o usuário: risco real de
 * capturar dado sigiloso de cliente/caso, sendo escritório de
 * advocacia/financeira) — só as 5 ações confirmadas: instância conectada,
 * campanha criada/agendada, contato criado/importado, grupo criado,
 * conversa atribuída a si mesmo.
 *
 * Mensagem enviada FICA DE FORA de propósito — já tem contagem separada
 * (messagesSentLast30d, getUsabilityStatsByOwner em src/store.js); logar
 * cada envio aqui inundaria o histórico e esconderia as ações mais
 * raras/significativas.
 */

// Fire-and-forget, best-effort — chamado de dentro de rotas já em
// andamento (criar instância, criar campanha, etc.); uma falha aqui NUNCA
// deve impedir a ação real de completar, só perde o registro (mesma
// filosofia do sync automático de contato, src/server.js onMessage).
// `detail` é texto livre JÁ FORMATADO no momento do registro (decisão de
// exibição fica aqui, não recalculada depois na tela).
async function logAction(ownerId, action, detail = null) {
  try {
    await pool.query(
      `insert into action_log (owner_id, action, detail) values ($1, $2, $3)`,
      [ownerId, action, detail]
    );
  } catch (err) {
    console.error('[actionLog] falha ao registrar ação (não bloqueia a ação real):', err.message);
  }
}

// Histórico de UMA pessoa, mais recente primeiro — pro modal Detalhado do
// Admin. Limitado a 200 linhas, mesmo raciocínio de
// pageSessions.getSessionHistory (volume baixo o suficiente pra não
// justificar paginação de SERVIDOR — a paginação que já existe no
// frontend, Parte DB, é client-side sobre esses 200).
async function getActionHistory(ownerId) {
  const { rows } = await pool.query(
    `select action, detail, created_at as "createdAt"
     from action_log
     where owner_id = $1
     order by created_at desc
     limit 200`,
    [ownerId]
  );
  return rows;
}

module.exports = { logAction, getActionHistory };
