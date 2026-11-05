const express = require('express');
const PDFDocument = require('pdfkit');
const store = require('../store');
const { logMessageToTimeline, logConversationSummaryToTimeline } = require('../bitrix');
const { saveMedia, downloadMediaByFilename } = require('../media');
const { computeMetrics, computeTeamMetrics, getOwnNumbersBySession } = require('../metrics');
const { createCampaign, getCampaign, runCampaign } = require('../campaigns');
const { computeCampaignMetrics } = require('../campaignStore');
const scheduledStore = require('../scheduledCampaigns');
const scheduler = require('../scheduler');
const instancesStore = require('../instances');
const instanceHealthStore = require('../instanceHealthStore');
const instanceBanStore = require('../instanceBanStore');
const { summarizeConversation, generateDashboardInsights, generateTeamInsights } = require('../openai');
const { getStageDistribution } = require('../bitrixCrm');
const { requireSession, requireResourceSession, requireOwnerMatch, requireResourceOwner, assertOwnsSession } = require('../authz');
const { getSubordinates, listEmployees, listEmployeesWithDepartment, listDepartments, listEmployeesInDepartment } = require('../bitrixHierarchy');
const { resolvePublicUrl, fetchHtmlSnippet, extractOpenGraph } = require('../linkPreview');
const presence = require('../presence');
const pageSessions = require('../pageSessions');
const blockedOwners = require('../blockedOwners');
const { requireSuperAdmin, isSuperAdmin } = require('../adminAuth');
const { publishFeedPost, recordFeedPost, listFeedPosts } = require('../bitrixFeed');
const conversationAnalysisGrants = require('../conversationAnalysisGrants');
const { ownerIdFor } = require('../auth');
const { buildPhoneAudit, buildPhoneAuditWorkbook } = require('../phoneAudit');
const actionLog = require('../actionLog');
const webpush = require('../webpush');

// Cache simples em memória (por processo — reseta num restart, tudo bem):
// metadados de uma página raramente mudam num intervalo curto, e evita
// buscar a mesma URL de novo a cada vez que a mensagem é renderizada.
const linkPreviewCache = new Map(); // url -> { data, expiresAt }
// Deduplicação do POST /send pelo id gerado no Chat (clientMsgId) — ver a rota.
const SEND_ID_RE = /^3EB0[0-9A-F]{18}$/;
const sendsInFlight = new Map(); // `${session}|${id}` -> Promise<message>
const sendsDone = new Map(); // `${session}|${id}` -> message (os mais recentes)
const SENDS_DONE_MAX = 5000;
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
// 2026-11-04: de 3 para 5 (equipe de vendas com vários chips). MAX_INSTANCES_PER_OWNER ajusta sem código.
const MAX_INSTANCES_PER_OWNER = Number(process.env.MAX_INSTANCES_PER_OWNER) || 5;

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
// "Contato sem foto de perfil" lembrado em memória (ver GET /avatar).
const AVATAR_MISS_TTL_MS = 6 * 60 * 60 * 1000;
const AVATAR_MISS_MAX = 50000;
const avatarMisses = new Map(); // `${session}|${phone}` -> expira em (ms epoch)

// Teto de consultas de foto AO VIVO por instância (ver GET /avatar).
const AVATAR_MAX_LIVE_PER_SESSION = Number(process.env.AVATAR_MAX_LIVE_PER_SESSION || 2);
const AVATAR_MAX_QUEUED_PER_SESSION = Number(process.env.AVATAR_MAX_QUEUED_PER_SESSION || 25);
const AVATAR_LIVE_TIMEOUT_MS = Number(process.env.AVATAR_LIVE_TIMEOUT_MS || 8000);
const avatarSlots = new Map(); // session -> { active, queue: [resolve...] }

