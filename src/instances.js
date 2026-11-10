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

// Variante pro super admin (ver POST /admin/instances/:id/delegates em
// src/routes/whatsapp.js, atrás de requireSuperAdmin) forçar um
// compartilhamento manual entre duas pessoas quaisquer, sem precisar ser o
// dono da instância nem depender da hierarquia do Bitrix (pedido do usuário
// 2026-10-01 — a árvore de departamentos às vezes está incorreta/
// desatualizada, "se der pra eu escolher qual usuário é o gestor ... seria
// bom"). Mesma tabela instance_delegates de addDelegate() acima — do ponto
// de vista de assertOwnsSession não há diferença entre uma delegação criada
// pelo próprio dono ou forçada pelo admin, ambas aparecem como delegação
// manual de qualquer forma.
async function addDelegateAsAdmin(instanceId, delegateOwnerId, delegateName) {
  const inst = await get(instanceId);
  if (!inst) throw new Error('instância não encontrada');
  if (delegateOwnerId === inst.ownerId) throw new Error('não é possível delegar pro próprio dono');
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

// Variante pro super admin (ver addDelegateAsAdmin acima) revogar um
// compartilhamento sem precisar ser o dono.
async function removeDelegateAsAdmin(instanceId, delegateOwnerId) {
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
// Delegação AUTOMÁTICA por hierarquia do Bitrix (gestor via subordinado só
// por estar acima na árvore, ver hierarchy_subordinates/getSubordinates em
// src/bitrixHierarchy.js) DESATIVADA a pedido do usuário 2026-10-01 — questão
// de privacidade: gestor não deve ver conversa de subordinado sem uma regra
// explícita, e a árvore de departamentos do Bitrix às vezes está incorreta/
// desatualizada. ensureHierarchyCacheFresh()/hierarchy_subordinates NÃO
// foram removidos — ficam calculando em segundo plano (custo baixo, já era
// background) prontos pra quando o usuário definir a regra nova. Delegação
// MANUAL (instance_delegates, "Compartilhar acesso") continua normalmente —
// é decisão consciente de quem é dono da instância, não automática.
async function listAccessible(ownerId) {
  const { rows } = await pool.query(
    `select i.id, i.owner_id as "ownerId", i.label, i.created_at as "createdAt", false as delegated
     from instances i
     where i.owner_id = $1
     union
     select i.id, i.owner_id as "ownerId", i.label, i.created_at as "createdAt", true as delegated
     from instances i
     join instance_delegates d on d.instance_id = i.id
     where d.delegate_owner_id = $1
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
//
// Inclui também instâncias "órfãs" (`session_id` que já trocou mensagem
// real, mas cuja linha em `instances` foi removida depois — ver
// instances.remove(), que nunca apaga conversations/messages de
// propósito, pra não perder histórico de atendimento só por desconectar/
// remover a instância). Achado real, 2026-08-25: a métrica agregada da
// Auditoria (conversationAnalysisStore.computeAggregateMetrics) já
// contava essas órfãs certo (conta por messages.session_id, não por
// instances), mas o dropdown de filtro "Instância" (que só lia esta
// tabela) não deixava escolher especificamente uma delas — usuário
// percebeu o gap (218 em instances vs. 119 aqui) comparando os dois
// números; investigado e confirmado que NÃO é bug de contagem (218
// inclui instância nunca usada; 119 é "tem conversa real", que
// corretamente soma instância ainda cadastrada + órfã) — só o dropdown
// tinha essa lacuna real, corrigida aqui.
//
// Não há como recuperar o dono/label originais de uma órfã (a única
// fonte disso era a própria linha de `instances`, já apagada) — por
// isso usa o próprio `session_id` como identificador e um `ownerId`
// nulo (nunca um valor adivinhado por heurística de string, que
// poderia mostrar um dono errado com confiança falsa).
async function listAll() {
  const { rows } = await pool.query(
    `select id, owner_id as "ownerId", label, created_at as "createdAt", false as "isOrphan"
     from instances
     union all
     select c.session_id as id, null as "ownerId", '(instância removida)' as label,
            min(c.created_at) as "createdAt", true as "isOrphan"
     from conversations c
     where not exists (select 1 from instances i where i.id = c.session_id)
     group by c.session_id
     order by "ownerId", "createdAt" asc`
  );
  return rows;
}

// Todo owner_id distinto já cadastrado (tem ao menos 1 instância) — usado
// pelo broadcast manual do Dapinho (ver src/dapinho.js), pra avisar "todo
// usuário que já usa o gateway" sem depender de uma lista à parte de
// funcionários do Bitrix (que incluiria gente que nunca usou o app).
async function listAllOwnerIds() {
  const { rows } = await pool.query(`select distinct owner_id as "ownerId" from instances`);
  return rows.map((r) => r.ownerId);
}

// Instâncias (não órfãs) pertencentes a qualquer um dos `ownerIds` — base do
// "Compartilhar por departamento" no Admin.
async function listByOwners(ownerIds) {
  if (!ownerIds.length) return [];
  const { rows } = await pool.query(
    `select id, owner_id as "ownerId", label from instances where owner_id = any($1::text[])`,
    [ownerIds]
  );
  return rows;
}

// Concede/revoga `delegateOwnerId` em várias instâncias de uma vez (admin,
// mesma tabela instance_delegates de addDelegateAsAdmin). Pula as instâncias
// do próprio delegado. Idempotente: rodar de novo só inclui o que faltava.
async function addDelegatesBulkAsAdmin(instanceIds, delegateOwnerId, delegateName) {
  if (!instanceIds.length) return 0;
  const { rowCount } = await pool.query(
    `insert into instance_delegates (instance_id, delegate_owner_id, delegate_name)
     select i.id, $2, $3 from instances i
     where i.id = any($1::text[]) and i.owner_id <> $2
     on conflict (instance_id, delegate_owner_id) do update set delegate_name = excluded.delegate_name`,
    [instanceIds, delegateOwnerId, delegateName || null]
  );
  return rowCount;
}

async function removeDelegatesBulkAsAdmin(instanceIds, delegateOwnerId) {
  if (!instanceIds.length) return 0;
  const { rowCount } = await pool.query(
    `delete from instance_delegates where instance_id = any($1::text[]) and delegate_owner_id = $2`,
    [instanceIds, delegateOwnerId]
  );
  return rowCount;
}

module.exports = {
  listByOwners,
  addDelegatesBulkAsAdmin,
  removeDelegatesBulkAsAdmin,
  listByOwner,
  get,
  ensureDefault,
  create,
  rename,
  remove,
  ownerOf,
  listDelegates,
  addDelegate,
  addDelegateAsAdmin,
  removeDelegate,
  removeDelegateAsAdmin,
  listAccessible,
  listAll,
  listAllOwnerIds,
};
