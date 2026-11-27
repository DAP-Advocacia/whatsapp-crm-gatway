const store = require('./store');
const instancesStore = require('./instances');
const bitrixCrm = require('./bitrixCrm');
const { getEmployeeInfo, getResponsibleChain, normalizeBrazilPhone } = require('./bitrixHierarchy');
const { logStatusToTimeline } = require('./bitrix');
const alertDispatcher = require('./alertDispatcher');
const { ownerIdFor } = require('./auth');
const { getOwnNumbersBySession } = require('./ownNumbers');

/**
 * Grupo de WhatsApp automático ao entrar numa etapa específica do Kanban
 * (ex: "Fechado - Contrato assinado") — diferente do grupo automático do
 * Agente de IA (src/agentDispatch.js::createCardGroupForNewLead, que reúne
 * só cliente + dono da instância na etapa de "ganho"). Aqui os
 * participantes são: Responsável do negócio, cliente (campos customizados
 * do negócio), Gerente e Diretor responsáveis pelo Responsável (campos
 * customizados do PERFIL dele — ver bitrixHierarchy::getResponsibleChain,
 * não a árvore de departamentos, que não reflete o organograma comercial
 * real deste portal) e dois números fixos configurados por variável de
 * ambiente: o do escritório (OFFICE_OWNER_PHONE, "Dr. Bruno") e o do
 * setor de Verificação (VERIFICATION_SECTOR_PHONE).
 * Escopo futuro ainda não implementado (pedido do usuário, ATA de reunião
 * "Grupo de WhatsApp integrado ao processo comercial"): financeiro,
 * jurídico, responsável pelo prazo e demais setores envolvidos (CEO NÃO
 * está na ATA — só vendedor/gestor/diretor/financeiro/jurídico/
 * responsável pelo prazo/demais setores/Dr. Bruno).
 *
 * Disparado via POST /api/system/deal-group-trigger (ver
 * src/routes/dealGroupTrigger.js), chamado por um Robô de Automação
 * cadastrado na etapa-alvo do Kanban (não por polling — precisa ser quase
 * instantâneo, decisão confirmada com o usuário). Mesmo padrão de
 * idempotência de createCardGroupForNewLead (getCardGroupForDeal antes de
 * criar), pra sobreviver a um robô disparando mais de uma vez pro mesmo
 * negócio.
 */

const sessionsRef = { current: null };
const broadcastRef = { current: null };

function configure({ sessions, broadcast }) {
  sessionsRef.current = sessions;
  broadcastRef.current = broadcast;
}

// Instância WhatsApp usada para CRIAR o grupo: a do próprio Responsável do
// negócio (decisão confirmada com o usuário — o cliente vê o grupo como
// criado pelo atendente que já fala com ele, não por um número
// administrativo à parte). Usa a mesma convenção de instances.ensureDefault
// (a primeira/única instância de um dono usa o próprio ownerId como
// sessionId) — se o responsável tiver várias instâncias, usa a mais
// antiga (primeira da lista, já ordenada por created_at asc em
// listByOwner).
async function resolveAssignedInstance(assignedOwnerId) {
  const instances = await instancesStore.listByOwner(assignedOwnerId);
  if (instances.length) return instances[0].id;
  return assignedOwnerId; // sem linha em `instances` = usa o próprio ownerId (convenção do projeto)
}

// Resolve nome + telefone de um Bitrix user id, mesmo padrão de
// resolveParticipant em src/routes/cardGroup.js — nunca lança por um
// participante sem celular/HR indisponível, `resolved:false` sinaliza pra
// quem chama decidir o que fazer.
async function resolveEmployee(role, bitrixUserId) {
  if (!bitrixUserId) return { role, bitrixUserId: null, name: null, phone: null, resolved: false };
  const info = await getEmployeeInfo(bitrixUserId).catch((err) => {
    console.error('[deal-group-trigger] falha ao resolver funcionário:', err.message);
    return null;
  });
  const phone = normalizeBrazilPhone(info?.phone);
  return { role, bitrixUserId, name: info?.name || null, phone, resolved: !!phone };
}

// Campos customizados do negócio (nome/telefone "corretos" do cliente,
// cadastrados manualmente pelo time) — prioritários sobre o CONTACT_ID
// vinculado, que na prática vem vazio/desatualizado em vários negócios
// (confirmado testando o negócio 5685627, CONTACT_ID: 0 mas os campos
// customizados existem). UF_CRM_1752095090 é multi-valor no Bitrix
// (isMultiple: true) mesmo guardando um único telefone na prática — usa
// sempre o primeiro item.
const CLIENT_NAME_FIELD = 'UF_CRM_1703254259078';
const CLIENT_PHONE_FIELD = 'UF_CRM_1752095090';

