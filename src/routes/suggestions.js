const express = require('express');
const suggestions = require('../suggestions');
const store = require('../store');
const instancesStore = require('../instances');
const { requireSuperAdmin } = require('../adminAuth');
const { bitrixUserIdFromOwnerId } = require('../auth');
const { getEmployeePhone, normalizeBrazilPhone } = require('../bitrixHierarchy');

const MAX_TEXT_LENGTH = 2000;
const MAX_RESPONSE_LENGTH = 2000;

// Best-effort, chamado dentro de POST /:id/release (usuário pediu, além
// da notificação já existente dentro do app, uma mensagem de WhatsApp de
// verdade pra quem sugeriu — HANDOFF Parte DG). Usa uma instância do
// PRÓPRIO super admin que clicou "lançar" (releaserOwnerId) — quem
// sugeriu não tem instância própria. Nunca lança erro pra fora nem cria
// uma sessão nova só pra isto (sessions.listActive()/getActiveGateway(),
// nunca sessions.get()) — sem celular cadastrado, sem instância PRÓPRIA
// do releaser online agora, ou qualquer outra falha, simplesmente desiste
// em silêncio; a notificação dentro do app já aconteceu de qualquer forma.
async function sendReleaseWhatsAppMessage(released, releaserOwnerId, sessions) {
  try {
    const bitrixUserId = bitrixUserIdFromOwnerId(released.ownerId);
    if (!bitrixUserId) return;
    const rawPhone = await getEmployeePhone(bitrixUserId);
    const phone = normalizeBrazilPhone(rawPhone);
    if (!phone) return;

    const myInstances = await instancesStore.listByOwner(releaserOwnerId);
    if (!myInstances.length) return;
    const myInstanceIds = new Set(myInstances.map((i) => i.id));
    const active = sessions.listActive().filter((s) => myInstanceIds.has(s.sessionId) && s.status === 'online');
    if (!active.length) return;

    const sessionId = active[0].sessionId;
    const gateway = sessions.getActiveGateway(sessionId);
    const text = `🎉 Sua sugestão foi implementada!\n\n"${released.text}"` + (released.response ? `\n\n${released.response}` : '');
    const message = await gateway.sendMessage(phone, text, null);
    await store.addMessage(sessionId, phone, message, null);
  } catch (err) {
    console.error('[suggestions:release] falha ao mandar WhatsApp (best-effort, não afeta a resposta):', err.message);
  }
}

/**
 * Sugestões de melhoria (tela `public/suggestions.html`) — montado em
 * /api/suggestions, atrás de requireAuth (ver server.js). Lista (GET /) e
 * enviar (POST /) continuam abertos a qualquer usuário autenticado — visão
 * de TIME, igual Análise de Conversas. Toda ação de TRIAGEM (mover,
 * responder, marcar lançada) agora exige requireSuperAdmin — antes era
 * aberta a qualquer autenticado (não existia um papel de admin separado);
 * mudou porque a triagem passou a viver dentro do Admin (ver HANDOFF
 * Parte CO).
 */
function createSuggestionsRouter({ sessions }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      res.json({ suggestions: await suggestions.list() });
    } catch (err) {
      console.error('[suggestions] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text é obrigatório' });
    if (text.trim().length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: `texto muito longo (máx. ${MAX_TEXT_LENGTH} caracteres)` });
    }
    try {
      res.json(await suggestions.create(req.ownerId, text.trim()));
    } catch (err) {
      console.error('[suggestions] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // FAQ pública (GET /api/suggestions/faq) — qualquer usuário autenticado
  // (não requireSuperAdmin). Devolve só pergunta+resposta, sem ownerId —
  // ver src/suggestions.js listFaq().
  router.get('/faq', async (req, res) => {
    try {
      res.json({ faq: await suggestions.listFaq() });
    } catch (err) {
      console.error('[suggestions:faq] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Move pra "Em análise" e notifica quem sugeriu (Central de Notificações
  // já existente, ver store.addNotification). Restrito a super admin.
  router.post('/:id/move-to-review', requireSuperAdmin, async (req, res) => {
    try {
      const moved = await suggestions.moveToReview(req.params.id);
      if (!moved) return res.status(404).json({ error: 'sugestão não encontrada ou já não está mais pendente' });
      await store.addNotification({
        ownerId: moved.ownerId,
        title: 'Sua sugestão está sendo analisada',
        body: moved.text,
        target: null,
      });
      res.json(moved);
    } catch (err) {
      console.error('[suggestions:move-to-review] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Responde (a resposta some na FAQ pública, ver GET /faq acima) — não
  // notifica quem perguntou sozinho, a resposta é pública, não privada.
  // Restrito a super admin.
  router.post('/:id/respond', requireSuperAdmin, async (req, res) => {
    const { response } = req.body || {};
    if (response && response.trim().length > MAX_RESPONSE_LENGTH) {
      return res.status(400).json({ error: `resposta muito longa (máx. ${MAX_RESPONSE_LENGTH} caracteres)` });
    }
    try {
      const updated = await suggestions.respond(req.params.id, response ? response.trim() : null);
      if (!updated) return res.status(404).json({ error: 'sugestão não encontrada' });
      res.json(updated);
    } catch (err) {
      console.error('[suggestions:respond] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Marca como lançada e notifica quem sugeriu. Restrito a super admin
  // (antes era aberto a qualquer autenticado — ver comentário no topo).
  router.post('/:id/release', requireSuperAdmin, async (req, res) => {
    try {
      const released = await suggestions.markReleased(req.params.id);
      if (!released) return res.status(404).json({ error: 'sugestão não encontrada ou já lançada' });
      await store.addNotification({
        ownerId: released.ownerId,
        title: 'Sua sugestão foi implementada!',
        body: released.text,
        target: null,
      });
      // Best-effort, não bloqueia a resposta (ver função no topo do
      // arquivo) — mensagem de WhatsApp de verdade, além da notificação
      // dentro do app acima.
      sendReleaseWhatsAppMessage(released, req.ownerId, sessions);
      res.json(released);
    } catch (err) {
      console.error('[suggestions:release] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSuggestionsRouter };
