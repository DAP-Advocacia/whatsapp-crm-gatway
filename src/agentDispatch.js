const { pool } = require('./db');
const store = require('./store');
const instancesStore = require('./instances');
const agentConfigStore = require('./agentConfig');
const { generateAgentReply } = require('./agent');
const bitrixCrm = require('./bitrixCrm');
const agentRetryQueue = require('./agentRetryQueue');
const leadForms = require('./leadForms');

/**
 * Orquestração central do Agente de IA — chamado de dentro de
 * onMessage (src/server.js) quando uma mensagem NOVA de um lead
 * (conversa que não existia antes) chega, de QUALQUER origem (LP ou
 * Campanha). Sempre best-effort: uma falha aqui nunca derruba o resto
 * do processamento de onMessage, que já rodou antes desta chamada
 * (broadcast/timeline/notificação de mensagem recebida).
 *
 * TUDO — criação do card no Bitrix + tag de origem + resposta
 * automática — depende de `agentConfig.active` pra aquela instância
 * (ver HANDOFF Parte EP). Isso mudou 2x: a Parte EM tinha tornado a
 * criação do card INCONDICIONAL (rodava com ou sem IA ativa, unificando
 * com o fluxo de Campanha); voltou a ser condicional na Parte EP, a
 * pedido explícito do usuário — só instâncias com o Agente de IA
 * ativado na própria tela (`agente-ia.html`) devem criar negócio
 * automaticamente ao lead responder, reaproveitando o MESMO toggle que
 * já existia pra resposta automática (sem tela/config nova).
 */

// Distingue a origem do lead pro rótulo do card — telefone com linha
// em lead_form_submissions (passou pelo formulário de uma LP) = "LP:
// <nome da LP>"; senão = "Campanha" (hipótese mais provável pra um
// número desconhecido mandando mensagem direta, sem form nenhum —
// decisão confirmada com o usuário). `submissionId` (só presente pra
// 'lp') é usado por handleNewLeadMessage pra gravar o vínculo com o
// negócio Bitrix de volta na PRÓPRIA submissão do formulário (mesmo
// campo que src/routes/leads.js preenchia antes da Parte EM, só que
// agora no momento em que o lead responde, não no envio do form).
async function resolveLeadOrigin(phone) {
  const { rows } = await pool.query(
    `select s.id as "submissionId", lf.name as "formName"
     from lead_form_submissions s
     join lead_forms lf on lf.id = s.form_id
     where s.phone = $1
     order by s.created_at desc
     limit 1`,
    [phone]
  );
  return rows[0]
    ? { kind: 'lp', label: rows[0].formName, submissionId: rows[0].submissionId }
    : { kind: 'campanha', label: 'Campanha', submissionId: null };
}

