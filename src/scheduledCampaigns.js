const { pool } = require('./db');

/**
 * Campanhas agendadas pra disparo futuro — CRUD usado pela página de
 * Kanban/Calendário (public/campaign-schedule.html) e pelo poller que
 * dispara automaticamente quando chega a hora (ver src/scheduler.js).
 */

// `media.url` (caminho relativo já salvo no Storage via saveMedia, ver
// POST /campaign/schedule) é o formato novo — `media.dataBase64` só existe
// por compatibilidade, se algum caller antigo ainda passar assim.
async function create({ id, sessionId, name, recipients, template, media, scheduledAt }) {
  await pool.query(
    `insert into scheduled_campaigns
       (id, session_id, name, recipients, template, media_type, media_mimetype, media_base64, media_url, scheduled_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      sessionId,
      name || null,
      JSON.stringify(recipients),
      template,
      media?.type || null,
      media?.mimetype || null,
      media?.dataBase64 || null,
      media?.url || null,
      scheduledAt,
    ]
  );
}

// Lista tudo, já com as contagens reais de envio (join com `campaigns`)
// quando o agendamento já virou (ou está virando) um envio de verdade. Cada
// usuário só agenda envios das próprias instâncias de WhatsApp — sem
// sessionIds, mostraria os agendamentos de todo mundo. `sessionIds` é um
// array (1 item, ou vários pra "todas as minhas instâncias").
async function listAll(sessionIds) {
  const hasFilter = Array.isArray(sessionIds) && sessionIds.length > 0;
  const params = hasFilter ? [sessionIds] : [];
  const { rows } = await pool.query(
    `select
       sc.id, sc.session_id as "sessionId", sc.name,
       sc.recipients, sc.media_type as "mediaType",
       sc.scheduled_at as "scheduledAt", sc.status,
       sc.campaign_id as "campaignId", sc.created_at as "createdAt",
       jsonb_array_length(sc.recipients) as "recipientsCount",
       c.sent as "sentCount", c.failed as "failedCount", c.total as "totalCount",
       c.finished_at as "finishedAt"
     from scheduled_campaigns sc
     left join campaigns c on c.id = sc.campaign_id
     ${hasFilter ? 'where sc.session_id = any($1)' : ''}
     order by sc.scheduled_at asc`,
    params
  );
  return rows.map((r) => ({
    ...r,
    scheduledAt: r.scheduledAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  }));
}

async function getById(id) {
  const { rows } = await pool.query(`select * from scheduled_campaigns where id = $1`, [id]);
  return rows[0] || null;
}

async function setStatus(id, status, campaignId) {
  await pool.query(
    `update scheduled_campaigns set status = $1, campaign_id = coalesce($2, campaign_id) where id = $3`,
    [status, campaignId || null, id]
  );
}

async function cancel(id) {
  await pool.query(`update scheduled_campaigns set status = 'canceled' where id = $1 and status = 'scheduled'`, [id]);
}

async function reschedule(id, scheduledAt) {
  await pool.query(
    `update scheduled_campaigns set scheduled_at = $1 where id = $2 and status = 'scheduled'`,
    [scheduledAt, id]
  );
}

// Ids prontos pra disparar agora (chegou a hora e ainda não foi processado).
async function dueForSending() {
  const { rows } = await pool.query(
    `select id from scheduled_campaigns where status = 'scheduled' and scheduled_at <= now() order by scheduled_at asc`
  );
  return rows.map((r) => r.id);
}

module.exports = { create, listAll, getById, setStatus, cancel, reschedule, dueForSending };
