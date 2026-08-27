const webpush = require('web-push');
const { pool } = require('./db');

/**
 * Web Push (Service Worker) — notifica o usuário mesmo com TODAS as abas
 * do sistema fechadas (diferente do toast in-app existente, que só
 * aparece com alguma aba aberta E visível no momento). Usado hoje só pelo
 * alerta de "instância precisa de atenção" (ver src/alertDispatcher.js),
 * mas o desenho (por owner_id, não por instância) já serve qualquer outro
 * evento futuro sem mudança de schema.
 *
 * Opcional: sem VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY configuradas, toda
 * chamada de notifyOwner() é um no-op silencioso — mesmo padrão de
 * degradação graciosa já usado em src/bitrix.js/src/bitrixHierarchy.js
 * (variável ausente = feature inativa, nunca erro).
 */

const configured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:contato@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Chamado pelo frontend (POST /notifications/push-subscribe) depois de
// PushManager.subscribe() ter sucesso — `on conflict` porque o mesmo
// endpoint pode tentar se registrar de novo (ex: usuário clica o botão
// 2x, ou o navegador já tinha essa subscription de uma sessão anterior).
async function saveSubscription(ownerId, { endpoint, p256dh, auth }) {
  await pool.query(
    `insert into push_subscriptions (owner_id, endpoint, p256dh, auth)
     values ($1, $2, $3, $4)
     on conflict (endpoint) do update set owner_id = excluded.owner_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    [ownerId, endpoint, p256dh, auth]
  );
}

async function removeSubscription(endpoint) {
  await pool.query('delete from push_subscriptions where endpoint = $1', [endpoint]);
}

// Manda a notificação real pra TODAS as subscriptions do dono (pode ter
// mais de um navegador/aparelho já autorizado). Best-effort por
// subscription — uma falhar não afeta as outras nem propaga erro pra
// quem chamou (src/alertDispatcher.js já isola por canal, mas esta
// função também nunca lança sozinha).
async function notifyOwner(ownerId, { title, body, target }) {
  if (!configured) return;
  const { rows } = await pool.query(
    'select endpoint, p256dh, auth from push_subscriptions where owner_id = $1',
    [ownerId]
  );
  if (!rows.length) return;

  const payload = JSON.stringify({ title, body, target });
  await Promise.allSettled(
    rows.map(async (r) => {
      try {
        await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload);
      } catch (err) {
        // 404/410 = subscription expirada/revogada do lado do navegador —
        // limpa do banco pra não acumular lixo indefinidamente (o usuário
        // desinstalou o navegador, limpou dados do site, etc.).
        if (err.statusCode === 404 || err.statusCode === 410) {
          await removeSubscription(r.endpoint).catch(() => {});
        } else {
          console.error(`[webpush] falha ao enviar pra ${ownerId} (best-effort):`, err.message);
        }
      }
    })
  );
}

module.exports = { saveSubscription, removeSubscription, notifyOwner, configured };
