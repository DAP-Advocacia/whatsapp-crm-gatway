const { pool } = require('./db');

/**
 * Modelos de mensagem reutilizáveis na Campanha. O corpo pode conter
 * {{nome}} e {{telefone}}, substituídos por destinatário no momento do
 * envio (ver renderTemplate em src/campaigns.js).
 */

async function listTemplates(sessionId) {
  const { rows } = await pool.query(
    `select id, name, body from message_templates where session_id = $1 order by name`,
    [sessionId]
  );
  return rows;
}

async function createTemplate(sessionId, name, body) {
  const { rows } = await pool.query(
    `insert into message_templates (session_id, name, body) values ($1, $2, $3)
     returning id, name, body`,
    [sessionId, name, body]
  );
  return rows[0];
}

async function updateTemplate(id, sessionId, name, body) {
  const { rows } = await pool.query(
    `update message_templates set name = $1, body = $2, updated_at = now()
     where id = $3 and session_id = $4
     returning id, name, body`,
    [name, body, id, sessionId]
  );
  return rows[0];
}

async function deleteTemplate(id, sessionId) {
  const { rowCount } = await pool.query(`delete from message_templates where id = $1 and session_id = $2`, [id, sessionId]);
  return rowCount > 0;
}

module.exports = { listTemplates, createTemplate, updateTemplate, deleteTemplate };
