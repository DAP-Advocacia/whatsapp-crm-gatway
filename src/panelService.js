const { buildPhoneAudit } = require('./phoneAudit');
const { getEmployees, resolveRecipient } = require('./teamDirectory');
const panelStore = require('./panelStore');
const alertDispatcher = require('./alertDispatcher');
const { ownerIdFor } = require('./auth');

/**
 * Regras do painel de auditoria: situação de cada pessoa, agrupamento por equipe (a equipe é
 * quem recebe o alerta daquelas pessoas, ver teamDirectory.resolveRecipient), resumo diário
 * para o gestor e disparo manual.
 *
 * Situação da pessoa (o que o painel mostra):
 *   conectado        número pareado e sessão online agora
 *   offline          já conectou, e a sessão está carregada no servidor mas NÃO online (caiu de fato)
 *   nao_verificado   já conectou, mas a sessão não está carregada (boot preguiçoso: a pessoa ainda
 *                    não abriu o DapZap desde o último deploy) — NÃO dá pra afirmar que desconectou
 *   nunca_conectou   tem instância, nunca escaneou o QR
 *   sem_instancia    não criou nenhuma instância
 */

const SITUATION_LABEL = {
  conectado: 'Conectado',
  offline: 'Offline (caiu)',
  nao_verificado: 'Não verificado',
  nunca_conectou: 'Nunca conectou',
  sem_instancia: 'Sem instância',
};

let auditCache = null; // { at, audit }
let auditLoading = null;
async function getAudit(sessions, { force = false } = {}) {
  if (!force && auditCache && Date.now() - auditCache.at < 30000) return auditCache.audit;
  if (auditLoading) return auditLoading;
  auditLoading = buildPhoneAudit(sessions, { force })
    .then((audit) => { auditCache = { at: Date.now(), audit }; return audit; })
    .finally(() => { auditLoading = null; });
  return auditLoading;
}

function classify(person, instances) {
  if (person.situation === 'conectado_agora') return 'conectado';
  if (person.situation === 'sem_instancia') return 'sem_instancia';
  if (person.situation === 'nunca_conectou') return 'nunca_conectou';
  // ja_conectou_offline: separa "caiu de verdade" de "sessão não carregada"
  const paired = instances.filter((i) => i.phone);
  const loaded = paired.some((i) => i.liveStatus === 'offline' || i.liveStatus === 'connecting');
  return loaded ? 'offline' : 'nao_verificado';
}

async function getPeople(sessions, opts = {}) {
  const [audit, dir, routes] = await Promise.all([getAudit(sessions, opts), getEmployees(opts), panelStore.listRoutes({ fresh: !!opts.force })]);
  const instByOwner = new Map();
  for (const i of audit.instances) {
    if (!instByOwner.has(i.ownerId)) instByOwner.set(i.ownerId, []);
    instByOwner.get(i.ownerId).push(i);
  }
  const people = audit.people.map((p) => {
    const instances = instByOwner.get(p.ownerId) || [];
    const recipient = p.activeInBitrix === false ? null : resolveRecipient(p, routes, dir.byId);
    const state = classify(p, instances);
    return {
      ownerId: p.ownerId, bitrixUserId: p.bitrixUserId, name: p.name, department: p.department, departmentName: p.departmentName,
      activeInBitrix: p.activeInBitrix, state, stateLabel: SITUATION_LABEL[state],
      instances: instances.map((i) => ({ id: i.id, label: i.label, phone: i.phone, liveStatus: i.liveStatus, needsAttention: i.needsAttention, banned: i.banned, lastDisconnectReason: i.lastDisconnectReason })),
      phones: [...new Set(instances.filter((i) => i.phone).map((i) => i.phone))],
      onlinePhones: p.onlinePhones, offlinePhones: p.offlinePhones,
      recipient: recipient ? { bitrixUserId: recipient.bitrixUserId, name: recipient.name, source: recipient.source } : null,
    };
  });
  return { audit, people, routes, byId: dir.byId, hrConfigured: audit.summary.hrConfigured };
}

const emptyCounts = () => ({ total: 0, conectado: 0, offline: 0, nao_verificado: 0, nunca_conectou: 0, sem_instancia: 0 });

// Equipes = grupos de pessoas pelo mesmo destinatário. Quem não tem destinatário vai pra "Sem gestor definido".
function buildTeams(people) {
  const teams = new Map();
  for (const p of people) {
    if (p.activeInBitrix === false) continue; // fora do cadastro ativo: não pertence a equipe nenhuma
    const key = p.recipient ? p.recipient.bitrixUserId : '_none';
    if (!teams.has(key)) {
      teams.set(key, { key, managerId: p.recipient?.bitrixUserId || null, managerName: p.recipient?.name || 'Sem gestor definido', counts: emptyCounts(), members: [], departments: new Set() });
    }
    const t = teams.get(key);
    t.counts.total++;
    t.counts[p.state]++;
    t.members.push(p);
    if (p.department) t.departments.add(p.department);
  }
  return [...teams.values()]
    .map((t) => ({ ...t, departments: [...t.departments].sort() }))
    .sort((a, b) => (a.key === '_none') - (b.key === '_none') || b.counts.total - a.counts.total);
}

