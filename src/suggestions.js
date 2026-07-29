const { pool } = require('./db');

/**
 * Sugestões de melhoria enviadas pelos usuários (tela `public/suggestions.html`)
 * — visão de TIME (todo mundo vê todas as sugestões, igual Análise de
 * Conversas), não escopada por owner_id na leitura. Ao marcar como
 * lançada, quem sugeriu recebe uma notificação (ver src/routes/suggestions.js).
 */

async function create(ownerId, text) {
  const { rows } = await pool.query(
    `insert into suggestions (owner_id, text)
     values ($1, $2)
     returning id, owner_id as "ownerId", text, status, created_at as "createdAt", released_at as "releasedAt"`,
    [ownerId, text]
  );
  return rows[0];
}

async function list() {
  const { rows } = await pool.query(
    `select id, owner_id as "ownerId", text, status, created_at as "createdAt", released_at as "releasedAt"
     from suggestions order by created_at desc limit 500`
  );
  return rows;
}

// Só atualiza se ainda não estava lançada — evita notificar de novo se
// alguém clicar 2x, e devolve null pro chamador saber que nada mudou.
async function markReleased(id) {
  const { rows } = await pool.query(
    `update suggestions set status = 'released', released_at = now()
     where id = $1 and status <> 'released'
     returning id, owner_id as "ownerId", text, status, created_at as "createdAt", released_at as "releasedAt"`,
    [id]
  );
  return rows[0] || null;
}

module.exports = { create, list, markReleased };
