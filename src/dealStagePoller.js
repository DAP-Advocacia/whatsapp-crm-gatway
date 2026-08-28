const store = require('./store');
const instancesStore = require('./instances');
const bitrixCrm = require('./bitrixCrm');
const dealStageStore = require('./dealStageStore');
const agentDispatch = require('./agentDispatch');

/**
 * Grupo de WhatsApp automático do Agente de IA — MUDANÇA DE GATILHO
 * (2026-08-27): antes disparava na criação do card do lead novo (Parte
 * EV/EY do HANDOFF); agora dispara quando o negócio FECHA (atinge a
 * etapa de "ganho" no Bitrix). O Bitrix não avisa o gateway quando um
 * negócio muda de etapa (nenhum webhook de evento configurado — só o
 * webhook de ENTRADA que o gateway já usa pra CHAMAR o Bitrix), então
 * este módulo varre periodicamente os negócios vinculados a conversas e
 * compara com a última etapa vista (deal_stage_watch).
 *
 * Sem retroatividade: um negócio nunca visto antes (deal_stage_watch sem
 * linha) tem a etapa atual gravada como BASELINE, sem disparar o grupo —
 * só uma MUDANÇA observada a partir de agora conta (decisão confirmada
 * com o usuário).
 */

const DEFAULT_CATEGORY_ID = Number(process.env.BITRIX_LEADS_CATEGORY_ID) || null;

// Cache em memória do STAGE_ID de "ganho" por categoria — não muda com
// frequência (é config de funil do Bitrix), refrescado a cada boot do
// poller (não a cada tick, pra não bater a API do Bitrix à toa).
let wonStageIdCache = null;

async function resolveWonStageId() {
  if (wonStageIdCache !== null) return wonStageIdCache; // já resolvido (ou já confirmado null) neste boot
  if (!DEFAULT_CATEGORY_ID) return null;
  wonStageIdCache = await bitrixCrm.getWonStageId(DEFAULT_CATEGORY_ID);
  return wonStageIdCache;
}

// Um tick da varredura — best-effort por negócio: erro num negócio
// nunca aborta o lote inteiro (mesmo contrato de todo poller do
// projeto).
async function runOnce() {
  const wonStageId = await resolveWonStageId();
  if (!wonStageId) return; // sem categoria configurada, ou Bitrix não devolveu estágio de ganho — nada a fazer

  const conversations = await store.listConversationsWithDeal();
  if (!conversations.length) return;

  const dealIds = conversations.map((c) => c.dealId);
  const deals = await bitrixCrm.listDealStages(dealIds);
  const dealById = new Map(deals.map((d) => [String(d.ID), d]));

  for (const conv of conversations) {
    try {
      await processDeal(conv, dealById.get(String(conv.dealId)), wonStageId);
    } catch (err) {
      console.error(`[deal-stage-poller] falha ao processar negócio ${conv.dealId}:`, err.message);
    }
  }
}

async function processDeal({ sessionId, phone, dealId }, deal, wonStageId) {
  if (!deal) return; // negócio não encontrado no Bitrix (apagado, sem permissão, etc) — best-effort, ignora

  const currentStageId = deal.STAGE_ID;
  const alreadySeen = await dealStageStore.hasBeenSeen(dealId);

  if (!alreadySeen) {
    // Primeira observação — vira baseline, nunca dispara (sem
    // retroatividade: só MUDANÇA observada a partir de agora conta).
    await dealStageStore.touchStage(dealId, currentStageId);
    return;
  }

  const lastSeenStageId = await dealStageStore.getLastSeenStage(dealId);
  const stageChanged = lastSeenStageId !== currentStageId;
  await dealStageStore.touchStage(dealId, currentStageId);

  if (!stageChanged || currentStageId !== wonStageId) return;

  // Mudou pra "ganho" — dispara o grupo automático. Reaproveita
  // createCardGroupForNewLead 1:1 (já é idempotente via
  // getCardGroupForDeal, então mesmo que o poller processe o mesmo
  // negócio 2x por alguma corrida, não cria grupo duplicado).
  const ownerId = await instancesStore.ownerOf(sessionId);
  const origin = await agentDispatch.resolveLeadOrigin(phone);
  await agentDispatch.createCardGroupForNewLead({ sessionId, ownerId, phone, dealId, origin });
  console.log(`[deal-stage-poller] negócio ${dealId} fechado (${sessionId}/${phone}) — grupo automático disparado`);
}

// Mesmo padrão de src/scheduler.js::startPolling — setInterval simples,
// try/catch por tick (nunca derruba o processo se um tick falhar).
function startPolling(intervalMs = 20 * 60 * 1000) {
  setInterval(() => {
    runOnce().catch((err) => console.error('[deal-stage-poller] falha no tick:', err.message));
  }, intervalMs);
}

module.exports = { startPolling, runOnce, processDeal };
