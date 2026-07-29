const { pool } = require('./db');

/**
 * Registro de instâncias de WhatsApp por "dono" (owner_id = member_id + id
 * do usuário no Bitrix, o mesmo valor que já usávamos como session_id antes
 * desta tabela existir). Um dono pode ter várias instâncias; o `id` de cada
 * uma continua sendo o `session_id` usado em todo o resto do app.
 */

async function listByOwner(ownerId) {
  const { rows } = await pool.query(
    `select id, owner_id as "ownerId", label, created_at as "createdAt"
     from instances where owner_id = $1 order by created_at asc`,
    [ownerId]
  );
  return rows;
}

async function get(id) {
  const { rows } = await pool.query(`select id, owner_id as "ownerId", label from instances where id = $1`, [id]);
  return rows[0] || null;
}

// Garante que o dono sempre tenha ao menos uma instância. A primeira usa o
// próprio ownerId como id — assim quem já usava o app antes desta feature
// não perde nada (session_id já gravado nas outras tabelas bate certinho).
async function ensureDefault(ownerId) {
  const existing = await listByOwner(ownerId);
  if (existing.length) return existing;
  await pool.query(
    `insert into instances (id, owner_id, label) values ($1, $2, $3) on conflict (id) do nothing`,
    [ownerId, ownerId, 'Principal']
  );
  return listByOwner(ownerId);
}

async function create(ownerId, label) {
  const id = `${ownerId}__${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await pool.query(`insert into instances (id, owner_id, label) values ($1, $2, $3)`, [id, ownerId, label]);
  return id;
}

async function rename(id, ownerId, label) {
  await pool.query(`update instances set label = $1 where id = $2 and owner_id = $3`, [label, id, ownerId]);
}

async function remove(id, ownerId) {
  await pool.query(`delete from instances where id = $1 and owner_id = $2`, [id, ownerId]);
}

// Resolve o dono de uma sessão (mesmo fallback que assertOwnsSession usa em
// src/authz.js: sem linha em `instances` significa que o próprio id JÁ é o
// ownerId, caso do dono com uma instância só / de antes desta tabela existir).
async function ownerOf(sessionId) {
  const inst = await get(sessionId);
  return inst ? inst.ownerId : sessionId;
}

module.exports = { listByOwner, get, ensureDefault, create, rename, remove, ownerOf };
