const { pool } = require('./db');

/**
 * Persistência de `deal_stage_watch` — última etapa vista de cada
 * negócio vinculado a uma conversa. Usado por src/dealStagePoller.js
 * pra saber se um negócio MUDOU de etapa desde a última varredura (sem
 * isso, o poller disparia o grupo automático de novo a cada tick).
 */

async function getLastSeenStage(dealId) {
  const { rows } = await pool.query(
    `select last_seen_stage_id as "lastSeenStageId" from deal_stage_watch where deal_id = $1`,
    [dealId]
  );
  return rows[0]?.lastSeenStageId ?? null; // undefined explícito seria "nunca visto" — null aqui só cobre a coluna nullable
}

// Upsert simples — grava a etapa atual como a "última vista". Chamado
// tanto na primeira observação (baseline, sem disparo) quanto depois de
// qualquer mudança de etapa processada (com ou sem disparo de grupo).
async function touchStage(dealId, stageId) {
  await pool.query(
    `insert into deal_stage_watch (deal_id, last_seen_stage_id, checked_at)
     values ($1, $2, now())
     on conflict (deal_id) do update set
       last_seen_stage_id = $2,
       checked_at = now()`,
    [dealId, stageId]
  );
}

// Distingue "negócio nunca visto pelo poller" (linha não existe ainda)
// de "negócio visto, mas com valor nulo" (não deveria acontecer na
// prática, mas devolve false por segurança — nunca trata ausência de
// dado como "já visto").
async function hasBeenSeen(dealId) {
  const { rows } = await pool.query(
    `select 1 from deal_stage_watch where deal_id = $1`,
    [dealId]
  );
  return rows.length > 0;
}

module.exports = { getLastSeenStage, touchStage, hasBeenSeen };
