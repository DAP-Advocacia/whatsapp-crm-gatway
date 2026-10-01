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
//
// Campos ampliados (2026-08-13, HANDOFF Parte CY) — usuário pediu "todos os
// dados do Bitrix" no modal "Detalhado" do Admin; antes só extraía 6 campos
// de um payload de user.get bem mais rico (confirmado via teste real contra
// o Bitrix, sessão 2026-08-12: XML_ID, PERSONAL_MOBILE, PERSONAL_CITY,
// WORK_PHONE, PERSONAL_BIRTHDAY, LAST_LOGIN, UF_EMPLOYMENT_DATE, entre
// outros). Deliberadamente NÃO inclui campos técnicos sem valor pra exibir
// a um humano (XML_ID, TIMESTAMP_X, UF_USR_* customizados sem label,
// USER_TYPE) nem PERSONAL_GENDER (sensível, não pedido explicitamente).
async function listEmployees() {
  const users = await callBitrixHRAll('user.get', { FILTER: { ACTIVE: true } });
  if (!users) return null;
  return users.map((u) => ({
    id: String(u.ID),
    // SECOND_NAME (nome do meio) fica de fora do nome combinado antes —
    // comum em nome brasileiro, corrigido junto com a ampliação de campos.
    name: [u.NAME, u.SECOND_NAME, u.LAST_NAME].filter(Boolean).join(' ') || null,
    workPosition: u.WORK_POSITION || null,
    email: u.EMAIL || null,
    photo: u.PERSONAL_PHOTO || null,
    departmentIds: (u.UF_DEPARTMENT || []).map(String),
    // "Criado em" na tela de Usuários do Admin (ver HANDOFF Parte CO) —
    // data de registro da conta no próprio Bitrix, não deste app.
    dateRegister: u.DATE_REGISTER || null,
    mobile: u.PERSONAL_MOBILE || null,
    workPhone: u.WORK_PHONE || null,
    city: u.PERSONAL_CITY || null,
    birthday: u.PERSONAL_BIRTHDAY || null,
    // Último login NO PRÓPRIO Bitrix — diferente do último acesso a ESTE
    // app (lastAccess, via page_sessions), que é outra coisa.
    lastLoginBitrix: u.LAST_LOGIN || null,
    // Data de admissão (RH) — diferente de dateRegister (criação da CONTA
    // no Bitrix, que pode ter sido bem depois da contratação de verdade).
    employmentDate: u.UF_EMPLOYMENT_DATE || null,
  }));
}

// Celular de UMA pessoa específica, por ID numérico do Bitrix — sem
// paginar o universo inteiro de funcionários (listEmployees) só pra achar
// uma. Usado pra mandar WhatsApp automático quando uma sugestão é lançada
// (ver POST /suggestions/:id/release, HANDOFF Parte DG). `user.get` aceita
// `ID` direto (fora de FILTER) pra buscar 1 usuário só — mesmo método,
// forma de chamada diferente de listEmployees/callBitrixHRAll.
async function getEmployeePhone(bitrixUserId) {
  const users = await callBitrixHR('user.get', { ID: bitrixUserId });
  if (!users || !users.length) return null;
  return users[0].PERSONAL_MOBILE || null;
}

// Nome + celular + e-mail de UMA pessoa, por ID numérico do Bitrix — usado
// pela feature "Criar grupo" do card (ver src/routes/cardGroup.js), pelo
// grupo automático do Agente de IA (src/agentDispatch.js) e pelo alerta de
// e-mail de instância caída (src/emailAlert.js). `email` foi adicionado
// depois (mudança aditiva, os 2 chamadores anteriores só desestruturam
// .name/.phone e ignoram campos extras — seguro). `null` se o usuário não
// existir/HR indisponível — best-effort, quem chama trata como "não
// resolvido".
//
// Prioridade de telefone WORK_PHONE > PERSONAL_MOBILE (2026-09-15,
// confirmado consultando os 50 usuários ativos do portal: 27 têm
// WORK_PHONE preenchido contra 17 com PERSONAL_MOBILE — o celular
// pessoal é o campo menos usado aqui, ao contrário do que o comentário
// original desta função assumia). Mudança deliberadamente GLOBAL: afeta
// os 3 chamadores já existentes (cardGroup.js, agentDispatch.js,
// emailAlert.js) além do gatilho de grupo por etapa
// (dealGroupTrigger.js) — decisão confirmada com o usuário, mesmo
// problema provavelmente já afetava os 3 fluxos antigos sem terem sido
// notados.
async function getEmployeeInfo(bitrixUserId) {
  const users = await callBitrixHR('user.get', { ID: bitrixUserId });
  if (!users || !users.length) return null;
  const u = users[0];
  return {
    name: [u.NAME, u.SECOND_NAME, u.LAST_NAME].filter(Boolean).join(' ') || null,
    phone: u.WORK_PHONE || u.PERSONAL_MOBILE || null,
    email: u.EMAIL || null,
  };
}

