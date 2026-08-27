const express = require('express');
const store = require('../store');
const insightsStore = require('../insightsStore');
const commercialConfig = require('../commercialConfig');
const { requireSession } = require('../authz');
const { isSuperAdmin } = require('../adminAuth');

/**
 * Copiloto Comercial — insights de IA em tempo real (ver
 * src/insightGenerator.js pra geração, src/commercialConfig.js pra
 * config por instância). Montado em /api/insights, atrás de
 * requireAuth (ver server.js).
 */
function createInsightsRouter({ sessions, broadcast }) {
  const router = express.Router();

  // GET /?session=&phone=
  router.get('/', requireSession((req) => req.query.session), async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      const insights = await insightsStore.listActiveInsights(req.query.session, phone);
      res.json({ insights });
    } catch (err) {
      console.error('[insights] erro ao listar:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Checagem de posse compartilhada pelas 3 rotas abaixo (dismiss,
  // feedback, send) — busca o insight e confirma que ele pertence
  // MESMO à session+phone informados no body, não só que o usuário
  // autenticado é dono de ALGUMA session (requireSession já garante
  // isso, mas sozinho não impede passar um :id de insight de OUTRA
  // instância/conversa do mesmo usuário ou adivinhado por ser
  // sequencial — achado real de revisão de segurança, 2026-08-27:
  // antes só POST /:id/send tinha essa checagem, dismiss/feedback não,
  // permitindo ler/alterar e receber de volta na resposta e no
  // broadcast o conteúdo de um insight alheio). Devolve o insight se
  // a posse bater, ou já escreve a resposta de erro (404/403) e
  // devolve null — quem chama só precisa checar `if (!insight) return`.
  async function loadOwnedInsight(req, res) {
    const { session, phone } = req.body || {};
    const insight = await insightsStore.getInsightWithConversation(req.params.id);
    if (!insight) {
      res.status(404).json({ error: 'insight não encontrado' });
      return null;
    }
    if (insight.sessionId !== session || insight.phone !== phone) {
      res.status(403).json({ error: 'insight não pertence a esta conversa' });
      return null;
    }
    return insight;
  }

  // POST /:id/dismiss  { session, phone }
  router.post('/:id/dismiss', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      const owned = await loadOwnedInsight(req, res);
      if (!owned) return;
      const insight = await insightsStore.setInsightStatus(req.params.id, 'dismissed');
      broadcast(session, phone, { type: 'ai-insight-updated', insight });
      res.json({ ok: true, insight });
    } catch (err) {
      console.error('[insights] erro ao dispensar:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /:id/feedback  { session, phone, feedback: 'useful'|'not_useful' }
  router.post('/:id/feedback', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, feedback } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    if (!['useful', 'not_useful'].includes(feedback)) {
      return res.status(400).json({ error: 'feedback precisa ser "useful" ou "not_useful"' });
    }
    try {
      const owned = await loadOwnedInsight(req, res);
      if (!owned) return;
      const insight = await insightsStore.setInsightFeedback(req.params.id, feedback);
      broadcast(session, phone, { type: 'ai-insight-updated', insight });
      res.json({ ok: true, insight });
    } catch (err) {
      console.error('[insights] erro ao registrar feedback:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /:id/send  { session, phone }
  // Envia o TEXTO do insight como mensagem de WhatsApp de verdade pro
  // cliente da conversa — nunca automático, sempre a partir de um
  // clique explícito do atendente (confirmação já exigida no
  // frontend). Idempotente: um insight já 'sent' não pode ser
  // reenviado por aqui (evita duplicar mensagem em cliques repetidos).
  router.post('/:id/send', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });

    try {
      const insight = await loadOwnedInsight(req, res);
      if (!insight) return;
      if (insight.status === 'sent') {
        return res.status(409).json({ error: 'este insight já foi enviado ao cliente' });
      }

      const gateway = sessions.get(session);
      if (gateway.getStatus() !== 'online') {
        return res.status(409).json({ error: 'Essa sessão não está com o WhatsApp conectado no momento' });
      }

      const message = await gateway.sendMessage(phone, insight.body);
      await store.addMessage(session, phone, message, null);
      broadcast(session, phone, { type: 'message', message });

      const updated = await insightsStore.setInsightStatus(req.params.id, 'sent');
      broadcast(session, phone, { type: 'ai-insight-updated', insight: updated });
      res.json({ ok: true, insight: updated });
    } catch (err) {
      console.error('[insights] erro ao enviar insight:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // GET /commercial-config?session=
  router.get('/commercial-config', requireSession((req) => req.query.session), async (req, res) => {
    try {
      const config = await commercialConfig.get(req.query.session);
      res.json({ config });
    } catch (err) {
      console.error('[insights] erro ao ler config comercial:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // PUT /commercial-config  { session, enabled?, playbook?, topics? }
  router.put('/commercial-config', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, ...patch } = req.body || {};
    // Piloto restrito: só super admin pode LIGAR o Copiloto Comercial
    // numa instância — mesma régua do Agente de IA (ver src/routes/agent.js
    // PUT /config). Editar playbook/tópicos ou desligar continua liberado.
    if (patch.enabled === true && !isSuperAdmin(req.ownerId)) {
      return res.status(403).json({ error: 'ativar o Copiloto Comercial está restrito a administradores no momento' });
    }
    try {
      const config = await commercialConfig.upsert(session, patch);
      res.json({ ok: true, config });
    } catch (err) {
      console.error('[insights] erro ao salvar config comercial:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createInsightsRouter };
