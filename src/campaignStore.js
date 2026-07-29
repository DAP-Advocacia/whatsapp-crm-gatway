const { pool } = require('./db');

/**
 * Persistência do histórico de campanhas (ver src/campaigns.js pro estado
 * "ao vivo" em memória, usado só pra polling de progresso). Aqui é o que
 * alimenta o dashboard de métricas (public/campaign-metrics.html).
 */

async function insertCampaign({ id, sessionId, name, total, hasMedia }) {
  await pool.query(
    `insert into campaigns (id, session_id, name, total, has_media) values ($1, $2, $3, $4, $5)`,
    [id, sessionId, name || null, total, !!hasMedia]
  );
}

async function recordResult(campaignId, phone, ok, error) {
  await pool.query(
    `insert into campaign_results (campaign_id, phone, ok, error) values ($1, $2, $3, $4)`,
    [campaignId, phone, ok, error || null]
  );
}

async function updateProgress(campaignId, sent, failed) {
  await pool.query(`update campaigns set sent = $1, failed = $2 where id = $3`, [sent, failed, campaignId]);
}

async function finishCampaign(campaignId) {
  await pool.query(`update campaigns set status = 'done', finished_at = now() where id = $1`, [campaignId]);
}

// Métricas agregadas pro dashboard de campanhas: totais gerais, série diária
// (últimos 30 dias) e a lista das campanhas mais recentes. Cada usuário só
// dispara campanhas com as próprias instâncias de WhatsApp, então isto é
// sempre filtrado — sem `sessionIds`, mostraria as campanhas de todo mundo.
// `sessionIds` é um array (pode ter 1 item, ou vários quando o usuário tem
// múltiplas instâncias e quer ver "todas as minhas").
async function computeCampaignMetrics(sessionIds) {
  const hasFilter = Array.isArray(sessionIds) && sessionIds.length > 0;
  const params = hasFilter ? [sessionIds] : [];
  const sessionFilter = hasFilter ? 'where session_id = any($1)' : '';

  const { rows: totalsRows } = await pool.query(
    `select
       count(*)::int as "totalCampaigns",
       coalesce(sum(sent), 0)::int as "totalSent",
       coalesce(sum(failed), 0)::int as "totalFailed",
       coalesce(sum(total), 0)::int as "totalRecipients"
     from campaigns
     ${sessionFilter}`,
    params
  );

  const { rows: byDay } = await pool.query(
    `select
       to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
       coalesce(sum(sent), 0)::int as sent,
       coalesce(sum(failed), 0)::int as failed
     from campaigns
     where created_at >= now() - interval '30 days'
     ${hasFilter ? 'and session_id = any($1)' : ''}
     group by day
     order by day asc`,
    params
  );

  const { rows: recent } = await pool.query(
    `select
       id, session_id as "sessionId", name, total, sent, failed, status,
       has_media as "hasMedia", created_at as "createdAt", finished_at as "finishedAt"
     from campaigns
     ${sessionFilter}
     order by created_at desc
     limit 25`,
    params
  );

  return {
    totals: totalsRows[0],
    byDay,
    recent: recent.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    })),
  };
}

module.exports = { insertCampaign, recordResult, updateProgress, finishCampaign, computeCampaignMetrics };
