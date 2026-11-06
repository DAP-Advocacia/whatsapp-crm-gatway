const { pool } = require('./db');

/**
 * Alerta de instância caída/desconectada — histórico de queda/retorno
 * (`instance_connection_events`) + série de métricas diárias
 * (`instance_metrics_daily`), ver db/schema.sql.
 *
 * `instance_id` aqui é sempre o `session_id` (mesmo identificador usado em
 * `instances`/`conversations`) — NUNCA uma FK pra `instances`, de propósito:
 * o histórico precisa sobreviver mesmo se a instância for removida depois
 * (mesmo raciocínio já aplicado às 27 instâncias órfãs, ver
 * `instancesStore.listAll()` e HANDOFF Parte ED).
 */

// Fecha qualquer evento aberto esquecido e abre um novo — protege contra
// duplicidade se `handleStatusForHealth` (src/server.js) disparar fora de
// ordem (ex: 2 eventos 'attention' seguidos sem um 'online' no meio).
async function openConnectionEvent(instanceId, kind, reason) {
  await closeOpenConnectionEvent(instanceId);
  const { rows } = await pool.query(
    `insert into instance_connection_events (instance_id, kind, reason)
     values ($1, $2, $3)
     returning id, instance_id as "instanceId", kind, reason,
               started_at as "startedAt", ended_at as "endedAt", duration_ms as "durationMs"`,
    [instanceId, kind, reason || null]
  );
  return rows[0];
}

// Fecha a queda em aberto (se houver) calculando a duração real no próprio
// Postgres (evita depender do relógio do processo Node, que pode ter
// reiniciado entre a abertura e o fechamento do evento).
async function closeOpenConnectionEvent(instanceId) {
  const { rows } = await pool.query(
    `update instance_connection_events
     set ended_at = now(),
         duration_ms = extract(epoch from (now() - started_at)) * 1000
     where instance_id = $1 and ended_at is null
     returning id, instance_id as "instanceId", kind, reason,
               started_at as "startedAt", ended_at as "endedAt", duration_ms as "durationMs"`,
    [instanceId]
  );
  return rows[0] || null;
}

// A queda em aberto AGORA, se houver — alimenta o indicador de duração no
// card (GET /instances já estende cada instância com isto, ver src/routes/whatsapp.js).
async function getOpenConnectionEvent(instanceId) {
  const { rows } = await pool.query(
    `select id, instance_id as "instanceId", kind, reason, started_at as "startedAt"
     from instance_connection_events
     where instance_id = $1 and ended_at is null
     limit 1`,
    [instanceId]
  );
  return rows[0] || null;
}

async function listConnectionEvents(instanceId, limit = 50) {
  const { rows } = await pool.query(
    `select id, instance_id as "instanceId", kind, reason,
            started_at as "startedAt", ended_at as "endedAt", duration_ms as "durationMs"
     from instance_connection_events
     where instance_id = $1
     order by started_at desc
     limit $2`,
    [instanceId, limit]
  );
  return rows;
}

// Todas as janelas de 'attention' ainda ABERTAS, de QUALQUER instância,
// filtrando pelos motivos pedidos — diferente das funções acima (que
// sempre recebem 1 instanceId), esta varre a tabela inteira. Usada por
// src/instanceBanStore.js (categoria "Banida" na aba Instâncias) e pelo
// poller de aviso (src/instanceBanPoller.js) — mesma fonte de dado,
// sem duplicar consulta.
async function listOpenAttentionEvents(reasons) {
  const { rows } = await pool.query(
    `select id, instance_id as "instanceId", reason, started_at as "startedAt"
     from instance_connection_events
     where kind = 'attention' and ended_at is null and reason = any($1::text[])`,
    [reasons]
  );
  return rows;
}

