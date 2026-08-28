const express = require('express');
const store = require('../store');
const dapinho = require('../dapinho');
const { requireSuperAdmin } = require('../adminAuth');

/**
 * Dapinho — assistente de IA conversacional por dono + canal de avisos de
 * feature nova (ver src/dapinho.js). Router PRÓPRIO (não dentro de
 * routes/whatsapp.js) porque, diferente de toda outra rota daquele
 * arquivo, NUNCA toca `sessions`/`SessionManager` (Baileys) — a "conversa"
 * do Dapinho não é uma instância WhatsApp real, então misturar aqui
 * evitaria de vez qualquer rota chamar `sessions.get()` num session_id
 * virtual por engano (ver GET /history em routes/whatsapp.js, que faz
 * isso e por isso não serve pro Dapinho).
 *
 * Montado em /api/dapinho, atrás de requireAuth (ver server.js) — cada
 * rota aqui é sempre sobre a PRÓPRIA conversa do usuário autenticado
 * (req.ownerId), nunca recebe session/owner alheio pra checar (diferente
 * de requireSession, que existe pra recursos que podem ser delegados/
 * hierárquicos — o Dapinho nunca é).
 */
function createDapinhoRouter() {
  const router = express.Router();

  // GET /  — a "conversa" fixa do Dapinho pro dono autenticado, no mesmo
  // formato de uma linha de store.listConversations (ver
  // dapinho.getConversationSummary) — pra injetar no topo da lista do
  // Chat sem lógica especial de renderização no front.
  router.get('/', async (req, res) => {
    try {
      const conversation = await dapinho.getConversationSummary(req.ownerId);
      res.json({ conversation });
    } catch (err) {
      console.error('[dapinho] erro ao buscar conversa:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // GET /history — histórico completo da conversa do Dapinho com o dono
  // autenticado. Espelha GET /history de routes/whatsapp.js, mas SEM
  // tocar `sessions`/Baileys (não existe status de conexão/presença pra
  // uma conversa de sistema).
  router.get('/history', async (req, res) => {
    try {
      const sessionId = dapinho.sessionIdFor(req.ownerId);
      const messages = await store.getHistory(sessionId, dapinho.PHONE);
      res.json({ messages });
    } catch (err) {
      console.error('[dapinho] erro ao buscar histórico:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /ask  { question }
  // Pergunta do usuário — gera e grava a resposta da IA (ver
  // dapinho.ask), já registrando o par pergunta+resposta pra few-shot.
  // Síncrono (não fire-and-forget): o front espera a resposta pra saber
  // quando parar de mostrar "digitando...".
  router.post('/ask', async (req, res) => {
    const { question, ownerName } = req.body || {};
    try {
      const answer = await dapinho.ask(req.ownerId, question, { ownerName });
      res.json({ ok: true, answer });
    } catch (err) {
      console.error('[dapinho] erro ao processar pergunta:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // POST /mark-read — marca como lidas as notificações da conversa do
  // Dapinho (mesmo padrão de POST /conversations/mark-read em
  // routes/whatsapp.js), chamado ao abrir a conversa no Chat.
  router.post('/mark-read', async (req, res) => {
    try {
      const sessionId = dapinho.sessionIdFor(req.ownerId);
      await store.markNotificationsReadForConversation(sessionId, dapinho.PHONE);
      res.json({ ok: true });
    } catch (err) {
      console.error('[dapinho] erro ao marcar como lida:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /admin/broadcast  { title?, message }
  // Dispara o aviso de feature nova pra TODO owner_id já cadastrado —
  // SEMPRE manual (mesma decisão de produto já confirmada pro Feed do
  // Bitrix, ver bitrixFeed.js: nunca automático a partir de deploy/commit).
  // ---------------------------------------------------------------
  router.post('/admin/broadcast', requireSuperAdmin, async (req, res) => {
    const { title, message, testOnly } = req.body || {};
    try {
      const result = await dapinho.broadcastFeatureAnnouncement({ title, message, sentBy: req.ownerId, testOnly: !!testOnly });
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[dapinho] falha ao disparar aviso:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // GET /admin/broadcasts — histórico local de avisos já disparados.
  router.get('/admin/broadcasts', requireSuperAdmin, async (req, res) => {
    try {
      res.json({ broadcasts: await dapinho.listBroadcasts() });
    } catch (err) {
      console.error('[dapinho] erro ao listar avisos:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createDapinhoRouter };
