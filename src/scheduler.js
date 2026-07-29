const scheduledStore = require('./scheduledCampaigns');
const { createCampaign, runCampaign } = require('./campaigns');
const { downloadMedia } = require('./media');

// Mesmos limites usados no envio imediato (ver routes/whatsapp.js).
const CAMPAIGN_MIN_DELAY_MS = 4000;
const CAMPAIGN_MAX_DELAY_MS = 9000;

/**
 * Transforma um agendamento em um envio de verdade: cria a campanha "ao vivo"
 * (src/campaigns.js) e deixa o loop de envio rodando em segundo plano. Usado
 * tanto pelo poller automático (quando chega a hora) quanto pela ação manual
 * "arrastar para Enviar agora" no Kanban.
 */
async function sendScheduled(id, sessions) {
  const row = await scheduledStore.getById(id);
  if (!row || row.status !== 'scheduled') {
    return { ok: false, error: 'agendamento já foi processado ou não existe mais' };
  }

  let gateway;
  try {
    gateway = sessions.get(row.session_id);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (gateway.getStatus() !== 'online') {
    return { ok: false, error: 'a sessão desse agendamento não está com o WhatsApp conectado no momento' };
  }

  const recipients = row.recipients; // jsonb já vem parseado pelo driver
  // media_url é o formato novo (mídia já subiu pro Storage na hora de
  // agendar, ver POST /campaign/schedule) — media_base64 só existe em
  // agendamentos criados antes dessa mudança.
  let media = null;
  if (row.media_url) {
    media = { type: row.media_type, mimetype: row.media_mimetype, buffer: await downloadMedia(row.media_url) };
  } else if (row.media_base64) {
    media = { type: row.media_type, mimetype: row.media_mimetype, buffer: Buffer.from(row.media_base64, 'base64') };
  }

  const campaignId = await createCampaign(recipients.length, {
    name: row.name,
    sessionId: row.session_id,
    hasMedia: !!media,
  });

  // liga o agendamento à campanha real assim que ela nasce, pra o Kanban já
  // conseguir mostrar o progresso "ao vivo" (join em scheduledCampaigns.listAll)
  await scheduledStore.setStatus(id, 'sending', campaignId);

  runCampaign(campaignId, {
    gateway,
    sessionId: row.session_id,
    recipients,
    template: row.template,
    media,
    minDelayMs: CAMPAIGN_MIN_DELAY_MS,
    maxDelayMs: CAMPAIGN_MAX_DELAY_MS,
  })
    .then(() => scheduledStore.setStatus(id, 'sent', campaignId))
    .catch((err) => {
      console.error('[scheduler] falha ao rodar campanha agendada:', err.message);
      scheduledStore.setStatus(id, 'sent', campaignId).catch(() => {});
    });

  return { ok: true, campaignId };
}

// Verifica periodicamente se algum agendamento já chegou na hora marcada.
function startPolling(sessions, intervalMs = 30000) {
  setInterval(async () => {
    try {
      const dueIds = await scheduledStore.dueForSending();
      for (const id of dueIds) {
        const result = await sendScheduled(id, sessions);
        if (!result.ok) {
          console.error(`[scheduler] não foi possível disparar o agendamento ${id}:`, result.error);
        }
      }
    } catch (err) {
      console.error('[scheduler] falha ao verificar agendamentos:', err.message);
    }
  }, intervalMs);
}

module.exports = { sendScheduled, startPolling };
