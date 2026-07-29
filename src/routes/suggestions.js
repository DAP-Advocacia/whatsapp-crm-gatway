const express = require('express');
const suggestions = require('../suggestions');
const store = require('../store');

const MAX_TEXT_LENGTH = 2000;

/**
 * Sugestões de melhoria (tela `public/suggestions.html`) — montado em
 * /api/suggestions, atrás de requireAuth (ver server.js). Lista é de TIME
 * (todo mundo vê todas), sem checagem de posse por item — igual Análise de
 * Conversas, é uma visão agregada de propósito.
 */
function createSuggestionsRouter() {
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

  // Marca como lançada e notifica quem sugeriu (Central de Notificações já
  // existente, ver store.addNotification) — qualquer usuário autenticado
  // pode marcar; este app não tem hoje um papel de "admin" separado, e a
  // equipe é pequena/confiável o bastante pra isso não ser um problema.
  router.post('/:id/release', async (req, res) => {
    try {
      const released = await suggestions.markReleased(req.params.id);
      if (!released) return res.status(404).json({ error: 'sugestão não encontrada ou já lançada' });
      await store.addNotification({
        ownerId: released.ownerId,
        title: 'Sua sugestão foi implementada!',
        body: released.text,
        target: null,
      });
      res.json(released);
    } catch (err) {
      console.error('[suggestions:release] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSuggestionsRouter };
