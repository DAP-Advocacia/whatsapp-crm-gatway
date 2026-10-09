const instancesStore = require('./instances');
const store = require('./store');
const bitrixCrm = require('./bitrixCrm');

/**
 * Gatilho de UMA ÚNICA instância de WhatsApp: a campanha de tráfego pago
 * do Dr. Adriano (número da Monalisa Figueiredo, bitrix id 193286,
 * instância secundária rotulada "21979840129" em /instances.html).
 *
 * Toda vez que chega uma mensagem de um CLIENTE NOVO (conversa que não
 * existia antes) nessa instância específica, cria contato + negócio no
 * Bitrix automaticamente (ver bitrixCrm.createDealForAdrianoCampaign).
 * Diferente do Agente de IA (src/agentDispatch.js::handleNewLeadMessage),
 * isto NÃO depende de agent_config.active — dispara com ou sem Agente de
 * IA ligado nessa instância. Pedido do usuário, 2026-10-09.
 *
 * Se este número for desativado/substituído, ajustar
 * ADRIANO_CAMPAIGN_SESSION_ID no .env (sem precisar mexer em código); sem
 * essa variável definida, a função não faz nada.
 */
const ADRIANO_CAMPAIGN_SESSION_ID = process.env.ADRIANO_CAMPAIGN_SESSION_ID || null;

// Chamado de dentro de onMessage (src/server.js), nas mesmas condições já
// usadas pro Agente de IA (mensagem 'in', não é grupo, conversa recém-
// criada) — ver chamada ao lado de agentDispatch.handleNewLeadMessage.
// Fire-and-forget: nenhum await síncrono antes do primeiro .then/.catch,
// então um erro aqui nunca vira unhandled rejection nem atrasa quem chama.
function handleNewAdrianoLead({ sessionId, phone, pushName }) {
  if (!ADRIANO_CAMPAIGN_SESSION_ID || sessionId !== ADRIANO_CAMPAIGN_SESSION_ID) return;

  instancesStore.ownerOf(sessionId)
    .then((ownerId) => bitrixCrm.createDealForAdrianoCampaign({ ownerId, phone, pushName }))
    .then(async ({ dealId }) => {
      // Vincula o negócio à conversa (mesmo campo que o Agente de IA usa)
      // pra mensagens seguintes logarem na timeline do Bitrix automaticamente.
      if (dealId) await store.setDealForPhone(sessionId, phone, dealId);
    })
    .catch((err) =>
      console.error(`[campanha-adriano] falha ao criar negócio no Bitrix (${sessionId}/${phone}):`, err.message)
    );
}

module.exports = { handleNewAdrianoLead };
