require('dotenv').config();

// Rede de segurança: uma falha de rede transitória chamando o Bitrix (ex:
// ECONNRESET no meio de um fetch de logMessageToTimeline/verifyBitrixToken)
// pode escapar do try/catch normal — é um bug conhecido do undici, onde o
// erro chega como evento 'error' cru em vez de rejeição de Promise — e sem
// isso aqui derruba o processo inteiro (todas as sessões de WhatsApp caem
// junto). Loga e mantém o servidor no ar em vez de matar o processo.
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException (processo mantido no ar):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[server] unhandledRejection (processo mantido no ar):', err);
});

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const { URL } = require('url');
const swaggerUi = require('swagger-ui-express');
const openapiSpec = require('./openapi');

const { SessionManager } = require('./sessions');
const { createWhatsappRouter } = require('./routes/whatsapp');
const { createCrmRouter } = require('./routes/crm');
const { createLeadFormsRouter } = require('./routes/leadForms');
const { createLeadsRouter } = require('./routes/leads');
const { createAbTestsRouter } = require('./routes/abTests');
const { createSuggestionsRouter } = require('./routes/suggestions');
const { createSettingsRouter } = require('./routes/settings');
const { createConversationAnalysisRouter } = require('./routes/conversationAnalysis');
const { createCardGroupRouter } = require('./routes/cardGroup');
const { createInternalNotesRouter } = require('./routes/internalNotes');
const { createDapinhoRouter } = require('./routes/dapinho');
const { createAgentRouter } = require('./routes/agent');
const { createInsightsRouter } = require('./routes/insights');
const { createSatisfactionRouter } = require('./routes/satisfaction');
const { createSatisfactionPublicRouter } = require('./routes/satisfactionPublic');
const settings = require('./settings');
const abTests = require('./abTests');
const store = require('./store');
const pageSessions = require('./pageSessions');
const contactsStore = require('./contacts');
const { onCampaignMessageStatus } = require('./campaigns');
const { logMessageToTimeline, logStatusToTimeline } = require('./bitrix');
const { verifyBitrixToken, ownerIdFor, issueAppToken, verifyAppToken, requireAuth, TOKEN_TTL_MS } = require('./auth');
const { assertOwnsSession, isDapinhoSession } = require('./authz');
const instancesStore = require('./instances');
const instanceHealthStore = require('./instanceHealthStore');
const agentDispatch = require('./agentDispatch');
const agentRetryWorker = require('./agentRetryWorker');
const insightGenerator = require('./insightGenerator');
const dapinho = require('./dapinho');
const alertDispatcher = require('./alertDispatcher');

const PORT = process.env.PORT || 3333;
const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_session';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// URL pública deste servidor (ex: o endereço do ngrok). É para onde o
// Bitrix vai abrir a aba "WhatsApp" dentro do card do Negócio.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const app = express();
// Limite alto porque imagem/áudio/vídeo de /send-media chega em base64 no corpo
// JSON (base64 infla o tamanho original em ~33%; vídeo é o maior caso, por isso
// o limite folgado).
app.use(express.json({ limit: '40mb' }));
// O Bitrix24 sempre carrega a página do app via POST (envia o contexto
// de auth/placement no corpo, como form-urlencoded), então precisamos
// conseguir ler esse body além do JSON usado pela nossa própria API.
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true,
  })
);

// Limite por IP em toda a API — protege contra abuso claro (script
// martelando requisições), sem afetar uso humano normal. O número é
// deliberadamente generoso, calculado com margem pro próprio tráfego
// legítimo deste app: cada tela aberta dispara heartbeat + page-session
// ping + checagem de notificação a cada 30s (até 3 requisições/ciclo,
// ver startPresenceHeartbeat nas 14 telas) — alguém com várias abas
// abertas, ou várias pessoas atrás do MESMO IP corporativo (rede única de
// escritório), pode legitimamente gerar várias centenas de
// requisições/minuto sem que isso seja abuso. `standardHeaders`/
// `legacyHeaders` só controlam quais headers de rate-limit são expostos
// na resposta, não afetam o limite em si.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600, // por IP, por minuto
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'muitas requisições, aguarde um momento e tente de novo' },
});
app.use('/api', apiLimiter);

