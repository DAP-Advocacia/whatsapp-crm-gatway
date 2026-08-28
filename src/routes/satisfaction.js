const express = require('express');
const satisfactionSurveys = require('../satisfactionSurveys');
const { requireSuperAdmin } = require('../adminAuth');

/**
 * Pesquisa de Satisfação — CRUD e métricas (só super admin, ver
 * requireSuperAdmin em todas as rotas abaixo, exceto a de resposta do
 * atendente) + resposta do público "internal" (qualquer usuário
 * autenticado). Montado em /api/satisfaction, atrás de requireAuth (ver
 * server.js). A rota PÚBLICA (público "client", sem login) fica em
 * src/routes/satisfactionPublic.js, router separado, montada ANTES do
 * requireAuth global.
 */
function createSatisfactionRouter() {
  const router = express.Router();

  // GET / — lista todas as pesquisas (visão de admin, cross-owner).
  router.get('/', requireSuperAdmin, async (req, res) => {
    try {
      const surveys = await satisfactionSurveys.listAll();
      res.json({ surveys });
    } catch (err) {
      console.error('[satisfaction] erro ao listar:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /  { audience, title, questions }
  router.post('/', requireSuperAdmin, async (req, res) => {
    try {
      const survey = await satisfactionSurveys.create(req.ownerId, req.body || {});
      res.json({ ok: true, survey });
    } catch (err) {
      console.error('[satisfaction] erro ao criar:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // PUT /:id  { title?, questions?, active? }
  router.put('/:id', requireSuperAdmin, async (req, res) => {
    try {
      const survey = await satisfactionSurveys.update(req.params.id, req.body || {});
      if (!survey) return res.status(404).json({ error: 'pesquisa não encontrada' });
      res.json({ ok: true, survey });
    } catch (err) {
      console.error('[satisfaction] erro ao atualizar:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // DELETE /:id
  router.delete('/:id', requireSuperAdmin, async (req, res) => {
    try {
      await satisfactionSurveys.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('[satisfaction] erro ao remover:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // GET /:id/metrics
  router.get('/:id/metrics', requireSuperAdmin, async (req, res) => {
    try {
      const metrics = await satisfactionSurveys.computeMetrics(req.params.id);
      if (!metrics) return res.status(404).json({ error: 'pesquisa não encontrada' });
      res.json(metrics);
    } catch (err) {
      console.error('[satisfaction] erro ao calcular métricas:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // GET /internal/active — pesquisa "internal" ativa, pro atendente ver
  // o que precisa responder. QUALQUER usuário autenticado (não só super
  // admin) — é ele quem responde.
  router.get('/internal/active', async (req, res) => {
    try {
      const surveys = await satisfactionSurveys.listActiveByAudience('internal');
      res.json({ survey: surveys[0] || null });
    } catch (err) {
      console.error('[satisfaction] erro ao buscar pesquisa interna ativa:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /:id/respond  { answers }
  // Resposta do ATENDENTE (público "internal") — qualquer autenticado,
  // sem requireSuperAdmin. `respondentOwnerId` é sempre req.ownerId
  // (nunca do client), mesmo princípio de author_owner_id em nota
  // interna (src/routes/internalNotes.js).
  router.post('/:id/respond', async (req, res) => {
    try {
      const survey = await satisfactionSurveys.getById(req.params.id);
      if (!survey || survey.audience !== 'internal' || !survey.active) {
        return res.status(404).json({ error: 'pesquisa não encontrada ou não é do tipo interno' });
      }
      const response = await satisfactionSurveys.recordResponse(req.params.id, {
        respondentOwnerId: req.ownerId,
        answers: req.body?.answers,
      }, survey);
      res.json({ ok: true, response });
    } catch (err) {
      console.error('[satisfaction] erro ao registrar resposta interna:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createSatisfactionRouter };
