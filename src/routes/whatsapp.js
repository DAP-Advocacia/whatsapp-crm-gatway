const express = require('express');
const store = require('../store');
const { logMessageToTimeline } = require('../bitrix');
const { saveMedia, getSignedMediaUrl } = require('../media');
const { computeMetrics, computeTeamMetrics, getOwnNumbersBySession } = require('../metrics');
const { createCampaign, getCampaign, runCampaign } = require('../campaigns');
const { computeCampaignMetrics } = require('../campaignStore');
const scheduledStore = require('../scheduledCampaigns');
const scheduler = require('../scheduler');
const instancesStore = require('../instances');
const { summarizeConversation, generateDashboardInsights, generateTeamInsights } = require('../openai');
const { getStageDistribution } = require('../bitrixCrm');
const { requireSession, requireResourceSession, requireOwnerMatch, requireResourceOwner, assertOwnsSession } = require('../authz');
const { getSubordinates, listEmployees } = require('../bitrixHierarchy');
const { resolvePublicUrl, fetchHtmlSnippet, extractOpenGraph } = require('../linkPreview');
const presence = require('../presence');
const pageSessions = require('../pageSessions');
const blockedOwners = require('../blockedOwners');
const { requireSuperAdmin, isSuperAdmin } = require('../adminAuth');
const { ownerIdFor } = require('../auth');
const actionLog = require('../actionLog');

// Cache simples em memória (por processo — reseta num restart, tudo bem):
// metadados de uma página raramente mudam num intervalo curto, e evita
// buscar a mesma URL de novo a cada vez que a mensagem é renderizada.
const linkPreviewCache = new Map(); // url -> { data, expiresAt }
const LINK_PREVIEW_TTL_MS = 60 * 60 * 1000;

// Cards de "Insights de IA" do Dashboard (ver GET /insights) — cache em
// memória por dono, pra não chamar a OpenAI de novo a cada 30s (o Dashboard
// já poll a métrica nesse intervalo). Só recalcula depois de expirar ou
// quando o usuário pede "Atualizar" na tela (?refresh=1).
const insightsCache = new Map(); // ownerId -> { insights, generatedAt, expiresAt }
const INSIGHTS_TTL_MS = 30 * 60 * 1000;

// Igual ao de cima, mas pro Painel de atendimento (GET /team-insights) —
// chave composta `${viewerOwnerId}::${sessionId}` porque a mesma pessoa
// pode ver o painel de instâncias diferentes (a própria + delegadas),
// cada uma com dados de equipe diferentes.
const teamInsightsCache = new Map();

// Intervalo entre cada mensagem de uma campanha, e limite de destinatários —
// precaução básica contra detecção de spam do WhatsApp (não é garantia).
// Valor PADRÃO — o usuário pode escolher um intervalo maior na hora de
// disparar/agendar (minDelayMs/maxDelayMs no body, ver validateDelayOverride
// abaixo); sem esses campos, cai neste padrão de sempre.
const CAMPAIGN_MIN_DELAY_MS = 4000;
const CAMPAIGN_MAX_DELAY_MS = 9000;
const CAMPAIGN_MAX_RECIPIENTS = 100;

// Limites aceitáveis pro override de intervalo (minDelayMs/maxDelayMs vindo
// do client) — 1s no mínimo (abaixo disso é praticamente o disparo robótico
// que a precaução tenta evitar) e 2min no máximo (acima disso uma campanha
// de 100 destinatários levaria mais de 3h só de intervalo, sem contar o
// tempo de envio em si). Devolve {minDelayMs, maxDelayMs} válidos (o padrão,
// se nada foi passado) ou lança erro com mensagem pronta pra resposta 400.
const DELAY_OVERRIDE_MIN_MS = 1000;
const DELAY_OVERRIDE_MAX_MS = 120000;
function validateDelayOverride(minDelayMs, maxDelayMs) {
  if (minDelayMs == null && maxDelayMs == null) {
    return { minDelayMs: CAMPAIGN_MIN_DELAY_MS, maxDelayMs: CAMPAIGN_MAX_DELAY_MS };
  }
  const min = Number(minDelayMs ?? CAMPAIGN_MIN_DELAY_MS);
  const max = Number(maxDelayMs ?? CAMPAIGN_MAX_DELAY_MS);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error('minDelayMs/maxDelayMs precisam ser números');
  }
  if (min < DELAY_OVERRIDE_MIN_MS || max > DELAY_OVERRIDE_MAX_MS) {
    throw new Error(`intervalo precisa estar entre ${DELAY_OVERRIDE_MIN_MS / 1000}s e ${DELAY_OVERRIDE_MAX_MS / 1000}s`);
  }
  if (min > max) {
    throw new Error('minDelayMs não pode ser maior que maxDelayMs');
  }
  return { minDelayMs: min, maxDelayMs: max };
}

// Máximo de instâncias de WhatsApp por dono (ver POST /instances abaixo) —
// decisão do usuário, não uma limitação técnica do Baileys/gateway em si.
const MAX_INSTANCES_PER_OWNER = 3;

// Resolve o dono de um agendamento (session_id) pra checagem de posse nas
// rotas /scheduled-campaigns/:id/... — a coluna vem com nome de banco
// (session_id), não camelCase, porque scheduledStore.getById faz `select *`.
async function scheduledCampaignOwner(req) {
  const row = await scheduledStore.getById(req.params.id);
  return row?.session_id || null;
}

// Resolve o dono de uma notificação (owner_id) pra checagem de posse na rota
// /notifications/:id/read — ver requireResourceOwner em src/authz.js.
async function notificationOwner(req) {
  return store.getNotificationOwner(req.params.id);
}

/**
 * Recebe o SessionManager (multi-sessão) e o "hub" de WebSocket
 * (broadcast(sessionId, phone, payload)) por injeção.
 *
 * Este router já é montado atrás do middleware requireAuth (ver server.js),
 * que garante req.ownerId = identidade real do usuário Bitrix, verificada
 * contra o próprio Bitrix — não um valor que o navegador afirma. Cada rota
 * abaixo ainda precisa confirmar que o `session`/`owner` recebido de fato
 * pertence a req.ownerId (ver src/authz.js) — a autenticação sozinha não
 * garante posse do recurso.
 */
