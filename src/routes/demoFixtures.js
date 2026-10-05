/**
 * Serve as fixtures do MODO DEMO (src/demoData.js) nos MESMOS paths das
 * rotas reais, respondendo só quando `req.isDemoMode` (setado por
 * src/demoModeGate.js). Se não estiver em modo demo, `next()` — a
 * request cai pro mount real de sempre, atrás de `requireAuth`, sem
 * nenhuma mudança de comportamento pra quem não usa `?demo=1`.
 *
 * Precisa ficar montado ANTES dos mounts autenticados reais em
 * src/server.js (mesmo padrão já usado pra /api/leads coexistir com
 * /api/lead-forms — uma base de path pública, outra atrás de auth).
 *
 * IMPORTANTE: os paths aqui têm que bater exatamente com os das rotas
 * reais (mesmo prefixo de mount) — ver comentário de cada bloco.
 */

const express = require('express');
const demoData = require('../demoData');

function createDemoFixturesRouter() {
  const router = express.Router();

  const only = (handler) => (req, res, next) => {
    if (!req.isDemoMode) return next();
    handler(req, res);
  };

  // ---------------------------------------------------------------
  // montado em /api/whatsapp (mesmo prefixo de createWhatsappRouter)
  // ---------------------------------------------------------------
  router.get('/api/whatsapp/metrics', only((req, res) => res.json(demoData.dashboardMetrics)));
  router.get('/api/whatsapp/insights', only((req, res) => res.json(demoData.dashboardInsights)));
  router.get('/api/whatsapp/instances', only((req, res) => res.json(demoData.whatsappInstances)));
  router.get('/api/whatsapp/instances/status', only((req, res) => res.json({ hasInstance: true })));
  router.get('/api/whatsapp/instances/:id/delegates', only((req, res) => res.json(demoData.instanceDelegates)));
  // Simula "+ Conectar outro WhatsApp" — devolve um instanceId novo (não
  // persiste nada de verdade, só pra abrir o modal de QR em seguida e
  // testar o fluxo de pareamento/fila localmente, ver qrStatusFor).
  router.post('/api/whatsapp/instances', only((req, res) => {
    const instanceId = 'demo_new_' + Date.now();
    res.json({ instanceId });
  }));
  // Simula o pareamento (fila -> gerando QR -> aguardando scan -> online)
  // com o tempo real decorrido desde a 1ª chamada por essa `session` — ver
  // demoData.qrStatusFor. `?queued=1` simula ter esperado vaga na fila
  // (ver MAX_CONCURRENT_PAIRINGS em sessions.js); as instâncias fixas do
  // demo (INSTANCE_1/INSTANCE_2) sempre respondem 'online' direto, só uma
  // sessão NOVA (criada via o POST acima) passa pela simulação completa.
  router.get('/api/whatsapp/qr', only((req, res) => {
    const session = req.query.session;
    if (session === demoData.INSTANCE_1 || session === demoData.INSTANCE_2 || session === demoData.OWNER_ID) {
      return res.json({ status: 'online', qr: null });
    }
    res.json(demoData.qrStatusFor(session, { queued: req.query.queued === '1' }));
  }));
  router.get('/api/whatsapp/groups', only((req, res) => res.json(demoData.whatsappGroups)));
  router.get('/api/whatsapp/contacts/groups', only((req, res) => res.json({ groups: [] })));
  router.get('/api/whatsapp/campaigns/metrics', only((req, res) => res.json(demoData.campaignMetrics)));
  router.get('/api/whatsapp/status', only((req, res) => res.json({ status: 'online' })));
  router.get('/api/whatsapp/notifications', only((req, res) => res.json(demoData.notificationsList())));
  router.get('/api/whatsapp/notifications/unread-count', only((req, res) => res.json(demoData.notificationsUnreadCount)));
  router.get('/api/whatsapp/notifications/latest-unread', only((req, res) => res.json(demoData.notificationsLatestUnread())));
  router.get('/api/whatsapp/notifications/push-public-key', only((req, res) => res.json(demoData.notificationsPushPublicKey)));

  // ---------------------------------------------------------------
  // montado em /api (createCrmRouter)
  // ---------------------------------------------------------------
  router.get('/api/contacts', only((req, res) => res.json(demoData.contactsList)));
  router.get('/api/contact-lists', only((req, res) => res.json(demoData.contactLists)));
  router.get('/api/contact-lists/:id', only((req, res) => {
    const detail = demoData.contactListDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'lista não encontrada' });
    res.json(detail);
  }));
  router.get('/api/templates', only((req, res) => res.json(demoData.templates)));

  // ---------------------------------------------------------------
  // montado em /api/lead-forms
  // ---------------------------------------------------------------
  router.get('/api/lead-forms/metrics', only((req, res) => res.json(demoData.leadFormsMetrics)));
  router.get('/api/lead-forms/', only((req, res) => res.json({ forms: [], leadsKanbanUrl: null })));

  // ---------------------------------------------------------------
  // montado em /api/suggestions
  // ---------------------------------------------------------------
  router.get('/api/suggestions/', only((req, res) => res.json(demoData.suggestionsList)));
  router.get('/api/suggestions/faq', only((req, res) => res.json(demoData.suggestionsFaq)));

  // ---------------------------------------------------------------
  // montado em /api/agent
  // ---------------------------------------------------------------
  router.get('/api/agent/config', only((req, res) => res.json(demoData.agentConfig(req.query.session || demoData.INSTANCE_1))));
  router.get('/api/agent/knowledge', only((req, res) => res.json(demoData.agentKnowledgeDocs)));
  router.get('/api/agent/examples', only((req, res) => res.json(demoData.agentExamples)));
  router.get('/api/agent/examples/candidates', only((req, res) => res.json({ candidates: [] })));
  router.get('/api/agent/conversations/status', only((req, res) => res.json({ enabled: false })));

  // ---------------------------------------------------------------
  // montado em /api/conversation-analysis
  // ---------------------------------------------------------------
  router.get('/api/conversation-analysis/whoami', only((req, res) => res.json(demoData.conversationAnalysisWhoami)));
  router.get('/api/conversation-analysis/instances', only((req, res) => res.json(demoData.conversationAnalysisInstances)));
  router.get('/api/conversation-analysis/conversations', only((req, res) => {
    const page = Number(req.query.page) || 1;
    const pageSize = Number(req.query.pageSize) || 50;
    res.json(demoData.conversationAnalysisConversations(page, pageSize));
  }));
  router.get('/api/conversation-analysis/conversations/:sessionId/:phone/history', only((req, res) => res.json(demoData.conversationHistory())));
  router.get('/api/conversation-analysis/metrics', only((req, res) => res.json(demoData.conversationAnalysisMetrics)));
  router.post('/api/conversation-analysis/insight', only((req, res) => res.json({
    insights: [{ title: 'Bom volume de conversas recentes', text: 'O filtro atual mostra atividade consistente nas últimas semanas, sem sinais de queda.', tone: 'positive' }],
    sampledConversations: 8,
    totalMatching: demoData.conversationAnalysisConversations().total,
  })));

  return router;
}

module.exports = { createDemoFixturesRouter };
