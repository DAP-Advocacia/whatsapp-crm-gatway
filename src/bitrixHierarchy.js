const { pool } = require('./db');
const { ownerIdFor } = require('./auth');

/**
 * Delegação AUTOMÁTICA de acesso via hierarquia do Bitrix: o gestor de um
 * departamento passa a enxergar (mesmo nível de acesso de um delegado
 * manual, ver instance_delegates) as instâncias de WhatsApp de todo mundo
 * abaixo dele na árvore de departamentos — cascateando sub-departamentos,
 * não só o nível direto.
 *
 * Usa um webhook de entrada DEDICADO (BITRIX_HR_WEBHOOK_URL, escopo
 * "Usuários"/departamentos) — separado do BITRIX_WEBHOOK_URL de CRM já
 * existente (src/bitrix.js), pra poder revogar/trocar um sem afetar o
 * outro. Opcional: sem a variável configurada, a feature fica
 * silenciosamente inativa (mesmo padrão de degradação graciosa já usado
 * em src/bitrix.js).
 */

const BITRIX_HR_WEBHOOK_URL = process.env.BITRIX_HR_WEBHOOK_URL;
const HIERARCHY_CACHE_TTL_MS = (Number(process.env.HIERARCHY_CACHE_TTL_HOURS) || 6) * 60 * 60 * 1000;

