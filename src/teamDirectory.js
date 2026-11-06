const { listEmployeesForAudit } = require('./bitrixHierarchy');
const { ownerIdFor, bitrixUserIdFromOwnerId } = require('./auth');
const panelStore = require('./panelStore');

/**
 * Diretório de pessoas/equipes do painel: funcionários ativos do Bitrix (com cache, já que
 * listEmployeesForAudit varre o cadastro inteiro) e a regra de "quem recebe o alerta".
 *
 * Quem recebe, em ordem de prioridade:
 *   1. regra por PESSOA (alert_routes scope_type='person');
 *   2. regra por DEPARTAMENTO de topo (scope_type='department') — é o que resolve "a
 *      vendedora da gerente da equipe da Carol avisa a Carol, não a gerente";
 *   3. gestor do perfil no Bitrix ([GER] RESPONSÁVEL -> [DIR] -> chefe do departamento).
 * Nunca devolve a própria pessoa como destinatária de si mesma: cai pro próximo nível.
 */

const TTL_MS = Number(process.env.TEAM_DIRECTORY_TTL_MS || 10 * 60 * 1000);
let cache = null; // { at, employees, byId }
let loading = null;

async function getEmployees({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache;
  if (loading) return loading;
  loading = (async () => {
    try {
      const employees = await listEmployeesForAudit();
      if (employees === null) return cache || { at: Date.now(), employees: null, byId: new Map() }; // Bitrix de RH indisponível
      cache = { at: Date.now(), employees, byId: new Map(employees.map((e) => [e.id, e])) };
      return cache;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function nameOf(byId, id) {
  return byId.get(String(id))?.name || null;
}

// `person`: { bitrixUserId|id, department, supervisor, director }. `routes`: panelStore.listRoutes().
function resolveRecipient(person, routes, byId) {
  const id = String(person.bitrixUserId || person.id || '');
  const candidates = [];
  const personRule = routes.find((r) => r.scopeType === 'person' && r.scopeValue === id);
  if (personRule) candidates.push({ id: personRule.recipientBitrixId, name: personRule.recipientName, source: 'regra da pessoa' });
  const deptRule = person.department && routes.find((r) => r.scopeType === 'department' && r.scopeValue === person.department);
  if (deptRule) candidates.push({ id: deptRule.recipientBitrixId, name: deptRule.recipientName, source: `regra do departamento ${person.department}` });
  if (person.supervisor?.userId) {
    candidates.push({ id: person.supervisor.userId, name: person.supervisor.name, source: person.supervisor.source || 'gestor do perfil' });
  }
  if (person.director?.userId) candidates.push({ id: person.director.userId, name: person.director.name, source: 'diretor do perfil' });
  for (const c of candidates) {
    if (c.id && String(c.id) !== id) return { bitrixUserId: String(c.id), name: c.name || nameOf(byId, c.id) || `Usuário ${c.id}`, source: c.source };
  }
  return null;
}

// Resolve o destinatário a partir do ownerId da instância (usado pelo monitor).
async function recipientForOwner(ownerId) {
  const bitrixId = bitrixUserIdFromOwnerId(ownerId);
  if (!bitrixId) return { person: null, recipient: null };
  const [dir, routes] = await Promise.all([getEmployees(), panelStore.listRoutes()]);
  const person = dir.byId.get(bitrixId) || null;
  if (!person) return { person: null, recipient: null }; // fora do cadastro ativo do Bitrix: sem gestor a avisar
  return { person, recipient: resolveRecipient(person, routes, dir.byId) };
}

module.exports = { getEmployees, resolveRecipient, recipientForOwner, ownerIdFor };
