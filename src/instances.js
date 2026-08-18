const { pool } = require('./db');
const { getSubordinates, ensureHierarchyCacheFresh } = require('./bitrixHierarchy');

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

// --- Delegação de acesso (ver db/schema.sql, tabela instance_delegates) ---
// Só o dono de verdade pode conceder/revogar — por isso toda função abaixo
// recebe `ownerId` e confere contra o dono real antes de mexer, mesmo
// padrão de rename/remove acima.

async function listDelegates(instanceId) {
  const { rows } = await pool.query(
    `select delegate_owner_id as "delegateOwnerId", delegate_name as "delegateName", created_at as "createdAt"
     from instance_delegates where instance_id = $1 order by created_at asc`,
    [instanceId]
  );
  return rows;
}

async function addDelegate(instanceId, ownerId, delegateOwnerId, delegateName) {
  const inst = await get(instanceId);
  if (!inst || inst.ownerId !== ownerId) throw new Error('instância não encontrada');
  if (delegateOwnerId === ownerId) throw new Error('não é possível delegar pra si mesmo');
  await pool.query(
    `insert into instance_delegates (instance_id, delegate_owner_id, delegate_name)
     values ($1, $2, $3)
     on conflict (instance_id, delegate_owner_id) do update set delegate_name = excluded.delegate_name`,
    [instanceId, delegateOwnerId, delegateName || null]
  );
}

async function removeDelegate(instanceId, ownerId, delegateOwnerId) {
  const inst = await get(instanceId);
  if (!inst || inst.ownerId !== ownerId) throw new Error('instância não encontrada');
  await pool.query(
    `delete from instance_delegates where instance_id = $1 and delegate_owner_id = $2`,
    [instanceId, delegateOwnerId]
  );
}

// Instâncias que `ownerId` pode acessar: as próprias + as delegadas a ele
// por outro dono. Usado em GET /instances (Chat/Instâncias) — diferente de
// listByOwner (usado só pra contar contra MAX_INSTANCES_PER_OWNER, esse
// limite não vale pra instância delegada nem pra hierárquica).
//
// Terceira fonte (além de própria/delegada manual): hierarquia automática
// via Bitrix (gestor de departamento vê instâncias de todo subordinado,
// cascateando sub-departamentos — ver src/bitrixHierarchy.js). Lê do cache
// já resolvido (rápido, sem chamar o Bitrix nesta request) e dispara um
// refresh em segundo plano se estiver vencido, sem atrasar a resposta.
async function listAccessible(ownerId) {
  ensureHierarchyCacheFresh();
  const { rows } = await pool.query(
    `select i.id, i.owner_id as "ownerId", i.label, i.created_at as "createdAt", false as delegated
     from instances i
     where i.owner_id = $1
     union
     select i.id, i.owner_id as "ownerId", i.label, i.created_at as "createdAt", true as delegated
     from instances i
     join instance_delegates d on d.instance_id = i.id
     where d.delegate_owner_id = $1
     union
     select i.id, i.owner_id as "ownerId", i.label, i.created_at as "createdAt", true as delegated
     from instances i
     join hierarchy_subordinates h on h.subordinate_owner_id = i.owner_id
     where h.manager_owner_id = $1
     order by "createdAt" asc`,
    [ownerId]
  );
  return rows;
}

// Lista TODAS as instâncias do sistema, qualquer dono — SEM filtro de
// propósito, exclusivamente pra Auditoria de Conversas (ver
// src/adminAuth.js, requireConversationAnalysisAccess — só chamada
// atrás desse middleware, nunca exposta sem ele). Diferente de
// listByOwner/listAccessible (ambas SEMPRE ancoradas num ownerId) — aqui
// a ausência de filtro é o requisito da feature, não um esquecimento.
// NÃO CHAMAR fora de uma rota protegida por requireConversationAnalysisAccess.
async function listAll() {
  const { rows } = await pool.query(
    `select id, owner_id as "ownerId", label, created_at as "createdAt"
     from instances order by owner_id, created_at asc`
  );
  return rows;
}

module.exports = {
  listByOwner,
  get,
  ensureDefault,
  create,
  rename,
  remove,
  ownerOf,
  listDelegates,
  addDelegate,
  removeDelegate,
  listAccessible,
  listAll,
};
