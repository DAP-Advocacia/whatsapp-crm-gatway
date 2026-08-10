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

module.exports = { createCampaign, getCampaign, runCampaign };
