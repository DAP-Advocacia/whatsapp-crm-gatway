const instancesStore = require('./instances');
const instanceBanStore = require('./instanceBanStore');
const { getOwnNumbersBySession } = require('./ownNumbers');
const { getEmployees } = require('./teamDirectory');
const { ownerIdFor, bitrixUserIdFromOwnerId } = require('./auth');

/**
 * Auditoria de números de WhatsApp por colaborador (Admin > aba "Números" e
 * export Excel) — só LEITURA, não inicia nem reconecta nenhuma sessão.
 *
 * Duas fontes, que NÃO são a mesma coisa:
 *  - `phone`: número do próprio WhatsApp lido das credenciais salvas em disco
 *    (getOwnNumbersBySession). Existe pra quem JÁ pareou um dia, mesmo que a
 *    sessão esteja caída hoje.
 *  - status ao vivo: sessions.getActiveGateway() — só olha o que já está em
 *    memória (NUNCA sessions.get(), que cria+inicia a sessão e, chamado em
 *    lote, pareceria login em massa pro WhatsApp). Sem gateway em memória =
 *    'sem_sessao'.
 *
 * Situação da instância: conectado_agora (tem número E status online),
 * ja_conectou_offline (tem número, hoje não está online) ou nunca_conectou
 * (nunca teve número — QR nunca escaneado).
 */

const LIVE_LABEL = {
  online: 'Online',
  offline: 'Offline',
  connecting: 'Conectando',
  queued: 'Na fila',
  sem_sessao: 'Não carregada (dono ainda não abriu o app)',
};

const INSTANCE_SITUATION_LABEL = {
  conectado_agora: 'Conectado agora',
  ja_conectou_offline: 'Já conectou — hoje offline',
  nunca_conectou: 'Nunca conectou',
};

const PERSON_SITUATION_LABEL = {
  ...INSTANCE_SITUATION_LABEL,
  sem_instancia: 'Sem instância',
};

function personSituation(counts) {
  if (counts.online > 0) return 'conectado_agora';
  if (counts.withPhone > 0) return 'ja_conectou_offline';
  if (counts.total > 0) return 'nunca_conectou';
  return 'sem_instancia';
}