// Chamado de dentro de onMessage toda vez que uma mensagem 'in' chega
// numa conversa RECÉM-CRIADA (LP ou Campanha). Só age se a instância
// tiver o agente ativo (agent_config.active) — instância sem config,
// ou com active:false, mantém o comportamento de sempre (sem negócio
// novo, sem tag, sem resposta automática). Reaproveita o MESMO toggle
// "Agente ativo nesta instância" já existente na tela agente-ia.html —
// não há config separada pra "só criar card, sem responder" ou
// vice-versa (decisão confirmada com o usuário, Parte EP).
async function handleNewLeadMessage({ sessionId, phone, pushName, leadMessageText }) {
  const config = await agentConfigStore.get(sessionId);
  if (!config.active) return;

  // Marca ANTES de gerar a resposta — evita corrida se 2 mensagens do
  // mesmo lead novo chegarem quase juntas (ex: manda 2 mensagens
  // seguidas antes da 1ª resposta sair): a 2ª chamada veria
  // conversationExistedBefore=true (já que a conversa já foi criada
  // pela 1ª) e nunca chegaria a re-executar este bloco.
  await store.setAgentEnabled(sessionId, phone, true);

  const origin = await resolveLeadOrigin(phone);
  const ownerId = await instancesStore.ownerOf(sessionId);

  // Criação do card no Bitrix é BEST-EFFORT e EM BACKGROUND — nunca
  // atrasa nada do resto do processamento de onMessage nem a resposta
  // da IA.
  bitrixCrm.createDealForNewLead({ ownerId, phone, pushName, origin })
    .then(async ({ contactId, dealId }) => {
      if (dealId) await store.setDealForPhone(sessionId, phone, dealId);
      // Se veio de LP, grava o vínculo de volta na PRÓPRIA submissão
      // do formulário (bitrix_deal_id/bitrix_contact_id em
      // lead_form_submissions) — mesmo campo que existia antes da
      // Parte EM, só que preenchido agora (quando o lead responde),
      // não no envio do form.
      if (origin.submissionId && (dealId || contactId)) {
        await leadForms.setSubmissionBitrixIds(origin.submissionId, { dealId, contactId });
      }
    })
    .catch((err) => console.error(`[agent-dispatch] falha ao criar negócio no Bitrix (${sessionId}/${phone}):`, err.message));

  // Tag de origem — mesmo padrão exato já usado pelo fluxo de LP
  // (fixed=true, tag de sistema sem botão de remover no Chat). Emite
  // um broadcast próprio depois de aplicar — diferente da tag manual
  // (botão do Chat), que já está com a tela aberta e atualiza a lista
  // localmente sem depender do servidor, aqui é o BACKEND aplicando a
  // tag sem ninguém interagindo na UI, então sem isso a tag só
  // apareceria depois de um reload manual (achado testando o fluxo
  // real de ponta a ponta).
  store.createTag(sessionId, origin.kind === 'lp' ? `LP: ${origin.label}` : 'Campanha', null, true)
    .then(async (tag) => {
      await store.addTagToConversation(sessionId, phone, tag.id);
      if (_broadcast) _broadcast(sessionId, phone, { type: 'tags-updated', tags: await store.getConversationTags(sessionId, phone) });
    })
    .catch((err) => console.error(`[agent-dispatch] falha ao aplicar tag de origem (${sessionId}/${phone}):`, err.message));

  await dispatchAgentReply({ sessionId, phone, leadMessageText });
}

// Gera a resposta do agente e tenta enviar; se a instância estiver
// offline no momento (sessions.get lança dentro de gateway.sendMessage
// quando status !== 'online'), enfileira em agent_retry_queue em vez
// de perder a mensagem — src/agentRetryWorker.js reprocessa quando a
// instância reconectar.
async function dispatchAgentReply({ sessionId, phone, leadMessageText }) {
  const reply = await generateAgentReply(sessionId, phone, leadMessageText);
  if (!reply) return; // agente desativado nesta instância (checado de novo, defensivamente, dentro de generateAgentReply)

  try {
    await sendAgentReply(sessionId, phone, reply.text);
  } catch (err) {
    console.error(`[agent-dispatch] falha ao enviar resposta (${sessionId}/${phone}), enfileirando retry:`, err.message);
    await agentRetryQueue.enqueue(sessionId, phone);
  }
}

// Envio de fato + persistência + broadcast — mesmo padrão exato já
// usado em src/routes/leads.js (sendMessage não persiste/broadcasta
// sozinho, quem chama faz isso). Precisa de acesso a `sessions`, que
// só existe dentro do módulo que instancia o SessionManager
// (src/server.js) — por isso é injetado aqui via `setSessions` em vez
// de importado diretamente (evita dependência circular: server.js já
// importa agentDispatch pra chamar handleNewLeadMessage).
let _sessions = null;
let _broadcast = null;
function configure({ sessions, broadcast }) {
  _sessions = sessions;
  _broadcast = broadcast;
}

async function sendAgentReply(sessionId, phone, text) {
  if (!_sessions || !_broadcast) {
    throw new Error('agentDispatch não configurado — chame configure({sessions, broadcast}) no boot do servidor');
  }
  const gateway = _sessions.get(sessionId);
  const message = await gateway.sendMessage(phone, text);
  await store.addMessage(sessionId, phone, message, null);
  _broadcast(sessionId, phone, { type: 'message', message });
}

module.exports = { configure, handleNewLeadMessage, dispatchAgentReply, resolveLeadOrigin };