// Roda `fn` respeitando o teto por instância. Devolve { value } normalmente,
// { busy: true } se a fila da instância já está cheia, ou { timedOut: true }
// se a consulta passou de AVATAR_LIVE_TIMEOUT_MS (o slot é liberado na hora;
// a consulta atrasada termina sozinha e o resultado dela é descartado).
async function withAvatarSlot(session, fn) {
  let slot = avatarSlots.get(session);
  if (!slot) { slot = { active: 0, queue: [] }; avatarSlots.set(session, slot); }
  if (slot.active >= AVATAR_MAX_LIVE_PER_SESSION) {
    if (slot.queue.length >= AVATAR_MAX_QUEUED_PER_SESSION) return { busy: true };
    await new Promise((resolve) => slot.queue.push(resolve)); // o slot é entregue por quem libera (active não muda)
  } else {
    slot.active++;
  }
  let timer;
  try {
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), AVATAR_LIVE_TIMEOUT_MS); });
    return await Promise.race([Promise.resolve(fn()).then((value) => ({ value })), timeout]);
  } finally {
    clearTimeout(timer);
    const next = slot.queue.shift();
    if (next) next();
    else {
      slot.active--;
      if (slot.active === 0 && !slot.queue.length) avatarSlots.delete(session);
    }
  }
}

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
    // `phone` opcional (2026-08-30, mini-chat embutido no card do
    // Negócio/Contato, public/index.html) — quando informado, cada
    // instância retornada ganha `hasHistory: true/false` (já existe
    // conversa com esse número nela). Sem esse parâmetro, comportamento
    // idêntico a antes (chat.html/instances.html nunca passam `phone`
    // aqui, sem custo extra pra eles). Ver getSessionsWithHistory —
    // resolve o bug real onde o app sempre escolhia a 1ª instância do
    // owner pra abrir um card, mesmo com a conversa de verdade já
    // existindo (e conectada) em outra instância da mesma conta.
    // `typeof === 'string'` rejeita array (`?phone=a&phone=b`) antes de
    // chegar na query parametrizada (achado do security-reviewer-agent
    // — sem isso, virava 502 por erro de tipo ao bindar array num
    // parâmetro `text` do Postgres); `.slice(0, 30)` é um teto de
    // tamanho generoso (E.164 real tem no máximo 15 dígitos) — não é
    // proteção contra injeção (a query já é parametrizada, imune a
    // isso), só um limite de robustez consistente com a falta de
    // validação de formato de `phone` já presente em outras rotas deste
    // arquivo.
    const phone = typeof req.query.phone === 'string' ? req.query.phone.slice(0, 30) || null : null;
    try {
      // SEM ensureDefault aqui de propósito (removido 2026-09-30) — chamava
      // sempre, incondicionalmente, então o simples fato de abrir o Chat
      // (chat.html, ponto de entrada padrão do app) já recriava a
      // "Principal" no Postgres mesmo pra quem nunca conectou nada. Isso
      // não pegava na correção do item 17 (GET /instances/status, usada só
      // por instances.html) porque chat.html/index.html continuavam
      // batendo NESTA rota, que recriava a instância de novo antes mesmo
      // da pessoa abrir a tela de Conexões — usuário confirmou com dois
      // colaboradores reais (Henrique/Caio) que a Principal órfã voltava a
      // aparecer e nem sumia removendo manualmente (porque a cada reload
      // do Chat ela era recriada de novo). A instância "Principal" só é
      // persistida de verdade pelo fluxo de QR + POST /instances/confirm-default
      // (ver instances.html), nunca mais implicitamente aqui.
      const list = await instancesStore.listAccessible(owner); // próprias + delegadas (ver instance_delegates)
      const ownNumbers = getOwnNumbersBySession();
      const sessionsWithHistory = phone
        ? new Set(await store.getSessionsWithHistory(list.map((i) => i.id), phone))
        : null;
      // Nome do dono (pelo ID do Bitrix) — só resolvido/exibido pra
      // instância DELEGADA (i.delegated), onde "de quem é" é informação
      // nova pra quem está olhando; a própria instância já é óbvio de
      // quem é (best-effort: null se BITRIX_HR_WEBHOOK_URL não estiver
      // configurada, sem quebrar o resto da lista).
      const needsOwnerName = list.some((i) => i.delegated);
      const employees = needsOwnerName ? await listEmployees() : null;
      const nameByOwnerId = employees ? new Map(employees.map((e) => [ownerIdFor(e.id), e.name])) : new Map();
      // Instâncias "banidas" (ver src/instanceBanStore.js: forbidden aberto
      // há mais de 24h) — 1 query pro lote inteiro, não 1 por instância.
      const bannedSet = new Set((await instanceBanStore.listBannedNow()).map((e) => e.instanceId));
      const withStatus = await Promise.all(list.map(async (i) => {
        let gateway = null;
        let status = 'offline';
        try {
          // Só inicia (sessions.get) sessão JÁ PAREADA (tem número em
          // ownNumbers) — é assim que o boot preguiçoso as sobe quando o dono
          // abre o app. Instância NUNCA pareada (sem creds) não é iniciada
          // aqui: antes, toda abertura do Chat criava um socket+QR pra cada
          // uma delas (medido em produção: ~100 sessões não pareadas em loop
          // de reconexão/timeout 408, ~2.100 eventos "connecting" em 30 min,
          // CPU e reputação junto ao WhatsApp gastas à toa). O QR continua
          // sendo gerado quando a pessoa de fato abre a tela de pareamento
          // (GET /qr, POST /instances), que chamam sessions.get direto.
          gateway = sessions.getActiveGateway(i.id) || (ownNumbers[i.id] ? sessions.get(i.id) : null);
          if (gateway) status = gateway.getStatus();
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
        // Alerta de instância caída (ver src/instanceHealthStore.js) — a
        // queda em aberto AGORA, se houver, alimenta o indicador de duração
        // no card ("fora do ar há Xh") sem precisar de uma 2ª chamada por
        // instância visível na tela.
        const openConnectionEvent = await instanceHealthStore.getOpenConnectionEvent(i.id);
        const ownerName = i.delegated ? (nameByOwnerId.get(i.ownerId) || null) : null;
        const hasHistory = sessionsWithHistory ? sessionsWithHistory.has(i.id) : undefined;
        const banned = bannedSet.has(i.id);
        return { ...i, status, phone: ownNumbers[i.id] || null, groupCount, contactCount, needsAttention, lastDisconnectReason, banned, openConnectionEvent, ownerName, hasHistory };
      }));
      res.json({ instances: withStatus, limit: MAX_INSTANCES_PER_OWNER });
    } catch (err) {
      console.error('[instances] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /instances/status  (2026-09-30)
  // Mesma lista de GET /instances, mas SEM `ensureDefault` — não cria a
  // "Principal" automaticamente. Usada só por instances.html no carregamento
  // inicial, pra decidir entre "grid de instâncias" (owner já tem alguma) e
  // "mostrar QR direto" (owner não tem nenhuma ainda — ver POST
  // /instances/confirm-default, chamado só depois de confirmado o
  // pareamento). Sem essa rota, o simples fato de abrir a tela já gravava
  // uma linha "Principal" no Postgres mesmo que o usuário fechasse a aba
  // sem escanear nada — causa raiz das dezenas de instâncias órfãs
  // "ainda não pareado" vistas em produção (ROADMAP itens 5/13). Precisa
  // vir ANTES da rota GET /instances (mesmo prefixo /instances) — Express
  // casa rotas na ordem declarada, e /instances/:id em outro arquivo
  // poderia capturar "/status" como :id se esta viesse depois.
  // ---------------------------------------------------------------
  router.get('/instances/status', requireOwnerMatch((req) => req.query.owner), async (req, res) => {
    try {
      const list = await instancesStore.listByOwner(req.query.owner);
      res.json({ hasInstance: list.length > 0 });
    } catch (err) {
      console.error('[instances:status] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // POST /instances/confirm-default  { owner }  (2026-09-30)
  // Persiste a instância "Principal" (mesmo id/convenção de
  // instancesStore.ensureDefault: id === ownerId) SÓ quando o pareamento
  // já foi confirmado de verdade — chamado pelo frontend (instances.html)
  // assim que o polling de GET /qr?session=<owner> devolve status:'online'
  // no fluxo de primeiro acesso (zero instâncias). Idempotente (mesmo
  // "on conflict do nothing" de ensureDefault) — seguro chamar mais de uma
  // vez. Não inicia sessão nenhuma (já está rodando desde que GET /qr foi
  // chamado, ver SessionManager.get()) — só grava a linha no Postgres pra
  // essa sessão já pareada passar a aparecer no grid normal a partir daqui.
  // ---------------------------------------------------------------
  router.post('/instances/confirm-default', requireOwnerMatch((req) => req.body?.owner), async (req, res) => {
    const owner = req.body?.owner;
    try {
      const gateway = sessions.get(owner);
      if (gateway.getStatus() !== 'online') {
        return res.status(409).json({ error: 'sessão ainda não está conectada' });
      }
      await instancesStore.ensureDefault(owner);
      actionLog.logAction(owner, 'instance_created', 'Principal');
      res.json({ ok: true });
    } catch (err) {
      console.error('[instances:confirm-default] erro:', err.message);
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
      // listByOwner (não ensureDefault) — este endpoint só precisa CONTAR
      // quantas instâncias já existem pro limite abaixo; ensureDefault
      // criaria uma "Principal" vazia por engano se chamado aqui sem
      // nenhuma instância ainda existir (ex: botão "+ Conectar outro
      // WhatsApp" clicado antes de confirmar a Principal via QR — ver
      // POST /instances/confirm-default e a remoção de ensureDefault de
      // GET /instances, mesmo motivo, 2026-09-30).
      const existing = await instancesStore.listByOwner(owner);
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
  // (ex: funcionários), sem contar contra o limite de instâncias de quem recebe. Só
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
  // POST/DELETE /admin/instances/:id/delegates
  // Super admin força um compartilhamento manual entre duas pessoas
  // quaisquer, sem precisar ser o dono da instância nem depender da
  // hierarquia automática do Bitrix — pedido do usuário 2026-10-01, logo
  // depois de desativar a delegação automática por hierarquia (questão de
  // privacidade: gestor não deve ver conversa de subordinado sem uma regra
  // explícita) e observando que a árvore de departamentos do Bitrix às
  // vezes está incorreta/desatualizada ("se der pra eu escolher qual
  // usuário é o gestor... seria bom"). Usa a MESMA tabela
  // instance_delegates de "Compartilhar acesso" (instances.html) — pro
  // resto do sistema (assertOwnsSession, listAccessible) não há diferença
  // entre uma delegação criada pelo próprio dono ou forçada pelo admin.
  // ---------------------------------------------------------------
  // Leitura dos delegados atuais, do ponto de vista do ADMIN (sem
  // requireOwnerMatch, que exigiria o admin SER o dono da instância — não é
  // o caso aqui, de propósito, ele está olhando a instância de outra
  // pessoa).
  router.get('/admin/instances/:id/delegates', requireSuperAdmin, async (req, res) => {
    try {
      res.json({ delegates: await instancesStore.listDelegates(req.params.id) });
    } catch (err) {
      console.error('[admin:instances:delegates] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/admin/instances/:id/delegates', requireSuperAdmin, async (req, res) => {
    const { delegateOwnerId, delegateName } = req.body || {};
    if (!delegateOwnerId) return res.status(400).json({ error: 'delegateOwnerId é obrigatório' });
    try {
      await instancesStore.addDelegateAsAdmin(req.params.id, delegateOwnerId, delegateName);
      res.json({ ok: true });
    } catch (err) {
      console.error('[admin:instances:delegates] erro:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/admin/instances/:id/delegates/:delegateOwnerId', requireSuperAdmin, async (req, res) => {
    try {
      await instancesStore.removeDelegateAsAdmin(req.params.id, req.params.delegateOwnerId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[admin:instances:delegates] erro:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // Compartilhar por departamento (admin) — em vez de compartilhar instância
  // por instância, concede a UMA pessoa (ex: gestora) acesso às instâncias
  // de todos os colaboradores de um departamento, opcionalmente com os
  // sub-departamentos em cascata. NÃO é automático: é uma ação manual do
  // super admin que grava em instance_delegates (mesma tabela do
  // compartilhamento individual, removível um a um) e vale como um retrato
  // do momento — quem entrar no departamento depois não é incluído até o
  // admin rodar de novo (idempotente). `dryRun` só conta, não grava.
  // ---------------------------------------------------------------
  router.get('/admin/departments', requireSuperAdmin, async (req, res) => {
    try {
      const departments = await listDepartments();
      if (departments === null) return res.json({ departments: [], hrConfigured: false });
      res.json({ departments, hrConfigured: true });
    } catch (err) {
      console.error('[admin:departments] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  async function resolveDepartmentTargets(body) {
    const { delegateOwnerId, departmentId, includeSubdepartments } = body || {};
    if (!delegateOwnerId || !departmentId) {
      const e = new Error('delegateOwnerId e departmentId são obrigatórios');
      e.status = 400;
      throw e;
    }
    const found = await listEmployeesInDepartment(departmentId, !!includeSubdepartments);
    if (!found) {
      const e = new Error('não foi possível consultar os departamentos no Bitrix');
      e.status = 502;
      throw e;
    }
    const ownerIds = found.employees.map((emp) => ownerIdFor(emp.id)).filter((id) => id !== delegateOwnerId);
    const instances = await instancesStore.listByOwners(ownerIds);
    return {
      delegateOwnerId,
      departmentCount: found.departmentIds.length,
      peopleCount: found.employees.length,
      ownersWithInstances: new Set(instances.map((i) => i.ownerId)).size,
      instanceIds: instances.map((i) => i.id),
    };
  }

  router.post('/admin/department-grants', requireSuperAdmin, async (req, res) => {
    try {
      const t = await resolveDepartmentTargets(req.body);
      const summary = {
        departmentCount: t.departmentCount,
        peopleCount: t.peopleCount,
        ownersWithInstances: t.ownersWithInstances,
        instanceCount: t.instanceIds.length,
      };
      if (req.body.dryRun) return res.json({ dryRun: true, ...summary });
      await instancesStore.addDelegatesBulkAsAdmin(t.instanceIds, t.delegateOwnerId, req.body.delegateName);
      console.log(`[admin:department-grants] ${req.ownerId} concedeu ${t.instanceIds.length} instância(s) do depto ${req.body.departmentId} a ${t.delegateOwnerId}`);
      res.json({ ok: true, ...summary });
    } catch (err) {
      console.error('[admin:department-grants] erro:', err.message);
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  router.post('/admin/department-grants/revoke', requireSuperAdmin, async (req, res) => {
    try {
      const t = await resolveDepartmentTargets(req.body);
      const removed = await instancesStore.removeDelegatesBulkAsAdmin(t.instanceIds, t.delegateOwnerId);
      console.log(`[admin:department-grants] ${req.ownerId} revogou ${removed} compartilhamento(s) do depto ${req.body.departmentId} de ${t.delegateOwnerId}`);
      res.json({ ok: true, removed });
    } catch (err) {
      console.error('[admin:department-grants] erro:', err.message);
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /instances/:id/health?owner=
  // Alerta de instância caída — histórico de queda/retorno + série de
  // métricas diárias (ver src/instanceHealthStore.js). Diferente das
  // rotas de AÇÃO acima (reconnect/delete/put, restritas só ao DONO
  // real) — esta é uma rota de LEITURA, então aceita também DELEGADO
  // (instance_delegates) E gestor por hierarquia automática do Bitrix
  // (mesmo critério de assertOwnsSession/listAccessible — achado real
  // 2026-09-16: um gestor via a instância do subordinado normalmente na
  // listagem geral, mas o histórico dela dava "instância não encontrada"
  // porque esta rota checava posse com uma regra própria, mais restrita,
  // que nunca considerava hierarquia). requireOwnerMatch só impede
  // spoofing de identidade (o owner do query precisa bater com o token) —
  // a checagem de posse de fato é a de baixo.
  // ---------------------------------------------------------------
  router.get('/instances/:id/health', requireOwnerMatch((req) => req.query.owner), async (req, res) => {
    const owner = req.query.owner;
    try {
      const hasAccess = await assertOwnsSession(req.params.id, owner);
      if (!hasAccess) return res.status(404).json({ error: 'instância não encontrada' });
      const [openEvent, events, metrics] = await Promise.all([
        instanceHealthStore.getOpenConnectionEvent(req.params.id),
        instanceHealthStore.listConnectionEvents(req.params.id),
        instanceHealthStore.listMetricsDaily(req.params.id),
      ]);
      res.json({ openEvent, events, metrics });
    } catch (err) {
      console.error('[instances:health] erro:', err.message);
      res.status(502).json({ error: err.message });
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
      const missKey = `${session}|${phone}`;
      if (!url) {
        // Cache NEGATIVO (2026-10-30): contato sem foto nunca era gravado
        // (só `if (url)`), então toda renderização da lista de conversas
        // perguntava de novo ao WhatsApp — 1.173 dos 2.008 pedidos barrados
        // por rate limit em 2h eram /avatar. Lembra o "sem foto" em memória.
        const missUntil = avatarMisses.get(missKey);
        if (missUntil && missUntil > Date.now()) {
          res.set('Cache-Control', 'private, max-age=3600');
          return res.json({ url: null });
        }
        const gateway = sessions.get(session);
        // Consulta ao WhatsApp com TETO de concorrência por instância e de
        // espera (2026-10-30): medido em produção, 693 pedidos de /avatar
        // levaram 9,9s em média (149 acima de 15s) porque o Chat pedia a foto
        // de todas as conversas ao mesmo tempo e cada uma é uma consulta ao
        // vivo no socket do WhatsApp, que as enfileira. Aqui no máximo
        // AVATAR_MAX_LIVE_PER_SESSION rodam juntas por instância; o excesso
        // espera na fila e, se a fila passar do limite ou a consulta passar do
        // tempo, responde "sem foto agora" SEM gravar cache de ausência (o
        // Chat tenta de novo depois).
        const outcome = await withAvatarSlot(session, () => gateway.getProfilePicture(phone));
        if (outcome.busy) {
          res.set('Cache-Control', 'no-store');
          return res.json({ url: null, busy: true });
        }
        url = outcome.value;
        if (url) await store.setAvatarUrl(session, phone, url);
        else if (!outcome.timedOut) {
          if (avatarMisses.size >= AVATAR_MISS_MAX) avatarMisses.delete(avatarMisses.keys().next().value);
          avatarMisses.set(missKey, Date.now() + AVATAR_MISS_TTL_MS);
        } else {
          res.set('Cache-Control', 'no-store');
          return res.json({ url: null });
        }
      }
      res.set('Cache-Control', 'private, max-age=600'); // o navegador também não repergunta a cada render
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

  // ---------------------------------------------------------------
  // GET /notifications/latest-unread?owner=...
  // Toast em tempo real (HANDOFF Parte DG) — reaproveita o heartbeat de
  // 30s já disparado em toda tela (não é um canal push dedicado). O
  // frontend decide o que é "novo" comparando IDs contra um Set já visto
  // (sessionStorage, sobrevive a navegar entre as 13 telas na mesma aba) —
  // nunca comparando timestamp de client com o do servidor.
  // ---------------------------------------------------------------
  router.get('/notifications/latest-unread', requireOwnerMatch((req) => req.query.owner), async (req, res) => {
    try {
      res.json({ notifications: await store.listLatestUnreadNotifications(req.query.owner, 5) });
    } catch (err) {
      console.error('[notifications:latest-unread] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // Web Push (Service Worker) — ver src/webpush.js. Diferente das rotas
  // acima (que leem o histórico já persistido), estas gerenciam a
  // INSCRIÇÃO em si. Nunca usam req.query.owner/req.body.owner — sempre
  // req.ownerId (já verificado por requireAuth), pra ninguém se inscrever
  // no lugar de outro dono.
  // ---------------------------------------------------------------
  router.get('/notifications/push-public-key', (req, res) => {
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
  });

  router.post('/notifications/push-subscribe', async (req, res) => {
    const { endpoint, keys } = req.body?.subscription || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'subscription inválida' });
    }
    try {
      await webpush.saveSubscription(req.ownerId, { endpoint, p256dh: keys.p256dh, auth: keys.auth });
      res.json({ ok: true });
    } catch (err) {
      console.error('[notifications:push-subscribe] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/notifications/push-unsubscribe', async (req, res) => {
    try {
      if (req.body?.endpoint) await webpush.removeSubscription(req.body.endpoint);
      res.json({ ok: true });
    } catch (err) {
      console.error('[notifications:push-unsubscribe] erro:', err.message);
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
  // que era mídia 100% pública sem nenhuma autenticação) pode pedir esse
  // arquivo. `requireAuth` (server.js) já protege essa rota, igual a todas
  // as outras de /api/whatsapp.
  //
  // PROXY dos bytes (não redirect) — antes fazia `res.redirect(302, signedUrl)`
  // pro Supabase Storage; o frontend busca essa rota via fetch() autenticado
  // (Authorization: Bearer, ver hydrateOneMedia em chat.html/index.html), e
  // um redirect cross-origin nesse fetch depende do bucket do Supabase ter
  // CORS liberado pro domínio do app — causava "Não foi possível carregar"
  // intermitente (áudio/imagem às vezes carregava, às vezes não, sem relação
  // com o arquivo em si). Baixando aqui e reenviando os bytes direto, o
  // fetch nunca sai do nosso próprio domínio (usuário reportou 2026-09-29,
  // ver ROADMAP item 10/11).
  // ---------------------------------------------------------------
  router.get('/media/:filename', async (req, res) => {
    try {
      const { buffer, contentType } = await downloadMediaByFilename(req.params.filename);
      res.set('Content-Type', contentType || 'application/octet-stream');
      // SEM Cache-Control permissivo aqui de propósito — uma versão anterior
      // desta rota usava `private, max-age=3600`, e qualquer resposta salva
      // no cache do navegador ANTES da mídia existir de verdade (ex: 404
      // batido durante a corrida de upload, ou a versão antiga desta rota
      // que fazia redirect e podia falhar por CORS) ficava presa lá por até
      // 1h, servida direto do disco sem nunca mais perguntar ao servidor —
      // "Tentar de novo" clicado pelo usuário parecia não fazer nada porque
      // o navegador respondia do cache, sem nem chegar aqui (usuário
      // reportou 2026-09-29: continuava idêntico mesmo após o deploy da
      // correção anterior; Network do DevTools confirmou "disk cache" nas
      // requisições de mídia). `no-store` força sempre buscar de novo.
      res.set('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (err) {
      console.error('[media] erro:', err.message);
      res.set('Cache-Control', 'no-store');
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
    const gateway = sessions.get(req.query.session, { wantQr: true });
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
  // ---------------------------------------------------------------
  // POST /conversations/sync { session, phone }
  // Pede ao celular as últimas mensagens dessa conversa (ver
  // WhatsAppGateway.syncConversation). Responde na hora; as mensagens que faltavam
  // chegam em alguns segundos e entram na conversa (o Chat recarrega sozinho).
  // ---------------------------------------------------------------
  const syncCooldown = new Map(); // session::phone -> último pedido (evita martelar o celular)
  router.post('/conversations/sync', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    const key = session + '::' + phone;
    if (Date.now() - (syncCooldown.get(key) || 0) < 20000) return res.json({ ok: true, throttled: true });
    syncCooldown.set(key, Date.now());
    if (syncCooldown.size > 5000) syncCooldown.clear();
    try {
      const anchor = await store.getLatestMessageKey(session, phone);
      if (!anchor) return res.status(400).json({ error: 'conversa sem mensagens para sincronizar' });
      const gateway = sessions.getActiveGateway(session) || sessions.get(session);
      if (gateway.getStatus() !== 'online') return res.status(409).json({ error: 'WhatsApp não está conectado no momento' });
      await gateway.syncConversation(phone, anchor, 50);
      res.json({ ok: true });
    } catch (err) {
      console.error('[conversations:sync] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

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
  // POST /conversations/pending  { session, phone, pending }
  // Marca/desmarca "pendente" MANUALMENTE (ver db/schema.sql,
  // pending_manual) — diferente do indicador automático (unreadCount > 0),
  // este é setável pelo próprio atendente (ou pelo Dapinho, a pedido dele
  // — ver src/dapinho.js), mesmo padrão de POST /conversations/archive
  // acima.
  // ---------------------------------------------------------------
  router.post('/conversations/pending', requireSession((req) => req.body?.session), async (req, res) => {
    const { session, phone, pending } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      await store.setConversationPendingManual(session, phone, !!pending);
      res.json({ ok: true });
    } catch (err) {
      console.error('[conversations:pending] erro:', err.message);
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
  // Histórico daquele telefone na sessão do usuário (ao abrir a aba) —
  // só a página MAIS RECENTE (50 mensagens, ver store.getHistoryPage).
  // Paginação de verdade adicionada 2026-09-30 (pedido do usuário —
  // conversa longa carregava até 500 mensagens + tentava baixar toda a
  // mídia de cara, mesmo fora da tela). Página seguinte (mais antiga) via
  // GET /history/older, chamada pelo frontend ao rolar pro topo da lista.
  // ---------------------------------------------------------------
  router.get('/history', requireSession((req) => req.query.session), async (req, res) => {
    const { session, dealId, phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });

    try {
      const gateway = sessions.get(session);
      const { messages, hasMore } = await store.getHistoryPage(session, phone, { limit: 50 });

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
      // POST /conversations/summary pra (re)gerar. Continua usando
      // store.getHistory (não paginado) — o resumo por IA precisa do
      // contexto completo da conversa, não só da última página.
      const { aiSummary, aiSummaryUpdatedAt } = await store.getConversationSummary(session, phone);

      res.json({
        messages,
        hasMore,
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
  // GET /history/older?session=...&phone=...&before=<ISO date>
  // Página anterior (mais antiga) do histórico — chamada ao rolar pro
  // topo da lista de mensagens já aberta. `before` é o createdAt da
  // mensagem mais antiga já carregada no cliente (ver store.getHistoryPage).
  // ---------------------------------------------------------------
  router.get('/history/older', requireSession((req) => req.query.session), async (req, res) => {
    const { session, phone, before } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    if (!before) return res.status(400).json({ error: 'before é obrigatório' });

    try {
      const { messages, hasMore } = await store.getHistoryPage(session, phone, { before, limit: 50 });
      res.json({ messages, hasMore });
    } catch (err) {
      console.error('[history:older] erro:', err.message);
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
    // Resumo com IA desligado (2026-11-05, decisão do Gabriel): sem OPENAI_API_KEY
    // cada pedido lia as 500 últimas mensagens do banco antes de falhar — ~2.800
    // por hora. Religar: AI_SUMMARY_ENABLED=true + OPENAI_API_KEY, e a flag em chat.html.
    if (process.env.AI_SUMMARY_ENABLED !== 'true') {
      return res.status(410).json({ error: 'resumo com IA desativado' });
    }
    const { session, phone, contactName } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      const messages = await store.getHistory(session, phone);
      const result = await summarizeConversation({ contactName, messages });
      await store.setConversationSummary(session, phone, result);
      // Automático, toda vez que um resumo novo é gerado (decisão
      // confirmada com o usuário, 2026-08-13) — best-effort, igual
      // logMessageToTimeline: uma falha aqui (webhook indisponível, deal
      // sem card, etc.) nunca deve impedir o resumo de ser salvo/devolvido.
      store.getDealForPhone(session, phone)
        .then((dealId) => logConversationSummaryToTimeline(dealId, result))
        .catch((err) => console.error('[conversations:summary] falha ao logar na timeline do Bitrix:', err.message));
      res.json({ ...result, updatedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[conversations:summary] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /conversations/summary-history?session=&phone=
  // Todo resumo já gerado pra essa conversa (não só o atual, devolvido
  // junto de GET /history) — mais recente primeiro. Alimenta o link "Ver
  // histórico" no painel de detalhes do contato (Chat).
  // ---------------------------------------------------------------
  router.get('/conversations/summary-history', requireSession((req) => req.query.session), async (req, res) => {
    const { session, phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      const history = await store.listConversationSummaryHistory(session, phone);
      res.json({ history });
    } catch (err) {
      console.error('[conversations:summary-history] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /conversations/export-pdf?session=&phone=
  // Exporta a conversa (mensagens + notas internas) como PDF real,
  // gerado no servidor (pdfkit) e devolvido pronto pra download — busca
  // os dados de novo aqui (fonte de verdade), não depende do que está em
  // memória do browser. Nota interna SEMPRE rotulada explicitamente
  // (bloco destacado + prefixo no texto), pra nunca ser confundida com
  // mensagem real se o arquivo circular fora do sistema.
  // ---------------------------------------------------------------
  router.get('/conversations/export-pdf', requireSession((req) => req.query.session), async (req, res) => {
    const { session, phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
    try {
      const [messages, notes] = await Promise.all([
        store.getHistory(session, phone),
        store.listInternalNotes(session, phone),
      ]);
      const combined = [
        ...messages.map((m) => ({ ...m, _kind: 'message' })),
        ...notes.map((n) => ({ ...n, _kind: 'note' })),
      ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="conversa-${phone}-${Date.now()}.pdf"`);

      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      doc.pipe(res);

      doc.font('Helvetica-Bold').fontSize(16).text(`Conversa com ${phone}`);
      doc.font('Helvetica').fontSize(10).fillColor('#666666')
        .text(`Exportado em ${new Date().toLocaleString('pt-BR')}`);
      doc.moveDown(1);
      doc.strokeColor('#cccccc').moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
      doc.moveDown(1);

      if (!combined.length) {
        doc.fontSize(11).fillColor('#333333').text('Nenhuma mensagem nesta conversa ainda.');
      }

      combined.forEach((item) => {
        const time = new Date(item.createdAt).toLocaleString('pt-BR');
        if (item._kind === 'note') {
          // Nota interna sempre em dourado + rótulo explícito no próprio
          // texto — distinção visual clara sem precisar calcular a altura
          // de um retângulo de fundo antecipadamente (pdfkit não sabe
          // quantas linhas o texto vai ocupar antes de desenhá-lo).
          doc.font('Helvetica-Bold').fontSize(9).fillColor('#8a6b32')
            .text(`[${time}] [NOTA INTERNA — não enviada ao cliente] ${item.authorName || 'Sem nome'}`);
          doc.font('Helvetica-Oblique').fontSize(10).fillColor('#8a6b32').text(item.text);
        } else {
          const author = item.direction === 'out' ? (item.sentByName || 'Você') : phone;
          const body = item.text || `(${item.type === 'image' ? 'Foto' : item.type === 'video' ? 'Vídeo' : item.type === 'audio' ? 'Áudio' : item.type === 'document' ? 'Documento' : 'Mensagem'})`;
          doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a1408').text(`[${time}] ${author}`, { continued: false });
          doc.font('Helvetica').fontSize(10).fillColor('#333333').text(body);
        }
        doc.moveDown(0.6);
      });

      doc.end();
    } catch (err) {
      console.error('[conversations:export-pdf] erro:', err.message);
      if (!res.headersSent) res.status(502).json({ error: err.message });
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

    // Id da mensagem gerado pelo Chat, igual em toda tentativa (2026-11-04).
    // Mesmo id = mesma mensagem: se já foi enviada, devolve a mesma; se está
    // sendo enviada agora (duplo clique, duas abas, reenvio automático junto
    // com o clique), espera a primeira em vez de mandar outra. O worker também
    // deduplica (ver WhatsAppGateway.sendMessage), pro caso de o pedido ter
    // estourado o tempo aqui enquanto ele ainda enviava.
    const clientMsgId = typeof req.body?.clientMsgId === 'string' && SEND_ID_RE.test(req.body.clientMsgId)
      ? req.body.clientMsgId : null;
    const sendKey = clientMsgId ? `${session}|${clientMsgId}` : null;
    if (sendKey) {
      const done = sendsDone.get(sendKey);
      if (done) return res.json({ ok: true, message: done, duplicate: true });
      const running = sendsInFlight.get(sendKey);
      if (running) {
        try {
          return res.json({ ok: true, message: await running, duplicate: true });
        } catch (err) {
          return res.status(502).json({ error: err.message });
        }
      }
    }

    let finish;
    if (sendKey) {
      const p = new Promise((resolve, reject) => { finish = { resolve, reject }; });
      p.catch(() => {});
      sendsInFlight.set(sendKey, p);
    }

    try {
      const gateway = sessions.get(session);
      const replyTo = await resolveReplyTo(session, phone, replyToId);
      const message = await gateway.sendMessage(phone, text, replyTo, clientMsgId || undefined);
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

      if (sendKey) {
        if (sendsDone.size >= SENDS_DONE_MAX) sendsDone.delete(sendsDone.keys().next().value);
        sendsDone.set(sendKey, message);
        finish.resolve(message);
      }
      res.json({ ok: true, message });
    } catch (err) {
      console.error('[send] erro:', err.message);
      if (sendKey) finish.reject(err);
      res.status(502).json({ error: err.message });
    } finally {
      if (sendKey) sendsInFlight.delete(sendKey);
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
      // listEmployeesWithDepartment() em vez de listEmployees() — adiciona
      // o campo `department` (macro-setor: VENDAS/JURÍDICO/ADMINISTRATIVO/
      // etc, ver src/bitrixHierarchy.js) pedido pelo usuário 2026-10-01
      // pro controle de chips/conexões de WhatsApp por setor.
      const employees = await listEmployeesWithDepartment();
      if (employees === null) {
        return res.json({ users: [], hrConfigured: false });
      }

      const ownerIds = employees.map((e) => ownerIdFor(e.id));
      const sinceDate = new Date(Date.now() - ADMIN_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const [presenceRows, lastAccessMap, usage, blocked, activeDaysByOwner, usabilityByOwner, analysisGrants, allInstances] = await Promise.all([
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
        // Quem tem acesso à Auditoria de Conversas (HANDOFF Parte DK) —
        // reaproveita esta mesma tabela de Usuários pra conceder/revogar,
        // sem precisar de um fluxo de busca por nome separado.
        conversationAnalysisGrants.listGrants(),
        // Instâncias de WhatsApp por dono (unificado aqui em vez de aba
        // separada — decisão do usuário, 2026-08-28: "unifique as
        // tabelas, tudo fica dentro da tabela usuários"). Órfã (sem
        // instances.owner_id resolvível) fica de fora de propósito — não
        // cabe numa linha de usuário; segue só visível via
        // conversationAnalysisStore (Auditoria de Conversas).
        instancesStore.listAll(),
      ]);

      const presenceByOwner = new Map(presenceRows.map((r) => [r.ownerId, r]));
      const blockedByOwner = new Map(blocked.map((b) => [b.ownerId, b]));
      const analysisGrantByOwner = new Set(analysisGrants.map((g) => g.ownerId));
      const ownNumbers = getOwnNumbersBySession();
      const instancesByOwner = new Map(); // ownerId -> [{ id, label, phone }]
      for (const inst of allInstances) {
        if (inst.isOrphan || !inst.ownerId) continue;
        if (!instancesByOwner.has(inst.ownerId)) instancesByOwner.set(inst.ownerId, []);
        // `id` incluído (2026-10-01) — necessário pro admin escolher qual
        // instância forçar compartilhamento (POST /admin/instances/:id/
        // delegates), antes só label/phone bastavam pra exibição.
        instancesByOwner.get(inst.ownerId).push({ id: inst.id, label: inst.label, phone: ownNumbers[inst.id] || null });
      }

      const users = employees.map((e) => {
        const ownerId = ownerIdFor(e.id);
        const presenceRow = presenceByOwner.get(ownerId);
        const isOnline = !!presenceRow && Date.now() - new Date(presenceRow.lastSeenAt).getTime() < ADMIN_ONLINE_THRESHOLD_MS;
        const favoritePage = usage.favoritePageByOwner.get(ownerId);
        const blockedRow = blockedByOwner.get(ownerId);
        const usability = usabilityByOwner.get(ownerId);
        return {
          ownerId,
          // ID numérico puro do Bitrix (sem o prefixo member_id de
          // ownerId) — pedido do usuário 2026-10-01 pra alimentar o CSV
          // exportado no agente externo de disparo/controle de chips.
          bitrixUserId: e.id,
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
          // Macro-setor (VENDAS/JURÍDICO/ADMINISTRATIVO/FINANCEIRO/
          // NEGOCIAÇÃO E ACORDOS/SEM DEPARTAMENTO) — null se o funcionário
          // não estiver em nenhum departamento resolvível (não deveria
          // acontecer na prática, mas o Bitrix não impede).
          department: e.department,
          isOnline,
          currentPage: presenceRow?.lastPage || null,
          lastAccess: lastAccessMap.get(ownerId) || null,
          // Instâncias de WhatsApp deste dono (unificado da antiga aba
          // "Instâncias" — ver instancesByOwner acima). [] pra quem nunca
          // conectou nenhuma.
          instances: instancesByOwner.get(ownerId) || [],
          totalSecondsLast30d: usage.totalByOwner.get(ownerId) || 0,
          favoritePage: favoritePage?.page || null,
          isBlocked: !!blockedRow,
          blockedReason: blockedRow?.reason || null,
          hasConversationAnalysisAccess: analysisGrantByOwner.has(ownerId),
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
  // GET /admin/instances
  // TODAS as instâncias do sistema (instancesStore.listAll(), inclusive
  // órfãs — mesma fonte já usada pela Auditoria de Conversas), com o
  // NÚMERO real de WhatsApp (getOwnNumbersBySession, mesma fonte de
  // GET /instances) e o NOME do dono resolvido via listEmployees() +
  // ownerIdFor (mesmo padrão de GET /admin/users). hrConfigured:false
  // (200, não erro) se BITRIX_HR_WEBHOOK_URL não estiver configurada —
  // nesse caso ownerName fica null pra todo mundo (sem cadastro do
  // Bitrix pra cruzar), mas a lista de instâncias em si continua
  // completa. Instância órfã sempre com ownerName null (não há dono
  // pra resolver, ver instancesStore.listAll()). Restrito a super
  // admin.
  //
  // SEM USO na UI do Admin desde 2026-08-28 — a aba "Instâncias" foi
  // unificada dentro da tabela "Usuários" (GET /admin/users ganhou o
  // campo `instances` por dono, ver acima), decisão do usuário pra não
  // ter dois lugares mostrando o mesmo cruzamento dono↔instância.
  // Mantida (não removida) por compatibilidade — pode ter consumidor
  // externo via token de API de longa duração (ver SECURITY.md).
  // ---------------------------------------------------------------
  router.get('/admin/instances', requireSuperAdmin, async (req, res) => {
    try {
      const [allInstances, employees] = await Promise.all([
        instancesStore.listAll(),
        listEmployees(),
      ]);
      const ownNumbers = getOwnNumbersBySession();
      const nameByOwnerId = employees ? new Map(employees.map((e) => [ownerIdFor(e.id), e.name])) : new Map();

      const result = allInstances.map((i) => ({
        id: i.id,
        ownerId: i.ownerId,
        ownerName: i.ownerId ? (nameByOwnerId.get(i.ownerId) || null) : null,
        label: i.label,
        phone: ownNumbers[i.id] || null,
        isOrphan: i.isOrphan,
        createdAt: i.createdAt,
      }));

      res.json({ instances: result, hrConfigured: employees !== null });
    } catch (err) {
      console.error('[admin] falha ao listar instâncias:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /admin/phone-audit            -> JSON (resumo + pessoas + instâncias)
  // GET /admin/phone-audit?format=xlsx -> mesma coisa em planilha Excel
  // Auditoria de números de WhatsApp por colaborador: quem está conectado
  // agora, quem já conectou e hoje está offline (com os números), quem nunca
  // conectou, supervisor, números repetidos. Só LEITURA — status ao vivo vem
  // de sessions.getActiveGateway (não inicia sessão nenhuma, ver
  // src/phoneAudit.js). Restrito a super admin.
  // ---------------------------------------------------------------
  router.get('/admin/phone-audit', requireSuperAdmin, async (req, res) => {
    try {
      const audit = await buildPhoneAudit(sessions);
      if (req.query.format !== 'xlsx') return res.json(audit);
      const wb = await buildPhoneAuditWorkbook(audit);
      const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="dapzap-numeros-${day}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('[admin] falha na auditoria de números:', err.message);
      if (!res.headersSent) res.status(502).json({ error: err.message });
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

  // ---------------------------------------------------------------
  // POST /admin/feed-post  { title?, content }
  // Publica no Feed nativo do Bitrix24 (Live Feed, "Para todos os
  // colaboradores") — SEMPRE manual, disparado só quando o super admin
  // clica "Publicar" no Painel Admin depois de revisar o texto (decisão
  // confirmada com o usuário: nunca automático a partir de deploy/commit).
  // Registrado em feed_posts mesmo em falha, pra nunca perder o rastro de
  // uma tentativa que não foi ao ar.
  //
  // O campo do BODY se chama "content", não "message" (nome da coluna no
  // banco, mantido só internamente) — descoberto em teste real
  // (2026-08-25) que algo na infraestrutura de produção (proxy/WAF fora
  // do nosso controle, nunca chega a este Express — confirmado pela
  // ausência de X-Powered-By/Ratelimit-* na resposta 502) bloqueia
  // especificamente POST nesta rota quando o body tem uma chave literal
  // "message" — GET na mesma rota, e POST com "title" sozinho ou outro
  // nome de campo, sempre funcionaram normalmente. Renomear o campo
  // externo contorna sem depender de alterar a infraestrutura.
  // ---------------------------------------------------------------
  router.post('/admin/feed-post', requireSuperAdmin, async (req, res) => {
    const { title, content } = req.body || {};
    const message = content;
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'a mensagem é obrigatória' });
    }
    try {
      const bitrixPostId = await publishFeedPost({ title, message });
      await recordFeedPost({ ownerId: req.ownerId, title, message, bitrixPostId, status: 'published' });
      res.json({ ok: true, bitrixPostId });
    } catch (err) {
      console.error('[feed] falha ao publicar:', err.message);
      await recordFeedPost({ ownerId: req.ownerId, title, message, status: 'failed', error: err.message }).catch(() => {});
      res.status(502).json({ error: err.message });
    }
  });

  // GET /admin/feed-posts — histórico LOCAL de posts já publicados (ou
  // tentados), pra saber o que já foi anunciado e não duplicar.
  router.get('/admin/feed-posts', requireSuperAdmin, async (req, res) => {
    try {
      res.json({ posts: await listFeedPosts() });
    } catch (err) {
      console.error('[feed] erro ao listar histórico:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createWhatsappRouter };
