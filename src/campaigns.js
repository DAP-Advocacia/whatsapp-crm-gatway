const store = require('./store');
const { logMessageToTimeline } = require('./bitrix');
const { saveMedia } = require('./media');
const campaignStore = require('./campaignStore');
const scheduledStore = require('./scheduledCampaigns');

/**
 * Envio em lote (campanha): manda uma mensagem (com variáveis {{nome}} e
 * {{telefone}} substituídas por destinatário) pra vários telefones, um de
 * cada vez, com um intervalo entre cada envio, opcionalmente anexando uma
 * mídia (imagem/áudio/vídeo).
 *
 * AVISO: enviar em volume é o padrão de comportamento que mais chama atenção
 * dos sistemas antispam do WhatsApp — o número pode ser banido. O intervalo
 * entre mensagens e o limite de destinatários (ver routes/whatsapp.js) são
 * uma precaução básica, não uma garantia.
 *
 * Estado guardado em memória (Map) — some se o processo reiniciar no meio de
 * uma campanha. Não é pensado para volumes que justifiquem uma fila de
 * verdade (ex: BullMQ) — se isso virar necessário, é hora de trocar.
 */

const campaigns = new Map();

// wa_message_id -> { campaignId, phone, sessionId, templates, retryAttempt,
// media } — só enquanto a campanha ainda pode receber uma correção
// retroativa de status (ver onCampaignMessageStatus abaixo). Os demais
// campos são o que precisamos pra reconstruir um agendamento de retry sem
// re-consultar nada (ver scheduleCampaignRetry) — media é null se a
// mensagem original não tinha anexo. Sem TTL: o volume é o mesmo de
// `campaigns` (que também nunca é limpo em memória hoje — reinicia zerado
// a cada restart do processo, mesma limitação já aceita pro estado "ao
// vivo" de campanha).
const messageIdToCampaign = new Map();

// campaignId -> { phones: Set, sessionId, template, timer } — falhas 463
// confirmadas de uma campanha ainda não finalizada em retry, esperando o
// debounce (nenhuma falha nova por RETRY_DEBOUNCE_MS) antes de agendar o
// retry de uma vez só pra TODOS os telefones falhos daquela campanha, em
// vez de um agendamento por telefone (ver onCampaignMessageStatus).
const pendingRetryBuffers = new Map();
const RETRY_DEBOUNCE_MS = 60 * 1000;
const RETRY_DELAY_MS = 24 * 60 * 60 * 1000; // 24h — decisão confirmada com o
// usuário, alinhada com o aviso do próprio Baileys ("retrying counts as
// another reach out and worsens the restriction") — 1h/3 tentativas
// (valor inicial) foi descartado por causa desse aviso.

// É async e PRECISA ser aguardada pelo caller: quem chama isto depois usa o
// id retornado em updates que têm foreign key pra `campaigns` (ver
// campaignStore.recordResult/updateProgress e scheduledCampaigns.setStatus)
// — se a linha em `campaigns` ainda não existir de verdade no Postgres nesse
// momento, esses updates falham com "violates foreign key constraint".
async function createCampaign(total, meta = {}) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  campaigns.set(id, {
    id,
    sessionId: meta.sessionId || null,
    name: meta.name || null,
    total,
    sent: 0,
    failed: 0,
    status: 'running', // 'running' | 'done' (o histórico no banco só conhece estes dois; pausa é só em memória)
    paused: false, // instância offline, esperando voltar (a tela mostra "pausada")
    pausedAt: null,
    abortReason: null, // preenchido se desistiu por instância offline por tempo demais
    results: [], // { phone, ok, error? }
  });

  // grava o cabeçalho da campanha já de cara, pro dashboard de métricas
  // conseguir listá-la mesmo enquanto ainda está em andamento
  try {
    await campaignStore.insertCampaign({ id, sessionId: meta.sessionId, name: meta.name, total, hasMedia: !!meta.hasMedia });
  } catch (err) {
    console.error('[campaign] falha ao gravar histórico:', err.message);
  }

  return id;
}

