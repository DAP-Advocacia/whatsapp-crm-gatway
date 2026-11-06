const { pool } = require('./db');

/**
 * Acesso a dados do painel de auditoria (tabelas em db/painel.sql). Se as tabelas ainda
 * não foram criadas (SQL avulso pendente), `tablesMissing(err)` reconhece o erro e as
 * rotas respondem com um aviso em vez de 500 genérico.
 */

function tablesMissing(err) {
  return err?.code === '42P01'; // undefined_table
}

// ---- usuários do painel ----------------------------------------------------

async function getUserByName(username) {
  const { rows } = await pool.query(
    `select id, username, display_name as "displayName", password_hash as "passwordHash", active
     from panel_users where lower(username) = lower($1)`,
    [String(username || '')]
  );
  return rows[0] || null;
}

async function touchLogin(id) {
  await pool.query('update panel_users set last_login_at = now() where id = $1', [id]);
}

async function setPassword(id, passwordHash) {
  await pool.query('update panel_users set password_hash = $2 where id = $1', [id, passwordHash]);
}

async function upsertUser({ username, displayName, passwordHash }) {
  const { rows } = await pool.query(
    `insert into panel_users (username, display_name, password_hash)
     values ($1, $2, $3)
     on conflict (username) do update set password_hash = excluded.password_hash,
       display_name = coalesce(excluded.display_name, panel_users.display_name), active = true
     returning id, username, display_name as "displayName"`,
    [username, displayName || null, passwordHash]
  );
  return rows[0];
}

// ---- configurações ---------------------------------------------------------

const DEFAULT_SETTINGS = {
  monitor_enabled: 'false',
  monitor_enabled_at: '',
  grace_minutes: '30',
  digest_enabled: 'false',
  digest_hour: '9',
};

let settingsCache = null; // { at, map }
async function getSettings({ fresh = false } = {}) {
  if (!fresh && settingsCache && Date.now() - settingsCache.at < 15000) return settingsCache.map;
  let map = { ...DEFAULT_SETTINGS };
  try {
    const { rows } = await pool.query('select key, value from panel_settings');
    for (const r of rows) map[r.key] = r.value;
  } catch (err) {
    if (!tablesMissing(err)) throw err;
  }
  settingsCache = { at: Date.now(), map };
  return map;
}

async function setSetting(key, value, username) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`configuração desconhecida: ${key}`);
  await pool.query(
    `insert into panel_settings (key, value, updated_by) values ($1, $2, $3)
     on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [key, String(value), username || null]
  );
  settingsCache = null;
}

// ---- regras de destinatário ------------------------------------------------

let routesCache = null; // { at, rows }
async function listRoutes({ fresh = false } = {}) {
  if (!fresh && routesCache && Date.now() - routesCache.at < 30000) return routesCache.rows;
  let rows = [];
  try {
    ({ rows } = await pool.query(
      `select id, scope_type as "scopeType", scope_value as "scopeValue", scope_label as "scopeLabel",
              recipient_bitrix_id as "recipientBitrixId", recipient_name as "recipientName", note,
              created_by as "createdBy", created_at as "createdAt"
       from alert_routes order by scope_type, scope_label nulls last, scope_value`
    ));
  } catch (err) {
    if (!tablesMissing(err)) throw err;
  }
  routesCache = { at: Date.now(), rows };
  return rows;
}

async function upsertRoute({ scopeType, scopeValue, scopeLabel, recipientBitrixId, recipientName, note, username }) {
  const { rows } = await pool.query(
    `insert into alert_routes (scope_type, scope_value, scope_label, recipient_bitrix_id, recipient_name, note, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (scope_type, scope_value) do update set scope_label = excluded.scope_label,
       recipient_bitrix_id = excluded.recipient_bitrix_id, recipient_name = excluded.recipient_name,
       note = excluded.note, created_by = excluded.created_by
     returning id`,
    [scopeType, scopeValue, scopeLabel || null, recipientBitrixId, recipientName || null, note || null, username || null]
  );
  routesCache = null;
  return rows[0];
}

async function deleteRoute(id) {
  const { rowCount } = await pool.query('delete from alert_routes where id = $1', [id]);
  routesCache = null;
  return rowCount > 0;
}

// ---- alertas e auditoria ---------------------------------------------------

// Reserva o envio (a chave única impede repetir o mesmo evento pro mesmo destinatário).
// Devolve o id, ou null se já existia.
async function claimAlert(a) {
  const { rows } = await pool.query(
    `insert into monitor_alerts (kind, instance_id, owner_id, person_name, phone, reason, event_at,
        recipient_bitrix_id, recipient_name, route_source, status, detail)
     values ($1, $2, $3, $4, $5, $6, coalesce($7, now()), $8, $9, $10, $11, $12)
     on conflict (kind, instance_id, event_at, recipient_bitrix_id) where kind <> 'manual' do nothing
     returning id`,
    [a.kind, a.instanceId || '', a.ownerId || null, a.personName || null, a.phone || null, a.reason || null,
      a.eventAt || null, a.recipientBitrixId || '', a.recipientName || null, a.routeSource || null,
      a.status, a.detail || null]
  );
  return rows[0]?.id || null;
}

// Já houve aviso deste tipo para esta instância nas últimas `hours` horas?
async function recentAlertExists(instanceId, kind, hours) {
  const { rows } = await pool.query(
    `select 1 from monitor_alerts where instance_id = $1 and kind = $2 and created_at > now() - ($3::int * interval '1 hour') limit 1`,
    [instanceId, kind, hours]
  );
  return rows.length > 0;
}

async function finishAlert(id, status, detail) {
  await pool.query('update monitor_alerts set status = $2, detail = $3 where id = $1', [id, status, detail || null]);
}

async function listAlerts({ limit = 200, kind, status, recipient } = {}) {
  const where = [];
  const params = [];
  if (kind) { params.push(kind); where.push(`kind = $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (recipient) { params.push(recipient); where.push(`recipient_bitrix_id = $${params.length}`); }
  params.push(Math.min(Number(limit) || 200, 2000));
  const { rows } = await pool.query(
    `select id, kind, instance_id as "instanceId", owner_id as "ownerId", person_name as "personName", phone,
            reason, event_at as "eventAt", recipient_bitrix_id as "recipientBitrixId",
            recipient_name as "recipientName", route_source as "routeSource", status, detail,
            created_at as "createdAt"
     from monitor_alerts ${where.length ? 'where ' + where.join(' and ') : ''}
     order by created_at desc limit $${params.length}`,
    params
  );
  return rows;
}

async function logAudit(username, action, detail) {
  try {
    await pool.query('insert into panel_audit (username, action, detail) values ($1, $2, $3)', [username, action, detail || null]);
  } catch (err) {
    console.error('[panel] falha ao gravar auditoria do painel:', err.message);
  }
}

async function listAudit(limit = 200) {
  const { rows } = await pool.query(
    `select id, username, action, detail, created_at as "createdAt" from panel_audit order by created_at desc limit $1`,
    [Math.min(Number(limit) || 200, 1000)]
  );
  return rows;
}

module.exports = {
  tablesMissing, getUserByName, touchLogin, setPassword, upsertUser,
  getSettings, setSetting, DEFAULT_SETTINGS,
  listRoutes, upsertRoute, deleteRoute,
  claimAlert, finishAlert, recentAlertExists, listAlerts, logAudit, listAudit,
};
