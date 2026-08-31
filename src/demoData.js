/**
 * Fixtures do MODO DEMO — dados 100% fictícios, servidos sem tocar
 * Supabase/Postgres nem o Bitrix real. Ver src/demoModeGate.js (como o
 * modo é ativado) e src/routes/demoFixtures.js (quem serve isto).
 *
 * Motivação (2026-08-31, regra global CLAUDE.md): gravar vídeo/screenshot
 * de demonstração a partir de PRODUÇÃO com blur por cima é frágil e vaza
 * PII (tentado nesta sessão, não funcionou — ver HANDOFF). O caminho
 * certo é servir dado fictício de ORIGEM.
 *
 * Todas as datas são calculadas relativas a Date.now() (nunca
 * hardcoded) — o vídeo/demo sempre parece "recente" mesmo regravado
 * meses depois.
 */

const OWNER_ID = 'demo_owner_1';
const INSTANCE_1 = 'demo_instance_1'; // "Comercial SP" — online
const INSTANCE_2 = 'demo_instance_2'; // "Suporte RJ" — offline

const DAY_MS = 24 * 60 * 60 * 1000;
const now = () => Date.now();
const daysAgo = (n) => new Date(now() - n * DAY_MS).toISOString();
const dayKey = (n) => daysAgo(n).slice(0, 10);

// ---------------------------------------------------------------
// Nomes/contatos fictícios plausíveis (BR comuns), reaproveitados em
// várias fixtures pra manter os mesmos "clientes" em todas as telas.
// ---------------------------------------------------------------
const CONTACTS = [
  { id: 1, name: 'Marina Alves', phone: '5521970001001', dealId: '90001' },
  { id: 2, name: 'Ricardo Nunes', phone: '5521970001002', dealId: '90002' },
  { id: 3, name: 'Beatriz Farias', phone: '5521970001003', dealId: '90003' },
  { id: 4, name: 'Gustavo Pires', phone: '5521970001004', dealId: null },
  { id: 5, name: 'Camila Rocha', phone: '5521970001005', dealId: '90005' },
  { id: 6, name: 'Felipe Torres', phone: '5521970001006', dealId: null },
  { id: 7, name: 'Juliana Prado', phone: '5521970001007', dealId: '90007' },
  { id: 8, name: 'André Salles', phone: '5521970001008', dealId: '90008' },
];

// ---------------------------------------------------------------
// 1. Dashboard
// ---------------------------------------------------------------
function buildPerDay(totalDays, avgIn, avgOut) {
  const arr = [];
  for (let i = totalDays - 1; i >= 0; i--) {
    const jitter = () => Math.round((0.6 + Math.random() * 0.8) * 10) / 10;
    arr.push({ day: dayKey(i), in: Math.round(avgIn * jitter()), out: Math.round(avgOut * jitter()) });
  }
  return arr;
}

const dashboardMetrics = {
  totals: { in: 1240, out: 1580, total: 2820, conversas: 87, sessoes: 2 },
  avgResponseMs: 543000,
  avgResponseLabel: '9 min',
  responseRate: 82.4,
  avgMessagesPerConversation: 12.3,
  byType: { text: 2500, image: 210, audio: 90, video: 20 },
  perDay: buildPerDay(30, 41, 52),
  perSession: [
    { sessionId: INSTANCE_1, in: 800, out: 1000, conversas: 50, label: 'Comercial SP' },
    { sessionId: INSTANCE_2, in: 440, out: 580, conversas: 37, label: 'Suporte RJ' },
  ],
  conversations: CONTACTS.filter((c) => c.dealId).map((c, i) => ({
    sessionId: i % 2 === 0 ? INSTANCE_1 : INSTANCE_2,
    phone: c.phone,
    dealId: c.dealId,
    messageCount: 8 + i * 3,
    lastMessageAt: daysAgo(i),
    lastMessageDirection: i % 2 === 0 ? 'in' : 'out',
    lastMessageText: ['Combinado, obrigado!', 'Vou verificar e te retorno', '[image]', 'Pode confirmar o horário?', 'Perfeito, muito obrigado'][i % 5],
    origin: 'externa',
  })),
  trend: {
    current: { total: 940, in: 410, out: 530, conversas: 29, sessoes: 2, responseRate: 82.4, avgMessagesPerConversation: 12.3, avgResponseMs: 543000 },
    prevMonth: { total: 860, in: 380, out: 480, conversas: 26, sessoes: 2, responseRate: 79.1, avgMessagesPerConversation: 11.7, avgResponseMs: 601000 },
    prevYear: { total: 610, in: 260, out: 350, conversas: 19, sessoes: 1, responseRate: 74.0, avgMessagesPerConversation: 10.2, avgResponseMs: 720000 },
  },
  stages: [
    { name: 'Novo contato', count: 9, sort: 10 },
    { name: 'Qualificação', count: 14, sort: 20 },
    { name: 'Negociação', count: 7, sort: 30 },
    { name: 'Fechado', count: 12, sort: 40 },
  ],
};

