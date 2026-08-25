const express = require('express');
const { requireSuperAdmin, requireConversationAnalysisAccess } = require('../adminAuth');
const conversationAnalysisGrants = require('../conversationAnalysisGrants');
const conversationAnalysisAudit = require('../conversationAnalysisAudit');
const caStore = require('../conversationAnalysisStore');
const instancesStore = require('../instances');
const { listEmployees } = require('../bitrixHierarchy');
const { ownerIdFor } = require('../auth');
const { generateConversationAnalysisInsight } = require('../openai');

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_INSIGHT_CONVERSATIONS = 60; // mesmo teto de src/openai.js — busca só o necessário, não mais

/**
 * Auditoria de Conversas (`/conversation-analysis.html`, ver HANDOFF
 * Parte DK) — montado em /api/conversation-analysis, atrás de
 * requireAuth (ver server.js). Tela DIFERENTE do dashboard "Análise de
 * Conversas" já existente (métricas agregadas só das PRÓPRIAS
 * instâncias) — esta lê o conteúdo real de mensagens de QUALQUER owner
 * do sistema, por isso TODA rota abaixo passa primeiro por
 * requireConversationAnalysisAccess (super admin ou owner com grant
 * explícito, ver adminAuth.js) — NUNCA requireSession/assertOwnsSession
 * (src/authz.js), que bloqueariam por design (o propósito desta tela é
 * justamente ignorar posse de sessão, sob controle de acesso próprio).
 */