// Campos customizados de PERFIL DE USUÁRIO (não de negócio/CRM) que
// guardam a cadeia de responsabilidade "[GER]/[DIR] RESPONSÁVEL" de cada
// funcionário — usados pelo gatilho de grupo por etapa
// (dealGroupTrigger.js) pra achar o Gerente/Diretor de um Responsável
// específico. Nomes técnicos (UF_USR_*) resolvidos manualmente via
// user.fields em 2026-09-15 (não há como descobrir isso programaticamente
// sem já saber o rótulo em texto a procurar). Existe também um 3º campo,
// "[CEO] RESPONSÁVEL" (UF_USR_1785964093400) — fora do escopo hoje (CEO
// não está na ATA "Grupo de WhatsApp integrado ao processo comercial"),
// não resolvido aqui de propósito; se entrar no escopo depois, é o mesmo
// padrão de manager/director abaixo. Formato do valor: string
// "NOME COMPLETO | ID", não um ID puro nem array — extrai só o `\| (\d+)$`
// final.
const RESPONSIBLE_CHAIN_FIELDS = {
  manager: 'UF_USR_1785964131255', // "[GER] RESPONSÁVEL"
  director: 'UF_USR_1785964110500', // "[DIR] RESPONSÁVEL"
};

function extractUserIdFromChainField(raw) {
  if (!raw) return null;
  const match = String(raw).match(/\|\s*(\d+)\s*$/);
  return match ? match[1] : null;
}

// Gerente/Diretor responsável de UM funcionário, direto do campo
// customizado do PRÓPRIO perfil dele (não da árvore de departamentos,
// que resolve por hierarquia de departamento/UF_HEAD; este aqui é a fonte
// que reflete o organograma comercial real, confirmado com o usuário que
// a árvore de departamentos do Bitrix não mapeia isso de forma
// confiável). Cada chave pode vir `null` se o campo não estiver
// preenchido pra esse funcionário — comum, nem todo mundo tem os 2
// preenchidos.
async function getResponsibleChain(bitrixUserId) {
  const users = await callBitrixHR('user.get', { ID: bitrixUserId });
  if (!users || !users.length) return { managerUserId: null, directorUserId: null };
  const u = users[0];
  return {
    managerUserId: extractUserIdFromChainField(u[RESPONSIBLE_CHAIN_FIELDS.manager]),
    directorUserId: extractUserIdFromChainField(u[RESPONSIBLE_CHAIN_FIELDS.director]),
  };
}

// Celular do Bitrix costuma vir SEM o código do país (DDD + número, 10-11
// dígitos) — mesmo critério já usado em public/admin.html/src/routes/leads.js
// pra telefone de fonte externa: detecta por TAMANHO, nunca por já começar
// com "55" (DDD 55 é Rio Grande do Sul, checar prefixo daria falso
// positivo). Movida de src/routes/suggestions.js pra cá (Parte FC) pra ser
// compartilhada com src/whatsappAlert.js sem duplicar.
function normalizeBrazilPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length <= 11 ? `55${digits}` : digits;
}

module.exports = {
  getSubordinates,
  getResponsibleChain,
  ensureHierarchyCacheFresh,
  refreshHierarchyCache,
  listEmployees,
  getEmployeePhone,
  getEmployeeInfo,
  normalizeBrazilPhone,
};
