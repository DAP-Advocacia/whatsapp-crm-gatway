const { pool } = require('./db');
const store = require('./store');
const instancesStore = require('./instances');
const agentConfigStore = require('./agentConfig');
const { generateAgentReply } = require('./agent');
const bitrixCrm = require('./bitrixCrm');
const agentRetryQueue = require('./agentRetryQueue');
const leadForms = require('./leadForms');
const media = require('./media');
const mediaRecognition = require('./mediaRecognition');
const { getEmployeeInfo } = require('./bitrixHierarchy');

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
async function handleNewLeadMessage({ sessionId, phone, pushName, leadMessageText, mediaUrl, mediaType, mimetype, waMessageId }) {
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
      // Grupo de WhatsApp automático pro card criado pelo Agente de IA —
      // aninhado aqui porque depende do `dealId` (o grupo é gravado com
      // source='card' + deal_id, mesma marca que a criação manual do
      // card usa). Best-effort próprio: qualquer falha aqui (dono sem
      // celular no Bitrix, instância que caiu entre a mensagem e agora,
      // groupCreate recusado) é logada e ignorada — nunca afeta o card
      // já criado nem a resposta da IA.
      if (dealId) {
        await createCardGroupForNewLead({ sessionId, ownerId, phone, dealId, origin })
          .catch((err) => console.error(`[agent-dispatch] falha ao criar grupo do card (${sessionId}/${phone}):`, err.message));
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

  // Reconhecimento real de mídia (Whisper/Vision) — só roda se houver
  // mídia reconhecível E o agente estiver ativo (já checado acima, mesmo
  // toggle único que condiciona TUDO do Agente de IA). `await`-ado ANTES
  // de dispatchAgentReply (decisão de produto: espera terminar antes de
  // responder, não responde ao placeholder enquanto a mídia ainda está
  // sendo processada). Best-effort: se falhar, segue com leadMessageText
  // original (placeholder "[áudio]" etc, já presente no banco desde
  // addMessage) — nunca bloqueia a resposta da IA.
  //
  // Imagem/vídeo com legenda PRÓPRIA do lead: preserva o texto original,
  // não gera descrição de IA por cima (perderia dado real que o lead
  // efetivamente escreveu). Áudio sempre reconhece (nunca tem legenda pra
  // conflitar).
  let effectiveMessage = leadMessageText;
  if (mediaUrl && (mediaType === 'audio' || mediaType === 'image' || mediaType === 'video')) {
    const hasOwnCaption = (mediaType === 'image' || mediaType === 'video') && leadMessageText?.trim();
    if (!hasOwnCaption) {
      try {
        const recognized = await recognizeMedia({ sessionId, phone, waMessageId, mediaUrl, mediaType, mimetype });
        if (recognized) effectiveMessage = recognized;
      } catch (err) {
        console.error(`[agent-dispatch] falha no reconhecimento de mídia (${sessionId}/${phone}), seguindo com placeholder:`, err.message);
      }
    }
  }

  await dispatchAgentReply({ sessionId, phone, leadMessageText: effectiveMessage });
}

// Baixa o buffer já salvo (media.downloadMedia, server-to-server, sem
// passar por HTTP/signed URL — ver src/media.js), reconhece via
// Whisper/Vision (src/mediaRecognition.js), e ATUALIZA messages.text
// (store.updateMessageText) — pra todo lugar que já lê `text` (histórico
// da IA, timeline, resumo, Chat) se beneficiar sem mudança adicional.
// Devolve o texto reconhecido (usado IMEDIATAMENTE pela resposta da IA,
// sem esperar um novo select) ou null se o tipo não for suportado.
async function recognizeMedia({ sessionId, phone, waMessageId, mediaUrl, mediaType, mimetype }) {
  const buffer = await media.downloadMedia(mediaUrl);

  let text;
  if (mediaType === 'audio') text = await mediaRecognition.transcribeAudio(buffer, mimetype);
  else if (mediaType === 'image') text = await mediaRecognition.describeImage(buffer, mimetype);
  else if (mediaType === 'video') text = await mediaRecognition.describeVideo(buffer);
  else return null;

  // Best-effort separado do reconhecimento em si — se o reconhecimento
  // funcionou mas o UPDATE falhar (ex: hiccup de rede no banco), a IA
  // ainda responde ao texto reconhecido (já em mãos, em memória), só a
  // persistência pro Chat/timeline/histórico futuro que fica sem a
  // transcrição dessa vez (o placeholder original continua no banco).
  store.updateMessageText(sessionId, phone, waMessageId, text)
    .catch((err) => console.error(`[agent-dispatch] falha ao persistir transcrição (${sessionId}/${phone}/${waMessageId}):`, err.message));

  return text;
}

// Cria automaticamente um grupo de WhatsApp pro card que o Agente de IA
// acabou de abrir (só neste fluxo — o card criado por LP/Campanha sem
// Agente de IA ativo continua sem grupo automático; a criação manual
// pela aba do card segue existindo em src/routes/cardGroup.js).
//
// Participantes: o CLIENTE (o telefone do próprio lead) + o DONO da
// instância (celular cadastrado no Bitrix, `PERSONAL_MOBILE`, resolvido
// pelo user id embutido no ownerId — `member_id_userId`). Sem o campo
// "Verificação" e sem "quem clicou" da versão manual: aqui ninguém
// clica, e o card recém-criado normalmente ainda não tem o campo de
// verificação preenchido.
//
// Marca o grupo com source='card' + deal_id — a MESMA marca da criação
// manual —, então herda de graça: (1) o bypass que faz mensagem
// recebida de grupo ser processada/salva em vez de descartada
// (src/whatsapp.js::_processIncomingMessage), (2) o switch Cliente/Grupo
// na aba do card. Idempotente: se já existe grupo de card pra este
// negócio (retry, corrida de 2 mensagens), não cria outro.
async function createCardGroupForNewLead({ sessionId, ownerId, phone, dealId, origin }) {
  const existing = await store.getCardGroupForDeal([sessionId], String(dealId));
  if (existing) return;

  if (!_sessions) {
    throw new Error('agentDispatch não configurado — chame configure({sessions, broadcast}) no boot');
  }
  const gateway = _sessions.get(sessionId); // lança se a sessão não existe
  if (gateway.getStatus() !== 'online') {
    throw new Error('instância não está online — grupo do card não criado');
  }

  // Dono: user id numérico é o último segmento de `member_id_userId`.
  const ownerBitrixUserId = String(ownerId || '').split('_').pop() || null;
  const ownerInfo = ownerBitrixUserId ? await getEmployeeInfo(ownerBitrixUserId).catch(() => null) : null;
  const ownerPhone = normalizeBrazilPhone(ownerInfo?.phone);

  // Dedupe: telefone do lead nunca deveria bater com o do dono, mas
  // Set garante que um número não entre 2x se isso acontecer. `phone`
  // do lead já vem com código de país (é derivado do JID do WhatsApp),
  // mas passa pelo mesmo normalizador por segurança.
  const participants = [...new Set([normalizeBrazilPhone(phone), ownerPhone].filter(Boolean))];
  if (!participants.length) {
    throw new Error('nenhum telefone de participante resolvido (lead + dono)');
  }

  const name = origin.kind === 'lp' ? `LP: ${origin.label}` : 'Campanha';
  const group = await gateway.createGroup(name, participants);
  await store.createGroupRecord(group.id, sessionId, group.name, group.participantCount, { source: 'card', dealId: String(dealId) });
  console.log(`[agent-dispatch] grupo do card criado (${sessionId}/${phone}) → ${group.id} "${group.name}" (${group.participantCount} participantes)`);
}

// Celular do Bitrix costuma vir SEM o código do país (DDD + número,
// 10-11 dígitos) — mesmo critério de src/routes/cardGroup.js e
// src/routes/suggestions.js.
function normalizeBrazilPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length <= 11 ? `55${digits}` : digits;
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