function getCampaign(id) {
  return campaigns.get(id) || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderTemplate(template, recipient) {
  return template
    .replace(/\{\{\s*nome\s*\}\}/gi, recipient.name || '')
    .replace(/\{\{\s*telefone\s*\}\}/gi, recipient.phone);
}

// Instância caiu no meio da lista (queda 503, deploy, reconexão do boot): em vez de marcar
// todo mundo que falta como falhado, o envio PAUSA e retoma sozinho quando ela volta. Passou
// de OFFLINE_MAX_WAIT_MS fora do ar, desiste e marca o resto como "não enviado" (não houve
// tentativa de envio nenhuma pra eles). 30 min cobre quedas curtas; o boot completo leva ~75 min.
const OFFLINE_POLL_MS = Number(process.env.CAMPAIGN_OFFLINE_POLL_MS) || 5000;
const OFFLINE_MAX_WAIT_MS = Number(process.env.CAMPAIGN_OFFLINE_MAX_WAIT_MS) || 30 * 60 * 1000;
const NOT_CONNECTED_MSG = 'WhatsApp não está conectado no momento'; // src/whatsapp.js, lançado ANTES de qualquer envio
const MAX_NOT_CONNECTED_RETRIES = 3; // status dizia "online" mas o envio recusou: corrida entre a queda e o espelho de status

// true = online (retomou, se estava pausada); false = desistiu depois de OFFLINE_MAX_WAIT_MS.
async function waitForOnline(gateway, campaign, campaignId) {
  if (gateway.getStatus() === 'online') return true;
  campaign.paused = true;
  campaign.pausedAt = new Date().toISOString();
  console.warn(`[campaign] ${campaignId} pausada: instância ${campaign.sessionId} offline (espera até ${Math.round(OFFLINE_MAX_WAIT_MS / 60000)} min)`);
  const deadline = Date.now() + OFFLINE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(OFFLINE_POLL_MS);
    if (gateway.getStatus() === 'online') {
      campaign.paused = false;
      console.log(`[campaign] ${campaignId} retomada: instância ${campaign.sessionId} voltou`);
      return true;
    }
  }
  campaign.paused = false;
  return false;
}

