const { listDepartments } = require('./bitrixHierarchy');
const { getEmployees } = require('./teamDirectory');
const panelStore = require('./panelStore');

/**
 * Escopo de quem abre o painel pelo Bitrix: o que cada pessoa pode ver.
 *
 * Regra: quem CHEFIA (UF_HEAD) um departamento marcado [CEO] ou [DIR] enxerga as pessoas desse
 * departamento e de todos abaixo dele (CEO e DIR são o mesmo nível de acesso: "do meu para baixo").
 * Os [GER] ficam de fora por decisão (começa só por CEO e DIR). Além disso, `panel_access_grants`
 * soma acessos que o Bitrix não expõe (supervisor adjunto/auxiliar) e exceções.
 * Só entra quem está ativo no Bitrix. Sem departamento nenhum => null (sem acesso).
 */

const TOP_RE = /^\s*\[(CEO|DIR)\]/i;
const TTL_MS = 10 * 60 * 1000;
let tree = null; // { at, list, byId, children }
let loading = null;

async function getTree() {
  if (tree && Date.now() - tree.at < TTL_MS) return tree;
  if (loading) return loading;
  loading = (async () => {
    try {
      const list = await listDepartments();
      if (!list) return tree; // Bitrix de RH indisponível: usa o que já tinha (ou nada)
      const children = new Map();
      for (const d of list) if (d.parent) (children.get(d.parent) || children.set(d.parent, []).get(d.parent)).push(d.id);
      tree = { at: Date.now(), list, byId: new Map(list.map((d) => [d.id, d])), children };
      return tree;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function subtree(rootId, children) {
  const out = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) for (const c of children.get(stack.pop()) || []) if (!out.has(c)) { out.add(c); stack.push(c); }
  return out;
}

async function resolveScope(bitrixUserId) {
  const id = String(bitrixUserId || '');
  if (!/^\d{1,12}$/.test(id)) return null;
  const [t, dir, grants] = await Promise.all([getTree(), getEmployees(), panelStore.listGrants()]);
  if (!t || !dir.byId.has(id)) return null; // fora do cadastro ativo
  const roots = new Map(); // deptId -> motivo
  for (const d of t.list) if (d.head === id && TOP_RE.test(d.name)) roots.set(d.id, 'chefe do departamento');
  for (const g of grants) if (g.bitrixUserId === id && t.byId.has(g.departmentId)) roots.set(g.departmentId, g.note || 'concessão');
  if (!roots.size) return null;
  const deptIds = new Set();
  for (const r of roots.keys()) for (const d of subtree(r, t.children)) deptIds.add(d);
  return {
    bitrixUserId: id,
    name: dir.byId.get(id).name,
    roots: [...roots].map(([deptId, via]) => ({ id: deptId, name: t.byId.get(deptId).name, via })),
    deptIds,
  };
}

function filterPeople(people, scope) {
  return people.filter((p) => p.activeInBitrix !== false && (p.departmentIds || []).some((d) => scope.deptIds.has(d)));
}

module.exports = { resolveScope, filterPeople };