const dashboardInsights = {
  insights: [
    { title: 'Taxa de resposta saudável', text: 'A taxa de resposta está em 82%, acima da média do período anterior (79%). O time está respondendo consistentemente.', tone: 'positive' },
    { title: 'Pico de mensagens às quartas', text: 'Quartas-feiras concentram quase o dobro do volume médio diário. Considere reforçar a equipe nesse dia.', tone: 'neutral' },
    { title: 'Instância "Suporte RJ" com menos atividade', text: 'Essa instância recebeu 37 conversas no período, bem menos que "Comercial SP" (50). Vale investigar se há algum problema de divulgação do número.', tone: 'warning' },
  ],
  generatedAt: daysAgo(0),
  cached: false,
};

// ---------------------------------------------------------------
// 2. Contatos
// ---------------------------------------------------------------
const contactsList = { contacts: CONTACTS.map(({ id, name, phone, dealId }) => ({ id, name, phone, dealId })) };

const contactLists = {
  lists: [
    { id: 1, name: 'Clientes VIP', count: 3 },
    { id: 2, name: 'Follow-up desta semana', count: 5 },
  ],
};

function contactListDetail(id) {
  const found = contactLists.lists.find((l) => String(l.id) === String(id));
  if (!found) return null;
  return {
    id: found.id,
    name: found.name,
    ownerId: OWNER_ID,
    contacts: CONTACTS.slice(0, found.count).map(({ id: cid, name, phone }) => ({ id: cid, name, phone })),
  };
}

const whatsappGroups = {
  groups: [
    { id: `${INSTANCE_1}-g1`, sessionId: INSTANCE_1, name: 'Clientes — Comercial SP', participantCount: 14, createdAt: daysAgo(40) },
    { id: `${INSTANCE_2}-g1`, sessionId: INSTANCE_2, name: 'Time de Suporte', participantCount: 6, createdAt: daysAgo(90) },
  ],
};

// ---------------------------------------------------------------
// 3. Campanha
// ---------------------------------------------------------------
const templates = {
  templates: [
    { id: 1, name: 'Boas-vindas', body: 'Olá {{nome}}, tudo bem? Obrigado pelo contato! Em breve alguém do nosso time te retorna.' },
    { id: 2, name: 'Lembrete de reunião', body: 'Oi {{nome}}, passando pra confirmar nossa reunião — pode ser no horário combinado?' },
    { id: 3, name: 'Pesquisa de satisfação', body: 'Oi {{nome}}! Como foi sua experiência com a gente? Responda de 0 a 10.' },
  ],
};

// ---------------------------------------------------------------
// 4. Instâncias (também usado pela Campanha)
// ---------------------------------------------------------------
const whatsappInstances = {
  instances: [
    {
      id: INSTANCE_1,
      ownerId: OWNER_ID,
      label: 'Comercial SP',
      createdAt: daysAgo(120),
      delegated: false,
      status: 'online',
      phone: '5521999990001',
      groupCount: 8,
      contactCount: 6,
      needsAttention: false,
      lastDisconnectReason: null,
      openConnectionEvent: null,
      ownerName: null,
    },
    {
      id: INSTANCE_2,
      ownerId: OWNER_ID,
      label: 'Suporte RJ',
      createdAt: daysAgo(200),
      delegated: false,
      status: 'offline',
      phone: '5521999990002',
      groupCount: 3,
      contactCount: 2,
      needsAttention: false,
      lastDisconnectReason: null,
      openConnectionEvent: null,
      ownerName: null,
    },
  ],
  limit: 5,
};