// Roda em segundo plano (não é `await`ado pelo caller) — o progresso é
// consultado depois via getCampaign(id). retryAttempt (0 = campanha normal,
// 1 = ela mesma É o retry automático de outra) propaga pra
// onCampaignMessageStatus nunca agendar um SEGUNDO retry se este também
// falhar — decisão confirmada: só 1 tentativa.
async function runCampaign(id, { gateway, sessionId, recipients, template, templates, media, minDelayMs, maxDelayMs, retryAttempt = 0 }) {
  const campaign = campaigns.get(id);
  // Lista de transmissão: várias versões do mesmo texto, alternadas na ordem
  // (1, 2, 3, 1, 2, 3…) — o índice anda por DESTINATÁRIO (não só por envio
  // bem-sucedido), então a distribuição fica uniforme mesmo com falhas.
  // `template` sozinho (campanha comum, agendamento antigo) = 1 versão só.
  const variants = Array.isArray(templates) && templates.length ? templates : [template];

  let notConnectedRetries = 0;
  for (let i = 0; i < recipients.length; i++) {
    // Instância offline: espera voltar; se não voltar a tempo, os que faltam não são enviados.
    if (!(await waitForOnline(gateway, campaign, id))) {
      const reason = `não enviado: o WhatsApp ficou offline por mais de ${Math.round(OFFLINE_MAX_WAIT_MS / 60000)} min`;
      console.warn(`[campaign] ${id} interrompida: ${recipients.length - i} contato(s) não enviados (instância offline)`);
      for (let j = i; j < recipients.length; j++) {
        campaign.failed++;
        campaign.results.push({ phone: recipients[j].phone, ok: false, error: reason, variant: j % variants.length, notSent: true });
        campaignStore.recordResult(id, recipients[j].phone, false, reason).catch((e) => console.error('[campaign] falha ao gravar envio:', e.message));
      }
      campaign.abortReason = reason;
      campaignStore.updateProgress(id, campaign.sent, campaign.failed).catch((err) => console.error('[campaign] falha ao atualizar progresso:', err.message));
      break;
    }
    // Voltou depois de uma pausa: não manda na hora, espera um intervalo normal (a sessão acabou de reconectar).
    if (campaign.pausedAt) {
      campaign.pausedAt = null;
      await sleep(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
    }

    const recipient = recipients[i];
    const phone = recipient.phone;
    const variantTemplate = variants[i % variants.length];
    try {
      const text = renderTemplate(variantTemplate, recipient);
      let message;

      if (media) {
        // sendMedia pode converter o arquivo (ex: áudio -> ogg/opus) — sempre
        // salvar os bytes/mimetype que foram de fato enviados.
        const { buffer: sentBuffer, mimetype: sentMimetype, ...sent } = await gateway.sendMedia(phone, {
          type: media.type,
          buffer: media.buffer,
          mimetype: media.mimetype,
          caption: text || undefined,
        });
        const mediaUrl = await saveMedia(sessionId, sent.id, sentBuffer, sentMimetype);
        message = { ...sent, type: media.type, text: text || null, mediaUrl, mimetype: sentMimetype };
      } else {
        message = await gateway.sendMessage(phone, text);
      }

      const dealId = await store.getDealForPhone(sessionId, phone);
      await store.addMessage(sessionId, phone, message, dealId);

      if (dealId) {
        const label = media ? `[${media.type}]${text ? ' ' + text : ''}` : text;
        logMessageToTimeline(dealId, label, 'out').catch(() => {});
      }

      // Só marca sucesso AGORA sabendo que o WhatsApp pode rejeitar a
      // entrega DEPOIS, de forma assíncrona (ver messages.update/status
      // 'failed' em src/whatsapp.js — código 463 "account restricted",
      // comum ao mandar campanha pra quem nunca conversou com este número
      // antes). Guarda a correspondência pra onCampaignMessageStatus poder
      // corrigir isto retroativamente se essa rejeição chegar, e (se
      // retryAttempt for 0) eventualmente agendar um retry — incluindo a
      // mídia (se houver), pra um retry de campanha com mídia não virar
      // silenciosamente um retry só de texto.
      if (message.id) {
        messageIdToCampaign.set(message.id, {
          campaignId: id, phone, sessionId, templates: variants, retryAttempt,
          media: media ? { type: media.type, mimetype: message.mimetype, url: message.mediaUrl } : null,
        });
      }

      campaign.sent++;
      campaign.results.push({ phone, ok: true, variant: i % variants.length });
      campaignStore.recordResult(id, phone, true).catch((err) => console.error('[campaign] falha ao gravar envio:', err.message));
    } catch (err) {
      // Caiu entre a checagem de status e o envio: nada foi enviado (o erro é lançado antes),
      // então tenta o MESMO contato de novo (volta ao topo, que espera a instância voltar).
      if (err.message === NOT_CONNECTED_MSG && notConnectedRetries < MAX_NOT_CONNECTED_RETRIES) {
        notConnectedRetries++;
        i--;
        await sleep(OFFLINE_POLL_MS);
        continue;
      }
      campaign.failed++;
      campaign.results.push({ phone, ok: false, error: err.message, variant: i % variants.length });
      campaignStore.recordResult(id, phone, false, err.message).catch((e) => console.error('[campaign] falha ao gravar envio:', e.message));
    }

    notConnectedRetries = 0; // o contato foi resolvido (enviado ou falha definitiva)
    campaignStore.updateProgress(id, campaign.sent, campaign.failed).catch((err) => console.error('[campaign] falha ao atualizar progresso:', err.message));

    // intervalo com variação, pra não mandar tudo num ritmo robótico constante
    const delay = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
    await sleep(delay);
  }

  campaign.status = 'done';
  campaignStore.finishCampaign(id).catch((err) => console.error('[campaign] falha ao finalizar histórico:', err.message));
}

// Acumula um telefone falho no buffer daquela campanha e (re)agenda o
// debounce — chamado só quando retryAttempt da campanha original é 0 (ela
// mesma nunca foi um retry). Cada chamada nova pra mesma campanha reseta o
// timer (RETRY_DEBOUNCE_MS sem nenhuma falha nova antes de agendar de
// verdade) — evita criar um scheduled_campaigns por telefone, agrupa todos
// os falhos daquela campanha num retry só.
function bufferForRetry(campaignId, phone, sessionId, templates, media) {
  let buf = pendingRetryBuffers.get(campaignId);
  if (!buf) {
    buf = { phones: new Set(), sessionId, templates, media, timer: null };
    pendingRetryBuffers.set(campaignId, buf);
  }
  buf.phones.add(phone);
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    pendingRetryBuffers.delete(campaignId);
    scheduleCampaignRetry(campaignId, buf).catch((err) =>
      console.error('[campaign] falha ao agendar retry automático:', err.message)
    );
  }, RETRY_DEBOUNCE_MS);
}

