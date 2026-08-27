const email = require('./email');
const { bitrixUserIdFromOwnerId } = require('./auth');
const { getEmployeeInfo } = require('./bitrixHierarchy');

/**
 * Alerta de instância caída via e-mail — destinatário resolvido do
 * próprio cadastro Bitrix (campo EMAIL, mesma chamada user.get que já
 * traz telefone/nome — ver getEmployeeInfo). Chamado por
 * src/alertDispatcher.js, uma vez por destinatário (dono + delegados).
 * Best-effort: sem e-mail cadastrado, ou RESEND_API_KEY ausente, desiste
 * em silêncio.
 */
async function notifyOwner(ownerId, { title, body }) {
  try {
    const bitrixUserId = bitrixUserIdFromOwnerId(ownerId);
    if (!bitrixUserId) return;
    const info = await getEmployeeInfo(bitrixUserId);
    if (!info?.email) return;
    await email.sendEmail(info.email, title, body || '');
  } catch (err) {
    console.error(`[emailAlert] falha ao mandar e-mail de alerta pra ${ownerId} (best-effort):`, err.message);
  }
}

module.exports = { notifyOwner };
