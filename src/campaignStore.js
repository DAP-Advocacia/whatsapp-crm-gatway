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

// Corrige retroativamente um resultado que runCampaign já tinha gravado como
// sucesso (ok:true), na hora do envio — antes de saber que o WhatsApp ia
// rejeitar a entrega DEPOIS, de forma assíncrona (ver messages.update/status
// 'failed' em src/whatsapp.js, WAMessageStatus.ERROR/código 463 "account
// restricted", o caso real mais comum ao mandar campanha pra alguém que
// nunca conversou com este número). Sem isto, "Falharam"/"Taxa de sucesso"
// na tela de Métricas de Campanhas mostrava sempre sucesso, mesmo quando a
// mensagem nunca chegou de verdade — bug real reportado pelo usuário.
//
// Casa pela linha de resultado mais recente daquele phone+campaignId ainda
// marcada ok:true (não há wa_message_id salvo em campaign_results — só
// phone — então é o jeito possível de achar a linha certa sem mudar o
// schema). `for update skip locked` + checagem de rowCount evita corrigir
// duas vezes a mesma linha se o evento de status chegar repetido.
async function markResultFailedAsync(campaignId, phone, errorText) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `select id from campaign_results
       where campaign_id = $1 and phone = $2 and ok = true
       order by created_at desc
       limit 1
       for update skip locked`,
      [campaignId, phone]
    );
    const resultId = rows[0]?.id;
    if (!resultId) {
      await client.query('rollback');
      return false; // já corrigido antes, ou nunca existiu — nada a fazer
    }
    await client.query(
      `update campaign_results set ok = false, error = $1 where id = $2`,
      [errorText || 'rejeitado pelo WhatsApp após o envio (ex: conta restrita)', resultId]
    );
    await client.query(
      `update campaigns set sent = greatest(sent - 1, 0), failed = failed + 1 where id = $1`,
      [campaignId]
    );
    await client.query('commit');
    return true;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
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

module.exports = { insertCampaign, recordResult, updateProgress, finishCampaign, computeCampaignMetrics, markResultFailedAsync };
