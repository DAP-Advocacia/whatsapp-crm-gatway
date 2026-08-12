const { pool } = require('./db');

/**
 * Bloqueio de acesso individual (botão "Revogar" no Admin, ver HANDOFF
 * Parte CO) — verificado dentro de requireAuth (src/auth.js), em TODA
 * request autenticada do sistema, não só na emissão do token: quem já
 * tem um token válido em uso (até 12h, AUTH_TOKEN_TTL_HOURS) é cortado
 * na PRÓXIMA chamada, não precisa esperar o token expirar sozinho.
 *
 * Só o super admin (requireSuperAdmin, src/adminAuth.js) pode
 * bloquear/desbloquear — e a rota que chama isto (src/routes/whatsapp.js)
 * nunca deixa alguém bloquear o próprio ownerId, pra não trancar o único
 * acesso administrativo fora do sistema por engano.
 */

async function blockOwner(ownerId, blockedBy, reason) {
  await pool.query(
    `insert into blocked_owners (owner_id, blocked_by, reason)
     values ($1, $2, $3)
     on conflict (owner_id) do update
       set blocked_by = $2, blocked_at = now(), reason = $3`,
    [ownerId, blockedBy, reason || null]
  );
}

async function unblockOwner(ownerId) {
  const { rowCount } = await pool.query(`delete from blocked_owners where owner_id = $1`, [ownerId]);
  return rowCount > 0;
}

// Chamado em TODA request autenticada (requireAuth) — precisa ser rápido:
// lookup por primary key numa tabela que na prática tem poucas linhas
// (só quem foi de fato bloqueado, não todo mundo).
async function isBlocked(ownerId) {
  const { rows } = await pool.query(`select 1 from blocked_owners where owner_id = $1`, [ownerId]);
  return rows.length > 0;
}

async function listBlocked() {
  const { rows } = await pool.query(
    `select owner_id as "ownerId", blocked_by as "blockedBy", blocked_at as "blockedAt", reason
     from blocked_owners`
  );
  return rows.map((r) => ({ ...r, blockedAt: r.blockedAt.toISOString() }));
}

module.exports = { blockOwner, unblockOwner, isBlocked, listBlocked };
