const { pool } = require('./db');

/**
 * Campanhas agendadas pra disparo futuro — CRUD usado pela página de
 * Kanban/Calendário (public/campaign-schedule.html) e pelo poller que
 * dispara automaticamente quando chega a hora (ver src/scheduler.js).
 */

// `media.url` (caminho relativo já salvo no Storage via saveMedia, ver
// POST /campaign/schedule) é o formato novo — `media.dataBase64` só existe
// por compatibilidade, se algum caller antigo ainda passar assim.
// `minDelayMs`/`maxDelayMs`: nulo = usa o padrão de sempre na hora de
// disparar (ver sendScheduled, src/scheduler.js) — sempre vêm já validados
// (validateDelayOverride, src/routes/whatsapp.js) antes de chegar aqui.
// `retryOfCampaignId`/`retryAttempt`: só preenchidos quando este agendamento
// é um retry AUTOMÁTICO criado por src/campaigns.js (ver
// scheduleCampaignRetry) após erro 463 — nulo/0 pra agendamento normal
// criado pelo usuário.
// `templates` (lista de transmissão): array com as VERSÕES do texto, que o
// envio alterna na ordem (ver runCampaign, src/campaigns.js). `template`
// continua sendo a 1ª versão (e a única, no agendamento comum). A coluna
// `templates` só entra no insert quando há mais de uma versão — assim um
// agendamento de mensagem única segue funcionando mesmo se o ALTER TABLE
// de db/schema.sql ainda não tiver sido aplicado no banco.
async function create({ id, sessionId, name, recipients, template, templates, media, scheduledAt, minDelayMs, maxDelayMs, retryOfCampaignId, retryAttempt }) {
  const columns = ['id', 'session_id', 'name', 'recipients', 'template', 'media_type', 'media_mimetype', 'media_base64', 'media_url', 'scheduled_at', 'min_delay_ms', 'max_delay_ms', 'retry_of_campaign_id', 'retry_attempt'];
  const values = [
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
    minDelayMs ?? null,
    maxDelayMs ?? null,
    retryOfCampaignId || null,
    retryAttempt || 0,
  ];
  if (Array.isArray(templates) && templates.length > 1) {
    columns.push('templates');
    values.push(JSON.stringify(templates));
  }
  await pool.query(
    `insert into scheduled_campaigns (${columns.join(', ')})
     values (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    values
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
       sc.retry_of_campaign_id as "retryOfCampaignId", sc.retry_attempt as "retryAttempt",
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