// Agrega, por instância, o tempo TOTAL em 'attention' com os motivos
// pedidos, olhando pra trás `sinceMs` — soma TODAS as janelas que ainda
// estão abertas agora (não importa quando começaram — uma janela única
// nunca reaberta conta sua duração inteira) OU que fecharam dentro
// desse período (`ended_at > now() - sinceMs`, uma janela fechada há
// mais tempo que isso não é mais "recente" o bastante pra somar).
//
// Duas formas reais de "banida" observadas em produção (Parte FQ do
// HANDOFF): (1) 1 janela única aberta há muito tempo, nunca reaberta —
// típico de instância ÓRFÃ, sem ninguém tentando reconectar; (2)
// múltiplas janelas curtas se sobrepondo (o Baileys tenta reconectar
// sozinho e falha de novo com o mesmo motivo, fechando e reabrindo o
// evento repetidamente) — sozinha, cada janela raramente acumula muitas
// horas contínuas, mesmo com a conta banida de verdade há dias. Por
// isso `windowCount` vai junto no retorno — quem decide o critério
// final (src/instanceBanStore.js) usa AMBOS os sinais (tempo total OU
// contagem de janelas), não exige os dois ao mesmo tempo.
async function sumAttentionDuration(reasons, sinceMs) {
  const { rows } = await pool.query(
    `select instance_id as "instanceId",
            count(*)::int as "windowCount",
            sum(coalesce(duration_ms, extract(epoch from (now() - started_at)) * 1000))::bigint as "totalMs"
     from instance_connection_events
     where kind = 'attention' and reason = any($1::text[])
       and (ended_at is null or ended_at > now() - ($2 || ' milliseconds')::interval)
     group by instance_id`,
    [reasons, sinceMs]
  );
  return rows.map((r) => ({ ...r, totalMs: Number(r.totalMs) }));
}

// `on conflict` — idempotente, seguro rodar mais de 1x no mesmo dia (o job
// de snapshot em src/server.js roda a cada hora, só a última chamada do dia
// prevalece).
async function snapshotDailyMetrics(instanceId, { conversationCount, contactCountReal, contactCountBaileys, groupCount }) {
  await pool.query(
    `insert into instance_metrics_daily
       (instance_id, snapshot_date, conversation_count, contact_count_real, contact_count_baileys, group_count)
     values ($1, current_date, $2, $3, $4, $5)
     on conflict (instance_id, snapshot_date) do update set
       conversation_count = excluded.conversation_count,
       contact_count_real = excluded.contact_count_real,
       contact_count_baileys = excluded.contact_count_baileys,
       group_count = excluded.group_count`,
    [instanceId, conversationCount, contactCountReal, contactCountBaileys ?? null, groupCount ?? null]
  );
}

async function listMetricsDaily(instanceId, days = 90) {
  const { rows } = await pool.query(
    `select snapshot_date as "snapshotDate", conversation_count as "conversationCount",
            contact_count_real as "contactCountReal", contact_count_baileys as "contactCountBaileys",
            group_count as "groupCount"
     from instance_metrics_daily
     where instance_id = $1 and snapshot_date >= current_date - $2::int
     order by snapshot_date asc`,
    [instanceId, days]
  );
  return rows.map((r) => ({ ...r, snapshotDate: r.snapshotDate.toISOString().slice(0, 10) }));
}

// Quedas "temporárias" ainda em aberto há mais de `minutes` — o monitor de desconexões
// (src/connectionMonitor.js) decide quais delas viram aviso ao gestor.
async function listOpenTemporaryOlderThan(minutes, limit = 500) {
  const { rows } = await pool.query(
    `select id, instance_id as "instanceId", reason, started_at as "startedAt"
     from instance_connection_events
     where ended_at is null and kind = 'temporary' and started_at <= now() - ($1::int * interval '1 minute')
     order by started_at limit $2`,
    [Math.round(minutes), limit]
  );
  return rows;
}

module.exports = {
  listOpenTemporaryOlderThan,
  openConnectionEvent,
  closeOpenConnectionEvent,
  getOpenConnectionEvent,
  listConnectionEvents,
  listOpenAttentionEvents,
  sumAttentionDuration,
  snapshotDailyMetrics,
  listMetricsDaily,
};
