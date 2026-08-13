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

// Resumo de IA da conversa (title/subtitle/summary — ver
// summarizeConversation em src/openai.js) na timeline do Negócio, mesmo
// mecanismo de logMessageToTimeline/logStatusToTimeline acima — pedido do
// usuário (2026-08-13, com print da tela de resumo do Chat): "esse resumo
// da conversa deve ir para o card do bitrix". Chamado automaticamente
// TODA VEZ que um resumo novo é gerado (POST /conversations/summary,
// decisão confirmada com o usuário — não é um botão separado "Enviar pro
// Bitrix"), então um resumo recalculado várias vezes no mesmo dia cria
// vários comentários na timeline (aceito — reflete quando cada versão do
// resumo foi gerada, mesma natureza de "log" que já existe pra mensagem/
// status, não é editar um campo único).
async function logConversationSummaryToTimeline(dealId, { title, subtitle, summary }) {
  if (!dealId) return;
  const lines = [
    '[Resumo IA da conversa no WhatsApp]',
    title ? `*${title}*` : null,
    subtitle || null,
    '',
    summary,
  ].filter((l) => l !== null);
  await callBitrix('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: dealId,
      ENTITY_TYPE: 'deal',
      COMMENT: lines.join('\n'),
    },
  });
}

module.exports = { callBitrix, logMessageToTimeline, logStatusToTimeline, logConversationSummaryToTimeline };
