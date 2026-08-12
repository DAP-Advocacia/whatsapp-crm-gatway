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

// Só avança de 'pending' pra 'in_review' — nunca volta por aqui (mesma
// guarda de "só se ainda não estava" que markReleased já usa). Devolve
// null se já não estava mais pendente (chamador decide se notifica).
async function moveToReview(id) {
  const { rows } = await pool.query(
    `update suggestions set status = 'in_review'
     where id = $1 and status = 'pending'
     returning id, owner_id as "ownerId", text, status, created_at as "createdAt", released_at as "releasedAt"`,
    [id]
  );
  return rows[0] || null;
}

// Pode responder em qualquer status (inclusive antes de mover pra "Em
// análise", ou depois de já lançada) — resposta e lançamento são
// independentes. response vazio/null "limpa" a resposta (permite desfazer).
async function respond(id, response) {
  const { rows } = await pool.query(
    `update suggestions set response = $2, responded_at = now()
     where id = $1
     returning id, owner_id as "ownerId", text, status, response, created_at as "createdAt", released_at as "releasedAt"`,
    [id, response || null]
  );
  return rows[0] || null;
}

// FAQ pública (GET /api/suggestions/faq) — só sugestões já respondidas,
// SEM ownerId (não expor quem perguntou o quê). Mais antigas primeiro (faz
// mais sentido de leitura numa FAQ que "mais recentes primeiro").
async function listFaq() {
  const { rows } = await pool.query(
    `select id, text as question, response as answer, responded_at as "respondedAt"
     from suggestions
     where response is not null
     order by responded_at asc
     limit 500`
  );
  return rows;
}

module.exports = { create, list, markReleased, moveToReview, respond, listFaq };