// Cria a linha em scheduled_campaigns pro retry — reaproveita o poller já
// existente (src/scheduler.js, startPolling) sem nenhuma mudança nele: na
// hora marcada, sendScheduled trata isto como qualquer outro agendamento,
// só que com retryAttempt=1 propagado (ver src/scheduler.js), que impede um
// segundo retry se este também falhar.
async function scheduleCampaignRetry(campaignId, { phones, sessionId, templates, media }) {
  const id = 'retry_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const recipients = [...phones].map((phone) => ({ phone, name: null }));
  // media.url já é o caminho relativo salvo no Storage (mesmo formato que
  // POST /campaign/schedule monta) — scheduledStore.create/sendScheduled já
  // sabem lidar com isso sem nenhuma mudança (downloadMedia na hora de
  // disparar de fato, ver src/scheduler.js).
  await scheduledStore.create({
    id,
    sessionId,
    name: 'Retry automático (erro 463)',
    recipients,
    // o retry volta a alternar TODAS as versões da campanha original (não
    // só a que cada telefone recebeu) — mantém o objetivo de não repetir o
    // mesmo texto em sequência.
    template: templates[0],
    templates: templates.length > 1 ? templates : null,
    media: media?.url ? { type: media.type, mimetype: media.mimetype, url: media.url } : null,
    scheduledAt: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
    retryOfCampaignId: campaignId,
    retryAttempt: 1,
  });
  console.log(`[campaign] retry automático agendado: ${recipients.length} destinatário(s) da campanha ${campaignId}, em 24h`);
}

// Chamado por src/server.js (dentro de onMessageStatus) toda vez que uma
// mensagem qualquer muda de status — não só as de campanha, por isso o
// primeiro passo é checar se esse messageId é mesmo de uma campanha (a
// esmagadora maioria não é). Corrige tanto o estado em memória (usado pelo
// polling de progresso, GET /campaign/:id) quanto o histórico persistido
// (campaignStore.markResultFailedAsync) — e, se a campanha original nunca
// foi ela mesma um retry, acumula o telefone pro retry automático (24h,
// só 1 tentativa).
async function onCampaignMessageStatus(messageId, status) {
  if (status !== 'failed') return;
  const entry = messageIdToCampaign.get(messageId);
  if (!entry) return;
  messageIdToCampaign.delete(messageId); // consumido — não corrige duas vezes

  const { campaignId, phone, sessionId, templates, retryAttempt, media } = entry;
  try {
    const corrected = await campaignStore.markResultFailedAsync(campaignId, phone, 'rejeitado pelo WhatsApp após o envio (conta restrita/sem token de privacidade com este contato)');
    if (!corrected) return;
    const campaign = campaigns.get(campaignId);
    if (campaign) {
      const result = campaign.results.find((r) => r.phone === phone && r.ok);
      if (result) result.ok = false;
      campaign.sent = Math.max(campaign.sent - 1, 0);
      campaign.failed++;
    }
    if (retryAttempt === 0) bufferForRetry(campaignId, phone, sessionId, templates, media);
  } catch (err) {
    console.error('[campaign] falha ao corrigir resultado após rejeição assíncrona:', err.message);
  }
}

module.exports = { createCampaign, getCampaign, runCampaign, onCampaignMessageStatus };
