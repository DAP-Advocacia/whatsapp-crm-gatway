const { pool } = require('./db');

/**
 * "Quem está com o app aberto agora" — painel admin (ver src/adminAuth.js).
 * Um upsert por ownerId a cada heartbeat do navegador (POST
 * /presence/heartbeat, ver src/routes/whatsapp.js) — não é histórico, só o
 * estado mais recente. "Online"/"offline" NÃO é calculado aqui: fica pro
 * frontend comparar last_seen_at contra o próprio Date.now() do navegador
 * (evita misturar o relógio do Postgres com o de outro processo — mesmo bug
 * de clock skew já documentado no Painel de atendimento, HANDOFF Parte CI).
 */

async function heartbeat(ownerId, ownerName, page) {
  await pool.query(
    `insert into admin_presence (owner_id, owner_name, last_page, last_seen_at)
     values ($1, $2, $3, now())
     on conflict (owner_id) do update
       set owner_name = coalesce($2, admin_presence.owner_name),
           last_page = $3,
           last_seen_at = now()`,
    [ownerId, ownerName || null, page || null]
  );
}

async function listPresence() {
  const { rows } = await pool.query(
    `select owner_id as "ownerId", owner_name as "ownerName", last_page as "lastPage",
            last_seen_at as "lastSeenAt"
     from admin_presence
     order by last_seen_at desc`
  );
  return rows;
}

module.exports = { heartbeat, listPresence };
