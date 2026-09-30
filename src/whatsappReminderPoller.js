const instancesStore = require('./instances');
const { listEmployees, callBitrixHR } = require('./bitrixHierarchy');
const { ownerIdFor } = require('./auth');

/**
 * Lembrete diário via IM nativo do Bitrix pra quem ainda não conectou
 * nenhum WhatsApp — pedido do usuário 2026-09-30, depois de corrigir a
 * causa raiz de instâncias "Principal" órfãs (ver ROADMAP itens 17/18):
 * com isso corrigido, `instances.length === 0` de verdade significa
 * "nunca conectou", não mais um falso positivo de instância recriada à
 * toa. Mesmo esqueleto de src/instanceBanPoller.js (runOnce() com
 * try/catch por item, startPolling(intervalMs) chamado 1x no boot).
 *
 * Regras confirmadas com o usuário:
 * - Só conta quem já existe como usuário ATIVO do Bitrix há mais de 1 dia
 *   (GRACE_PERIOD_MS) — evita lembrar no primeiro dia de alguém recém-
 *   contratado ainda em treinamento.
 * - Repete 1x por dia até a pessoa conectar (dedupe por dia civil, não por
 *   intervalo fixo de 24h corridas — ver lastRemindedDate).
 * - Canal: IM nativo do Bitrix (im.message.add), não os 4 canais de
 *   alertDispatcher.notifyAttention — decisão explícita do usuário, já
 *   que quem nunca conectou WhatsApp não pode ser alcançado pelo canal
 *   WhatsApp de sistema (whatsappAlert precisa de outra instância do
 *   mesmo dono já online) e Web Push exige opt-in prévio que essa pessoa
 *   nunca teria motivo de ter dado ainda.
 */

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 1 dia

// owner_id -> "YYYY-MM-DD" do último lembrete mandado — dedupe por DIA
// CIVIL (não por "há pelo menos 24h"), pra não deslizar o horário do
// lembrete dia após dia dependendo de quando exatamente o poller rodou.
// Reseta a cada restart do processo — aceitável (mesmo raciocínio já
// usado em instanceBanPoller.js: na pior hipótese manda 1 lembrete extra
// no mesmo dia depois de um deploy, nunca deixa de lembrar).
const lastRemindedDate = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function sendBitrixIm(bitrixUserId, message) {
  const result = await callBitrixHR('im.message.add', {
    DIALOG_ID: String(bitrixUserId),
    MESSAGE: message,
  });
  if (!result) throw new Error('im.message.add falhou (ver log de callBitrixHR acima)');
}

async function runOnce() {
  const employees = await listEmployees();
  if (!employees) return; // BITRIX_HR_WEBHOOK_URL não configurada — feature inativa, mesmo padrão do resto do módulo

  const today = todayKey();
  const now = Date.now();

  for (const emp of employees) {
    try {
      // dateRegister é a data de CRIAÇÃO DA CONTA no Bitrix — proxy
      // razoável de "há quanto tempo essa pessoa é usuária ativa" (mesmo
      // campo já usado como "Criado em" na tela de Usuários do Admin).
      if (emp.dateRegister && now - new Date(emp.dateRegister).getTime() < GRACE_PERIOD_MS) continue;

      const ownerId = ownerIdFor(emp.id);
      if (lastRemindedDate.get(ownerId) === today) continue; // já lembrado hoje

      const instances = await instancesStore.listByOwner(ownerId);
      if (instances.length) continue; // já conectou pelo menos 1 — nada a lembrar

      const firstName = (emp.name || '').split(' ')[0] || 'tudo bem';
      await sendBitrixIm(
        emp.id,
        `Oi, ${firstName}! 👋 Notei que você ainda não conectou seu WhatsApp no DapZap. ` +
          'Acesse o app e vá em "Conexões do WhatsApp" para escanear o QR Code e começar a usar — leva menos de 1 minuto.'
      );
      lastRemindedDate.set(ownerId, today);
    } catch (err) {
      console.error(`[whatsapp-reminder-poller] falha ao lembrar ${emp.id} (${emp.name || 'sem nome'}):`, err.message);
    }
  }
}

// Uma vez por hora é suficiente pra garantir que todo mundo recebe o
// lembrete do dia mesmo que o processo reinicie no meio da janela — o
// dedupe por dia civil (lastRemindedDate) evita repetir dentro do mesmo
// dia mesmo rodando com essa frequência.
function startPolling(intervalMs = 60 * 60 * 1000) {
  setInterval(() => {
    runOnce().catch((err) => console.error('[whatsapp-reminder-poller] falha no tick:', err.message));
  }, intervalMs);
}

module.exports = { startPolling, runOnce };