async function buildPhoneAudit(sessions, { force = false } = {}) {
  const [allInstances, employees, banned] = await Promise.all([
    instancesStore.listAll(),
    getEmployees({ force }).then((d) => d.employees), // cadastro do Bitrix em cache (ver teamDirectory)
    instanceBanStore.listBannedNow(),
  ]);
  const hrConfigured = employees !== null;
  const ownNumbers = getOwnNumbersBySession();
  const bannedSet = new Set(banned.map((e) => e.instanceId));

  const instances = [];
  const orphanPhones = [];
  const knownIds = new Set();
  for (const i of allInstances) {
    knownIds.add(i.id);
    const phone = ownNumbers[i.id] || null;
    if (i.isOrphan || !i.ownerId) {
      if (phone) orphanPhones.push({ id: i.id, label: i.label, phone, source: 'instância removida', createdAt: i.createdAt });
      continue;
    }
    const gateway = sessions.getActiveGateway(i.id);
    const liveStatus = gateway ? gateway.getStatus() : 'sem_sessao';
    const situation = !phone ? 'nunca_conectou' : liveStatus === 'online' ? 'conectado_agora' : 'ja_conectou_offline';
    instances.push({
      id: i.id,
      ownerId: i.ownerId,
      label: i.label,
      phone,
      situation,
      liveStatus,
      needsAttention: !!gateway?.needsAttention,
      banned: bannedSet.has(i.id),
      lastDisconnectReason: gateway?.lastDisconnectReason || null,
      createdAt: i.createdAt,
    });
  }
  // Credenciais em disco sem nenhuma linha em `instances` (nem nas órfãs).
  for (const [id, phone] of Object.entries(ownNumbers)) {
    if (!knownIds.has(id)) orphanPhones.push({ id, label: '(só em disco)', phone, source: 'só em disco', createdAt: null });
  }

  // Mesmo número em mais de uma instância (mesma pessoa ou pessoas diferentes).
  const instancesByPhone = new Map();
  for (const inst of instances) {
    if (!inst.phone) continue;
    if (!instancesByPhone.has(inst.phone)) instancesByPhone.set(inst.phone, []);
    instancesByPhone.get(inst.phone).push(inst);
  }

  const byOwner = new Map();
  for (const inst of instances) {
    if (!byOwner.has(inst.ownerId)) byOwner.set(inst.ownerId, []);
    byOwner.get(inst.ownerId).push(inst);
  }

  function buildPerson(base, ownerId) {
    const list = byOwner.get(ownerId) || [];
    const counts = {
      total: list.length,
      withPhone: list.filter((i) => i.phone).length,
      online: list.filter((i) => i.situation === 'conectado_agora').length,
      offlineWithPhone: list.filter((i) => i.situation === 'ja_conectou_offline').length,
      never: list.filter((i) => i.situation === 'nunca_conectou').length,
    };
    const uniq = (arr) => [...new Set(arr)];
    return {
      ownerId,
      ...base,
      situation: personSituation(counts),
      ...counts,
      onlinePhones: uniq(list.filter((i) => i.situation === 'conectado_agora').map((i) => i.phone)),
      offlinePhones: uniq(list.filter((i) => i.situation === 'ja_conectou_offline').map((i) => i.phone)),
    };
  }

  const people = [];
  const seenOwners = new Set();
  for (const e of employees || []) {
    const ownerId = ownerIdFor(e.id);
    seenOwners.add(ownerId);
    people.push(buildPerson({
      bitrixUserId: e.id,
      name: e.name,
      department: e.department,
      departmentName: e.departmentName,
      supervisor: e.supervisor,
      director: e.director,
      activeInBitrix: true,
    }, ownerId));
  }
  // Donos de instância que não estão no cadastro ATIVO do Bitrix (saíram da
  // empresa ou foram desativados) — são os números que ficam "sem dono" real.
  for (const ownerId of byOwner.keys()) {
    if (seenOwners.has(ownerId)) continue;
    people.push(buildPerson({
      bitrixUserId: bitrixUserIdFromOwnerId(ownerId),
      name: null,
      department: null,
      departmentName: null,
      supervisor: { name: null, userId: null, source: null },
      director: { name: null, userId: null },
      activeInBitrix: hrConfigured ? false : null,
    }, ownerId));
  }

  const personByOwner = new Map(people.map((p) => [p.ownerId, p]));
  for (const inst of instances) {
    const p = personByOwner.get(inst.ownerId);
    inst.ownerName = p?.name || null;
    inst.bitrixUserId = p?.bitrixUserId || null;
    const same = inst.phone ? instancesByPhone.get(inst.phone) : null;
    inst.repeatedWith = same && same.length > 1
      ? same.filter((o) => o.id !== inst.id).map((o) => `${personByOwner.get(o.ownerId)?.name || o.ownerId} (${o.label})`)
      : [];
  }

  const phones = [...instancesByPhone.keys()];
  const repeatedPhones = phones.filter((ph) => instancesByPhone.get(ph).length > 1);
  const count = (fn) => people.filter(fn).length;
  const sessionsInMemory = sessions.listActive().length;

  const summary = {
    generatedAt: new Date().toISOString(),
    hrConfigured,
    sessionsInMemory,
    people: {
      activeEmployees: (employees || []).length,
      connectedNow: count((p) => p.situation === 'conectado_agora'),
      wasConnectedNowOffline: count((p) => p.situation === 'ja_conectou_offline'),
      neverConnected: count((p) => p.situation === 'nunca_conectou'),
      noInstance: count((p) => p.situation === 'sem_instancia' && p.activeInBitrix !== false),
      ownersNotActiveInBitrix: count((p) => p.activeInBitrix === false),
      ownersNotActiveWithPhone: count((p) => p.activeInBitrix === false && p.withPhone > 0),
    },
    instances: {
      total: instances.length,
      connectedNow: instances.filter((i) => i.situation === 'conectado_agora').length,
      wasConnectedNowOffline: instances.filter((i) => i.situation === 'ja_conectou_offline').length,
      neverConnected: instances.filter((i) => i.situation === 'nunca_conectou').length,
      needsAttention: instances.filter((i) => i.needsAttention).length,
      banned: instances.filter((i) => i.banned).length,
    },
    phones: {
      distinct: phones.length,
      repeated: repeatedPhones.length,
      orphanOrDiskOnly: orphanPhones.length,
    },
  };

  return { summary, people, instances, repeatedPhones, orphanPhones };
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

const FILL = {
  conectado_agora: 'FFC6EFCE',
  ja_conectou_offline: 'FFFFEB9C',
  nunca_conectou: 'FFEDEDED',
  sem_instancia: 'FFF8CBAD',
};

function styleSheet(ws, widths, situationCol, situationKeys) {
  ws.columns.forEach((col, i) => { col.width = widths[i] || 16; });
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F4F4F' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  if (situationCol) {
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const fill = FILL[situationKeys[n - 2]]; // linha 2 = 1º item
      if (fill) row.getCell(situationCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    });
  }
}

// Telefone como TEXTO (senão o Excel mostra 5,52E+12 e perde dígitos).
function phoneCell(v) {
  return v || '';
}

async function buildPhoneAuditWorkbook(audit) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DapZap';
  const { summary: s } = audit;
  const when = new Date(s.generatedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  // --- Resumo
  const ws0 = wb.addWorksheet('Resumo');
  ws0.columns = [{ width: 58 }, { width: 16 }];
  const lines = [
    ['Auditoria de números de WhatsApp — DapZap', ''],
    [`Gerado em ${when}`, ''],
    ['', ''],
    ['PESSOAS', ''],
    ['Colaboradores ativos no Bitrix', s.people.activeEmployees],
    ['Com WhatsApp conectado agora', s.people.connectedNow],
    ['Já conectaram, hoje sem nenhum online', s.people.wasConnectedNowOffline],
    ['Têm instância mas nunca conectaram', s.people.neverConnected],
    ['Sem nenhuma instância', s.people.noInstance],
    ['Donos de instância que NÃO estão ativos no Bitrix', s.people.ownersNotActiveInBitrix],
    ['  desses, com número já pareado', s.people.ownersNotActiveWithPhone],
    ['', ''],
    ['INSTÂNCIAS (exclui removidas)', ''],
    ['Total de instâncias', s.instances.total],
    ['Conectadas agora (número + online)', s.instances.connectedNow],
    ['Já conectaram, hoje offline', s.instances.wasConnectedNowOffline],
    ['Nunca conectaram (sem número)', s.instances.neverConnected],
    ['Precisam de atenção (WhatsApp recusou a conexão)', s.instances.needsAttention],
    ['Banidas', s.instances.banned],
    ['', ''],
    ['NÚMEROS', ''],
    ['Números distintos já pareados', s.phones.distinct],
    ['Números repetidos em mais de uma instância', s.phones.repeated],
    ['Números de instâncias removidas / só em disco', s.phones.orphanOrDiskOnly],
    ['', ''],
    ['COMO LER', ''],
    ['"Conectado agora" = número pareado E sessão online no servidor neste momento.', ''],
    ['"Já conectou — hoje offline" = número pareado, mas a sessão não está online agora.', ''],
    [`Status ao vivo vem das ${s.sessionsInMemory} sessões em memória; as sessões só sobem quando o dono abre o app (boot preguiçoso), então "Já conectou — hoje offline" com status "Não carregada" NÃO significa desconectado: significa que a pessoa ainda não abriu o DapZap desde o último deploy.`, ''],
    ['Supervisor = campo [GER] RESPONSÁVEL do perfil; se vazio, gestor do departamento (ver coluna Origem).', ''],
  ];
  lines.forEach((l) => ws0.addRow(l));
  [1, 4, 13, 21, 26].forEach((r) => { ws0.getRow(r).font = { bold: true }; });
  ws0.getRow(1).font = { bold: true, size: 14 };

  // --- Por pessoa
  const ws1 = wb.addWorksheet('Por pessoa');
  ws1.addRow(['Nome', 'ID Bitrix', 'Setor', 'Departamento', 'Supervisor', 'ID supervisor', 'Origem do supervisor', 'Diretor',
    'Situação', 'Ativo no Bitrix', 'Instâncias', 'Com número', 'Online agora', 'Offline (já conectou)', 'Nunca conectou',
    'Números online agora', 'Números que já conectou (hoje offline)']);
  const order = { conectado_agora: 0, ja_conectou_offline: 1, nunca_conectou: 2, sem_instancia: 3 };
  const sorted = [...audit.people].sort((a, b) =>
    (order[a.situation] - order[b.situation]) || String(a.name || 'zzz').localeCompare(String(b.name || 'zzz'), 'pt-BR'));
  const personKeys = sorted.map((p) => p.situation);
  for (const p of sorted) {
    const row = ws1.addRow([
      p.name || '(fora do cadastro ativo do Bitrix)', p.bitrixUserId || '', p.department || '', p.departmentName || '',
      p.supervisor?.name || '', p.supervisor?.userId || '', p.supervisor?.source || '', p.director?.name || '',
      PERSON_SITUATION_LABEL[p.situation], p.activeInBitrix === false ? 'Não' : p.activeInBitrix ? 'Sim' : '—',
      p.total, p.withPhone, p.online, p.offlineWithPhone, p.never,
      p.onlinePhones.join('; '), p.offlinePhones.join('; '),
    ]);
    row.getCell(16).numFmt = '@';
    row.getCell(17).numFmt = '@';
  }
  styleSheet(ws1, [32, 11, 20, 28, 28, 12, 24, 26, 26, 11, 11, 11, 11, 14, 13, 34, 38], 9, personKeys);

  // --- Instâncias
  const ws2 = wb.addWorksheet('Instâncias');
  ws2.addRow(['Colaborador', 'ID Bitrix', 'Instância', 'Telefone', 'Situação', 'Status ao vivo', 'Precisa de atenção', 'Banida',
    'Último motivo de desconexão', 'Criada em', 'Mesmo número também em']);
  const instOrder = { conectado_agora: 0, ja_conectou_offline: 1, nunca_conectou: 2 };
  const instSorted = [...audit.instances].sort((a, b) =>
    (instOrder[a.situation] - instOrder[b.situation]) || String(a.ownerName || 'zzz').localeCompare(String(b.ownerName || 'zzz'), 'pt-BR'));
  const instKeys = instSorted.map((i) => i.situation);
  for (const i of instSorted) {
    const row = ws2.addRow([
      i.ownerName || '(fora do cadastro ativo do Bitrix)', i.bitrixUserId || '', i.label, phoneCell(i.phone),
      INSTANCE_SITUATION_LABEL[i.situation], LIVE_LABEL[i.liveStatus] || i.liveStatus,
      i.needsAttention ? 'Sim' : '', i.banned ? 'Sim' : '', i.lastDisconnectReason || '',
      i.createdAt ? new Date(i.createdAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '',
      i.repeatedWith.join('; '),
    ]);
    row.getCell(4).numFmt = '@';
  }
  styleSheet(ws2, [32, 11, 30, 16, 26, 20, 12, 9, 28, 12, 50], 5, instKeys);

  // --- Números repetidos
  const ws3 = wb.addWorksheet('Números repetidos');
  ws3.addRow(['Telefone', 'Colaborador', 'ID Bitrix', 'Instância', 'Situação']);
  for (const ph of [...audit.repeatedPhones].sort()) {
    for (const i of audit.instances.filter((x) => x.phone === ph)) {
      const row = ws3.addRow([ph, i.ownerName || '(fora do cadastro ativo do Bitrix)', i.bitrixUserId || '', i.label, INSTANCE_SITUATION_LABEL[i.situation]]);
      row.getCell(1).numFmt = '@';
    }
  }
  styleSheet(ws3, [16, 32, 11, 30, 26]);

  // --- Órfãs / só em disco
  const ws4 = wb.addWorksheet('Removidas e só em disco');
  ws4.addRow(['Telefone', 'Origem', 'Rótulo', 'ID da sessão', 'Criada em']);
  for (const o of audit.orphanPhones) {
    const row = ws4.addRow([o.phone, o.source, o.label, o.id,
      o.createdAt ? new Date(o.createdAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '']);
    row.getCell(1).numFmt = '@';
  }
  styleSheet(ws4, [16, 20, 24, 56, 12]);

  return wb;
}

module.exports = { buildPhoneAudit, buildPhoneAuditWorkbook };