// ---- resumo para o gestor -------------------------------------------------

const BAD_STATES = ['offline', 'nunca_conectou', 'sem_instancia'];

function digestFor(team) {
  const bad = team.members.filter((m) => BAD_STATES.includes(m.state)).sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'));
  const unverified = team.members.filter((m) => m.state === 'nao_verificado').length;
  if (!bad.length) return null;
  const MAX = 40;
  const lines = bad.slice(0, MAX).map((m) => `• ${m.name || m.bitrixUserId} — ${SITUATION_LABEL[m.state]}`);
  if (bad.length > MAX) lines.push(`… e mais ${bad.length - MAX} pessoa(s)`);
  const body = [
    `Da sua equipe (${team.counts.total} pessoas), ${bad.length} sem DapZap conectado:`,
    ...lines,
    unverified ? `\n${unverified} pessoa(s) já conectaram antes e ainda não abriram o DapZap hoje (status não verificado).` : '',
  ].filter(Boolean).join('\n');
  return { title: `Equipe sem DapZap conectado: ${bad.length} pessoa(s)`, body, badCount: bad.length };
}

async function dispatch({ bitrixIds, title, body, channels, sessions, excludeSessionId }) {
  const recipients = bitrixIds.map((id) => ownerIdFor(id));
  await alertDispatcher.notifyAttention({
    recipients, title, body, channels, sessions, waSourceSessionId: excludeSessionId,
    target: { page: '/instances.html' },
  });
}

// Envia o resumo a cada gestor (ou só aos `onlyManagerIds`). `dryRun`: só devolve o que enviaria.
async function sendDigests(sessions, { onlyManagerIds = null, dryRun = false, channels = null, day, force = false } = {}) {
  const { people } = await getPeople(sessions, { force });
  const teams = buildTeams(people).filter((t) => t.managerId && (!onlyManagerIds || onlyManagerIds.includes(t.managerId)));
  const eventAt = day ? new Date(`${day}T00:00:00-03:00`) : null;
  const out = [];
  for (const t of teams) {
    const d = digestFor(t);
    if (!d) continue;
    if (dryRun) { out.push({ managerId: t.managerId, managerName: t.managerName, ...d, status: 'previa' }); continue; }
    const id = await panelStore.claimAlert({
      kind: 'resumo', instanceId: 'resumo', eventAt, recipientBitrixId: t.managerId, recipientName: t.managerName,
      routeSource: 'equipe', status: 'simulado', detail: `${d.badCount} pessoa(s)`,
    });
    if (!id) { out.push({ managerId: t.managerId, managerName: t.managerName, status: 'ja_enviado' }); continue; }
    try {
      await dispatch({ bitrixIds: [t.managerId], title: d.title, body: d.body, channels, sessions });
      await panelStore.finishAlert(id, 'enviado', `${d.badCount} pessoa(s)`);
      out.push({ managerId: t.managerId, managerName: t.managerName, status: 'enviado', badCount: d.badCount });
    } catch (err) {
      await panelStore.finishAlert(id, 'falhou', err.message);
      out.push({ managerId: t.managerId, managerName: t.managerName, status: 'falhou', error: err.message });
    }
  }
  return out;
}

// ---- disparo manual -------------------------------------------------------

async function sendManual(sessions, { bitrixIds, title, body, channels, username }) {
  const { byId } = await getEmployees();
  const results = [];
  const ids = [...new Set(bitrixIds.map(String))];
  for (let i = 0; i < ids.length; i += 5) {
    await Promise.all(ids.slice(i, i + 5).map(async (id) => {
      const person = byId.get(id);
      try {
        await dispatch({ bitrixIds: [id], title, body, channels, sessions });
        await panelStore.claimAlert({ kind: 'manual', recipientBitrixId: id, recipientName: person?.name || null, routeSource: `painel (${username})`, status: 'enviado', detail: title });
        results.push({ bitrixUserId: id, name: person?.name || null, status: 'enviado' });
      } catch (err) {
        await panelStore.claimAlert({ kind: 'manual', recipientBitrixId: id, recipientName: person?.name || null, routeSource: `painel (${username})`, status: 'falhou', detail: err.message });
        results.push({ bitrixUserId: id, name: person?.name || null, status: 'falhou', error: err.message });
      }
    }));
  }
  return results;
}

module.exports = { getAudit, getPeople, buildTeams, digestFor, sendDigests, sendManual, dispatch, SITUATION_LABEL };
