const express = require('express');
const crypto = require('crypto');
const { handleDealStageTrigger } = require('../dealGroupTrigger');

/**
 * Endpoint DE SISTEMA (não de usuário) chamado por um Robô de Automação
 * cadastrado na etapa-alvo do Kanban no Bitrix — decisão confirmada com o
 * usuário: precisa ser quase instantâneo (não o poller de 20min de
 * src/dealStagePoller.js), então o próprio Bitrix chama este endpoint ao
 * entrar na etapa, passando o `dealId` que o robô já tem em mãos.
 *
 * Autenticação DIFERENTE do resto do app: não há usuário logado nem
 * BX24.getAuth() aqui — quem chama é o Bitrix (servidor a servidor), então
 * a proteção é um segredo compartilhado fixo (DEAL_GROUP_TRIGGER_TOKEN),
 * comparado com crypto.timingSafeEqual (mesmo padrão de verifyAppToken em
 * src/auth.js) pra não vazar o segredo por timing. Sem essa variável
 * configurada, o endpoint responde 503 pra QUALQUER chamada — nunca abre
 * sem proteção "por engano" só por env ausente.
 */
function createDealGroupTriggerRouter() {
  const router = express.Router();

  function isValidToken(provided) {
    const expected = process.env.DEAL_GROUP_TRIGGER_TOKEN;
    if (!expected) return false;
    const a = Buffer.from(String(provided || ''));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function handle(req, res) {
    const token = req.query.token || req.get('X-Trigger-Token');
    if (!isValidToken(token)) {
      // Nunca diferenciar "token ausente" de "token errado" na resposta —
      // mesmo motivo de requireResourceSession devolver 404 em vez de 403
      // em src/authz.js, aqui não há recurso a esconder, mas não vale
      // confirmar que o endpoint existe/qual token seria válido.
      return res.status(process.env.DEAL_GROUP_TRIGGER_TOKEN ? 401 : 503).json({ error: 'não autorizado' });
    }

    // dealId aceito por query OU body — o robô "Webhook" simples do Bitrix
    // (só uma URL única, sem escolha de método/corpo) só consegue montar
    // querystring, então GET /?token=...&dealId=... precisa funcionar sem
    // nada além da URL. POST com { dealId } no body continua funcionando
    // igual, pra chamada manual/curl ou um robô mais flexível no futuro.
    const rawDealId = req.query.dealId || req.body?.dealId;
    // Extrai só os dígitos — achado real testando via robô "Webhook" do
    // Bitrix: o placeholder {{ID}} na URL chegou com um "_" colado
    // (ex: "5685627_"), provavelmente formatação específica desse tipo de
    // robô. ID de negócio no Bitrix é sempre numérico, então isto sanitiza
    // sem risco de aceitar um dealId errado.
    const dealId = rawDealId ? String(rawDealId).replace(/\D/g, '') : null;
    if (!dealId) return res.status(400).json({ error: 'dealId é obrigatório' });

    try {
      const result = await handleDealStageTrigger(dealId);
      res.json(result);
    } catch (err) {
      console.error('[deal-group-trigger] erro ao processar gatilho:', err.message);
      res.status(502).json({ error: err.message });
    }
  }

  // GET /?token=...&dealId=...  — usado pelo robô "Webhook" do Bitrix, que
  // só permite configurar uma URL única (sem campo de método/corpo).
  router.get('/', handle);
  // POST /?token=...  { dealId }
  router.post('/', handle);

  return router;
}

module.exports = { createDealGroupTriggerRouter };
