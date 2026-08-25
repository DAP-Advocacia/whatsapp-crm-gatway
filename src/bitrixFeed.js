const { pool } = require('./db');

/**
 * Publicar no Feed (Live Feed) nativo do Bitrix24 — "Para todos os
 * colaboradores", diferente de `crm.timeline` (src/bitrix.js, usado hoje
 * pra mensagem/status/resumo de IA dentro de UM negócio). Sempre MANUAL —
 * decisão confirmada com o usuário: nunca dispara automaticamente a
 * partir de deploy/commit, só quando o super admin clica "Publicar" no
 * Painel Admin depois de revisar o texto.
 *
 * Cliente PRÓPRIO, não reaproveita callBitrix de src/bitrix.js — aquele
 * aponta pro BITRIX_WEBHOOK_URL, que tem escopo CRM apenas. log.blogpost.add
 * exige o escopo "Rede Social", que esse webhook não tem — precisa de um
 * webhook de entrada SEGUNDO e dedicado (BITRIX_FEED_WEBHOOK_URL), mesmo
 * padrão já usado pra BITRIX_HR_WEBHOOK_URL (hierarquia de departamento).
 */

const BITRIX_FEED_WEBHOOK_URL = process.env.BITRIX_FEED_WEBHOOK_URL;

async function callBitrixFeed(method, params = {}) {
  if (!BITRIX_FEED_WEBHOOK_URL) {
    throw new Error('BITRIX_FEED_WEBHOOK_URL não configurado — crie um webhook de entrada dedicado no Bitrix (Aplicativos > Webhooks de entrada, escopo "Rede Social") e defina essa variável antes de publicar.');
  }
  const url = `${BITRIX_FEED_WEBHOOK_URL.replace(/\/$/, '')}/${method}.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }
  return data.result;
}

// CONFIRMADO em teste real (2026-08-25): o payload abaixo funciona
// exatamente como esperado (post criado no Feed real, id devolvido em
// `result`). O único obstáculo real não foi o payload — foi o ESCOPO do
// webhook: "Rede Social (socialnetwork)" sozinho NÃO é suficiente pra
// log.blogpost.add, apesar do nome sugerir o contrário. O escopo exigido
// é "log" (Feed/Log de atividades) — precisa marcar os DOIS no painel do
// webhook (Aplicativos > Webhooks de entrada), senão a chamada falha com
// `insufficient_scope` mesmo com a URL/token corretos.
//   POST_TITLE: string (título do post, pode ficar vazio)
//   POST_MESSAGE: string — aceita BB-code básico (ex: [B]texto[/B])
//   DEST: { AUDIENCE_TYPE: 'ALL' } — "Para todos os colaboradores"
//         (confirmado via print do usuário ser este destino, não outro)
async function publishFeedPost({ title, message }) {
  const trimmed = String(message || '').trim();
  if (!trimmed) throw new Error('a mensagem do post não pode ficar vazia');
  return callBitrixFeed('log.blogpost.add', {
    POST_TITLE: title || '',
    POST_MESSAGE: trimmed,
    DEST: { AUDIENCE_TYPE: 'ALL' },
  });
}

// Histórico LOCAL de posts publicados — nunca é a fonte de verdade (o
// Bitrix é o dono real do post), só um registro pra "o que já foi
// anunciado, não duplicar". Registrado mesmo em falha (status='failed'),
// pra nunca perder o rastro de uma tentativa que não foi ao ar.
async function recordFeedPost({ ownerId, title, message, bitrixPostId, status, error }) {
  await pool.query(
    `insert into feed_posts (owner_id, title, message, bitrix_post_id, status, error)
     values ($1, $2, $3, $4, $5, $6)`,
    [ownerId, title || null, message, bitrixPostId || null, status, error || null]
  );
}

async function listFeedPosts() {
  const { rows } = await pool.query(
    `select id, owner_id as "ownerId", title, message, bitrix_post_id as "bitrixPostId",
            status, error, created_at as "createdAt"
     from feed_posts order by created_at desc limit 100`
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

module.exports = { publishFeedPost, recordFeedPost, listFeedPosts };