async function resolveClient(deal) {
  const name = deal[CLIENT_NAME_FIELD] ? String(deal[CLIENT_NAME_FIELD]).trim() : null;

  const customPhoneRaw = Array.isArray(deal[CLIENT_PHONE_FIELD]) ? deal[CLIENT_PHONE_FIELD][0] : deal[CLIENT_PHONE_FIELD];
  let phone = normalizeBrazilPhone(customPhoneRaw);

  if (!phone && deal.CONTACT_ID) {
    const rawPhone = await bitrixCrm.getContactPhone(deal.CONTACT_ID).catch((err) => {
      console.error('[deal-group-trigger] falha ao resolver telefone do contato:', err.message);
      return null;
    });
    phone = normalizeBrazilPhone(rawPhone);
  }

  return { role: 'client', contactId: deal.CONTACT_ID || null, name, phone, resolved: !!phone };
}

// Participantes fixos configurados por variável de ambiente (mesmo padrão
// pros dois, ver .env.example) — não dependem de nenhum dado do negócio/
// Bitrix, só de configuração do servidor.
function resolveFixedParticipant(role, name, envVar) {
  const phone = normalizeBrazilPhone(process.env[envVar]);
  return { role, name, phone, resolved: !!phone };
}

/**
 * Ponto de entrada chamado pela rota. `dealId` vem do Robô de Automação do
 * Bitrix. Lança erro (a rota decide o status HTTP) só pra falhas que
 * impedem qualquer progresso (negócio inexistente, instância do
 * responsável offline) — participante individual sem telefone resolvido
 * NUNCA aborta o grupo inteiro (decisão confirmada com o usuário: cria
 * mesmo assim, avisando quem ficou de fora).
 */