async function callBitrixHR(method, params = {}) {
  if (!BITRIX_HR_WEBHOOK_URL) return null;
  const url = `${BITRIX_HR_WEBHOOK_URL.replace(/\/$/, '')}/${method}.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) {
    console.error(`[bitrixHierarchy] erro em ${method}:`, data.error_description || data.error);
    return null;
  }
  return data.result;
}

// Busca TODAS as páginas de um método de listagem do Bitrix (paginado de
// 50 em 50 via `start`) — department.get e user.get podem passar de 50
// linhas numa empresa maior.
async function callBitrixHRAll(method, params = {}) {
  const all = [];
  let start = 0;
  for (;;) {
    const page = await callBitrixHR(method, { ...params, start });
    if (!page) return all.length ? all : null;
    all.push(...page);
    if (page.length < 50) break;
    start += 50;
  }
  return all;
}

// Monta, a partir da lista de departamentos (cada um com ID, PARENT e
// UF_HEAD = gestor), um mapa "departmentId -> gestor(userId)" e um mapa
// "departmentId -> [departmentId filhos diretos]" pra cascatear depois.
function buildDepartmentMaps(departments) {
  const headByDept = new Map();
  const childrenByDept = new Map();
  for (const dept of departments) {
    if (dept.UF_HEAD) headByDept.set(String(dept.ID), String(dept.UF_HEAD));
    const parent = dept.PARENT ? String(dept.PARENT) : null;
    if (parent) {
      if (!childrenByDept.has(parent)) childrenByDept.set(parent, []);
      childrenByDept.get(parent).push(String(dept.ID));
    }
  }
  return { headByDept, childrenByDept };
}

// Todos os IDs de departamento alcançáveis a partir de `deptId`, incluindo
// ele mesmo — é isso que faz a delegação cascatear por sub-departamentos.
function collectDeptSubtree(deptId, childrenByDept) {
  const result = new Set([deptId]);
  const stack = [deptId];
  while (stack.length) {
    const current = stack.pop();
    for (const child of childrenByDept.get(current) || []) {
      if (!result.has(child)) {
        result.add(child);
        stack.push(child);
      }
    }
  }
  return result;
}

// Recalcula a hierarquia inteira do zero e substitui o cache — chamado sob
// demanda (ver getSubordinates) quando o cache está vencido ou vazio, nunca
// em toda request (ver HIERARCHY_CACHE_TTL_MS).
async function refreshHierarchyCache() {
  if (!BITRIX_HR_WEBHOOK_URL) return false;
  const [departments, users] = await Promise.all([
    callBitrixHRAll('department.get'),
    callBitrixHRAll('user.get', { FILTER: { ACTIVE: true } }),
  ]);
  if (!departments || !users) {
    console.error('[bitrixHierarchy] falha ao buscar department.get/user.get — cache não atualizado');
    return false;
  }

  const { headByDept, childrenByDept } = buildDepartmentMaps(departments);

  // membros de cada departamento (um usuário pode estar em mais de um,
  // UF_DEPARTMENT é array no Bitrix)
  const membersByDept = new Map();
  for (const user of users) {
    const deptIds = user.UF_DEPARTMENT || [];
    for (const deptId of deptIds) {
      const key = String(deptId);
      if (!membersByDept.has(key)) membersByDept.set(key, []);
      membersByDept.get(key).push(String(user.ID));
    }
  }

  // manager ownerId -> Set de subordinate ownerIds (dedupe: mesma pessoa
  // pode aparecer via mais de um sub-departamento)
  const subordinatesByManager = new Map();
  for (const [deptId, headUserId] of headByDept) {
    const managerOwnerId = ownerIdFor(headUserId);
    const subtree = collectDeptSubtree(deptId, childrenByDept);
    const subs = subordinatesByManager.get(managerOwnerId) || new Set();
    for (const subDeptId of subtree) {
      for (const memberUserId of membersByDept.get(subDeptId) || []) {
        if (memberUserId === headUserId) continue; // gestor não é subordinado de si mesmo
        subs.add(ownerIdFor(memberUserId));
      }
    }
    if (subs.size) subordinatesByManager.set(managerOwnerId, subs);
  }

  const rows = [];
  for (const [managerOwnerId, subs] of subordinatesByManager) {
    for (const subordinateOwnerId of subs) rows.push([managerOwnerId, subordinateOwnerId]);
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from hierarchy_subordinates');
    if (rows.length) {
      const values = [];
      const placeholders = rows.map(([manager, subordinate], i) => {
        values.push(manager, subordinate);
        return `($${i * 2 + 1}, $${i * 2 + 2})`;
      });
      await client.query(
        `insert into hierarchy_subordinates (manager_owner_id, subordinate_owner_id) values ${placeholders.join(',')}`,
        values
      );
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }

  console.log(`[bitrixHierarchy] cache atualizado: ${subordinatesByManager.size} gestor(es), ${rows.length} vínculo(s) gestor->subordinado`);
  return true;
}

async function isCacheExpired() {
  const { rows } = await pool.query(`select max(refreshed_at) as "refreshedAt" from hierarchy_subordinates`);
  const refreshedAt = rows[0]?.refreshedAt;
  return !refreshedAt || Date.now() - new Date(refreshedAt).getTime() > HIERARCHY_CACHE_TTL_MS;
}

// Dispara o recálculo em segundo plano SE o cache estiver vencido/vazio,
// sem esperar terminar (fire-and-forget) — usado por listAccessible
// (src/instances.js), onde a resposta não pode ficar lenta esperando o
// Bitrix; a request atual usa o cache como está (mesmo que um pouco
// desatualizado), a próxima já vê o resultado atualizado.
function ensureHierarchyCacheFresh() {
  if (!BITRIX_HR_WEBHOOK_URL) return;
  isCacheExpired()
    .then((expired) => {
      if (expired) return refreshHierarchyCache();
    })
    .catch((err) => console.error('[bitrixHierarchy] falha ao verificar/atualizar cache em segundo plano:', err.message));
}

// Devolve os ownerIds de todos os subordinados (diretos + sub-departamentos)
// de `managerOwnerId`, usando o cache — recalcula e ESPERA primeiro se
// estiver vencido/vazio. Usado por assertOwnsSession (src/authz.js), onde
// a decisão de acesso precisa do dado mais atual disponível antes de
// liberar/negar (diferente de ensureHierarchyCacheFresh, que não bloqueia).
async function getSubordinates(managerOwnerId) {
  if (!BITRIX_HR_WEBHOOK_URL) return [];
  if (await isCacheExpired()) {
    try {
      await refreshHierarchyCache();
    } catch (err) {
      console.error('[bitrixHierarchy] falha ao atualizar cache, usando o que houver:', err.message);
    }
  }
  const { rows } = await pool.query(
    `select subordinate_owner_id as "subordinateOwnerId" from hierarchy_subordinates where manager_owner_id = $1`,
    [managerOwnerId]
  );
  return rows.map((r) => r.subordinateOwnerId);
}

// Cadastro de funcionários pro painel admin (src/adminAuth.js) — reusa o
// MESMO webhook/chamada de user.get já usada por refreshHierarchyCache
// acima, só que devolvendo o payload inteiro (nome, cargo, foto, email),
// não só ID/UF_DEPARTMENT. Sem cache próprio (diferente de
// getSubordinates): só o super admin visita a tela que chama isto, volume
// baixo de sobra pra não justificar a complexidade de um cache de horas.
// null = BITRIX_HR_WEBHOOK_URL não configurado ou falha ao consultar —
// quem chama decide como comunicar isso (ver GET /admin/employees).
async function listEmployees() {
  const users = await callBitrixHRAll('user.get', { FILTER: { ACTIVE: true } });
  if (!users) return null;
  return users.map((u) => ({
    id: String(u.ID),
    name: [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || null,
    workPosition: u.WORK_POSITION || null,
    email: u.EMAIL || null,
    photo: u.PERSONAL_PHOTO || null,
    departmentIds: (u.UF_DEPARTMENT || []).map(String),
  }));
}

module.exports = { getSubordinates, ensureHierarchyCacheFresh, refreshHierarchyCache, listEmployees };
