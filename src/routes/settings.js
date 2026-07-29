const express = require('express');
const settings = require('../settings');
const { issueApiToken } = require('../auth');

const HEX_RE = /^#[0-9a-f]{6}$/i;
const FIELDS = ['accentColor', 'accentColorDim', 'greenColor', 'redColor', 'bgColor'];

/**
 * Configurações globais editáveis (tela `public/settings.html`) — montado
 * em /api/settings, atrás de requireAuth. Paleta (destaque, destaque
 * secundário, verde, vermelho), lida também por GET /api/brand (público)
 * pra aplicar em todas as páginas. Qualquer usuário autenticado pode
 * editar — mesma equipe pequena/confiável já assumida em /api/suggestions,
 * não há um papel de "admin" separado hoje.
 */
function createSettingsRouter() {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      res.json(await settings.get());
    } catch (err) {
      console.error('[settings] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.put('/', async (req, res) => {
    const body = req.body || {};
    const patch = {};
    for (const field of FIELDS) {
      if (!(field in body)) continue;
      const value = body[field];
      if (value && !HEX_RE.test(value)) {
        return res.status(400).json({ error: `${field} precisa ser uma cor hex, ex: #d8ab4f` });
      }
      patch[field] = value || null;
    }
    try {
      res.json(await settings.update(patch));
    } catch (err) {
      console.error('[settings] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /api-token
  // Gera um token de API de validade longa (padrão 90 dias, ver
  // API_TOKEN_TTL_DAYS) pro dono autenticado usar fora do navegador
  // (scripts, Postman, Power Query) — ver painel "Token de API" em
  // /settings.html e a documentação em /api-docs. Mesmo mecanismo de
  // sempre (Bearer + requireAuth), só que sem depender do login
  // embutido no Bitrix pra renovar a cada poucas horas. Não fica
  // guardado no servidor — só o próprio usuário tem a cópia gerada
  // aqui; gerar de novo não revoga o anterior (ele só expira sozinho).
  // ---------------------------------------------------------------
  router.post('/api-token', (req, res) => {
    const { token, expiresAt } = issueApiToken(req.ownerId);
    res.json({ token, expiresAt });
  });

  return router;
}

module.exports = { createSettingsRouter };
