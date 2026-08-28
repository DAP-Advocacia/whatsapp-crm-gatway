const express = require('express');
const satisfactionSurveys = require('../satisfactionSurveys');

/**
 * Rota PÚBLICA (sem login/Bitrix) que alimenta a página /pesquisa/<slug>
 * (public/satisfaction-form.html) — mesmo padrão de src/routes/leads.js:
 * quem responde nunca autenticou com nada, o `slug` é o único "segredo"
 * de acesso. Montada ANTES do requireAuth global (ver server.js).
 */
function createSatisfactionPublicRouter() {
  const router = express.Router();

  // GET /:slug — devolve as perguntas (nunca as respostas de outra
  // pessoa). `sessionId`/`phone` vêm como query opcional — permitem
  // vincular a resposta a uma conversa específica quando o link foi
  // mandado dentro de uma campanha (ver src/campaigns.js), mas a
  // pesquisa funciona igual sem eles (link genérico, sem vínculo).
  router.get('/:slug', async (req, res) => {
    try {
      const survey = await satisfactionSurveys.getBySlug(req.params.slug);
      if (!survey || survey.audience !== 'client' || !survey.active) {
        return res.status(404).json({ error: 'pesquisa não encontrada' });
      }
      res.json({ title: survey.title, questions: survey.questions });
    } catch (err) {
      console.error('[satisfaction-public:get] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /:slug  { answers, session?, phone? }
  router.post('/:slug', async (req, res) => {
    const { answers, session, phone } = req.body || {};
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'answers é obrigatório' });
    }
    try {
      const survey = await satisfactionSurveys.getBySlug(req.params.slug);
      if (!survey || survey.audience !== 'client' || !survey.active) {
        return res.status(404).json({ error: 'pesquisa não encontrada' });
      }
      const response = await satisfactionSurveys.recordResponse(survey.id, {
        sessionId: session || null,
        phone: phone || null,
        answers,
      }, survey);
      res.json({ ok: true, response });
    } catch (err) {
      console.error('[satisfaction-public:post] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSatisfactionPublicRouter };
