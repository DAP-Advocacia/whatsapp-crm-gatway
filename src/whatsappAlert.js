const store = require('./store');
const instancesStore = require('./instances');
const { bitrixUserIdFromOwnerId } = require('./auth');
const { getEmployeePhone, normalizeBrazilPhone } = require('./bitrixHierarchy');

/**
 * Alerta de instância caída via WhatsApp — usa uma OUTRA instância do
 * MESMO dono (ownerId) que ainda esteja online, diferente do precedente
 * sendReleaseWhatsAppMessage (src/routes/suggestions.js), que usa a
 * instância de quem EXECUTA a ação. Aqui a instância "natural" do dono
 * provavelmente é justamente a que caiu, então precisa achar uma de
 * backup — se o dono só tiver essa 1 instância, ou nenhuma outra estiver
 * online, desiste em silêncio (best-effort, nunca lança).
 *
 * Chamado por src/alertDispatcher.js, uma vez por destinatário (dono +
 * cada delegado) — cada um recebe pelo PRÓPRIO WhatsApp, não pelo do
 * dono da instância caída.
 */
async function notifyOwner(ownerId, { text, excludeSessionId, sessions }) {
  try {
    const bitrixUserId = bitrixUserIdFromOwnerId(ownerId);
    if (!bitrixUserId) return;
    const rawPhone = await getEmployeePhone(bitrixUserId);
    const phone = normalizeBrazilPhone(rawPhone);
    if (!phone) return;

    const myInstances = await instancesStore.listByOwner(ownerId);
    const candidateIds = new Set(myInstances.map((i) => i.id).filter((id) => id !== excludeSessionId));
    if (!candidateIds.size) return; // única instância do dono é a que caiu -> não tem como avisar por WhatsApp

    const active = sessions.listActive().filter((s) => candidateIds.has(s.sessionId) && s.status === 'online');
    if (!active.length) return; // dono tem outra(s) instância(s), mas nenhuma está online agora

    const sessionId = active[0].sessionId;
    const gateway = sessions.getActiveGateway(sessionId);
    const message = await gateway.sendMessage(phone, text, null);
    await store.addMessage(sessionId, phone, message, null);
  } catch (err) {
    console.error(`[whatsappAlert] falha ao mandar WhatsApp de alerta pra ${ownerId} (best-effort):`, err.message);
  }
}

module.exports = { notifyOwner };