// `no-cache` (não `no-store`): o navegador ainda pode GUARDAR o arquivo, mas é
// OBRIGADO a revalidar com o servidor (If-Modified-Since/ETag, automático via
// express.static) antes de usar a cópia local — na prática, sempre pega a
// versão nova depois de um deploy, sem precisar de hard refresh manual. Sem
// isto (comportamento padrão do navegador sem header explícito), correções de
// frontend ficavam "presas" no cache até o usuário limpar/forçar reload —
// usuário reportou a tag "Pendente" (Parte CV) só atualizando depois de trocar
// de filtro/aba, mesmo com o deploy já confirmado no servidor (HANDOFF Parte
// CV/CW). Aplica pra TODOS os estáticos (html/js/css em public/), não só
// chat.html — mesma causa afetaria qualquer arquivo dali.
app.use(express.static('public', { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
// Imagem/áudio/vídeo ficam no Supabase Storage (ver src/media.js) — não
// precisa de rota estática local pra mídia.

// ---------------------------------------------------------------
// Página de INSTALAÇÃO do app local. É o "Caminho de instalação
// inicial" configurado no Bitrix. Aqui registramos a aba "WhatsApp"
// no card do Negócio (placement CRM_DEAL_DETAIL_TAB). Usa o SDK BX24
// no próprio navegador — assim não dependemos de extrair o AUTH_ID do
// corpo do POST. Ao final, BX24.installFinish() avisa o Bitrix que a
// instalação terminou.
//
// "Análise Conversas" (dashboard.html) NÃO é uma aba do card — é
// aberta pelo próprio ícone do app (fora de um Negócio), ver o
// tratamento de PLACEMENT === 'DEFAULT' em public/index.html. Local
// apps do tipo "Servidor" não têm API pra injetar um ícone próprio na
// barra lateral do Bitrix; o ícone que já existe (o do app instalado)
// é o único ponto de entrada disponível fora do card.
//
// Bitrix abre essa página via POST (mas aceitamos GET também, para
// dar pra testar manualmente no navegador).
// ---------------------------------------------------------------
function renderInstallPage() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><title>Instalando…</title></head>
<body style="font-family:sans-serif;padding:24px;color:#222">
  <p id="msg">Registrando a aba "DapZAP" nos cards de Negócio e Contato…</p>
  <script src="https://api.bitrix24.com/api/v1/"></script>
  <script>
    BX24.init(function () {
      var el = document.getElementById('msg');

      // Remove vínculos antigos (em reinstalações) e registra a aba de novo.
      BX24.callMethod('placement.unbind', { PLACEMENT: 'CRM_DEAL_DETAIL_TAB' }, function () {
        BX24.callMethod('placement.bind', {
          PLACEMENT: 'CRM_DEAL_DETAIL_TAB',
          HANDLER: location.origin + '/',
          TITLE: 'DapZAP'
        }, function (res) {
          if (res.error()) {
            el.textContent = 'Erro ao registrar a aba: ' + JSON.stringify(res.error());
            return;
          }
          el.textContent = 'Aba registrada. Registrando a aba no card de Contato…';

          // Mesma aba, agora também no card de CONTATO (usuário perguntou
          // "aonde está o dapZAP dentro do card" abrindo um Contato — não
          // aparecia porque só existia CRM_DEAL_DETAIL_TAB, HANDOFF Parte
          // DE). Mesmo HANDLER (index.html) — ele já sabe distinguir os
          // dois contextos (ver placementInfo.placement em initBx24()).
          BX24.callMethod('placement.unbind', { PLACEMENT: 'CRM_CONTACT_DETAIL_TAB' }, function () {
            BX24.callMethod('placement.bind', {
              PLACEMENT: 'CRM_CONTACT_DETAIL_TAB',
              HANDLER: location.origin + '/',
              TITLE: 'DapZAP'
            }, function (resContact) {
              if (resContact.error()) {
                el.textContent = 'Aba de Negócio registrada; aba de Contato indisponível neste portal (' + JSON.stringify(resContact.error()) + '). Registrando o botão "DapZAP"…';
              } else {
                el.textContent = 'Abas de Negócio e Contato registradas. Registrando o botão "DapZAP"…';
              }

              // Item "Abrir WhatsApp" no menu do botão superior do card — abre a
              // página-ponte /bridge, que resolve o telefone do contato do negócio
              // e redireciona pro Chat já naquela conversa (ver public/bridge.html).
              // O installFinish() fica no ÚLTIMO callback: encerrar antes deixaria
              // a instalação "pronta" sem este placement registrado.
              BX24.callMethod('placement.unbind', { PLACEMENT: 'CRM_DEAL_DETAIL_TOOLBAR' }, function () {
                BX24.callMethod('placement.bind', {
                  PLACEMENT: 'CRM_DEAL_DETAIL_TOOLBAR',
                  HANDLER: location.origin + '/bridge',
                  TITLE: 'DapZAP'
                }, function (res2) {
                  if (res2.error()) {
                    // Não aborta a instalação: a aba (recurso principal) já está
                    // registrada; este placement pode não existir em toda
                    // edição/plano do Bitrix. Só informa e finaliza mesmo assim.
                    el.textContent = 'Abas registradas; botão "DapZAP" indisponível neste portal (' + JSON.stringify(res2.error()) + '). Finalizando…';
                    BX24.installFinish();
                    return;
                  }
                  el.textContent = 'Abas e botão "DapZAP" registrados! Finalizando…';
                  BX24.installFinish();
                });
              });
            });
          });
        });
      });
    });
  </script>
</body>
</html>`;
}

app.get('/install', (req, res) => res.send(renderInstallPage()));
app.post('/install', (req, res) => res.send(renderInstallPage()));

// ---------------------------------------------------------------
// Página-ponte do item "Abrir WhatsApp" (placement CRM_DEAL_DETAIL_TOOLBAR,
// registrado em renderInstallPage acima): o Bitrix abre isto num slider,
// e o JS da página resolve dealId -> telefone -> instância e redireciona
// pro Chat na conversa certa. Bitrix abre placements via POST; GET fica
// pra teste manual.
// ---------------------------------------------------------------
app.get('/bridge', (req, res) => res.sendFile(path.join(__dirname, '../public/bridge.html')));
app.post('/bridge', (req, res) => res.sendFile(path.join(__dirname, '../public/bridge.html')));

// ---------------------------------------------------------------
// Handler principal do app local do Bitrix24. Como o Bitrix abre
// a página (placement, abertura do app) sempre via POST, e
// express.static só responde a GET, sem essa rota o Express
// devolve "Cannot POST /".
//
// Também tratamos o evento offline ONAPPINSTALL aqui, caso ele
// chegue via server-to-server (alguns fluxos de reinstalação).
// ---------------------------------------------------------------
app.post('/', async (req, res) => {
  // Só os campos não-sensíveis: o payload do Bitrix traz AUTH_ID/REFRESH_ID/
  // APPLICATION_TOKEN, que dão acesso ao portal e não podem ir pro log (ele é
  // lido por `docker logs`, que qualquer um com acesso à VPS consegue).
  console.log('[bitrix] POST /', {
    event: req.body?.event,
    placement: req.body?.PLACEMENT,
    member_id: req.body?.member_id,
  });

  // Evento offline de instalação (server-to-server): só confirma.
  if (req.body?.event === 'ONAPPINSTALL') {
    res.send(`<!DOCTYPE html>
<html><body>
<script src="https://api.bitrix24.com/api/v1/"></script>
<script>BX24.init(function () { BX24.installFinish(); });</script>
</body></html>`);
    return;
  }

  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Mesmo motivo do POST / acima: essa aba também é aberta via POST pelo Bitrix,
// e express.static só serve GET.
app.post('/dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.post('/chat.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/chat.html'));
});

app.post('/campaign.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/campaign.html'));
});

app.post('/contacts.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/contacts.html'));
});

app.post('/sites.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/sites.html'));
});

app.post('/lead-metrics.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/lead-metrics.html'));
});

app.post('/campaign-metrics.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/campaign-metrics.html'));
});

app.post('/campaign-schedule.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/campaign-schedule.html'));
});

app.post('/instances.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/instances.html'));
});

app.post('/apresentacao.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/apresentacao.html'));
});

app.post('/notifications.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/notifications.html'));
});

app.post('/suggestions.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/suggestions.html'));
});

app.post('/onboarding.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/onboarding.html'));
});

app.post('/settings.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/settings.html'));
});

app.post('/conversation-analysis.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/conversation-analysis.html'));
});

// ---------------------------------------------------------------
// WebSocket: um "hub" simples que mantém quais sockets estão
// inscritos em (sessão + telefone), para fazer broadcast direcionado.
// Cada usuário do Bitrix é uma sessão de WhatsApp separada.
// ---------------------------------------------------------------
const subscribers = new Map(); // "sessionId::phone" (ou "sessionId::*") -> Set<ws>

// Dedupe em memória do sync automático de contatos (ver onMessage abaixo) —
// evita chamar upsertContact (1 query) de novo pro MESMO (sessionId, phone)
// repetidas vezes dentro da mesma "rajada" de histórico: com
// shouldSyncHistoryMessage aceitando syncType FULL (HANDOFF Parte CP), um
// backfill inicial pode trazer centenas/milhares de mensagens do mesmo
// contato de uma vez, e upsertContact já é idempotente (coalesce), então
// repetir a query não causaria dado errado — só query redundante à toa.
// Zera a cada restart do processo (não é dado persistido, é só otimização;
// o próximo backfill/mensagem real corrige de novo sem problema).
const contactSyncedThisRun = new Set(); // "sessionId::phone"

// phone omitido = inscrição "toda a sessão" (usada pelo inbox do Chat, que
// precisa saber de mensagens novas em qualquer conversa pra atualizar a
// lista, não só a conversa aberta no momento).
function subKey(sessionId, phone) {
  return `${sessionId}::${phone || '*'}`;
}

function broadcast(sessionId, phone, payload) {
  const targets = new Set([
    ...(subscribers.get(subKey(sessionId, phone)) || []),
    ...(subscribers.get(subKey(sessionId, null)) || []),
  ]);
  if (!targets.size) return;
  const data = JSON.stringify({ ...payload, phone });
  for (const ws of targets) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// Alerta de instância caída/desconectada (ver src/instanceHealthStore.js,
// db/schema.sql) — guarda em memória qual foi o último estado "relevante"
// já processado por sessão, pra só agir em MUDANÇA real de estado, não a
// cada emissão redundante do evento 'status' (ex: cada tentativa de
// reconexão dentro do mesmo backoff dispara 'offline' de novo). Reseta a
// cada boot do processo — aceitável: a próxima mudança real de estado
// resolve sozinha (fecha o evento aberto anterior antes de abrir um novo,
// ver instanceHealthStore.openConnectionEvent).
const lastHealthState = new Map(); // sessionId -> 'online' | 'temporary' | 'attention'

async function handleStatusForHealth(sessionId, status) {
  if (status === 'connecting') return; // estado transitório, não é queda nem retomada

  // IMPORTANTE: connection.update (src/whatsapp.js) emite 'status' ANTES de
  // atualizar needsAttention/loggedOut/lastDisconnectReason (essas
  // atribuições acontecem depois, dentro do mesmo handler síncrono) — ler o
  // gateway agora leria os campos ainda com o valor da queda ANTERIOR.
  // setImmediate adia a leitura pro próximo tick, depois que o handler
  // síncrono do 'connection.update' já terminou de rodar por completo.
  await new Promise((resolve) => setImmediate(resolve));

  const gateway = sessions.getActiveGateway(sessionId);
  if (!gateway) return; // sessão já não está mais em memória (ex: removida)

  let currentState;
  if (status === 'online') currentState = 'online';
  else if (gateway.needsAttention || gateway.loggedOut) currentState = 'attention';
  else currentState = 'temporary';

  const previousState = lastHealthState.get(sessionId) || null;
  if (currentState === previousState) return; // nada mudou de fato, ignora
  lastHealthState.set(sessionId, currentState);

  try {
    if (currentState === 'online') {
      await instanceHealthStore.closeOpenConnectionEvent(sessionId);
      return;
    }

    const reason = gateway.loggedOut ? 'loggedOut' : gateway.lastDisconnectReason;
    await instanceHealthStore.openConnectionEvent(sessionId, currentState, reason);

    // Notifica só ao ENTRAR em 'attention' vindo de um estado que não era
    // 'attention' (evita notificar de novo numa escalada dentro da mesma
    // janela de atenção). Nunca notifica em 'temporary' isolado — queda de
    // rede comum com reconexão automática é esperada e frequente nesse tipo
    // de integração (mesmo raciocínio já documentado em src/whatsapp.js);
    // notificar a cada uma inundaria o usuário — mesmo problema já visto
    // antes com histórico de mensagem (2325 notificações falsas, ver
    // onMessage acima).
    if (currentState === 'attention' && previousState !== 'attention') {
      const ownerId = await instancesStore.ownerOf(sessionId);
      const delegates = await instancesStore.listDelegates(sessionId);
      const recipients = [ownerId, ...delegates.map((d) => d.delegateOwnerId)];
      const inst = await instancesStore.get(sessionId);
      const label = inst?.label || sessionId;
      const body = gateway.loggedOut
        ? 'A sessão foi encerrada pelo celular — escaneie o QR de novo pra reconectar.'
        : 'A conexão parou de tentar reconectar sozinha — tente reconectar manualmente, ou troque de número se persistir.';
      // Dispara os 4 canais (in-app + Web Push + WhatsApp de sistema +
      // e-mail, ver src/alertDispatcher.js) — cada um best-effort/
      // independente (Parte FC), pra notificar mesmo com todas as abas
      // do sistema fechadas, não só quando alguém está olhando a tela.
      await alertDispatcher.notifyAttention({
        recipients,
        title: `Instância "${label}" precisa de atenção`,
        body,
        target: { page: '/instances.html', sessionId },
        waSourceSessionId: sessionId,
        sessions,
      });
    }
  } catch (err) {
    console.error(`[whatsapp:${sessionId}] falha ao processar histórico de status:`, err.message);
  }
}

// avisa todas as abas abertas daquela sessão (qualquer telefone)
function broadcastStatus(sessionId, status) {
  const prefix = `${sessionId}::`;
  for (const [key, sockets] of subscribers) {
    if (!key.startsWith(prefix)) continue;
    const data = JSON.stringify({ type: 'status', status });
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }
}

// ---------------------------------------------------------------
// Boot do WhatsApp multi-sessão (Baileys)
// ---------------------------------------------------------------
const sessions = new SessionManager({
  baseFolder: AUTH_FOLDER,
  isCardGroup: store.isCardGroupId,
  onStatus: (sessionId, status) => {
    console.log(`[whatsapp:${sessionId}] status:`, status);
    broadcastStatus(sessionId, status);
    handleStatusForHealth(sessionId, status).catch((err) =>
      console.error(`[whatsapp:${sessionId}] falha ao processar histórico de status:`, err.message)
    );
    // Fila de retry do Agente de IA (src/agentRetryQueue.js) — reprocessa
    // mensagens de lead que não puderam ser respondidas enquanto esta
    // instância estava offline, agora que ela voltou.
    if (status === 'online') {
      agentRetryWorker.processRetryQueueForSession(sessionId).catch((err) =>
        console.error(`[agent-retry:${sessionId}] falha ao processar fila:`, err.message)
      );
    }
  },
  onMessage: async (sessionId, phone, message, pushName, isHistory, senderPhone, senderName) => {
    try {
      // Mensagem de GRUPO de card (feature de Negócio) — identificada por
      // senderPhone vir preenchido (só acontece nesse caso, ver
      // WhatsAppGateway._processIncomingMessage). O "phone" aqui já é o
      // JID do grupo, não um telefone de cliente — dealId vem do PRÓPRIO
      // grupo (wa_groups.deal_id), nunca de getDealForPhone (que é por
      // telefone de cliente e nunca teria linha pra um JID de grupo).
      const isGroupMsg = !!senderPhone;
      const dealId = isGroupMsg ? await store.getDealForGroup(phone) : await store.getDealForPhone(sessionId, phone);
      if (isGroupMsg) {
        message.groupSenderPhone = senderPhone;
        message.groupSenderName = senderName;
      }
      // Agente de IA (src/agentDispatch.js) — precisa saber se esta
      // conversa JÁ EXISTIA antes desta mensagem, pra decidir se é um
      // lead novo. Checado ANTES de addMessage (que sempre cria a
      // conversa via upsert se ela não existir) — depois disso seria
      // tarde demais pra saber. Não se aplica a grupo (JID de grupo
      // nunca é "lead").
      const conversationExistedBefore = isGroupMsg ? true : await store.conversationExists(sessionId, phone);

      const isNew = await store.addMessage(sessionId, phone, message, dealId, pushName);
      if (!isNew) return; // já tínhamos essa mensagem (ex: eco da que nós mesmos enviamos)

      // Sincroniza automaticamente com a tela de Contatos (ver
      // src/contacts.js, HANDOFF Parte CO/CP) — antes só existia o botão
      // manual "Importar de conversas"; agora toda mensagem de verdade
      // (nova OU de histórico — INCLUSIVE histórico, diferente de
      // broadcast/timeline/notificação abaixo) já garante que o telefone
      // existe como contato do dono, sem precisar de ação manual. Ao
      // conectar uma instância nova, o backfill de histórico (agora
      // completo, ver shouldSyncHistoryMessage em src/whatsapp.js) é
      // justamente o que dá "histórico + contato já prontos, mesmo na
      // 1ª conexão" — cortar isto pra histórico (como era antes)
      // significava nunca sincronizar contato de conversa antiga nenhuma.
      // upsertContact já é seguro chamar de novo pra cada mensagem da mesma
      // conversa (não sobrescreve nome já salvo com vazio, ver coalesce
      // lá) — o dedupe em memória abaixo só evita volume de query à toa
      // num backfill grande, não é necessário pra correção. Best-effort:
      // uma falha aqui nunca deve impedir salvar/notificar a mensagem em
      // si — é um efeito colateral, não o caminho principal.
      // Sync automático de contato não se aplica a grupo — "phone" é um JID
      // de grupo (@g.us), não um telefone de cliente; não existe "contato"
      // pra cadastrar automaticamente aqui (os participantes já foram
      // resolvidos individualmente na criação do grupo, ver cardGroup.js).
      if (!isGroupMsg) {
        const contactSyncKey = `${sessionId}::${phone}`;
        if (!contactSyncedThisRun.has(contactSyncKey)) {
          contactSyncedThisRun.add(contactSyncKey);
          instancesStore.ownerOf(sessionId)
            .then((ownerId) => contactsStore.upsertContact(ownerId, { phone, name: pushName, dealId }))
            .catch((err) => {
              contactSyncedThisRun.delete(contactSyncKey); // falhou -> tenta de novo na próxima mensagem
              console.error('[contacts] falha ao sincronizar contato automaticamente:', err.message);
            });
        }
      }

      // Mensagem de histórico (backfill via messaging-history.set, ver
      // src/whatsapp.js) só precisa ser SALVA (e o contato sincronizado,
      // acima) — ela já aconteceu há tempo, então não é uma "mensagem
      // nova" de verdade. Sem este corte, um import de histórico
      // (centenas/milhares de mensagens de uma vez) dispara broadcast em
      // tempo real (parece mensagem chegando agora na tela de quem estiver
      // com o Chat aberto), loga na timeline do Bitrix retroativamente e
      // cria uma notificação por mensagem — já aconteceu isso na prática:
      // uma instância só gerou 2325 notificações falsas num import de
      // histórico antes desta correção.
      if (isHistory) return;

      broadcast(sessionId, phone, { type: 'message', message });

      const label =
        message.type && message.type !== 'text'
          ? `[${message.type}]${message.text ? ' ' + message.text : ''}`
          : message.text;

      if (dealId) {
        logMessageToTimeline(dealId, label, message.direction).catch((e) =>
          console.error('[bitrix] falha ao logar mensagem na timeline:', e.message)
        );
      }

      // Histórico persistido da Central de Notificações (público em
      // notifications.html) — nasce aqui, não no client, pra existir mesmo
      // se ninguém estiver com o Chat aberto no momento. Só mensagem
      // recebida (não eco do que a gente mesmo mandou) e conversa não
      // silenciada (notifica por padrão).
      if (message.direction === 'in') {
        const prefs = await store.getConversationNotifPrefs(sessionId, phone);
        if (prefs.notificationsEnabled !== false) {
          const contactName = pushName || prefs.pushName || phone;
          // Conversa atribuída (ver POST /conversations/assign) notifica só
          // quem está atendendo — sem atribuição (inclusive contato novo),
          // notifica o dono da instância E todos os delegados dela (ver
          // instance_delegates), já que ninguém "pegou" ainda.
          let recipients;
          if (prefs.assignedTo) {
            recipients = [prefs.assignedTo];
          } else {
            const ownerId = await instancesStore.ownerOf(sessionId);
            const delegates = await instancesStore.listDelegates(sessionId);
            recipients = [ownerId, ...delegates.map((d) => d.delegateOwnerId)];
          }
          await Promise.all(recipients.map((ownerId) => store.addNotification({
            ownerId,
            title: `Nova mensagem de ${contactName}`,
            body: label || null,
            target: { sessionId, phone, contactName },
          })));
        }

        // Agente de IA — só em conversa NOVA (lead), nunca em cliente
        // já existente. Best-effort: tudo acima (broadcast/timeline/
        // notificação) já rodou, uma falha aqui nunca deve apagar
        // esse processamento já feito.
        if (!isGroupMsg && !conversationExistedBefore) {
          agentDispatch.handleNewLeadMessage({
            sessionId,
            phone,
            pushName,
            leadMessageText: message.text || '',
            // Dados de mídia (reconhecimento real via Whisper/Vision, ver
            // src/mediaRecognition.js) — únicos campos já disponíveis em
            // `message` (payload de _processIncomingMessage), sem
            // round-trip novo. waMessageId localiza a linha certa pra
            // atualizar messages.text depois do reconhecimento.
            mediaUrl: message.mediaUrl || null,
            mediaType: message.type !== 'text' ? message.type : null,
            mimetype: message.mimetype || null,
            waMessageId: message.id,
          }).catch((err) => console.error('[agent] falha ao processar lead novo:', err.message));
        }

        // Copiloto Comercial — insights de IA em tempo real, só em
        // instâncias marcadas "comercial" (checado dentro de
        // maybeGenerateInsight via commercialConfig; aqui não há gate
        // de conversationExistedBefore — diferente do Agente de IA
        // acima, o copiloto sugere em QUALQUER conversa comercial, não
        // só lead novo). Best-effort, mesmo padrão do bloco acima.
        if (!isGroupMsg) {
          insightGenerator.maybeGenerateInsight({
            sessionId, phone, dealId, messageId: message.id,
          }).catch((err) => console.error('[insights] falha ao gerar insight:', err.message));
        }
      }
    } catch (err) {
      console.error('[server] falha ao processar mensagem:', err.message);
    }
  },
  // Nome de contato vindo da AGENDA do WhatsApp (contacts.upsert/update ao
  // vivo, ou o backfill de histórico — ver WhatsAppGateway._extractContactInfo),
  // não de uma mensagem em si. Existe separado de onMessage/pushName porque
  // mensagem de HISTÓRICO nunca traz pushName (só mensagem nova recebida
  // traz) — sem isto, toda conversa criada via backfill (1ª conexão de uma
  // instância nova) ficava com nome null até a PRÓXIMA mensagem AO VIVO
  // daquele contato (podendo nunca acontecer) — usuário reportou com print
  // (sessão 2026-08-12).
  //
  // NÃO reusa o corte de contactSyncedThisRun (chave só session::phone) —
  // aquele dedupe existe pra evitar volume de query à toa quando a MESMA
  // fonte (pushName de mensagem) já rodou; aqui a fonte é outra (nome da
  // agenda, mais confiável) e pode chegar DEPOIS de onMessage já ter
  // sincronizado sem nome — vale sempre chamar de novo. upsertContact já é
  // seguro chamar repetido (coalesce, nunca sobrescreve nome salvo com
  // vazio, ver src/contacts.js) — o único custo é uma query extra, aceitável
  // pro volume normal de contatos por pareamento.
  onContact: (sessionId, phone, name) => {
    if (!phone || !name) return;
    instancesStore.ownerOf(sessionId)
      .then((ownerId) => contactsStore.upsertContact(ownerId, { phone, name }))
      .catch((err) => console.error('[contacts] falha ao sincronizar nome de contato da agenda:', err.message));
  },
  onReaction: async (sessionId, phone, targetId, emoji, direction) => {
    try {
      await store.setMessageReaction(sessionId, phone, targetId, emoji, direction);
      broadcast(sessionId, phone, { type: 'reaction', targetId, emoji, direction });
    } catch (err) {
      console.error('[server] falha ao processar reação:', err.message);
    }
  },
  onMessageStatus: async (sessionId, phone, messageId, status) => {
    try {
      await store.updateMessageStatus(sessionId, phone, messageId, status);
      broadcast(sessionId, phone, { type: 'message-status', messageId, status });

      // Corrige retroativamente as métricas de campanha (sent/failed) se
      // esse messageId foi mandado como parte de uma campanha e o WhatsApp
      // rejeitou a entrega DEPOIS do envio (ver src/campaigns.js e a
      // explicação em src/whatsapp.js _mapStatus, código 463/"account
      // restricted"). Não faz nada se não for uma mensagem de campanha, ou
      // se o status não for 'failed' — checagem já feita dentro da função.
      onCampaignMessageStatus(messageId, status).catch((err) =>
        console.error('[server] falha ao corrigir métricas de campanha:', err.message)
      );

      // Registro de entrega/leitura na timeline do negócio — pedido do
      // usuário pra saber se o contato recebeu/visualizou, direto no card
      // do Negócio (a "bolha" que ele vê ali é a timeline nativa do
      // Bitrix, sem controle visual nosso — só dá pra acrescentar TEXTO).
      // Best-effort, nunca deve derrubar o processamento normal do status.
      if (status === 'delivered' || status === 'read') {
        try {
          const dealId = await store.getDealForPhone(sessionId, phone);
          if (dealId) {
            const message = await store.getMessageForReply(sessionId, phone, messageId);
            if (message && message.direction === 'out') {
              const preview = message.text
                ? `"${message.text.length > 80 ? message.text.slice(0, 80) + '…' : message.text}"`
                : `[${message.type}]`;
              const label = status === 'read' ? 'Visualizada' : 'Entregue';
              logStatusToTimeline(dealId, `${label} pelo contato — ${preview}`).catch((e) =>
                console.error('[server] falha ao logar status na timeline:', e.message)
              );
            }
          }
        } catch (err) {
          console.error('[server] falha ao preparar log de status na timeline:', err.message);
        }
      }
    } catch (err) {
      console.error('[server] falha ao processar status de mensagem:', err.message);
    }
  },
  // "Digitando…"/"gravando áudio…" do CONTATO — puramente ao vivo, não
  // persiste em lugar nenhum (mesma natureza efêmera de qualquer indicador
  // de digitação em qualquer chat).
  onPresence: (sessionId, phone, state) => {
    broadcast(sessionId, phone, { type: 'presence', state });
  },
});

// retoma sessões já pareadas para continuar recebendo mensagens
sessions.startAllExisting();

// verifica a cada 30s se algum agendamento de campanha (Kanban/Calendário)
// já chegou na hora marcada e dispara sozinho
require('./scheduler').startPolling(sessions);

// Varre a cada ~20min os negócios vinculados a conversas em busca de
// mudança pra etapa "ganho" — dispara o grupo automático do Agente de
// IA no FECHAMENTO do negócio (mudança de gatilho, antes disparava na
// criação do card — ver HANDOFF). Sem retroatividade: só mudança
// observada a partir de agora conta.
require('./dealStagePoller').startPolling();

// Fecha sozinha page_sessions "órfãs" (aba fechada sem o beacon de saída
// disparar — crash, queda de luz, ver HANDOFF Parte CO) — sem isto,
// ficariam com ended_at null pra sempre. Intervalo de 60s (mais frequente
// que o timeout de 90s que closeStaleSessions usa internamente, pra não
// deixar uma sessão órfã "pendurada" por muito tempo além do necessário).
setInterval(() => {
  pageSessions.closeStaleSessions().catch((err) =>
    console.error('[page-session] falha ao fechar sessões órfãs:', err.message)
  );
}, 60000);

// Alerta de instância caída — snapshot diário da série de métricas
// (instance_metrics_daily, ver src/instanceHealthStore.js). Roda a cada
// hora, mas grava só 1x por dia por instância de fato — o próprio
// `on conflict (instance_id, snapshot_date)` do insert garante isso
// (chamadas depois da 1ª no mesmo dia só atualizam com o valor mais
// recente, não duplicam linha). Reintentar a cada hora (em vez de 1x/dia
// fixo) existe só pra se recuperar sozinho de uma falha pontual (ex:
// banco fora do ar por alguns minutos) sem esperar até o dia seguinte.
//
// Pula instâncias ÓRFÃS (isOrphan, ver instancesStore.listAll() e HANDOFF
// Parte ED) no cálculo POR OWNER — não há dono real pra contar contatos
// contra. Grava só conversation_count (sempre válido, é por session_id)
// e deixa contact_count_real como 0 explicitamente pra essas (nunca um
// valor adivinhado).
async function runDailyMetricsSnapshot() {
  const instances = await instancesStore.listAll();
  for (const inst of instances) {
    try {
      const conversationCount = await store.countConversations(inst.id);
      const contactCountReal = inst.isOrphan ? 0 : await contactsStore.countContacts(inst.ownerId);
      const gateway = sessions.getActiveGateway(inst.id);
      const contactCountBaileys = gateway ? gateway.getContactCount() : null;
      const groupCount = gateway ? await gateway.getGroupCount() : null;
      await instanceHealthStore.snapshotDailyMetrics(inst.id, {
        conversationCount,
        contactCountReal,
        contactCountBaileys,
        groupCount,
      });
    } catch (err) {
      console.error(`[instance-health] falha ao gerar snapshot de métricas de ${inst.id}:`, err.message);
    }
  }
}
setInterval(() => {
  runDailyMetricsSnapshot().catch((err) =>
    console.error('[instance-health] falha ao rodar snapshot diário de métricas:', err.message)
  );
}, 60 * 60 * 1000);
// Dispara 1x já no boot (com um pequeno atraso, pra não competir com o
// escalonamento de reconexão de sessões salvas — startAllExisting acima),
// pra não esperar até 1h depois de um deploy pra ter o 1º dado do dia.
setTimeout(() => {
  runDailyMetricsSnapshot().catch((err) =>
    console.error('[instance-health] falha ao rodar snapshot inicial de métricas:', err.message)
  );
}, 30000);

// ---------------------------------------------------------------
// POST /api/auth/verify { accessToken }
// Login do próprio app: confirma com o Bitrix (domínio fixo do servidor,
// nunca o que o client mandar) que o access_token pertence a um usuário real
// deste portal, e devolve um token de app (curto, assinado) que o frontend
// passa a usar em todas as chamadas seguintes via `Authorization: Bearer`.
// Fica FORA do requireAuth abaixo, porque é o próprio passo de login.
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Marca (nome/subtítulo/cor) — pública, sem autenticação: é só config de
// exibição, nada sensível. Vazio por padrão (o HTML de cada página já tem um
// texto fixo como fallback) — só sobrescreve quando as variáveis de
// ambiente estiverem definidas, pra uma instância nova (outro cliente)
// poder trocar a marca sem editar nenhum arquivo HTML.
// ---------------------------------------------------------------
app.get('/api/brand', async (req, res) => {
  // Paleta editada pela tela /settings.html (banco) tem prioridade sobre
  // BRAND_COLOR do .env — o .env continua funcionando como fallback pra
  // quem nunca abriu a tela de Configurações (nunca editou = null no banco
  // = usa o padrão de sempre pra aquele papel específico).
  let dbSettings = {};
  try {
    dbSettings = await settings.get();
  } catch (err) {
    console.error('[brand] falha ao ler paleta do banco:', err.message);
  }
  res.json({
    name: process.env.BRAND_NAME || null,
    subtitle: process.env.BRAND_SUBTITLE || null,
    color: dbSettings.accentColor || process.env.BRAND_COLOR || null,
    colorDim: dbSettings.accentColorDim || null,
    green: dbSettings.greenColor || null,
    red: dbSettings.redColor || null,
    bg: dbSettings.bgColor || null,
    instagramUrl: process.env.BRAND_INSTAGRAM_URL || null,
    linkedinUrl: process.env.BRAND_LINKEDIN_URL || null,
    address: process.env.BRAND_ADDRESS || null,
  });
});

// ---------------------------------------------------------------
// GET /api-docs — documentação interativa (Swagger UI) da API REST, pra
// equipe consumir dados fora do navegador (scripts, Postman, Power Query).
// Pública de propósito (só descreve as rotas, nenhum dado real aqui) — as
// chamadas de verdade continuam exigindo o Bearer token de sempre, gerado
// em /settings.html ("Token de API"). Ver src/openapi.js.
// ---------------------------------------------------------------
// customCss aplica a MESMA paleta dourada/escura do resto do app por
// cima do tema padrão claro do Swagger UI (nunca uma identidade visual
// nova, mesma regra de design system do resto do projeto) — swagger-ui-
// express aceita CSS bruto via essa opção, sem precisar de build/asset
// próprio. Cores em hex cru (não var(--x)) porque este CSS é injetado
// isolado do :root das outras páginas.
const SWAGGER_CUSTOM_CSS = `
  body { background: #15120d; }
  .swagger-ui { background: #15120d; color: #f3ede2; }
  .swagger-ui .topbar { background: #1d1812; border-bottom: 1px solid #34291a; padding: 10px 0; }
  .swagger-ui .info .title, .swagger-ui .info h1, .swagger-ui .info h2, .swagger-ui .info h3 { color: #d8ab4f; }
  .swagger-ui .info .title small.version-stamp { background: #8a6b32; }
  .swagger-ui .info .title small.version-stamp pre { background: #8a6b32; }
  .swagger-ui .scheme-container { background: #1d1812; box-shadow: none; border-bottom: 1px solid #34291a; }
  .swagger-ui .opblock-tag { color: #f3ede2; border-bottom: 1px solid #34291a; }
  .swagger-ui .opblock-tag:hover { background: rgba(216,171,79,.06); }
  .swagger-ui .opblock { background: #1d1812; border-color: #34291a; box-shadow: none; }
  .swagger-ui .opblock .opblock-summary { border-color: #34291a; }
  .swagger-ui .opblock .opblock-summary-description { color: #a89a83; }
  .swagger-ui .opblock.opblock-get { background: #1d1812; border-color: rgba(97,175,254,.4); }
  .swagger-ui .opblock.opblock-get .opblock-summary-method { background: #4c9fd8; }
  .swagger-ui .opblock.opblock-post { background: #1d1812; border-color: rgba(76,175,110,.4); }
  .swagger-ui .opblock.opblock-post .opblock-summary-method { background: #4caf6e; }
  .swagger-ui .opblock.opblock-put { background: #1d1812; border-color: rgba(216,171,79,.4); }
  .swagger-ui .opblock.opblock-put .opblock-summary-method { background: #d8ab4f; color: #1a1408; }
  .swagger-ui .opblock.opblock-delete { background: #1d1812; border-color: rgba(217,104,95,.4); }
  .swagger-ui .opblock.opblock-delete .opblock-summary-method { background: #d9685f; }
  .swagger-ui .opblock-body pre.microlight, .swagger-ui .highlight-code { background: #241d15 !important; color: #f3ede2; }
  .swagger-ui table thead tr td, .swagger-ui table thead tr th { color: #a89a83; border-bottom: 1px solid #34291a; }
  .swagger-ui .parameter__name, .swagger-ui .response-col_status { color: #f3ede2; }
  .swagger-ui .parameter__type, .swagger-ui .response-col_description { color: #a89a83; }
  .swagger-ui .tab li, .swagger-ui .opblock-description-wrapper p, .swagger-ui .opblock-external-docs-wrapper p,
  .swagger-ui .opblock-title_normal p, .swagger-ui .renderedMarkdown p { color: #a89a83; }
  .swagger-ui select, .swagger-ui input[type=text] { background: #241d15; color: #f3ede2; border-color: #34291a; }
  .swagger-ui .btn { border-color: #34291a; color: #f3ede2; }
  .swagger-ui .btn.authorize { background: rgba(76,175,110,.1); border-color: #4caf6e; color: #4caf6e; }
  .swagger-ui .btn.authorize svg { fill: #4caf6e; }
  .swagger-ui .btn.execute { background: #d8ab4f; border-color: #d8ab4f; color: #1a1408; }
  .swagger-ui .model-box, .swagger-ui section.models { background: #1d1812; border-color: #34291a; }
  .swagger-ui section.models .model-container { background: #241d15; }
  .swagger-ui .model-title, .swagger-ui .prop-name, .swagger-ui .model .property.primitive { color: #f3ede2; }
  .swagger-ui .dialog-ux .modal-ux { background: #1d1812; border-color: #34291a; }
  .swagger-ui .dialog-ux .modal-ux-header h3 { color: #d8ab4f; }
  .swagger-ui .info a { color: #d8ab4f; }
  .swagger-ui a.nostyle, .swagger-ui .opblock-summary-path, .swagger-ui .opblock-summary-path__deprecated { color: #f3ede2; }
  .swagger-ui .response-col_links, .swagger-ui .responses-inner h4, .swagger-ui .responses-inner h5 { color: #a89a83; }
  .swagger-ui .copy-to-clipboard { background: #34291a; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: #15120d; }
  ::-webkit-scrollbar-thumb { background: #34291a; border-radius: 100px; }
`;

app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(openapiSpec, {
    customSiteTitle: 'API — WhatsApp Gateway',
    customCss: SWAGGER_CUSTOM_CSS,
    swaggerOptions: {
      docExpansion: 'list', // tags expandidas, operações recolhidas — mais fácil de navegar que "none" (tudo fechado) ou "full" (tudo aberto, rola demais)
      defaultModelsExpandDepth: 1,
      displayRequestDuration: true,
      filter: true, // caixa de busca por tag/rota, útil com muitos endpoints
      tryItOutEnabled: false, // exige clique em "Try it out" antes de editar parâmetros — evita disparo acidental de request real numa API que já tem token de longa duração
    },
  })
);

// ---------------------------------------------------------------
// Formulários públicos de captura de lead ("Sites") — /l/<slug> é a
// página pública (mesmo arquivo estático pra qualquer slug, o JS dele lê
// o slug da própria URL); /api/leads/* são as rotas que essa página
// consome, sem login/Bitrix (ver src/routes/leads.js). O CRUD autenticado
// (criar/editar formulário) fica em /api/lead-forms, atrás de requireAuth,
// junto dos outros mounts protegidos mais abaixo.
// ---------------------------------------------------------------
app.get('/l/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/lead-form.html'));
});
app.use('/api/leads', createLeadsRouter({ sessions, broadcast }));

// ---------------------------------------------------------------
// Pesquisa de Satisfação — /pesquisa/<slug> é a página pública (público
// "client", sem login), consome /api/satisfaction-public/* (sem
// requireAuth, ver src/routes/satisfactionPublic.js). O CRUD/métricas
// (só super admin) e a resposta do público "internal" ficam em
// /api/satisfaction, atrás de requireAuth, montado junto dos outros
// mounts protegidos mais abaixo.
// ---------------------------------------------------------------
app.get('/pesquisa/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/satisfaction-form.html'));
});
app.use('/api/satisfaction-public', createSatisfactionPublicRouter());

// ---------------------------------------------------------------
// Teste A/B — URL pública única que divide o tráfego 50/50 entre as duas
// LPs do teste, com stickiness por visitante (cookie ab_<id>, 90 dias, pra
// quem voltar cair sempre na mesma variante). Redirect 302 pro /l/<slug>
// da variante: a view (GET /config) e a submissão contam pra variante
// naturalmente, sem tracking extra. Teste encerrado → todo mundo vai pro
// vencedor. Query string é preservada (utm_*), + #formulario (mesmo padrão
// do link público dos cards em sites.html).
// ---------------------------------------------------------------
app.get('/t/:slug', async (req, res) => {
  try {
    const test = await abTests.getBySlugPublic(req.params.slug);
    if (!test) return res.status(404).send('teste não encontrado');

    let variantSlug;
    if (test.status === 'finished') {
      // vencedor (ou A, se encerrado sem vencedor declarado)
      variantSlug =
        test.winnerFormId != null && String(test.winnerFormId) === String(test.formBId)
          ? test.formBSlug
          : test.formASlug || test.formBSlug;
    } else {
      const cookieName = `ab_${test.id}`;
      // parse manual do header (3 linhas) — o projeto não usa cookie-parser
      const cookies = Object.fromEntries(
        (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2)
      );
      let variant = cookies[cookieName];
      if (variant !== 'a' && variant !== 'b') {
        variant = Math.random() < 0.5 ? 'a' : 'b';
      }
      // se a LP sorteada foi excluída/está sem slug, cai pra outra
      if (variant === 'a' && !test.formASlug) variant = 'b';
      if (variant === 'b' && !test.formBSlug) variant = 'a';
      variantSlug = variant === 'b' ? test.formBSlug : test.formASlug;
      res.setHeader('Set-Cookie', `ab_${test.id}=${variant}; Path=/; Max-Age=7776000; SameSite=Lax`);
    }

    if (!variantSlug) return res.status(404).send('as LPs deste teste não existem mais');

    const qIndex = req.originalUrl.indexOf('?');
    const qs = qIndex >= 0 ? req.originalUrl.slice(qIndex) : '';
    res.redirect(302, `/l/${variantSlug}${qs}#formulario`);
  } catch (err) {
    console.error('[ab-tests:/t] erro:', err.message);
    res.status(502).send('erro ao abrir o teste');
  }
});

app.post('/api/auth/verify', async (req, res) => {
  const { accessToken } = req.body || {};
  if (!accessToken) return res.status(400).json({ error: 'accessToken é obrigatório' });
  try {
    const userId = await verifyBitrixToken(accessToken);
    if (!userId) return res.status(401).json({ error: 'token inválido' });
    const ownerId = ownerIdFor(userId);
    res.json({ ownerId, token: issueAppToken(ownerId), expiresIn: TOKEN_TTL_MS / 1000 });
  } catch (err) {
    console.error('[auth] erro ao verificar:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// POST /api/whatsapp/page-session/close  { sessionId, token }
// Fecha a "visita" de página com a duração real (ver navigator.sendBeacon
// no frontend, disparado no evento 'pagehide' — ver HANDOFF Parte CO).
// PRECISA ficar aqui, ANTES do app.use('/api/whatsapp', requireAuth, ...)
// abaixo: sendBeacon() não permite setar headers customizados, então não
// dá pra mandar Authorization: Bearer nele — uma rota "sem requireAuth"
// dentro do router (createWhatsappRouter) nunca seria alcançada, porque
// esse middleware já roda pra TODO o router antes de rotear qualquer
// coisa dele. Verifica o mesmo token de app de sempre, só que lido do
// BODY (não do header) — não é uma exceção de segurança, é a mesma
// adaptação que toda rota alimentada por beacon precisa.
// ---------------------------------------------------------------
app.post('/api/whatsapp/page-session/close', async (req, res) => {
  try {
    const { sessionId, token } = req.body || {};
    if (!sessionId || !token) return res.status(400).json({ error: 'sessionId e token são obrigatórios' });
    const ownerId = verifyAppToken(token);
    if (!ownerId) return res.status(401).json({ error: 'não autenticado' });
    await pageSessions.closeSession(sessionId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[page-session] falha ao fechar:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// Rotas REST consumidas pela aba do card (frontend) — atrás de requireAuth:
// nenhuma delas aceita mais `session`/`owner` sem provar (via token de app,
// emitido só depois de confirmar a identidade com o Bitrix) que pertence a
// quem está fazendo a requisição.
// ---------------------------------------------------------------
app.use('/api/whatsapp', requireAuth, createWhatsappRouter({ sessions, broadcast }));
app.use('/api', requireAuth, createCrmRouter());
app.use('/api/lead-forms', requireAuth, createLeadFormsRouter());
app.use('/api/ab-tests', requireAuth, createAbTestsRouter());
app.use('/api/suggestions', requireAuth, createSuggestionsRouter({ sessions }));
app.use('/api/settings', requireAuth, createSettingsRouter());
app.use('/api/conversation-analysis', requireAuth, createConversationAnalysisRouter());
app.use('/api/card-group', requireAuth, createCardGroupRouter({ sessions }));
app.use('/api/internal-notes', requireAuth, createInternalNotesRouter({ broadcast }));
// Dapinho (assistente de IA por dono + avisos de feature nova, ver
// src/dapinho.js) — mesma injeção de broadcast que internalNotes/
// agentDispatch/insightGenerator acima.
dapinho.configure({ broadcast });
app.use('/api/dapinho', requireAuth, createDapinhoRouter());
// agentDispatch precisa de `sessions`/`broadcast` (pra enviar a resposta
// gerada e persistir/broadcastar como qualquer mensagem de saída) — módulo
// separado, sem acesso a essas variáveis por closure, então injetado
// explicitamente aqui (mesmo momento em que os outros routers recebem os
// mesmos objetos).
agentDispatch.configure({ sessions, broadcast });
app.use('/api/agent', requireAuth, createAgentRouter());
// insightGenerator (Copiloto Comercial) — mesma injeção de broadcast que
// agentDispatch acima, pra emitir `ai-insight` assim que gerado.
insightGenerator.configure({ broadcast });
app.use('/api/insights', requireAuth, createInsightsRouter({ sessions, broadcast }));
app.use('/api/satisfaction', requireAuth, createSatisfactionRouter());

// ---------------------------------------------------------------
// Sobe HTTP + WebSocket no mesmo servidor/porta
// ---------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (request, socket, head) => {
  const { pathname, searchParams } = new URL(request.url, `http://${request.headers.host}`);

  if (pathname !== '/api/whatsapp/stream') {
    socket.destroy();
    return;
  }

  const phone = searchParams.get('phone'); // ausente = inscrição na sessão inteira (ver subKey)
  const session = searchParams.get('session');
  const token = searchParams.get('token');
  if (!session) {
    socket.destroy();
    return;
  }

  // Browser não manda headers customizados no handshake de WebSocket, então
  // o token de app (o mesmo emitido por POST /api/auth/verify) viaja na
  // querystring — mesma checagem de posse das rotas REST.
  const ownerId = verifyAppToken(token);
  if (!ownerId) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!(await assertOwnsSession(session, ownerId))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    const key = subKey(session, phone);
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key).add(ws);

    // Dapinho (ver src/authz.js, isDapinhoSession) nunca é uma sessão real
    // do SessionManager — sessions.get(session) lançaria pra esse
    // session_id virtual. Sem status de conexão faz sentido (não é
    // WhatsApp real), então só pula o envio inicial nesse caso.
    if (!isDapinhoSession(session)) {
      ws.send(JSON.stringify({ type: 'status', status: sessions.get(session).getStatus() }));
    }

    ws.on('close', () => {
      const set = subscribers.get(key);
      if (set) {
        set.delete(ws);
        if (set.size === 0) subscribers.delete(key);
      }
    });
  });
});

// Rede de segurança de ÚLTIMA LINHA — não substitui os try/catch já
// existentes em cada rota (essas continuam respondendo com err.message
// direto, são mensagens de negócio escritas de propósito: "sessão não
// encontrada", "imagem maior que 6MB" etc., úteis pro usuário). Isto aqui
// só entra em ação quando um erro ESCAPA de tudo isso sem ser tratado —
// no Express 4 (a versão usada aqui), isso só acontece de fato com um erro
// SÍNCRONO num handler não-async, ou se algum código chamar `next(err)`
// explicitamente (nenhum lugar faz isso hoje). PRECISA ficar depois de
// TODAS as rotas — é isso que o marca como error handler pro Express
// (assinatura de 4 parâmetros, não 3).
app.use((err, req, res, next) => {
  console.error('[server] erro não tratado chegou até a última linha de defesa:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'erro interno — já foi registrado, tente de novo em um momento' });
});

server.listen(PORT, () => {
  console.log(`[server] gateway multi-sessão rodando na porta ${PORT}`);
  console.log(`[server] o QR Code de cada usuário aparece dentro da aba "WhatsApp" do card de Negócio`);
});
