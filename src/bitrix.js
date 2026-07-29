/**
 * Cliente mínimo para chamar métodos REST do Bitrix24 usando um Webhook de entrada.
 * Usado aqui apenas para registrar as mensagens na timeline do negócio
 * (crm.timeline.comment.add), deixando o histórico visível também dentro do card padrão do CRM.
 *
 * Se você preferir usar OAuth (App local/Market) em vez de Webhook, troque `callBitrix`
 * para montar a URL com o token de acesso do usuário (AUTH_ID) em vez do webhook fixo.
 */

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;

async function callBitrix(method, params = {}) {
  if (!BITRIX_WEBHOOK_URL) {
    // Integração com a timeline é opcional — se não configurado, apenas ignora.
    return null;
  }

  const url = `${BITRIX_WEBHOOK_URL.replace(/\/$/, '')}/${method}.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  const data = await res.json();
  if (data.error) {
    console.error(`[bitrix] erro em ${method}:`, data.error_description || data.error);
    return null;
  }
  return data.result;
}

async function logMessageToTimeline(dealId, text, direction) {
  if (!dealId) return;
  const prefix = direction === 'out' ? '[WhatsApp enviado]' : '[WhatsApp recebido]';
  await callBitrix('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: dealId,
      ENTITY_TYPE: 'deal',
      COMMENT: `${prefix} ${text}`,
    },
  });
}

// Registro de entrega/leitura (status de mensagem enviada) na timeline —
// pedido do usuário: saber se o contato recebeu/visualizou direto no card
// do Negócio, já que a "bolha" que ele vê ali é a timeline NATIVA do
// Bitrix (sem controle visual nosso, só de texto — ver src/server.js
// onMessageStatus). Comentário separado do de conteúdo da mensagem, pra
// não confundir "o que foi dito" com "o que aconteceu com o envio".
async function logStatusToTimeline(dealId, text) {
  if (!dealId) return;
  await callBitrix('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: dealId,
      ENTITY_TYPE: 'deal',
      COMMENT: `[WhatsApp] ${text}`,
    },
  });
}

module.exports = { callBitrix, logMessageToTimeline, logStatusToTimeline };