async function handleDealStageTrigger(dealId) {
  const deal = await bitrixCrm.getDeal(dealId);
  if (!deal) throw new Error('negócio não encontrado no Bitrix (webhook indisponível ou ID inválido)');

  const assignedById = deal.ASSIGNED_BY_ID || null;
  const assignedOwnerId = assignedById ? ownerIdFor(assignedById) : null;
  if (!assignedOwnerId) throw new Error('negócio sem Responsável (ASSIGNED_BY_ID) — não é possível saber quem é o vendedor do grupo');

  // Instância única que cria TODOS os grupos (DEAL_GROUP_CREATOR_SESSION_ID,
  // pedido do usuário: um número fixo e estável cria o grupo, em vez de
  // depender do WhatsApp do vendedor estar online). Sem a variável, mantém o
  // comportamento antigo (instância do próprio Responsável).
  const creatorSessionId = process.env.DEAL_GROUP_CREATOR_SESSION_ID || null;
  const sessionId = creatorSessionId || (await resolveAssignedInstance(assignedOwnerId));

  // Idempotência: mesmo padrão de createCardGroupForNewLead — se já existe
  // grupo `source='card'` pra este negócio (em QUALQUER instância; o
  // responsável pode ter mudado entre a 1ª e a 2ª chamada do robô), não
  // cria de novo.
  const assignedInstances = await instancesStore.listByOwner(assignedOwnerId);
  const allSessionIds = assignedInstances.map((i) => i.id);
  if (!allSessionIds.includes(sessionId)) allSessionIds.push(sessionId);
  const existingGroup = await store.getCardGroupForDeal(allSessionIds, String(dealId));
  if (existingGroup) return { ok: true, alreadyExisted: true, group: existingGroup };

  // Gerente/Diretor do Responsável via campo customizado do PERFIL dele
  // (não árvore de departamentos — ver comentário no topo do arquivo).
  const chain = await getResponsibleChain(assignedById).catch((err) => {
    console.error('[deal-group-trigger] falha ao resolver Gerente/Diretor responsável:', err.message);
    return { managerUserId: null, directorUserId: null };
  });

  const [assigned, manager, director, client] = await Promise.all([
    resolveEmployee('assigned', assignedById),
    resolveEmployee('manager', chain.managerUserId),
    resolveEmployee('director', chain.directorUserId),
    resolveClient(deal),
  ]);
  const officeOwner = resolveFixedParticipant('office_owner', 'Dr. Bruno', 'OFFICE_OWNER_PHONE');
  const verification = resolveFixedParticipant('verification', 'Verificação', 'VERIFICATION_SECTOR_PHONE');

  const sessions = sessionsRef.current;
  if (!sessions) throw new Error('dealGroupTrigger não configurado (chame configure({sessions, broadcast}) no boot)');

  const participants = [assigned, manager, director, client, officeOwner, verification];

  // Com instância única criadora: também entram os números do vendedor
  // conectados agora (todas as instâncias online dele). O número da própria
  // instância criadora não entra (já é membro/admin por ter criado).
  const creatorPhone = creatorSessionId ? getOwnNumbersBySession()[creatorSessionId] : null;
  if (creatorSessionId) {
    const ownNumbers = getOwnNumbersBySession();
    for (const inst of assignedInstances) {
      if (inst.id === creatorSessionId) continue;
      const phone = ownNumbers[inst.id];
      if (phone && sessions.getActiveGateway(inst.id)?.getStatus() === 'online') {
        participants.push({ role: 'assigned_phone', name: null, phone, resolved: true });
      }
    }
  }

  const resolvedPhones = [...new Set(participants.filter((p) => p.resolved).map((p) => p.phone))].filter((ph) => ph !== creatorPhone);
  const missing = participants.filter((p) => !p.resolved);

  if (!resolvedPhones.length) {
    throw new Error('nenhum participante teve telefone resolvido — grupo não foi criado');
  }

  const gateway = sessions.get(sessionId);
  if (gateway.getStatus() !== 'online') {
    throw new Error(`instância do Responsável (${sessionId}) não está com o WhatsApp conectado no momento`);
  }

  // "{dealId} - {nome do cliente}" (pedido do usuário) — cai pro TITLE do
  // negócio, e por fim pra um rótulo genérico, se o nome do cliente não
  // tiver sido preenchido no campo customizado.
  const groupName = client.name ? `${dealId} - ${client.name}` : deal.TITLE ? String(deal.TITLE).trim() : `Negócio ${dealId}`;
  const group = await gateway.createGroup(groupName, resolvedPhones);

  // Promove os 2 participantes fixos (Dr. Bruno + Verificação) a admin do
  // grupo — quem cria (gateway.createGroup, a instância do Responsável) já
  // nasce admin automaticamente no WhatsApp, só esses dois precisam dessa
  // chamada extra. Best-effort, um de cada vez: falhar em um não impede
  // tentar o outro nem desfaz o grupo já criado (ex: um número pode não
  // ter entrado — ver `missing` abaixo — nesse caso nem faz sentido tentar
  // promover aquele especificamente).
  for (const fixedAdmin of [officeOwner, verification]) {
    if (fixedAdmin.resolved && resolvedPhones.includes(fixedAdmin.phone)) {
      await gateway.promoteParticipant(group.id, fixedAdmin.phone).catch((err) =>
        console.error(`[deal-group-trigger] falha ao promover ${roleLabel(fixedAdmin.role)} a admin:`, err.message)
      );
    }
  }

  await store.createGroupRecord(group.id, sessionId, group.name, group.participantCount, {
    source: 'card',
    dealId: String(dealId),
  });

  const missingLabel = missing.length
    ? missing.map((p) => `${roleLabel(p.role)}${p.name ? ` (${p.name})` : ''}`).join(', ')
    : null;
  const presentLabel = participants
    .filter((p) => p.resolved)
    .map((p) => `${roleLabel(p.role)}${p.name ? ` (${p.name})` : ''}`)
    .join(', ');

  const timelineText = missingLabel
    ? `Grupo automático criado ao atingir a etapa configurada, com: ${presentLabel}. Ainda falta adicionar (sem telefone/WhatsApp cadastrado): ${missingLabel}.`
    : `Grupo automático criado ao atingir a etapa configurada, com: ${presentLabel}.`;
  await logStatusToTimeline(dealId, timelineText).catch((err) =>
    console.error('[deal-group-trigger] falha ao logar timeline:', err.message)
  );

  // Notifica Responsável E Gerente direto (pedido do usuário) — lista quem
  // JÁ está no grupo e quem ainda falta adicionar manualmente, pra quem
  // recebe saber exatamente o que conferir. managerOwnerId só existe se o
  // Gerente responsável tiver sido resolvido (chain.managerUserId
  // presente) — sem isso, notifica só o Responsável mesmo (comportamento
  // anterior, preservado).
  const notifyBody = missingLabel
    ? `Negócio "${deal.TITLE || dealId}": grupo criado com ${presentLabel}. Ainda falta adicionar: ${missingLabel} (sem telefone/WhatsApp cadastrado).`
    : `Negócio "${deal.TITLE || dealId}": grupo criado com todos os participantes (${presentLabel}).`;

  const notifyRecipients = [assignedOwnerId, chain.managerUserId ? ownerIdFor(chain.managerUserId) : null].filter(Boolean);
  if (notifyRecipients.length) {
    await alertDispatcher
      .notifyAttention({
        recipients: notifyRecipients,
        title: 'Grupo de WhatsApp criado automaticamente',
        body: notifyBody,
        target: { sessionId, phone: group.id },
        waSourceSessionId: sessionId,
        sessions,
      })
      .catch((err) => console.error('[deal-group-trigger] falha ao notificar responsável/gestor:', err.message));
  }

  console.log(`[deal-group-trigger] negócio ${dealId} — grupo "${group.name}" criado (${resolvedPhones.length} participante(s), ${missing.length} ausente(s))`);
  return { ok: true, alreadyExisted: false, group, missing: missing.map((p) => ({ role: p.role, name: p.name })) };
}

function roleLabel(role) {
  return {
    assigned: 'Responsável',
    assigned_phone: 'WhatsApp do Responsável',
    manager: 'Gerente',
    director: 'Diretor',
    client: 'Cliente',
    office_owner: 'Dr. Bruno',
    verification: 'Verificação',
  }[role] || role;
}

module.exports = { configure, handleDealStageTrigger };
