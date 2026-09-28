const express = require('express');
const { issueApiToken } = require('../auth');

/**
 * Montado em /api/settings, atrás de requireAuth. Hoje só o Token de API
 * — a paleta de cores por usuário (GET/PUT /, tabela `user_palette`) foi
 * removida no redesign visual (Fase 1): a paleta do app passou a ser
 * fixa no código (ver public/assets/theme.css), sem exceção por usuário
 * nem por instalação. A tabela `user_palette` continua existindo no
 * banco, só sem leitura/escrita (mesmo precedente de `bg_color`, já
 * congelada antes).
 */
function createSettingsRouter() {
  const router = express.Router();

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
