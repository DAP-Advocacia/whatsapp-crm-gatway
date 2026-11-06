const instancesStore = require('./instances');
const instanceHealthStore = require('./instanceHealthStore');
const { getOwnNumbersBySession } = require('./ownNumbers');
const { recipientForOwner } = require('./teamDirectory');
const panelStore = require('./panelStore');
const panelService = require('./panelService');
const { ownerIdFor } = require('./auth');

/**
 * Monitor de desconexões: avisa o GESTOR (ver teamDirectory.resolveRecipient) quando alguém
 * que JÁ esteve conectado deixa de estar. Só age em desconexão real:
 *
 *  Na hora:  deslogou_celular   (aparelho desvinculado no celular)
 *            removida_dapzap    (a pessoa removeu a conexão no DapZap)
 *            substituida        (outro aparelho assumiu a sessão, 440)
 *  Com espera: queda_prolongada (sem reconectar há `grace_minutes`, padrão 30 — queda de rede
 *            curta e reinício do servidor NÃO avisam ninguém)
 *
 *  Nunca avisa: instância que nunca foi pareada, pessoa fora do cadastro ativo do Bitrix,
 *  recusa do WhatsApp (403, tratada pelo alerta de banimento que já existe), quedas durante
 *  os primeiros BOOT_QUIET_MIN minutos depois de um deploy/reinício de worker (todas as
 *  sessões caem juntas e voltam sozinhas), nem eventos anteriores à ativação do monitor.
 *
 *  Com o monitor DESLIGADO (padrão), tudo é só registrado como "simulado" no histórico do
 *  painel — dá pra auditar o que seria enviado antes de ligar.
 */

const BOOT_QUIET_MIN = Number(process.env.MONITOR_BOOT_QUIET_MIN || 60);
const MIN_FAILURES_FOR_DROP = 3; // tentativas seguidas que falharam: separa queda de verdade de sessão ainda na fila do boot
const bootAt = Date.now();

const KIND_LABEL = {
  deslogou_celular: 'desconectou o WhatsApp pelo celular',
  removida_dapzap: 'removeu a conexão no DapZap',
  substituida: 'teve a sessão assumida por outro aparelho',
  queda_prolongada: 'está sem conexão e não reconectou sozinho',
};

function formatPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith('55')) return `+55 (${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
  return d || '—';
}

const fmtWhen = (d) => new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function quietPeriod(sessions) {
  const last = Math.max(bootAt, sessions?.lastWorkerRestartAt || 0);
  return Date.now() - last < BOOT_QUIET_MIN * 60 * 1000;
}

/**
 * Registra (e, se o monitor estiver ligado, envia) o aviso de uma desconexão.
 * `eventAt` identifica o evento (um mesmo evento nunca avisa duas vezes o mesmo gestor).
 * Nunca lança: o monitor não pode atrapalhar o fluxo de status/remoção.
 */
async function handleDisconnect({ sessions, instanceId, kind, reason, eventAt, ownerId, phone }) {
  try {
    const owner = ownerId || (await instancesStore.ownerOf(instanceId));
    if (!owner) return;
    const ownPhone = phone || getOwnNumbersBySession()[instanceId];
    if (!ownPhone) return; // nunca pareou = nunca esteve conectado
    const { person, recipient } = await recipientForOwner(owner);
    if (!person) return; // fora do cadastro ativo do Bitrix

    const settings = await panelStore.getSettings();
    const enabled = settings.monitor_enabled === 'true';
    const enabledAt = settings.monitor_enabled_at ? new Date(settings.monitor_enabled_at) : null;
    const at = eventAt ? new Date(eventAt) : new Date();

    if (kind === 'queda_prolongada' && (await panelStore.recentAlertExists(instanceId, 'queda_prolongada', 6))) return;

    const base = {
      kind, instanceId, ownerId: owner, personName: person.name, phone: ownPhone, reason, eventAt: at,
      recipientBitrixId: recipient?.bitrixUserId || '', recipientName: recipient?.name || null, routeSource: recipient?.source || null,
    };
    if (!recipient) {
      await panelStore.claimAlert({ ...base, status: 'sem_destinatario', detail: 'nenhuma regra nem gestor no perfil do Bitrix' });
      return;
    }
    if (!enabled || !enabledAt || at < enabledAt) {
      await panelStore.claimAlert({ ...base, status: 'simulado', detail: !enabled ? 'monitor desligado' : 'evento anterior à ativação do monitor' });
      return;
    }

    const claimId = await panelStore.claimAlert({ ...base, status: 'simulado', detail: 'enviando' });
    if (!claimId) return; // já avisado
    const dept = person.department ? `Equipe: ${person.department}\n` : '';
    const body = `${person.name || 'Colaborador'} (${formatPhone(ownPhone)}) ${KIND_LABEL[kind]}.\n${dept}Quando: ${fmtWhen(at)}\nPeça para a pessoa reconectar pelo DapZap (Conexões).`;
    try {
      await panelService.dispatch({
        bitrixIds: [recipient.bitrixUserId], title: `DapZap desconectado: ${person.name || 'colaborador'}`, body, sessions, excludeSessionId: instanceId,
      });
      await panelStore.finishAlert(claimId, 'enviado', `${KIND_LABEL[kind]}`);
    } catch (err) {
      await panelStore.finishAlert(claimId, 'falhou', err.message);
    }
  } catch (err) {
    if (!panelStore.tablesMissing(err)) console.error('[monitor] falha ao tratar desconexão:', err.message);
  }
}

// Quedas "temporárias" que passaram do prazo de espera e continuam sem reconectar.
async function sweepProlongedDrops(sessions) {
  try {
    const settings = await panelStore.getSettings();
    const grace = Math.max(5, Number(settings.grace_minutes) || 30);
    if (quietPeriod(sessions)) return;
    const events = await instanceHealthStore.listOpenTemporaryOlderThan(grace);
    for (const ev of events) {
      const gw = sessions.getActiveGateway(ev.instanceId);
      if (!gw) continue; // sessão não está carregada: não dá pra afirmar que caiu
      const status = gw.getStatus();
      if (status === 'online' || status === 'queued') continue;
      if ((gw.consecutiveFailures || 0) < MIN_FAILURES_FOR_DROP) continue;
      await handleDisconnect({ sessions, instanceId: ev.instanceId, kind: 'queda_prolongada', reason: ev.reason, eventAt: ev.startedAt });
    }
  } catch (err) {
    if (!panelStore.tablesMissing(err)) console.error('[monitor] falha na varredura de quedas:', err.message);
  }
}

// Resumo diário das equipes (só com monitor e resumo ligados, na hora configurada, horário de Brasília).
let lastDigestDay = null;
async function maybeSendDailyDigest(sessions) {
  try {
    const s = await panelStore.getSettings();
    if (s.monitor_enabled !== 'true' || s.digest_enabled !== 'true') return;
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    const hour = Number(new Date().toLocaleString('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }));
    if (lastDigestDay === day || hour < (Number(s.digest_hour) || 9)) return;
    if (quietPeriod(sessions)) return; // logo depois de um deploy quase todo mundo aparece offline
    lastDigestDay = day;
    const sent = await panelService.sendDigests(sessions, { day });
    console.log(`[monitor] resumo diário: ${sent.filter((r) => r.status === 'enviado').length} gestor(es) avisado(s)`);
  } catch (err) {
    if (!panelStore.tablesMissing(err)) console.error('[monitor] falha no resumo diário:', err.message);
  }
}

function start(sessions) {
  setInterval(() => sweepProlongedDrops(sessions), 60 * 1000).unref();
  setInterval(() => maybeSendDailyDigest(sessions), 10 * 60 * 1000).unref();
  console.log(`[monitor] monitor de desconexões carregado (silêncio de ${BOOT_QUIET_MIN} min após deploy; liga/desliga no painel)`);
}

module.exports = { handleDisconnect, sweepProlongedDrops, start, ownerIdFor };