const instanceDelegates = { delegates: [] };

// ---------------------------------------------------------------
// 5. Métricas de campanha
// ---------------------------------------------------------------
const campaignMetrics = {
  totals: { totalCampaigns: 6, totalSent: 480, totalFailed: 9, totalRecipients: 500 },
  byDay: [12, 9, 15].map((sent, i) => ({ day: dayKey(20 - i * 6), sent, failed: i })),
  recent: [
    { id: 1, sessionId: INSTANCE_1, name: 'Promoção de agosto', total: 120, sent: 118, failed: 2, status: 'done', hasMedia: true, createdAt: daysAgo(6), finishedAt: daysAgo(6) },
    { id: 2, sessionId: INSTANCE_1, name: 'Lembrete de renovação', total: 60, sent: 60, failed: 0, status: 'done', hasMedia: false, createdAt: daysAgo(13), finishedAt: daysAgo(13) },
    { id: 3, sessionId: INSTANCE_2, name: null, total: 40, sent: 35, failed: 5, status: 'done', hasMedia: false, createdAt: daysAgo(21), finishedAt: daysAgo(21) },
  ],
};

// ---------------------------------------------------------------
// 6. Métricas de leads / LP
// ---------------------------------------------------------------
const leadFormsMetrics = {
  totals: { totalForms: 2, activeForms: 1, totalViews: 940, totalLeads: 62, totalWhatsappSent: 58 },
  byDay: Array.from({ length: 30 }, (_, i) => {
    const n = 29 - i;
    return { day: dayKey(n), views: 20 + Math.round(Math.random() * 20), leads: Math.round(Math.random() * 4) };
  }),
  forms: [
    { id: 1, name: 'LP Consulta gratuita', slug: 'consulta-gratuita', active: true, viewCount: 720, leadCount: 48, whatsappSentCount: 45 },
    { id: 2, name: 'LP Webinar', slug: 'webinar-agosto', active: false, viewCount: 220, leadCount: 14, whatsappSentCount: 13 },
  ],
};

// ---------------------------------------------------------------
// 7. Sugestões
// ---------------------------------------------------------------
const suggestionsList = {
  suggestions: [
    { id: 1, ownerId: OWNER_ID, text: 'Adicionar filtro por data no histórico de conversas', status: 'pending', createdAt: daysAgo(5), releasedAt: null },
    { id: 2, ownerId: OWNER_ID, text: 'Exportar relatório de campanhas em PDF', status: 'in_review', createdAt: daysAgo(18), releasedAt: null },
  ],
};
const suggestionsFaq = {
  faq: [
    { id: 1, question: 'Como faço pra conectar uma segunda instância?', answer: 'Vá em Instâncias e clique em "+ Nova instância". Você pode conectar até 5 números por conta.', respondedAt: daysAgo(30) },
  ],
};

// ---------------------------------------------------------------
// 8. Agente IA
// ---------------------------------------------------------------
function agentConfig(sessionId) {
  return {
    sessionId,
    active: sessionId === INSTANCE_1,
    systemMessage: sessionId === INSTANCE_1 ? 'Você é um assistente de triagem inicial. Seja cordial e direto, e nunca prometa prazo sem confirmar com um humano.' : null,
    knowledgeText: sessionId === INSTANCE_1 ? 'Horário de atendimento: seg-sex, 9h-18h. Endereço: Av. Paulista, 1000.' : null,
    updatedAt: sessionId === INSTANCE_1 ? daysAgo(10) : null,
  };
}
const agentKnowledgeDocs = { docs: [] };
const agentExamples = { examples: [] };

