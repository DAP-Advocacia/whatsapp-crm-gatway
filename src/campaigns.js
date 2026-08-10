const store = require('./store');
const { logMessageToTimeline } = require('./bitrix');
const { saveMedia } = require('./media');
const campaignStore = require('./campaignStore');

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

// wa_message_id -> { campaignId, phone } — só enquanto a campanha ainda
// pode receber uma correção retroativa de status (ver onCampaignMessageStatus
// abaixo). Sem TTL: o volume é o mesmo de `campaigns` (que também nunca é
// limpo em memória hoje — reinicia zerado a cada restart do processo,
// mesma limitação já aceita pro estado "ao vivo" de campanha).
const messageIdToCampaign = new Map();

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
    status: 'running', // 'running' | 'done'
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

// Roda em segundo plano (não é `await`ado pelo caller) — o progresso é
// consultado depois via getCampaign(id).
async function runCampaign(id, { gateway, sessionId, recipients, template, media, minDelayMs, maxDelayMs }) {
  const campaign = campaigns.get(id);

  for (const recipient of recipients) {
    const phone = recipient.phone;
    try {
      const text = renderTemplate(template, recipient);
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
      // corrigir isto retroativamente se essa rejeição chegar.
      if (message.id) messageIdToCampaign.set(message.id, { campaignId: id, phone });

      campaign.sent++;
      campaign.results.push({ phone, ok: true });
      campaignStore.recordResult(id, phone, true).catch((err) => console.error('[campaign] falha ao gravar envio:', err.message));
    } catch (err) {
      campaign.failed++;
      campaign.results.push({ phone, ok: false, error: err.message });
      campaignStore.recordResult(id, phone, false, err.message).catch((e) => console.error('[campaign] falha ao gravar envio:', e.message));
    }

    campaignStore.updateProgress(id, campaign.sent, campaign.failed).catch((err) => console.error('[campaign] falha ao atualizar progresso:', err.message));

    // intervalo com variação, pra não mandar tudo num ritmo robótico constante
    const delay = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
    await sleep(delay);
  }

  campaign.status = 'done';
  campaignStore.finishCampaign(id).catch((err) => console.error('[campaign] falha ao finalizar histórico:', err.message));
}

// Chamado por src/server.js (dentro de onMessageStatus) toda vez que uma
// mensagem qualquer muda de status — não só as de campanha, por isso o
// primeiro passo é checar se esse messageId é mesmo de uma campanha (a
// esmagadora maioria não é). Corrige tanto o estado em memória (usado pelo
// polling de progresso, GET /campaign/:id) quanto o histórico persistido
// (campaignStore.markResultFailedAsync).
async function onCampaignMessageStatus(messageId, status) {
  if (status !== 'failed') return;
  const entry = messageIdToCampaign.get(messageId);
  if (!entry) return;
  messageIdToCampaign.delete(messageId); // consumido — não corrige duas vezes

  const { campaignId, phone } = entry;
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
  } catch (err) {
    console.error('[campaign] falha ao corrigir resultado após rejeição assíncrona:', err.message);
  }
}

module.exports = { createCampaign, getCampaign, runCampaign, onCampaignMessageStatus };