function createConversationAnalysisRouter() {
  const router = express.Router();

  // Portão único — roda ANTES de toda rota abaixo, inclusive as de
  // /admin/grants (que ainda exigem requireSuperAdmin por cima: quem
  // TEM acesso concedido não pode conceder acesso a mais gente).
  router.use(requireConversationAnalysisAccess);

  function parseDateParam(raw) {
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // ---------------------------------------------------------------
  // GET /whoami
  // Mesmo padrão exato de GET /admin/whoami (src/routes/whatsapp.js) —
  // usado pelo frontend das 15 telas pra decidir se revela o item de
  // navegação. Só chega aqui quem já passou por
  // requireConversationAnalysisAccess acima, então a resposta é sempre
  // {hasAccess: true} — o 403 (sem acesso) já teria acontecido antes.
  // ---------------------------------------------------------------
  router.get('/whoami', (req, res) => {
    res.json({ hasAccess: true });
  });

  // ---------------------------------------------------------------
  // GET /instances
  // Todas as instâncias do sistema (id + label + dono + nome do dono),
  // pra popular o filtro "Instância" da tela — instancesStore.listAll()
  // é SEM filtro de propósito (ver comentário na própria função).
  // ---------------------------------------------------------------
  router.get('/instances', async (req, res) => {
    try {
      const [instances, employees] = await Promise.all([instancesStore.listAll(), listEmployees()]);
      const nameByOwnerId = new Map((employees || []).map((e) => [ownerIdFor(e.id), e.name]));
      res.json({
        // Instância "órfã" (ownerId null — removida de `instances`, mas com
        // histórico real preservado, ver instancesStore.listAll) nunca teria
        // match no mapa de nomes; sem este `isOrphan` explícito o fallback
        // `|| i.ownerId` mostraria "null" literal no dropdown.
        instances: instances.map((i) => ({
          ...i,
          ownerName: i.isOrphan ? i.label : (nameByOwnerId.get(i.ownerId) || i.ownerId),
        })),
      });
    } catch (err) {
      console.error('[conversation-analysis:instances] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /conversations?search=&sessionId=&sentBy=&from=&to=&page=&pageSize=
  // Lista cross-instância, paginada no SERVIDOR.
  // ---------------------------------------------------------------
  router.get('/conversations', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE));
      const filters = {
        search: req.query.search || null,
        sessionId: req.query.sessionId || null,
        sentBy: req.query.sentBy || null,
        from: parseDateParam(req.query.from),
        to: parseDateParam(req.query.to),
        page,
        pageSize,
      };
      const result = await caStore.listAll(filters);
      // Best-effort, fire-and-forget — nunca bloqueia a resposta real.
      conversationAnalysisAudit.logAccess(req.ownerId, 'search', {
        search: filters.search, sessionId: filters.sessionId, sentBy: filters.sentBy, from: filters.from, to: filters.to,
      });
      res.json({ ...result, page, pageSize });
    } catch (err) {
      console.error('[conversation-analysis:conversations] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /conversations/:sessionId/:phone/history
  // Histórico completo de UMA conversa específica, qualquer dono.
  // ---------------------------------------------------------------
  router.get('/conversations/:sessionId/:phone/history', async (req, res) => {
    try {
      const { sessionId, phone } = req.params;
      const messages = await caStore.getHistory(sessionId, phone);
      conversationAnalysisAudit.logAccess(req.ownerId, 'view_conversation', { sessionId, phone });
      res.json({ messages });
    } catch (err) {
      console.error('[conversation-analysis:history] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /metrics?sessionId=&sentBy=&from=&to=
  // Métricas agregadas cross-owner pro mesmo filtro de /conversations
  // (sem busca por termo/paginação).
  // ---------------------------------------------------------------
  router.get('/metrics', async (req, res) => {
    try {
      const metrics = await caStore.computeAggregateMetrics({
        sessionId: req.query.sessionId || null,
        sentBy: req.query.sentBy || null,
        from: parseDateParam(req.query.from),
        to: parseDateParam(req.query.to),
      });
      res.json(metrics);
    } catch (err) {
      console.error('[conversation-analysis:metrics] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /insight  { search?, sessionId?, sentBy?, from?, to? }
  // Gera insight de IA sobre o conjunto filtrado — amostra até
  // MAX_INSIGHT_CONVERSATIONS conversas mais recentes que batem o
  // filtro (ver src/openai.js pro teto de mensagens dentro disso).
  // Nunca persiste (diferente de conversations.ai_summary, que é POR
  // conversa) — o conjunto aqui é arbitrário e mutável a cada filtro.
  // ---------------------------------------------------------------
  router.post('/insight', async (req, res) => {
    try {
      const filters = {
        search: req.body?.search || null,
        sessionId: req.body?.sessionId || null,
        sentBy: req.body?.sentBy || null,
        from: parseDateParam(req.body?.from),
        to: parseDateParam(req.body?.to),
        page: 1,
        pageSize: MAX_INSIGHT_CONVERSATIONS,
      };
      const { conversations, total } = await caStore.listAll(filters);
      const conversationsWithMessages = await Promise.all(
        conversations.map(async (c) => ({
          contactName: c.contactName,
          phone: c.phone,
          messages: await caStore.getHistory(c.sessionId, c.phone),
        }))
      );
      const result = await generateConversationAnalysisInsight(conversationsWithMessages, total);
      conversationAnalysisAudit.logAccess(req.ownerId, 'generate_insight', {
        search: filters.search, sessionId: filters.sessionId, sentBy: filters.sentBy,
        from: filters.from, to: filters.to, sampledConversations: result.sampledConversations,
      });
      res.json(result);
    } catch (err) {
      console.error('[conversation-analysis:insight] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // Administração da PRÓPRIA permissão — exige requireSuperAdmin POR
  // CIMA do portão principal já aplicado no topo do arquivo.
  // ---------------------------------------------------------------

  router.get('/admin/grants', requireSuperAdmin, async (req, res) => {
    try {
      const [grants, employees] = await Promise.all([conversationAnalysisGrants.listGrants(), listEmployees()]);
      const nameByOwnerId = new Map((employees || []).map((e) => [ownerIdFor(e.id), e.name]));
      res.json({
        grants: grants.map((g) => ({ ...g, ownerName: nameByOwnerId.get(g.ownerId) || g.ownerId })),
      });
    } catch (err) {
      console.error('[conversation-analysis:admin:grants] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/admin/grants/:ownerId', requireSuperAdmin, async (req, res) => {
    try {
      await conversationAnalysisGrants.grantAccess(req.params.ownerId, req.ownerId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[conversation-analysis:admin:grant] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.delete('/admin/grants/:ownerId', requireSuperAdmin, async (req, res) => {
    try {
      await conversationAnalysisGrants.revokeAccess(req.params.ownerId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[conversation-analysis:admin:revoke] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createConversationAnalysisRouter };