// ---------------------------------------------------------------
// 9. Análise de conversas
// ---------------------------------------------------------------
function conversationAnalysisConversations(page = 1, pageSize = 50) {
  const all = CONTACTS.map((c, i) => ({
    conversationId: 500 + i,
    sessionId: i % 2 === 0 ? INSTANCE_1 : INSTANCE_2,
    phone: c.phone,
    dealId: c.dealId,
    contactName: c.name,
    assignedTo: OWNER_ID,
    assignedToName: 'Você (demo)',
    updatedAt: daysAgo(i),
    ownerId: OWNER_ID,
    lastText: ['Combinado, obrigado!', 'Vou verificar e te retorno', '[image]', 'Pode confirmar o horário?', 'Perfeito, muito obrigado'][i % 5],
    lastType: i % 5 === 2 ? 'image' : 'text',
    lastDirection: i % 2 === 0 ? 'in' : 'out',
  }));
  return { conversations: all, total: all.length, page, pageSize };
}
const conversationAnalysisMetrics = {
  totals: { total: 2820, totalIn: 1240, totalOut: 1580, conversas: 87, instancias: 2 },
  perDay: buildPerDay(30, 41, 52).map(({ day, in: i, out }) => ({ day, count: i + out })),
};
const conversationAnalysisInstances = {
  instances: [
    { id: INSTANCE_1, ownerId: OWNER_ID, label: 'Comercial SP', createdAt: daysAgo(120), isOrphan: false, ownerName: 'Você (demo)' },
    { id: INSTANCE_2, ownerId: OWNER_ID, label: 'Suporte RJ', createdAt: daysAgo(200), isOrphan: false, ownerName: 'Você (demo)' },
  ],
};
const conversationAnalysisWhoami = { hasAccess: true };

function conversationHistory() {
  return {
    messages: [
      { id: 'demo-1', direction: 'in', type: 'text', text: 'Oi, tudo bem? Vi o anúncio de vocês e queria saber mais', mediaUrl: null, mimetype: null, status: 'read', reaction: null, reactionBy: null, replyToId: null, fileName: null, sentBy: null, sentByName: null, groupSenderPhone: null, groupSenderName: null, createdAt: daysAgo(3) },
      { id: 'demo-2', direction: 'out', type: 'text', text: 'Olá! Tudo ótimo, obrigado por entrar em contato. Posso te ajudar com mais informações agora mesmo.', mediaUrl: null, mimetype: null, status: 'read', reaction: null, reactionBy: null, replyToId: null, fileName: null, sentBy: OWNER_ID, sentByName: 'Você (demo)', groupSenderPhone: null, groupSenderName: null, createdAt: daysAgo(3) },
      { id: 'demo-3', direction: 'in', type: 'text', text: 'Perfeito, muito obrigado!', mediaUrl: null, mimetype: null, status: 'read', reaction: null, reactionBy: null, replyToId: null, fileName: null, sentBy: null, sentByName: null, groupSenderPhone: null, groupSenderName: null, createdAt: daysAgo(3) },
    ],
  };
}

// ---------------------------------------------------------------
// 10. Configurações
// ---------------------------------------------------------------
const settings = { accentColor: null, accentColorDim: null, greenColor: null, redColor: null, bgColor: null };

// ---------------------------------------------------------------
// 11. Notificações
// ---------------------------------------------------------------
function notificationsList() {
  return {
    notifications: CONTACTS.slice(0, 5).map((c, i) => ({
      id: `demo-notif-${i}`,
      title: `Nova mensagem de ${c.name}`,
      body: ['Combinado, obrigado!', 'Vou verificar e te retorno', 'Pode confirmar o horário?', 'Perfeito, muito obrigado', 'Oi, tudo bem?'][i],
      target: { sessionId: i % 2 === 0 ? INSTANCE_1 : INSTANCE_2, phone: c.phone },
      read: i > 1,
      createdAt: daysAgo(i),
    })),
  };
}
function notificationsLatestUnread() {
  const { notifications } = notificationsList();
  return { notifications: notifications.filter((n) => !n.read).map(({ read, ...rest }) => rest) };
}
const notificationsUnreadCount = { count: 2 };
const notificationsPushPublicKey = { publicKey: null };

module.exports = {
  OWNER_ID,
  INSTANCE_1,
  INSTANCE_2,
  dashboardMetrics,
  dashboardInsights,
  contactsList,
  contactLists,
  contactListDetail,
  whatsappGroups,
  templates,
  whatsappInstances,
  instanceDelegates,
  campaignMetrics,
  leadFormsMetrics,
  suggestionsList,
  suggestionsFaq,
  agentConfig,
  agentKnowledgeDocs,
  agentExamples,
  conversationAnalysisConversations,
  conversationAnalysisMetrics,
  conversationAnalysisInstances,
  conversationAnalysisWhoami,
  conversationHistory,
  settings,
  notificationsList,
  notificationsLatestUnread,
  notificationsUnreadCount,
  notificationsPushPublicKey,
};
