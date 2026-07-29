const express = require('express');
const abTests = require('../abTests');
const { suggestAbTestAnalysis } = require('../openai');

/**
 * CRUD dos testes A/B entre LPs (public/sites.html, seção "Testes A/B") —
 * escopado por req.ownerId, igual lead-forms. Montado em /api/ab-tests,
 * atrás de requireAuth (ver server.js). A rota PÚBLICA que divide o
 * tráfego é GET /t/:slug, no server.js (não aqui).
 */
function createAbTestsRouter() {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      res.json({ tests: await abTests.listByOwner(req.ownerId) });
    } catch (err) {
      console.error('[ab-tests] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Histórico estruturado dos testes encerrados — base de aprendizados
  // (futuro system prompt de IA geradora de LPs). Declarada antes de
  // qualquer rota /:id por clareza (não colide, mas evita surpresa).
  router.get('/history', async (req, res) => {
    try {
      res.json({ history: await abTests.history(req.ownerId) });
    } catch (err) {
      console.error('[ab-tests:history] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/', async (req, res) => {
    const { name, formAId, formBId } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'dê um nome ao teste' });
    if (!formAId || !formBId) return res.status(400).json({ error: 'escolha as duas LPs do teste' });
    try {
      const test = await abTests.create(req.ownerId, { name: name.trim(), formAId, formBId });
      res.json(test);
    } catch (err) {
      console.error('[ab-tests] erro ao criar:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // Encerra o teste: `winner` = 'a' | 'b' | null (sem vencedor claro);
  // `analysis` é obrigatória — é o aprendizado que fica pro histórico.
  router.post('/:id/finish', async (req, res) => {
    const { winner, analysis } = req.body || {};
    if (!analysis || !analysis.trim()) {
      return res.status(400).json({ error: 'escreva a análise/aprendizados — é o que dá valor ao histórico' });
    }
    if (winner != null && winner !== 'a' && winner !== 'b') {
      return res.status(400).json({ error: "winner precisa ser 'a', 'b' ou vazio" });
    }
    try {
      const test = await abTests.get(req.params.id, req.ownerId);
      if (!test) return res.status(404).json({ error: 'teste não encontrado' });
      const winnerFormId = winner === 'a' ? test.formAId : winner === 'b' ? test.formBId : null;
      const finished = await abTests.finish(req.params.id, req.ownerId, {
        winnerFormId,
        analysis: analysis.trim(),
      });
      if (!finished) return res.status(404).json({ error: 'teste não encontrado' });
      res.json(finished);
    } catch (err) {
      console.error('[ab-tests:finish] erro:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // Sugestão de análise via IA (OpenAI) — a partir das métricas AO VIVO do
  // teste (views/leads/conversão por variante), nunca inventando dado. O
  // texto volta pro frontend preencher a textarea; o usuário sempre revisa
  // e pode reescrever antes de encerrar (POST /:id/finish continua exigindo
  // a análise final, gerada ou manual).
  router.post('/:id/suggest-analysis', async (req, res) => {
    try {
      const test = await abTests.get(req.params.id, req.ownerId);
      if (!test) return res.status(404).json({ error: 'teste não encontrado' });
      const analysis = await suggestAbTestAnalysis(test);
      res.json({ analysis });
    } catch (err) {
      console.error('[ab-tests:suggest-analysis] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Cancelar teste EM ANDAMENTO. Encerrados são imutáveis (são o histórico).
  router.delete('/:id', async (req, res) => {
    try {
      const removed = await abTests.removeRunning(req.params.id, req.ownerId);
      if (!removed) {
        return res.status(400).json({ error: 'teste não encontrado ou já encerrado (testes encerrados são histórico, não podem ser excluídos)' });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[ab-tests] erro ao cancelar:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAbTestsRouter };
