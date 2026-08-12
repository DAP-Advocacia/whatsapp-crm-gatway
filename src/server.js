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
const settings = require('./settings');
const abTests = require('./abTests');
const store = require('./store');
const pageSessions = require('./pageSessions');
const contactsStore = require('./contacts');
const { onCampaignMessageStatus } = require('./campaigns');
const { logMessageToTimeline, logStatusToTimeline } = require('./bitrix');
const { verifyBitrixToken, ownerIdFor, issueAppToken, verifyAppToken, requireAuth, TOKEN_TTL_MS } = require('./auth');
const { assertOwnsSession } = require('./authz');
const instancesStore = require('./instances');

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

app.use(express.static('public'));
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
  <p id="msg">Registrando a aba "DapZAP" nos cards de Negócio…</p>
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
          el.textContent = 'Aba registrada. Registrando o botão "DapZAP"…';

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
                el.textContent = 'Aba registrada; botão "DapZAP" indisponível neste portal (' + JSON.stringify(res2.error()) + '). Finalizando…';
                BX24.installFinish();
                return;
              }
              el.textContent = 'Aba e botão "DapZAP" registrados! Finalizando…';
              BX24.installFinish();
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
  onStatus: (sessionId, status) => {
    console.log(`[whatsapp:${sessionId}] status:`, status);
    broadcastStatus(sessionId, status);
  },
  onMessage: async (sessionId, phone, message, pushName, isHistory) => {
    try {
      const dealId = await store.getDealForPhone(sessionId, phone);
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
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, { customSiteTitle: 'API — WhatsApp Gateway' }));

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
app.use('/api/suggestions', requireAuth, createSuggestionsRouter());
app.use('/api/settings', requireAuth, createSettingsRouter());

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

    ws.send(JSON.stringify({ type: 'status', status: sessions.get(session).getStatus() }));

    ws.on('close', () => {
      const set = subscribers.get(key);
      if (set) {
        set.delete(ws);
        if (set.size === 0) subscribers.delete(key);
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`[server] gateway multi-sessão rodando na porta ${PORT}`);
  console.log(`[server] o QR Code de cada usuário aparece dentro da aba "WhatsApp" do card de Negócio`);
});
