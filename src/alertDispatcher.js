const store = require('./store');
const webpush = require('./webpush');
const whatsappAlert = require('./whatsappAlert');
const emailAlert = require('./emailAlert');

/**
 * Orquestra os 4 canais de alerta (in-app + Web Push + WhatsApp de
 * sistema + e-mail) quando uma instância entra em "precisa de atenção"
 * (ver handleStatusForHealth, src/server.js). Substitui a chamada direta
 * a store.addNotification que existia antes — "quem é destinatário"
 * continua calculado uma única vez por quem chama, aqui só orquestra o
 * ENVIO pra cada um.
 *
 * Cada canal é independente/best-effort (decisão de produto confirmada):
 * falha em 1 nunca bloqueia os outros 3. Promise.allSettled DUPLO — por
 * destinatário E por canal — é o que garante isso: Promise.all comum já
 * rejeitaria no primeiro erro, o que derrubaria os demais silenciosamente.
 * Cada sub-módulo (webpush/whatsappAlert/emailAlert) já engole o próprio
 * erro internamente (defesa em profundidade) — o allSettled aqui é uma
 * 2ª camada, não a única.
 */
// `channels` (opcional, usado pelo painel): subconjunto de ['app', 'push', 'whatsapp', 'email'];
// sem ele, os 4 como sempre.
async function notifyAttention({ recipients, title, body, target, waSourceSessionId, sessions, channels }) {
  const on = (c) => !channels || channels.includes(c);
  await Promise.allSettled(
    recipients.map((ownerId) =>
      Promise.allSettled([
        on('app') && store.addNotification({ ownerId, title, body, target }),
        on('push') && webpush.notifyOwner(ownerId, { title, body, target }),
        on('whatsapp') && whatsappAlert.notifyOwner(ownerId, { text: `${title}\n\n${body}`, excludeSessionId: waSourceSessionId, sessions }),
        on('email') && emailAlert.notifyOwner(ownerId, { title, body }),
      ])
    )
  );
}

module.exports = { notifyAttention };