function createWhatsappRouter({ sessions, broadcast }) {
  const router = express.Router();

  // ---------------------------------------------------------------
  // GET /metrics?origin=interna|externa
  // Números agregados das instâncias do DONO autenticado (req.ownerId), para
  // o dashboard (dashboard.html) — "visão de time" só entre as próprias
  // instâncias de um mesmo dono (ex: vários números do mesmo negócio), nunca
  // entre donos diferentes. Antes vazava as conversas de TODOS os donos pra
  // qualquer usuário autenticado (bug de isolamento corrigido em 2026-07-09,
  // ver Parte AQ do HANDOFF).
  // ---------------------------------------------------------------
  router.get('/metrics', async (req, res) => {
    try {
      const { origin } = req.query;
      const myInstances = await instancesStore.listByOwner(req.ownerId);
      const sessionIds = myInstances.map((i) => i.id);
      const metrics = await computeMetrics({
        origin: origin === 'interna' || origin === 'externa' ? origin : undefined,
        sessionIds,
      });
      // Nome amigável da instância (ver Instâncias/instances.label) em vez do
      // session_id cru na tabela "Por sessão" — `myInstances` já tem o label,
      // não precisa de round-trip extra.
      const labelBySession = new Map(myInstances.map((i) => [i.id, i.label]));
      metrics.perSession = metrics.perSession.map((s) => ({ ...s, label: labelBySession.get(s.sessionId) || s.sessionId }));

      // Gráfico "Leads por etapa": distribuição no Bitrix dos MESMOS negócios
      // já vinculados às conversas desta tela (m.conversations). Best-effort
      // à parte — sem webhook configurado ou qualquer erro, vira [] e o
      // gráfico simplesmente some, nunca derruba o resto das métricas.
      try {
        metrics.stages = await getStageDistribution((metrics.conversations || []).map((c) => c.dealId));
      } catch (err) {
        console.error('[metrics:stages] erro:', err.message);
        metrics.stages = [];
      }

      res.json(metrics);
    } catch (err) {
      console.error('[metrics] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /insights?refresh=1
  // Cards de "Insights de IA" no topo do Dashboard — recalcula os mesmos
  // agregados de /metrics (+ etapas do Bitrix) e pede pra OpenAI 3 a 5
  // observações curtas. Cacheado por dono (ver insightsCache acima);
  // ?refresh=1 ignora o cache (botão "Atualizar" da tela).
  // ---------------------------------------------------------------
  router.get('/insights', async (req, res) => {
    try {
      const cached = insightsCache.get(req.ownerId);
      const forceRefresh = req.query.refresh === '1';
      if (cached && !forceRefresh && cached.expiresAt > Date.now()) {
        return res.json({ insights: cached.insights, generatedAt: cached.generatedAt, cached: true });
      }

      const myInstances = await instancesStore.listByOwner(req.ownerId);
      const sessionIds = myInstances.map((i) => i.id);
      const labelBySession = new Map(myInstances.map((i) => [i.id, i.label]));
      const metrics = await computeMetrics({ sessionIds });
      metrics.perSession = metrics.perSession.map((s) => ({ ...s, label: labelBySession.get(s.sessionId) || s.sessionId }));

      let stages = [];
      try {
        stages = await getStageDistribution((metrics.conversations || []).map((c) => c.dealId));
      } catch (err) {
        console.error('[insights:stages] erro:', err.message);
      }

      const insights = await generateDashboardInsights(metrics, stages);
      const generatedAt = new Date().toISOString();
      insightsCache.set(req.ownerId, { insights, generatedAt, expiresAt: Date.now() + INSIGHTS_TTL_MS });
      res.json({ insights, generatedAt, cached: false });
    } catch (err) {
      console.error('[insights] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /team-metrics?session=<UMA instância>
  // Painel de atendimento (subaba "Painel" em chat.html) — desempenho por
  // atendente de UMA instância por vez (não agrega várias, pra não
  // misturar equipes diferentes se o usuário tiver acesso a instâncias de
  // mais de um gerente). `requireSession` já garante posse/delegação;
  // aqui só falta decidir SE quem está vendo é o dono real (isManager) —
  // dono vê a equipe inteira, delegado comum só o próprio desempenho
  // (decisão de produto confirmada com o usuário, ver Parte CI do
  // HANDOFF).
  // ---------------------------------------------------------------
  router.get('/team-metrics', requireSession((req) => req.query.session), async (req, res) => {
    if (req.sessionIds.length !== 1) {
      return res.status(400).json({ error: 'o Painel mostra uma instância por vez' });
    }
    try {
      const [sessionId] = req.sessionIds;
      const inst = await instancesStore.get(sessionId);
      const isManager = !!inst && inst.ownerId === req.ownerId;
      const metrics = await computeTeamMetrics([sessionId], { viewerOwnerId: req.ownerId, isManager });
      res.json(metrics);
    } catch (err) {
      console.error('[team-metrics] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /team-insights?session=<UMA instância>&refresh=1
  // "Storytelling" do Painel — mesmo padrão de cache/refresh de
  // /insights, só que por instância + quem está vendo (viewerOwnerId),
  // já que o conteúdo muda conforme isManager.
  // ---------------------------------------------------------------
  router.get('/team-insights', requireSession((req) => req.query.session), async (req, res) => {
    if (req.sessionIds.length !== 1) {
      return res.status(400).json({ error: 'o Painel mostra uma instância por vez' });
    }
    try {
      const [sessionId] = req.sessionIds;
      const cacheKey = `${req.ownerId}::${sessionId}`;
      const cached = teamInsightsCache.get(cacheKey);
      const forceRefresh = req.query.refresh === '1';
      if (cached && !forceRefresh && cached.expiresAt > Date.now()) {
        return res.json({ insights: cached.insights, generatedAt: cached.generatedAt, cached: true });
      }

      const inst = await instancesStore.get(sessionId);
      const isManager = !!inst && inst.ownerId === req.ownerId;
      const metrics = await computeTeamMetrics([sessionId], { viewerOwnerId: req.ownerId, isManager });
      const insights = await generateTeamInsights(metrics);
      const generatedAt = new Date().toISOString();
      teamInsightsCache.set(cacheKey, { insights, generatedAt, expiresAt: Date.now() + INSIGHTS_TTL_MS });
      res.json({ insights, generatedAt, cached: false });
    } catch (err) {
      console.error('[team-insights] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /sessions?session=...
  // Status da própria sessão do usuário — cada um só vê a(s) própria(s).
  // ---------------------------------------------------------------
  router.get('/sessions', requireSession((req) => req.query.session), (req, res) => {
    try {
      const ownNumbers = getOwnNumbersBySession();
      const list = req.sessionIds.map((sessionId) => ({
        sessionId,
        phone: ownNumbers[sessionId] || null,
        status: sessions.get(sessionId).getStatus(),
      }));
      res.json({ sessions: list });
    } catch (err) {
      console.error('[sessions] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /instances?owner=...
  // Lista as instâncias de WhatsApp desse usuário (um mesmo usuário pode
  // conectar mais de um número). Sempre garante ao menos uma (a "Principal").
  // `contactCount`/`groupCount` (ver card em instances.html): grupos vêm de
  // uma chamada real ao WhatsApp por instância online (groupFetchAllParticipating,
  // não instantânea); contatos são um acumulado em memória dos eventos do
  // Baileys (não existe "total de contatos" pronto na lib), null se a sessão
  // nunca esteve online neste processo.
  // ---------------------------------------------------------------
  router.get('/instances', requireOwnerMatch((req) => req.query.owner), async (req, res) => {
    const owner = req.query.owner;
    try {
      await instancesStore.ensureDefault(owner); // garante que o próprio dono tem ao menos 1
      const list = await instancesStore.listAccessible(owner); // próprias + delegadas (ver instance_delegates)
      const ownNumbers = getOwnNumbersBySession();
      const withStatus = await Promise.all(list.map(async (i) => {
        let gateway = null;
        let status = 'offline';
        try {
          gateway = sessions.get(i.id);
          status = gateway.getStatus();
        } catch {
          // sessão ainda não foi iniciada nesse processo — status fica offline
        }
        const groupCount = gateway ? await gateway.getGroupCount() : null;
        const contactCount = gateway ? gateway.getContactCount() : null;
        // needsAttention (HANDOFF Parte CQ): true quando o WhatsApp recusou a
        // conexão de forma que parece permanente (403/440/500) — o gateway já
        // parou de tentar reconectar sozinho; a tela precisa deixar isso
        // visível (não é só "desconectada", como uma queda de rede comum).
        const needsAttention = gateway?.needsAttention || false;
        const lastDisconnectReason = gateway?.lastDisconnectReason || null;
        return { ...i, status, phone: ownNumbers[i.id] || null, groupCount, contactCount, needsAttention, lastDisconnectReason };
      }));
      res.json({ instances: withStatus, limit: MAX_INSTANCES_PER_OWNER });
    } catch (err) {
      console.error('[instances] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /instances  { owner, label }
  // Cria uma nova instância pro usuário e já dispara o início da sessão
  // (gera QR Code pra pareamento em GET /qr?session=<instanceId>).
  // ---------------------------------------------------------------
  router.post('/instances', requireOwnerMatch((req) => req.body?.owner), async (req, res) => {
    const { owner, label } = req.body || {};
    try {
      const existing = await instancesStore.ensureDefault(owner);
      if (existing.length >= MAX_INSTANCES_PER_OWNER) {
        return res.status(400).json({ error: `Limite de ${MAX_INSTANCES_PER_OWNER} instâncias por usuário atingido — remova uma existente antes de criar outra.` });
      }
      const finalLabel = (label || '').trim() || `Instância ${existing.length + 1}`;
      const id = await instancesStore.create(owner, finalLabel);
      sessions.get(id); // cria e inicia a sessão (gera QR)
      // Ação registrada AQUI (criação da instância), não no evento de
      // conexão real do Baileys — esse dispara em TODA reconexão
      // automática (não só a primeira vez), o que pareceria "conectou
      // instância nova" a cada queda de rede recuperada. POST /instances
      // só roda uma vez por clique real em "+ Nova instância" (HANDOFF
      // Parte DB).
      actionLog.logAction(owner, 'instance_created', finalLabel);
      res.json({ ok: true, instanceId: id });
    } catch (err) {
      console.error('[instances] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // PUT /instances/:id  { owner, label }
  // ---------------------------------------------------------------
  router.put('/instances/:id', requireOwnerMatch((req) => req.body?.owner), async (req, res) => {
    const { owner, label } = req.body || {};
    if (!label || !label.trim()) {
      return res.status(400).json({ error: 'label é obrigatório' });
    }
    try {
      await instancesStore.rename(req.params.id, owner, label.trim());
      res.json({ ok: true });
    } catch (err) {
      console.error('[instances] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // DELETE /instances/:id?owner=...
  // Desconecta o WhatsApp dessa instância (tenta deslogar de verdade, ver
  // WhatsAppGateway.disconnect) e apaga o registro.
  // ---------------------------------------------------------------
  router.delete('/instances/:id', requireOwnerMatch((req) => req.query.owner), async (req, res) => {
    const owner = req.query.owner;
    try {
      const inst = await instancesStore.get(req.params.id);
      if (!inst || inst.ownerId !== owner) {
        return res.status(404).json({ error: 'instância não encontrada' });
      }
      await sessions.remove(req.params.id);
      await instancesStore.remove(req.params.id, owner);
      res.json({ ok: true });
    } catch (err) {
      console.error('[instances] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /instances/:id/reconnect?owner=...
  // Botão "Tentar reconectar" — só faz sentido quando needsAttention
  // (GET /instances) está true (desconexão marcada como permanente, ver
  // WhatsAppGateway connection.update). Usa getActiveGateway (nunca get(),
  // que criaria uma sessão nova por engano se ela não estivesse em memória
  // por algum motivo) — 404 se a sessão nem existe no processo ainda.
  // HANDOFF Parte CQ.
  // ---------------------------------------------------------------
  router.post('/instances/:id/reconnect', requireOwnerMatch((req) => req.query.owner), async (req, res) => {
    const owner = req.query.owner;
    try {
      const inst = await instancesStore.get(req.params.id);
      if (!inst || inst.ownerId !== owner) {
        return res.status(404).json({ error: 'instância não encontrada' });
      }
      const gateway = sessions.getActiveGateway(req.params.id);
      if (!gateway) {
        return res.status(404).json({ error: 'sessão não está ativa neste processo' });
      }
      await gateway.retryManually();
      res.json({ ok: true, status: gateway.getStatus() });
    } catch (err) {
      console.error('[instances] falha ao reconectar manualmente:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // Delegação de acesso (ver db/schema.sql, instance_delegates) — um
  // gerente compartilha a própria instância com outros usuários do Bitrix
  // (ex: funcionários), sem contar contra o limite de 3 de quem recebe. Só
  // o dono de verdade concede/revoga/lista (conferido dentro de
  // instancesStore, não só por requireOwnerMatch — mesmo cuidado de
  // DELETE /instances/:id acima).
  // ---------------------------------------------------------------
  router.get('/instances/:id/delegates', requireOwnerMatch((req) => req.query.owner), async (req, res) => {
    try {
      const inst = await instancesStore.get(req.params.id);
      if (!inst || inst.ownerId !== req.query.owner) {
        return res.status(404).json({ error: 'instância não encontrada' });
      }
      res.json({ delegates: await instancesStore.listDelegates(req.params.id) });
    } catch (err) {
      console.error('[instances:delegates] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/instances/:id/delegates', requireOwnerMatch((req) => req.body?.owner), async (req, res) => {
    const { owner, delegateOwnerId, delegateName } = req.body || {};
    if (!delegateOwnerId) return res.status(400).json({ error: 'delegateOwnerId é obrigatório' });
    try {
      await instancesStore.addDelegate(req.params.id, owner, delegateOwnerId, delegateName);
      res.json({ ok: true });
    } catch (err) {
      console.error('[instances:delegates] erro:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/instances/:id/delegates/:delegateOwnerId', requireOwnerMatch((req) => req.query.owner), async (req, res) => {
    try {
      await instancesStore.removeDelegate(req.params.id, req.query.owner, req.params.delegateOwnerId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[instances:delegates] erro:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /instances/eligible-delegates?owner=
  // Quem o dono PODE delegar manualmente ("Compartilhar acesso" em
  // instances.html): só os próprios subordinados na hierarquia do Bitrix
  // (ver src/bitrixHierarchy.js), não qualquer usuário do portal — pedido
  // do usuário: "deveria aparecer somente os usuários que estão abaixo de
  // mim". Devolve só os bitrixUserId (sufixo do ownerId) pra o client
  // filtrar o próprio BX24.callMethod('user.search'); sem hierarquia
  // mapeada (feature inativa ou dono sem subordinados), devolve lista
  // vazia — a busca fica sem resultado, de propósito, não cai pra
  // "buscar todo mundo".
  // ---------------------------------------------------------------
  router.get('/instances/eligible-delegates', requireOwnerMatch((req) => req.query.owner), async (req, res) => {
    try {
      const subordinateOwnerIds = await getSubordinates(req.query.owner);
      const bitrixUserIds = subordinateOwnerIds.map((id) => id.slice(id.lastIndexOf('_') + 1));
      res.json({ bitrixUserIds });
    } catch (err) {
      console.error('[instances:eligible-delegates] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /avatar?session=...&phone=...
  // Foto de perfil do contato (ou grupo, se `phone` for um JID de grupo).
  // ---------------------------------------------------------------
  router.get('/avatar', requireSession((req) => req.query.session), async (req, res) => {
    const { session, phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      let url = await store.getAvatarUrl(session, phone);
      if (!url) {
        const gateway = sessions.get(session);
        url = await gateway.getProfilePicture(phone);
        if (url) await store.setAvatarUrl(session, phone, url);
      }
      res.json({ url: url || null });
    } catch (err) {
      console.error('[avatar] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // Grupos de WhatsApp de verdade — diferente da Campanha (que manda uma DM
  // por destinatário), um "disparo pro grupo" é UMA mensagem só, entregue
  // pelo próprio WhatsApp a todos os participantes. Pra mandar, usa a rota
  // normal POST /send (ou /send-media) passando o id do grupo no lugar do
  // `phone` — o gateway já entende JIDs prontos (ver _phoneToJid).
  // ---------------------------------------------------------------

  // GET /groups?session=a,b,c
  router.get('/groups', requireSession((req) => req.query.session), async (req, res) => {
    try {
      res.json({ groups: await store.listGroups(req.sessionIds) });
    } catch (err) {
      console.error('[groups] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /groups  { session, name, phones: [...] }
  router.post('/groups', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, name, phones } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name é obrigatório' });
    }
    const uniquePhones = [...new Set((Array.isArray(phones) ? phones : []).map((p) => String(p).replace(/\D/g, '')).filter(Boolean))];
    if (uniquePhones.length < 1) {
      return res.status(400).json({ error: 'selecione ao menos um contato para o grupo' });
    }

    let gateway;
    try {
      gateway = sessions.get(session);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (gateway.getStatus() !== 'online') {
      return res.status(409).json({ error: 'Essa sessão não está com o WhatsApp conectado no momento' });
    }

    try {
      const group = await gateway.createGroup(name.trim(), uniquePhones);
      await store.createGroupRecord(group.id, session, group.name, group.participantCount);
      actionLog.logAction(req.ownerId, 'group_created', group.name);
      res.json({ ok: true, group });
    } catch (err) {
      console.error('[groups] erro ao criar grupo:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /contacts/groups?session=&phone=
  // Lista os grupos da instância dos quais esse telefone é participante —
  // usado no painel "Detalhes do contato" do Chat ("grupos em comum"). Uma
  // chamada ao WhatsApp por grupo da instância (ver
  // WhatsAppGateway.getGroupParticipantPhones) — aceitável pro volume normal
  // de grupos por instância, mas não é paginado nem cacheado.
  // ---------------------------------------------------------------
  router.get('/contacts/groups', requireSession((req) => req.query.session), async (req, res) => {
    const { session, phone } = req.query;
    const cleanPhone = String(phone || '').replace(/\D/g, '');
    if (!cleanPhone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      const gateway = sessions.get(session);
      const groups = await store.listGroups([session]);
      const matches = [];
      for (const group of groups) {
        const participants = await gateway.getGroupParticipantPhones(group.id);
        if (participants.includes(cleanPhone)) matches.push({ id: group.id, name: group.name });
      }
      res.json({ groups: matches });
    } catch (err) {
      console.error('[contacts:groups] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // Central de Notificações (public/notifications.html) — histórico
  // persistido, por dono do Bitrix (não por instância). A notificação em si
  // nasce em src/server.js (onMessage), não aqui — estas rotas só leem/
  // marcam como lida o que já foi criado.
  // ---------------------------------------------------------------
  router.get('/notifications', requireOwnerMatch((req) => req.query.owner), async (req, res) => {
    try {
      res.json({ notifications: await store.listNotifications(req.query.owner) });
    } catch (err) {
      console.error('[notifications] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.get('/notifications/unread-count', requireOwnerMatch((req) => req.query.owner), async (req, res) => {
    try {
      res.json({ count: await store.countUnreadNotifications(req.query.owner) });
    } catch (err) {
      console.error('[notifications] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/notifications/read-all', requireOwnerMatch((req) => req.body?.owner), async (req, res) => {
    try {
      await store.markAllNotificationsRead(req.body.owner);
      res.json({ ok: true });
    } catch (err) {
      console.error('[notifications] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/notifications/:id/read', requireResourceOwner(notificationOwner), async (req, res) => {
    try {
      await store.markNotificationRead(req.params.id, req.body?.read !== false);
      res.json({ ok: true });
    } catch (err) {
      console.error('[notifications] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /media/:filename
  // Bucket "media" do Supabase Storage é privado — mídia de conversa não é
  // mais servida via URL pública permanente. Qualquer usuário autenticado
  // deste portal (não só o dono da conversa — já resolve o problema real,
  // que era mídia 100% pública sem nenhuma autenticação) pode pedir a signed
  // URL de um arquivo, que expira em poucos minutos. `requireAuth` (server.js)
  // já protege essa rota, igual a todas as outras de /api/whatsapp.
  // ---------------------------------------------------------------
  router.get('/media/:filename', async (req, res) => {
    try {
      const url = await getSignedMediaUrl(req.params.filename);
      res.redirect(302, url);
    } catch (err) {
      console.error('[media] erro:', err.message);
      res.status(404).json({ error: 'mídia não encontrada' });
    }
  });

  // ---------------------------------------------------------------
  // POST /campaign/classify-recipients  { session, phones: [...] }
  // Pra cada telefone, diz se já existe conversa com pelo menos uma
  // mensagem RECEBIDA de verdade (hasReplied) — sinal mais forte de que o
  // contato já tem relação estabelecida com este número. Usado pela tela
  // de Campanha ANTES de disparar, pra avisar o risco de erro 463 do
  // WhatsApp ("account restricted or missing tctoken" — exige token de
  // privacidade antes de deixar iniciar conversa NOVA com quem nunca
  // respondeu; ver HANDOFF Parte CM/CN). Telefone sem nenhuma conversation
  // (nunca trocou mensagem em nenhuma direção) não aparece no resultado —
  // o frontend trata ausência como hasReplied:false.
  // ---------------------------------------------------------------
  router.post('/campaign/classify-recipients', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phones } = req.body || {};
    if (!Array.isArray(phones) || !phones.length) {
      return res.status(400).json({ error: 'phones (lista de telefones) é obrigatório' });
    }
    try {
      const results = await store.classifyRecipients(session, phones);
      res.json({ results });
    } catch (err) {
      console.error('[campaign:classify] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /campaign  { session, name?, recipients: [{phone, name?}], text, media? }
  // Envia a mesma mensagem (com {{nome}}/{{telefone}} substituídos por
  // destinatário) pra vários telefones, um de cada vez, com intervalo entre
  // os envios (ver src/campaigns.js). Aceita opcionalmente uma mídia (imagem/
  // áudio/vídeo em base64) anexada a todos os envios, usando `text` como
  // legenda. Também aceita o formato antigo `phones: [...]` (sem nome), por
  // compatibilidade. Devolve um campaignId pra acompanhar o progresso em
  // GET /campaign/:id.
  // ---------------------------------------------------------------
  router.post('/campaign', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, name, recipients, phones, text, media, minDelayMs, maxDelayMs } = req.body || {};

    const rawRecipients = Array.isArray(recipients) && recipients.length
      ? recipients
      : Array.isArray(phones)
        ? phones.map((p) => ({ phone: p }))
        : [];

    if (!rawRecipients.length) {
      return res.status(400).json({ error: 'recipients (lista de destinatários) é obrigatório' });
    }
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'text é obrigatório' });
    }
    if (rawRecipients.length > CAMPAIGN_MAX_RECIPIENTS) {
      return res.status(400).json({ error: `máximo de ${CAMPAIGN_MAX_RECIPIENTS} destinatários por campanha` });
    }

    let delayOverride;
    try {
      delayOverride = validateDelayOverride(minDelayMs, maxDelayMs);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    let gateway;
    try {
      gateway = sessions.get(session);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (gateway.getStatus() !== 'online') {
      return res.status(409).json({ error: 'Essa sessão não está com o WhatsApp conectado no momento' });
    }

    // dedupe por telefone, mantendo o primeiro nome encontrado pra ele
    const seen = new Map();
    for (const r of rawRecipients) {
      const phone = String(r?.phone || '').replace(/\D/g, '');
      if (!phone || seen.has(phone)) continue;
      seen.set(phone, { phone, name: r?.name || null });
    }
    const uniqueRecipients = [...seen.values()];
    if (!uniqueRecipients.length) {
      return res.status(400).json({ error: 'nenhum telefone válido na lista de destinatários' });
    }

    let mediaPayload = null;
    if (media && media.dataBase64 && media.type && media.mimetype) {
      if (media.type !== 'image' && media.type !== 'audio' && media.type !== 'video') {
        return res.status(400).json({ error: 'media.type deve ser "image", "audio" ou "video"' });
      }
      mediaPayload = {
        type: media.type,
        mimetype: media.mimetype,
        buffer: Buffer.from(media.dataBase64, 'base64'),
      };
    }

    const campaignId = await createCampaign(uniqueRecipients.length, { name, sessionId: session, hasMedia: !!mediaPayload });

    runCampaign(campaignId, {
      gateway,
      sessionId: session,
      recipients: uniqueRecipients,
      template: text.trim(),
      media: mediaPayload,
      minDelayMs: delayOverride.minDelayMs,
      maxDelayMs: delayOverride.maxDelayMs,
    }).catch((err) => console.error('[campaign] falha inesperada:', err.message));

    actionLog.logAction(req.ownerId, 'campaign_created', name || `${uniqueRecipients.length} destinatário(s)`);
    res.json({ ok: true, campaignId, total: uniqueRecipients.length });
  });

  // ---------------------------------------------------------------
  // GET /campaign/:id
  // Progresso de uma campanha em andamento/concluída — só o dono dela pode
  // consultar.
  // ---------------------------------------------------------------
  router.get('/campaign/:id', requireResourceSession((req) => getCampaign(req.params.id)?.sessionId), (req, res) => {
    const campaign = getCampaign(req.params.id);
    res.json(campaign);
  });

  // ---------------------------------------------------------------
  // POST /campaign/schedule  { session, name?, recipients, text, media?, scheduledAt }
  // Mesma validação de POST /campaign, mas em vez de disparar na hora, guarda
  // o envio pra ser feito automaticamente mais tarde (ver src/scheduler.js) —
  // ou manualmente, arrastando o card pra "Enviar agora" no Kanban
  // (public/campaign-schedule.html).
  // ---------------------------------------------------------------
  router.post('/campaign/schedule', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, name, recipients, phones, text, media, scheduledAt, minDelayMs, maxDelayMs } = req.body || {};

    if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt é obrigatório' });

    let delayOverride;
    try {
      delayOverride = validateDelayOverride(minDelayMs, maxDelayMs);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const scheduledDate = new Date(scheduledAt);
    if (Number.isNaN(scheduledDate.getTime())) {
      return res.status(400).json({ error: 'scheduledAt inválido' });
    }
    if (scheduledDate.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'a data agendada precisa ser no futuro' });
    }

    const rawRecipients = Array.isArray(recipients) && recipients.length
      ? recipients
      : Array.isArray(phones)
        ? phones.map((p) => ({ phone: p }))
        : [];

    if (!rawRecipients.length) {
      return res.status(400).json({ error: 'recipients (lista de destinatários) é obrigatório' });
    }
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'text é obrigatório' });
    }
    if (rawRecipients.length > CAMPAIGN_MAX_RECIPIENTS) {
      return res.status(400).json({ error: `máximo de ${CAMPAIGN_MAX_RECIPIENTS} destinatários por campanha` });
    }

    // não precisa estar online agora — só quando a hora do disparo chegar —
    // mas a sessão em si precisa existir.
    try {
      sessions.get(session);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const seen = new Map();
    for (const r of rawRecipients) {
      const phone = String(r?.phone || '').replace(/\D/g, '');
      if (!phone || seen.has(phone)) continue;
      seen.set(phone, { phone, name: r?.name || null });
    }
    const uniqueRecipients = [...seen.values()];
    if (!uniqueRecipients.length) {
      return res.status(400).json({ error: 'nenhum telefone válido na lista de destinatários' });
    }

    let mediaPayload = null;
    if (media && media.dataBase64 && media.type && media.mimetype) {
      if (media.type !== 'image' && media.type !== 'audio' && media.type !== 'video') {
        return res.status(400).json({ error: 'media.type deve ser "image", "audio" ou "video"' });
      }
      mediaPayload = media;
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    // Sobe a mídia pro Storage já na hora de agendar, em vez de guardar o
    // base64 na própria linha (pode chegar a ~25MB) — só o caminho fica
    // salvo (ver scheduledCampaigns.create). src/scheduler.js baixa os bytes
    // de volta na hora de disparar.
    if (mediaPayload) {
      try {
        const buffer = Buffer.from(mediaPayload.dataBase64, 'base64');
        const url = await saveMedia(session, id, buffer, mediaPayload.mimetype);
        mediaPayload = { type: mediaPayload.type, mimetype: mediaPayload.mimetype, url };
      } catch (err) {
        console.error('[campaign:schedule] falha ao subir mídia:', err.message);
        return res.status(502).json({ error: 'falha ao salvar a mídia: ' + err.message });
      }
    }

    try {
      await scheduledStore.create({
        id,
        sessionId: session,
        name,
        recipients: uniqueRecipients,
        template: text.trim(),
        media: mediaPayload,
        scheduledAt: scheduledDate.toISOString(),
        minDelayMs: delayOverride.minDelayMs,
        maxDelayMs: delayOverride.maxDelayMs,
      });
      actionLog.logAction(req.ownerId, 'campaign_created', name || `${uniqueRecipients.length} destinatário(s), agendada`);
      res.json({ ok: true, id, scheduledAt: scheduledDate.toISOString() });
    } catch (err) {
      console.error('[campaign:schedule] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /scheduled-campaigns?session=...
  // Lista os agendamentos da sessão do usuário, pro Kanban/Calendário —
  // cada usuário só vê os próprios agendamentos.
  // ---------------------------------------------------------------
  router.get('/scheduled-campaigns', requireSession((req) => req.query.session), async (req, res) => {
    try {
      res.json({ campaigns: await scheduledStore.listAll(req.sessionIds) });
    } catch (err) {
      console.error('[scheduled-campaigns] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /scheduled-campaigns/:id/send-now
  // Dispara um agendamento imediatamente, ignorando a data marcada — usado
  // quando o card é arrastado pra coluna "Enviar agora" no Kanban.
  // ---------------------------------------------------------------
  router.post('/scheduled-campaigns/:id/send-now', requireResourceSession(scheduledCampaignOwner), async (req, res) => {
    try {
      const result = await scheduler.sendScheduled(req.params.id, sessions);
      if (!result.ok) return res.status(409).json({ error: result.error });
      res.json(result);
    } catch (err) {
      console.error('[scheduled-campaigns:send-now] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // PUT /scheduled-campaigns/:id  { scheduledAt }
  // Reagenda pra outra data/hora (só funciona enquanto ainda está 'scheduled').
  // ---------------------------------------------------------------
  router.put('/scheduled-campaigns/:id', requireResourceSession(scheduledCampaignOwner), async (req, res) => {
    const { scheduledAt } = req.body || {};
    if (!scheduledAt) return res.status(400).json({ error: 'scheduledAt é obrigatório' });
    const scheduledDate = new Date(scheduledAt);
    if (Number.isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'scheduledAt precisa ser uma data válida no futuro' });
    }
    try {
      await scheduledStore.reschedule(req.params.id, scheduledDate.toISOString());
      res.json({ ok: true });
    } catch (err) {
      console.error('[scheduled-campaigns] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // DELETE /scheduled-campaigns/:id
  // Cancela um agendamento (só funciona enquanto ainda está 'scheduled').
  // ---------------------------------------------------------------
  router.delete('/scheduled-campaigns/:id', requireResourceSession(scheduledCampaignOwner), async (req, res) => {
    try {
      await scheduledStore.cancel(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('[scheduled-campaigns] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /campaigns/metrics?session=...
  // Métricas das campanhas já disparadas pela sessão do usuário, pro
  // dashboard de métricas de campanha (campaign-metrics.html) — cada usuário
  // só vê as próprias campanhas.
  // ---------------------------------------------------------------
  router.get('/campaigns/metrics', requireSession((req) => req.query.session), async (req, res) => {
    try {
      res.json(await computeCampaignMetrics(req.sessionIds));
    } catch (err) {
      console.error('[campaigns:metrics] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /qr?session=...
  // QR Code atual + status da sessão daquele usuário. Chamar este
  // endpoint também CRIA/INICIA a sessão (gera o QR no primeiro acesso).
  // ---------------------------------------------------------------
  router.get('/qr', requireSession((req) => req.query.session), (req, res) => {
    const gateway = sessions.get(req.query.session);
    res.json({ qr: gateway.getLastQr(), status: gateway.getStatus() });
  });

  // ---------------------------------------------------------------
  // GET /status?session=...
  // ---------------------------------------------------------------
  router.get('/status', requireSession((req) => req.query.session), (req, res) => {
    const gateway = sessions.get(req.query.session);
    res.json({ status: gateway.getStatus() });
  });

  // ---------------------------------------------------------------
  // GET /conversations?session=a,b,c&search=
  // Lista as conversas das instâncias informadas (mais recente primeiro),
  // com prévia da última mensagem e tags — usado pelo inbox da tela Chat
  // (public/chat.html). Aceita várias instâncias (ver requireSession) pra
  // mostrar "todas as minhas instâncias" numa lista só.
  // ---------------------------------------------------------------
  router.get('/conversations', requireSession((req) => req.query.session), async (req, res) => {
    try {
      const archived = req.query.archived === 'true';
      const conversations = await store.listConversations(req.sessionIds, req.query.search, { archived });
      res.json({ conversations });
    } catch (err) {
      console.error('[conversations] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /conversations/archive  { session, phone, archived }
  // Arquiva/desarquiva uma conversa — só organiza a lista da tela Chat
  // (some da principal, aparece em "Arquivadas"); não muda nada no envio ou
  // recebimento. Mensagem nova numa conversa arquivada não desarquiva sozinha.
  // ---------------------------------------------------------------
  // ---------------------------------------------------------------
  // POST /conversations/mark-read  { session, phone }
  // Marca como lidas todas as notificações desta conversa — chamado ao
  // abrir a conversa no Chat (ver public/chat.html openConversation), pra
  // sumir o indicador de não lida na lista sem precisar ir na Central de
  // Notificações. Não afeta o status das mensagens em si (✓✓), só a
  // notificação.
  // ---------------------------------------------------------------
  router.post('/conversations/mark-read', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      await store.markNotificationsReadForConversation(session, phone);
      res.json({ ok: true });
    } catch (err) {
      console.error('[conversations:mark-read] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /conversations/assign  { session, phone, assignedTo, assignedToName }
  // Atribui (ou desatribui, com assignedTo: null) uma conversa a um
  // atendente — dono da instância ou um dos delegados dela (ver
  // instance_delegates). "Pegar conversa"/"transferir" no Chat, ver
  // public/chat.html. `assignedToName` vem do próprio client (nome do
  // usuário atual, já disponível via BX24) — evita precisar resolver nome
  // de usuário do Bitrix no backend.
  // ---------------------------------------------------------------
  router.post('/conversations/assign', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, assignedTo, assignedToName } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      const inst = await instancesStore.get(session);
      const ownerId = inst ? inst.ownerId : session;
      if (assignedTo && assignedTo !== ownerId) {
        const delegates = await instancesStore.listDelegates(session);
        if (!delegates.some((d) => d.delegateOwnerId === assignedTo)) {
          return res.status(400).json({ error: 'assignedTo precisa ser o dono ou um delegado desta instância' });
        }
      }
      const finalAssignedToName = assignedTo ? assignedToName || null : null;
      await store.assignConversation(session, phone, assignedTo || null, finalAssignedToName, ownerId);
      // replica pra qualquer outra aba olhando esta conversa ou a lista de
      // conversas (mesmo hub de WebSocket usado por mensagem/reação) — sem
      // isso a tag/linha de atribuição só atualizava ao trocar de tela.
      broadcast(session, phone, { type: 'assignment', assignedTo: assignedTo || null, assignedToName: finalAssignedToName });
      // Só loga quando a pessoa atribui a CONVERSA A SI MESMA ("Atender") —
      // atribuir a OUTRO alguém (delegado) ou desatribuir (assignedTo null)
      // não é a ação confirmada com o usuário (HANDOFF Parte DB).
      if (assignedTo && assignedTo === req.ownerId) {
        actionLog.logAction(req.ownerId, 'conversation_assigned_self', phone);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[conversations:assign] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/conversations/archive', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, archived } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      await store.setConversationArchived(session, phone, !!archived);
      res.json({ ok: true });
    } catch (err) {
      console.error('[conversations:archive] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /conversations/move-instance  { session, phone, newSessionId }
  // "Resgata" uma conversa presa numa instância que caiu/desconectou —
  // Baileys não é a API oficial do WhatsApp, então a sessão pode cair a
  // qualquer momento e não voltar sozinha. Troca o dono da conversa (ver
  // store.moveConversationToInstance) pra outra instância DO MESMO usuário
  // que ainda esteja online, sem perder o histórico já trocado — as próximas
  // mensagens saem por essa instância nova.
  // ---------------------------------------------------------------
  router.post('/conversations/move-instance', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, newSessionId } = req.body || {};
    if (!phone || !newSessionId) return res.status(400).json({ error: 'phone e newSessionId são obrigatórios' });
    if (newSessionId === session) return res.status(400).json({ error: 'escolha uma instância diferente da atual' });
    if (!(await assertOwnsSession(newSessionId, req.ownerId))) {
      return res.status(403).json({ error: 'instância de destino não pertence a este usuário' });
    }
    try {
      await store.moveConversationToInstance(session, phone, newSessionId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[conversations:move-instance] erro:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /conversations/notifications  { session, phone, enabled }
  // Silencia/dessilencia notificações de uma conversa (tela Chat) — notifica
  // por padrão; silenciar é exceção manual, como no próprio WhatsApp.
  // ---------------------------------------------------------------
  router.post('/conversations/notifications', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, enabled } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      await store.setConversationNotifications(session, phone, !!enabled);
      res.json({ ok: true });
    } catch (err) {
      console.error('[conversations:notifications] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // Tags — criadas livremente pelo atendente durante o atendimento (tela
  // Chat) e aplicadas a conversas. Reutilizáveis dentro da mesma instância.
  // ---------------------------------------------------------------
  router.get('/tags', requireSession((req) => req.query.session), async (req, res) => {
    try {
      res.json({ tags: await store.listTags(req.sessionIds) });
    } catch (err) {
      console.error('[tags] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/tags', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, name, color } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'name é obrigatório' });
    }
    try {
      const tag = await store.createTag(session, name.trim(), color);
      res.json({ ok: true, tag });
    } catch (err) {
      console.error('[tags] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.delete('/tags/:id', requireSession((req) => req.query.session), async (req, res) => {
    try {
      await store.deleteTag(req.query.session, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('[tags] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /conversations/tags  { session, phone, tagId }
  router.post('/conversations/tags', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, tagId } = req.body || {};
    if (!phone || !tagId) {
      return res.status(400).json({ error: 'phone e tagId são obrigatórios' });
    }
    try {
      await store.addTagToConversation(session, phone, tagId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[conversations:tags] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // DELETE /conversations/tags?session=...&phone=...&tagId=...
  router.delete('/conversations/tags', requireSession((req) => req.query.session), async (req, res) => {
    const { session, phone, tagId } = req.query;
    if (!phone || !tagId) {
      return res.status(400).json({ error: 'phone e tagId são obrigatórios' });
    }
    try {
      await store.removeTagFromConversation(session, phone, tagId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[conversations:tags] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /history?session=...&dealId=...&phone=...
  // Histórico daquele telefone na sessão do usuário (ao abrir a aba)
  // ---------------------------------------------------------------
  router.get('/history', requireSession((req) => req.query.session), async (req, res) => {
    const { session, dealId, phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });

    try {
      const gateway = sessions.get(session);
      const messages = await store.getHistory(session, phone);

      // guarda/atualiza o vínculo telefone -> negócio para esta sessão
      if (dealId) {
        await store.setDealForPhone(session, phone, dealId);
      }

      // best-effort, não bloqueia a resposta: pede pro WhatsApp avisar quando
      // esse contato estiver digitando/gravando áudio (ver evento 'presence'
      // no WebSocket, /presence abaixo é o sentido contrário).
      gateway.subscribePresence(phone).catch(() => {});

      // Resumo persistido (se já foi gerado alguma vez) — vem junto pra não
      // precisar de round-trip extra ao abrir a conversa. Ver
      // POST /conversations/summary pra (re)gerar.
      const { aiSummary, aiSummaryUpdatedAt } = await store.getConversationSummary(session, phone);

      res.json({
        messages,
        connectionStatus: gateway.getStatus(),
        aiSummary,
        aiSummaryUpdatedAt,
      });
    } catch (err) {
      console.error('[history] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /conversations/summary  { session, phone, contactName? }
  // Gera (via OpenAI) e persiste um resumo da conversa — botão no painel
  // de detalhes do contato na tela Chat. Sempre reprocessa o histórico
  // inteiro na hora (não incremental); best-effort do lado do usuário —
  // erro aqui não afeta nada mais da conversa, só o resumo não é atualizado.
  // ---------------------------------------------------------------
  router.post('/conversations/summary', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, contactName } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      const messages = await store.getHistory(session, phone);
      const result = await summarizeConversation({ contactName, messages });
      await store.setConversationSummary(session, phone, result);
      res.json({ ...result, updatedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[conversations:summary] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Busca a mensagem citada (se `replyToId` vier preenchido) no formato que
  // WhatsAppGateway.sendMessage/sendMedia espera — usado por /send e
  // /send-media. `null` tanto pra "sem resposta" quanto pra "citou uma
  // mensagem que não existe mais" (best-effort: manda sem citação em vez de
  // falhar o envio inteiro por causa disso).
  async function resolveReplyTo(session, phone, replyToId) {
    if (!replyToId) return null;
    const quoted = await store.getMessageForReply(session, phone, replyToId);
    if (!quoted) return null;
    return { id: quoted.id, fromMe: quoted.direction === 'out', text: quoted.text, type: quoted.type };
  }

  // ---------------------------------------------------------------
  // POST /send  { session, dealId, phone, text, replyToId? }
  // ---------------------------------------------------------------
  router.post('/send', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, dealId, phone, text, replyToId, senderName } = req.body || {};

    if (!phone || !text) {
      return res.status(400).json({ error: 'phone e text são obrigatórios' });
    }

    try {
      const gateway = sessions.get(session);
      const replyTo = await resolveReplyTo(session, phone, replyToId);
      const message = await gateway.sendMessage(phone, text, replyTo);
      message.replyToId = replyTo ? replyToId : null;
      // sentBy é SEMPRE req.ownerId (quem autenticou esta requisição), nunca
      // um valor vindo do client — evita alguém se declarar outra pessoa.
      // senderName é best-effort (vem do BX24.callMethod('user.current') do
      // próprio client) só pra exibir sem round-trip extra ao Bitrix; se não
      // vier, fica sem nome mas sentBy ainda identifica quem foi.
      message.sentBy = req.ownerId;
      message.sentByName = senderName || null;
      await store.addMessage(session, phone, message, dealId);

      // replica para qualquer outra aba aberta olhando o mesmo telefone nesta sessão
      broadcast(session, phone, { type: 'message', message });

      // best-effort: não trava a resposta se o Bitrix estiver fora do ar
      logMessageToTimeline(dealId, text, 'out').catch((e) =>
        console.error('[bitrix] falha ao logar na timeline:', e.message)
      );

      res.json({ ok: true, message });
    } catch (err) {
      console.error('[send] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /link-preview?url=...
  // Busca metadados (Open Graph) de um link pra pré-visualizar na conversa,
  // igual o WhatsApp/Slack fazem ao "linkificar" uma URL — só título,
  // descrição e imagem da própria página, nada sensível. Sem requireSession
  // (não depende de nenhuma sessão/telefone específico), mas já protegida
  // pelo requireAuth do router inteiro (ver server.js). Best-effort: qualquer
  // falha (site fora do ar, sem tags OG, bloqueado) devolve campos vazios em
  // vez de erro — o frontend só não mostra o cartão de prévia nesse caso.
  // ---------------------------------------------------------------
  router.get('/link-preview', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url é obrigatória' });

    const cached = linkPreviewCache.get(url);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.data);
    }

    let data;
    try {
      const parsed = await resolvePublicUrl(url);
      const html = await fetchHtmlSnippet(parsed);
      data = { url, ...extractOpenGraph(html, parsed) };
    } catch (err) {
      data = { url, title: null, description: null, image: null, siteName: null };
    }
    if (linkPreviewCache.size > 500) linkPreviewCache.clear(); // teto simples, sem LRU
    linkPreviewCache.set(url, { data, expiresAt: Date.now() + LINK_PREVIEW_TTL_MS });
    res.json(data);
  });

  // ---------------------------------------------------------------
  // POST /presence  { session, phone, state }
  // state: 'composing' (digitando) | 'recording' (gravando áudio) | 'paused'
  // (parou). Sentido empresa -> contato: avisa que quem está atendendo pelo
  // CRM está digitando/gravando, pro contato ver "digitando…" no WhatsApp
  // dele — não fica salvo em lugar nenhum, é só o repasse ao vivo.
  // ---------------------------------------------------------------
  router.post('/presence', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, state } = req.body || {};
    if (!phone || !state) return res.status(400).json({ error: 'phone e state são obrigatórios' });
    if (!['composing', 'recording', 'paused'].includes(state)) {
      return res.status(400).json({ error: 'state deve ser "composing", "recording" ou "paused"' });
    }

    try {
      const gateway = sessions.get(session);
      await gateway.sendPresence(phone, state);
      res.json({ ok: true });
    } catch (err) {
      console.error('[presence] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /react  { session, phone, messageId, emoji }
  // `emoji` vazio/omitido remove a reação já enviada. Reagir do lado do
  // atendente usa o mesmo mecanismo de store.setMessageReaction/broadcast
  // já usado quando o CONTATO reage (ver onReaction em server.js) — só que
  // aqui a reação parte da empresa (`direction: 'out'`).
  // ---------------------------------------------------------------
  router.post('/react', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, messageId, emoji } = req.body || {};
    if (!phone || !messageId) {
      return res.status(400).json({ error: 'phone e messageId são obrigatórios' });
    }

    try {
      // reaproveita getMessageForReply só pra achar quem enviou a mensagem
      // original (precisa disso pra montar a key que o Baileys espera).
      const target = await store.getMessageForReply(session, phone, messageId);
      if (!target) return res.status(404).json({ error: 'mensagem não encontrada' });

      const gateway = sessions.get(session);
      await gateway.sendReaction(phone, messageId, emoji, target.direction === 'out');
      await store.setMessageReaction(session, phone, messageId, emoji, 'out');
      broadcast(session, phone, { type: 'reaction', targetId: messageId, emoji: emoji || null, direction: 'out' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[react] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /send-media  { session, dealId, phone, type, mimetype, dataBase64, caption, fileName?, replyToId? }
  // `type` é 'image', 'audio', 'video' ou 'document'; `dataBase64` é o arquivo
  // sem o prefixo "data:...;base64," (o frontend já manda só a parte de
  // dados). `fileName` só se aplica (e é obrigatório) a 'document' — é o
  // nome mostrado no cartão de anexo, já que o WhatsApp não sabe renderizar
  // um documento genérico como mídia embutida.
  // ---------------------------------------------------------------
  router.post('/send-media', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, dealId, phone, type, mimetype, dataBase64, caption, fileName, replyToId, senderName } = req.body || {};

    if (!phone || !type || !mimetype || !dataBase64) {
      return res.status(400).json({ error: 'phone, type, mimetype e dataBase64 são obrigatórios' });
    }
    if (type !== 'image' && type !== 'audio' && type !== 'video' && type !== 'document') {
      return res.status(400).json({ error: 'type deve ser "image", "audio", "video" ou "document"' });
    }
    if (type === 'document' && !fileName) {
      return res.status(400).json({ error: 'fileName é obrigatório pra documentos' });
    }

    try {
      const buffer = Buffer.from(dataBase64, 'base64');
      const gateway = sessions.get(session);
      const replyTo = await resolveReplyTo(session, phone, replyToId);
      // sendMedia pode converter o áudio (ex: webm do navegador -> ogg/opus, que é
      // o formato que o WhatsApp de fato entrega) — sempre salvar os bytes/mimetype
      // que foram realmente enviados, não os originais recebidos do frontend.
      const { buffer: sentBuffer, mimetype: sentMimetype, ...sent } = await gateway.sendMedia(phone, {
        type,
        buffer,
        mimetype,
        caption,
        fileName,
        replyTo,
      });
      const mediaUrl = await saveMedia(session, sent.id, sentBuffer, sentMimetype);

      const message = {
        ...sent, type, text: caption || null, mediaUrl, mimetype: sentMimetype,
        replyToId: replyTo ? replyToId : null, fileName: type === 'document' ? fileName : null,
        sentBy: req.ownerId, sentByName: senderName || null, // mesma regra de /send: sentBy nunca vem do client
      };
      await store.addMessage(session, phone, message, dealId);

      broadcast(session, phone, { type: 'message', message });

      logMessageToTimeline(dealId, caption ? `[${type}] ${caption}` : `[${type}]`, 'out').catch((e) =>
        console.error('[bitrix] falha ao logar na timeline:', e.message)
      );

      res.json({ ok: true, message });
    } catch (err) {
      console.error('[send-media] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /presence/heartbeat  { page? }
  // Sinal periódico de "esta pessoa está com o app aberto agora", pro
  // painel admin (GET /admin/presence, ver src/adminAuth.js). QUALQUER
  // usuário autenticado manda heartbeat (não só admin) — é o próprio uso
  // do app que alimenta o painel; a restrição de QUEM VÊ os dados agregados
  // fica nas rotas GET /admin/* abaixo. `ownerName` nunca vem do body —
  // resolvido aqui a partir do próprio req.ownerId autenticado (mesma
  // regra de sentBy/isManager já usada em /send, nunca aceitar "quem eu
  // sou" vindo do client) via um nome já resolvido no frontend
  // (BX24.callMethod('user.current')) e mandado como texto solto, não como
  // identidade — se vier vazio, listPresence() simplesmente não tem nome
  // ainda pra essa linha.
  // ---------------------------------------------------------------
  router.post('/presence/heartbeat', async (req, res) => {
    try {
      const { page, ownerName } = req.body || {};
      await presence.heartbeat(req.ownerId, ownerName, page);
      res.json({ ok: true });
    } catch (err) {
      console.error('[presence] falha ao registrar heartbeat:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /page-session/open  { page, ownerName? }
  // Abre uma "visita" a uma página, com duração REAL (não aproximada pelo
  // ciclo do heartbeat) — ver src/pageSessions.js e HANDOFF Parte CO.
  // Devolve o sessionId que o frontend guarda e reusa em ping/close.
  // ---------------------------------------------------------------
  router.post('/page-session/open', async (req, res) => {
    try {
      const { page, ownerName } = req.body || {};
      if (!page) return res.status(400).json({ error: 'page é obrigatório' });
      const sessionId = await pageSessions.openSession(req.ownerId, ownerName, page);
      res.json({ sessionId });
    } catch (err) {
      console.error('[page-session] falha ao abrir:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /page-session/ping  { sessionId }
  // Sinal de "ainda aberta" a cada 30s (mesmo ciclo do heartbeat de
  // presença, reaproveitado) — atualiza last_ping_at. Não falha se o
  // sessionId já não existir/já ter sido fechado (idempotente o
  // suficiente pra não gerar erro no console a cada corrida entre
  // ping e close).
  // ---------------------------------------------------------------
  router.post('/page-session/ping', async (req, res) => {
    try {
      const { sessionId } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId é obrigatório' });
      await pageSessions.pingSession(sessionId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[page-session] falha ao pingar:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // POST /page-session/close NÃO fica aqui — precisa ser acessível SEM o
  // requireAuth global deste router (sendBeacon não permite header
  // Authorization), e este router inteiro já está atrás de requireAuth em
  // src/server.js (`app.use('/api/whatsapp', requireAuth, ...)`) ANTES de
  // rotear qualquer coisa aqui dentro — uma rota "sem auth" definida neste
  // arquivo nunca seria alcançada. Ver a rota real em src/server.js, montada
  // antes desse app.use.

  // ---------------------------------------------------------------
  // GET /admin/whoami
  // Só confirma se o usuário autenticado é super admin — usado pelo
  // frontend pra decidir se mostra o item "Admin" na sidebar/redireciona
  // pra fora de /admin.html. NÃO expõe a lista de admins pro client (só
  // um booleano); a proteção real está em requireSuperAdmin nas rotas
  // GET /admin/presence e GET /admin/employees abaixo.
  // ---------------------------------------------------------------
  router.get('/admin/whoami', (req, res) => {
    res.json({ isSuperAdmin: isSuperAdmin(req.ownerId) });
  });

  // ---------------------------------------------------------------
  // GET /admin/presence
  // Lista de quem já mandou heartbeat alguma vez (ver POST
  // /presence/heartbeat) — "online"/"offline" é calculado NO FRONTEND a
  // partir de lastSeenAt (nunca comparar timestamp gerado pelo Postgres
  // com Date.now() de outro processo, mesmo bug de clock skew do Painel de
  // atendimento, HANDOFF Parte CI). Restrito a super admin.
  // ---------------------------------------------------------------
  router.get('/admin/presence', requireSuperAdmin, async (req, res) => {
    try {
      const rows = await presence.listPresence();
      res.json({ presence: rows });
    } catch (err) {
      console.error('[admin] falha ao listar presença:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /admin/employees
  // Cadastro de funcionários vindo direto do Bitrix (user.get via
  // BITRIX_HR_WEBHOOK_URL, ver src/bitrixHierarchy.js — mesmo webhook já
  // usado pela hierarquia de departamento/gestor, sem integração nova).
  // hrConfigured:false (200, não erro) quando a variável não está
  // configurada — a tela mostra aviso claro em vez de lista vazia sem
  // explicação. Restrito a super admin.
  // ---------------------------------------------------------------
  router.get('/admin/employees', requireSuperAdmin, async (req, res) => {
    try {
      const employees = await listEmployees();
      if (employees === null) {
        return res.json({ employees: [], hrConfigured: false });
      }
      res.json({ employees, hrConfigured: true });
    } catch (err) {
      console.error('[admin] falha ao listar funcionários:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Limiar de "online" espelha o mesmo valor já usado no frontend
  // (admin.html, ONLINE_THRESHOLD_MS) — repetido aqui só pro backend
  // decidir o mesmo booleano na resposta de GET /admin/users, sem
  // comparar timestamp gerado pelo Postgres com Date.now() de outro
  // processo (mesma lição da Parte CI): last_seen_at vem do próprio
  // banco, comparado contra Date.now() DESTE processo — ainda é uma
  // comparação entre dois relógios, mas o mesmo tipo de comparação que
  // já era aceita no resto do sistema pra esse cálculo específico.
  const ADMIN_ONLINE_THRESHOLD_MS = 90 * 1000;
  const ADMIN_USAGE_WINDOW_DAYS = 30;

  // ---------------------------------------------------------------
  // GET /admin/users
  // Lista TODO o universo de funcionários do Bitrix (listEmployees —
  // inclusive quem nunca abriu o app, ver HANDOFF Parte CO), cruzado com
  // presença atual (admin_presence), último acesso e tempo total/página
  // favorita dos últimos 30 dias (page_sessions), e status de bloqueio
  // (blocked_owners). Restrito a super admin.
  // ---------------------------------------------------------------
  router.get('/admin/users', requireSuperAdmin, async (req, res) => {
    try {
      const employees = await listEmployees();
      if (employees === null) {
        return res.json({ users: [], hrConfigured: false });
      }

      const ownerIds = employees.map((e) => ownerIdFor(e.id));
      const sinceDate = new Date(Date.now() - ADMIN_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const [presenceRows, lastAccessMap, usage, blocked, activeDaysByOwner, usabilityByOwner] = await Promise.all([
        presence.listPresence(),
        pageSessions.getLastAccessByOwners(ownerIds),
        pageSessions.getUsageSince(sinceDate),
        blockedOwners.listBlocked(),
        // Rastreamento de usabilidade ampliado (2026-08-13, HANDOFF Parte
        // CZ) — frequência de acesso (dias distintos, não só tempo total).
        pageSessions.getActiveDaysByOwner(sinceDate),
        // Mensagens enviadas (30d), contatos cadastrados, campanhas criadas
        // (aproximado por DONO da instância — ver getUsabilityStatsByOwner).
        store.getUsabilityStatsByOwner(sinceDate),
      ]);

      const presenceByOwner = new Map(presenceRows.map((r) => [r.ownerId, r]));
      const blockedByOwner = new Map(blocked.map((b) => [b.ownerId, b]));

      const users = employees.map((e) => {
        const ownerId = ownerIdFor(e.id);
        const presenceRow = presenceByOwner.get(ownerId);
        const isOnline = !!presenceRow && Date.now() - new Date(presenceRow.lastSeenAt).getTime() < ADMIN_ONLINE_THRESHOLD_MS;
        const favoritePage = usage.favoritePageByOwner.get(ownerId);
        const blockedRow = blockedByOwner.get(ownerId);
        const usability = usabilityByOwner.get(ownerId);
        return {
          ownerId,
          name: e.name,
          email: e.email,
          photo: e.photo,
          workPosition: e.workPosition,
          dateRegister: e.dateRegister,
          // Campos ampliados do Bitrix (2026-08-13, HANDOFF Parte CY) — só
          // usados no modal "Detalhado" (openUserDetail, admin.html), a
          // tabela principal continua mostrando só os campos de sempre.
          mobile: e.mobile,
          workPhone: e.workPhone,
          city: e.city,
          birthday: e.birthday,
          lastLoginBitrix: e.lastLoginBitrix,
          employmentDate: e.employmentDate,
          departmentIds: e.departmentIds,
          isOnline,
          currentPage: presenceRow?.lastPage || null,
          lastAccess: lastAccessMap.get(ownerId) || null,
          totalSecondsLast30d: usage.totalByOwner.get(ownerId) || 0,
          favoritePage: favoritePage?.page || null,
          isBlocked: !!blockedRow,
          blockedReason: blockedRow?.reason || null,
          // Rastreamento de usabilidade ampliado (2026-08-13, HANDOFF Parte
          // CZ) — só usados no modal "Detalhado", mesma decisão dos campos
          // do Bitrix acima (tabela principal não muda).
          activeDaysLast30d: activeDaysByOwner.get(ownerId) || 0,
          messagesSentLast30d: usability?.messagesSent || 0,
          contactsTotal: usability?.contactsTotal || 0,
          campaignsTotal: usability?.campaignsTotal || 0,
        };
      });

      res.json({ users, hrConfigured: true });
    } catch (err) {
      console.error('[admin] falha ao listar usuários:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /admin/users/:ownerId
  // Histórico completo de navegação de UMA pessoa (page_sessions, mais
  // recentes primeiro) — pro botão "Detalhado" na tabela de Usuários.
  // Restrito a super admin.
  // ---------------------------------------------------------------
  router.get('/admin/users/:ownerId', requireSuperAdmin, async (req, res) => {
    try {
      const [history, actionHistory] = await Promise.all([
        pageSessions.getSessionHistory(req.params.ownerId),
        actionLog.getActionHistory(req.params.ownerId),
      ]);
      res.json({ history, actionHistory });
    } catch (err) {
      console.error('[admin] falha ao buscar histórico do usuário:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /admin/usage-metrics?days=30
  // Agregados do topo do Admin (online agora, usuários ativos, tempo
  // total do time, página mais acessada) + os 2 gráficos de barra
  // (páginas mais acessadas por CONTAGEM de visitas; onde o time passa
  // mais tempo por DURAÇÃO somada — números diferentes de propósito).
  // Restrito a super admin.
  // ---------------------------------------------------------------
  router.get('/admin/usage-metrics', requireSuperAdmin, async (req, res) => {
    try {
      const days = Number(req.query.days) || ADMIN_USAGE_WINDOW_DAYS;
      const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const [presenceRows, usage, dailyByPageMap] = await Promise.all([
        presence.listPresence(),
        pageSessions.getUsageSince(sinceDate),
        // Detalhamento por dia, só pro tooltip dos 2 gráficos (ver
        // getDailyBreakdownByPage) — query separada de getUsageSince
        // porque o agrupamento por dia muda o group by inteiro.
        pageSessions.getDailyBreakdownByPage(sinceDate),
      ]);

      const onlineNow = presenceRows.filter(
        (r) => Date.now() - new Date(r.lastSeenAt).getTime() < ADMIN_ONLINE_THRESHOLD_MS
      ).length;
      const activeUsers = usage.totalByOwner.size;
      const totalSeconds = [...usage.totalByOwner.values()].reduce((sum, s) => sum + s, 0);
      const topPage = usage.mostVisitedPages[0]?.page || null;

      res.json({
        onlineNow,
        activeUsers,
        totalSecondsAllUsers: totalSeconds,
        topPage,
        mostVisitedPages: usage.mostVisitedPages.slice(0, 15),
        mostTimeSpentPages: usage.mostTimeSpentPages.slice(0, 15),
        // { [page]: [{date, visits, durationSeconds}, ...] } — Map não
        // serializa em JSON.stringify (vira {}), precisa virar objeto plano.
        dailyByPage: Object.fromEntries(dailyByPageMap),
      });
    } catch (err) {
      console.error('[admin] falha ao calcular métricas de uso:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /admin/users/:ownerId/block  { reason? }
  // "Revogar" na tabela de Usuários — bloqueia o ownerId de usar o app
  // inteiro, verificado em toda request autenticada (ver requireAuth,
  // src/auth.js). Nunca aceita bloquear o PRÓPRIO ownerId autenticado —
  // trava de segurança contra o super admin se trancar fora por engano.
  // Restrito a super admin.
  // ---------------------------------------------------------------
  router.post('/admin/users/:ownerId/block', requireSuperAdmin, async (req, res) => {
    const { ownerId } = req.params;
    if (ownerId === req.ownerId) {
      return res.status(400).json({ error: 'você não pode bloquear a si mesmo' });
    }
    try {
      await blockedOwners.blockOwner(ownerId, req.ownerId, req.body?.reason);
      res.json({ ok: true });
    } catch (err) {
      console.error('[admin] falha ao bloquear usuário:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /admin/users/:ownerId/unblock
  // "Reativar" na tabela de Usuários. Restrito a super admin.
  // ---------------------------------------------------------------
  router.post('/admin/users/:ownerId/unblock', requireSuperAdmin, async (req, res) => {
    try {
      await blockedOwners.unblockOwner(req.params.ownerId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[admin] falha ao desbloquear usuário:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /admin/diagnostics/sessions
  // Diagnóstico TEMPORÁRIO (HANDOFF Parte CP) — lista as sessões já em
  // memória no processo (sem criar nenhuma), pra saber quais estão online
  // agora e por isso capazes de resolver LID->telefone de verdade. Só
  // leitura. Restrito a super admin.
  // ---------------------------------------------------------------
  router.get('/admin/diagnostics/sessions', requireSuperAdmin, (req, res) => {
    res.json({ sessions: sessions.listActive() });
  });

  // ---------------------------------------------------------------
  // POST /admin/diagnostics/resolve-lid
  // Diagnóstico TEMPORÁRIO (HANDOFF Parte CP) — recebe { sessionId,
  // lidNumbers: [...] } e tenta resolver cada um pro telefone real via o
  // socket JÁ CONECTADO daquela sessão (signalRepository.lidMapping,
  // mesmo mecanismo de _resolveLidPhone). SÓ LEITURA — não altera nenhuma
  // linha do banco, não abre conexão nova, não envia nada pro WhatsApp.
  // Usa sessions.listActive() (não sessions.get()) de propósito: nunca
  // cria/inicia uma sessão só de tentar diagnosticar. 400 se a sessão não
  // estiver online agora (não tem como resolver sem um socket real).
  // Restrito a super admin. Remover esta rota depois que a investigação
  // das conversas antigas (HANDOFF Parte CP) for concluída.
  // ---------------------------------------------------------------
  router.post('/admin/diagnostics/resolve-lid', requireSuperAdmin, async (req, res) => {
    const { sessionId, lidNumbers } = req.body || {};
    if (!sessionId || !Array.isArray(lidNumbers) || !lidNumbers.length) {
      return res.status(400).json({ error: 'sessionId e lidNumbers (array) são obrigatórios' });
    }
    if (lidNumbers.length > 500) {
      return res.status(400).json({ error: 'máximo 500 números por chamada' });
    }
    const active = sessions.listActive().find((s) => s.sessionId === sessionId);
    if (!active || active.status !== 'online') {
      return res.status(400).json({ error: `sessão "${sessionId}" não está online agora (status: ${active?.status || 'não encontrada em memória'})` });
    }
    const gateway = sessions.getActiveGateway(sessionId);
    const results = {};
    for (const lidNumber of lidNumbers) {
      try {
        results[lidNumber] = await gateway.resolveLidToPhone(String(lidNumber));
      } catch (err) {
        results[lidNumber] = null;
      }
    }
    res.json({ sessionId, results });
  });

  return router;
}

module.exports = { createWhatsappRouter };
