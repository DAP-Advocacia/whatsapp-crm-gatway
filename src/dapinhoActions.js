const PDFDocument = require('pdfkit');
const store = require('./store');
const instancesStore = require('./instances');
const { callOpenAIRaw } = require('./openai');

/**
 * Ações de execução real do Dapinho (2026-08-28) — enviar mensagem de
 * WhatsApp, gerar relatório, arquivar conversa, marcar/desmarcar como
 * pendente manualmente. Módulo separado de src/dapinho.js (que continua
 * cuidando da conversa em si — snapshot, few-shot, broadcast de feature) pra
 * manter a fronteira clara entre "responder" e "agir".
 *
 * Fluxo de duas etapas, sempre com CONFIRMAÇÃO explícita antes de qualquer
 * ação que grave/envie algo de verdade (decisão de produto confirmada com o
 * usuário — nunca agir direto a partir de um comando em linguagem natural):
 *   1) detectIntent(question) — uma chamada à OpenAI em JSON estruturado
 *      decide se é uma pergunta normal (`chat`) ou um pedido de ação
 *      (`send_message`/`generate_report`/`archive`/`mark_pending`), com os
 *      parâmetros extraídos (nome do contato, texto).
 *   2) resolveAndDescribe(...) — resolve o nome pra uma conversa real (via
 *      busca já existente, store.listConversations), monta uma descrição
 *      legível ("vou mandar 'oi' pro Daniel Costa (5511999...)") e devolve
 *      um objeto `pendingAction` pra ser salvo em dapinho_state.pending_action
 *      até o usuário confirmar.
 *   3) executeAction(...) — só chamada depois que o usuário confirma (ver
 *      isConfirmation em src/dapinho.js) — executa de fato.
 */

// Valores fechados que o detector pode produzir — qualquer coisa fora
// disso vira 'chat' (fallback seguro, nunca uma ação não reconhecida).
const INTENT_TYPES = ['chat', 'send_message', 'generate_report', 'archive', 'unarchive', 'mark_pending', 'unmark_pending'];

const INTENT_SYSTEM_MESSAGE =
  'Você classifica a intenção de uma mensagem dentro do assistente Dapinho (gateway de WhatsApp). ' +
  'Responda SEMPRE em JSON, com este formato exato:\n' +
  '{"type": "chat" | "send_message" | "generate_report" | "archive" | "unarchive" | "mark_pending" | "unmark_pending", ' +
  '"contactName": string|null, "text": string|null}\n\n' +
  '- "chat": qualquer pergunta ou pedido de informação (ex: "quais leads não respondi", "resuma minhas conversas") — ' +
  'contactName e text ficam null.\n' +
  '- "send_message": pedido explícito para ENVIAR uma mensagem de WhatsApp a um contato (ex: "manda um oi pro Daniel", ' +
  '"avisa a Maria que vou atrasar"). contactName = nome do contato mencionado; text = o texto exato a enviar (extraia o ' +
  'conteúdo da mensagem pedida, sem aspas).\n' +
  '- "generate_report": pedido para gerar/exportar um relatório ou resumo em ARQUIVO (ex: "gera um relatório", "exporta um PDF ' +
  'das minhas conversas"). Um pedido de RESUMO EM TEXTO (ex: "resuma minhas conversas") é "chat", não "generate_report" — ' +
  '"generate_report" é só quando a pessoa pede um ARQUIVO pra baixar.\n' +
  '- "archive"/"unarchive": pedido para arquivar/desarquivar uma conversa específica por nome. contactName obrigatório.\n' +
  '- "mark_pending"/"unmark_pending": pedido para marcar/desmarcar uma conversa como pendente por nome. contactName obrigatório.\n\n' +
  'Nunca invente contactName/text que não estejam na mensagem do usuário. Se faltar informação (ex: pediu pra mandar ' +
  'mensagem mas não disse pra quem), ainda assim classifique o type certo, deixando o campo faltante null.';

async function detectIntent(question) {
  try {
    const { text } = await callOpenAIRaw(INTENT_SYSTEM_MESSAGE, question, 200, true);
    const data = JSON.parse(text);
    if (!INTENT_TYPES.includes(data?.type)) return { type: 'chat', contactName: null, text: null };
    return {
      type: data.type,
      contactName: typeof data.contactName === 'string' ? data.contactName.trim() || null : null,
      text: typeof data.text === 'string' ? data.text.trim() || null : null,
    };
  } catch (err) {
    console.error('[dapinhoActions] falha ao detectar intenção (seguindo como chat):', err.message);
    return { type: 'chat', contactName: null, text: null };
  }
}

// Acha a(s) conversa(s) do dono cujo nome/telefone bate com `term` — mesma
// busca ILIKE já usada pelo campo de busca do Chat (store.listConversations,
// parâmetro `search`), nenhuma lógica nova de matching. Devolve [] (nome não
// achado), [1 item] (resolvido) ou [2+ itens] (ambíguo — quem chama decide
// pedir desambiguação).
async function findConversationsByName(ownerId, term) {
  const accessible = await instancesStore.listAccessible(ownerId);
  const sessionIds = accessible.map((i) => i.id);
  if (!sessionIds.length) return [];
  return store.listConversations(sessionIds, term, { archived: false });
}

function describeAction(type, conv, text) {
  const name = conv.contactName || conv.phone;
  if (type === 'send_message') return `Vou mandar "${text}" pro ${name} (${conv.phone}).`;
  if (type === 'archive') return `Vou arquivar a conversa com ${name} (${conv.phone}).`;
  if (type === 'unarchive') return `Vou restaurar a conversa com ${name} (${conv.phone}) das arquivadas.`;
  if (type === 'mark_pending') return `Vou marcar a conversa com ${name} (${conv.phone}) como pendente.`;
  if (type === 'unmark_pending') return `Vou remover a marcação de pendente da conversa com ${name} (${conv.phone}).`;
  return `Vou executar essa ação na conversa com ${name} (${conv.phone}).`;
}

// Mesmo teto de MAX_QUESTION_LENGTH (src/dapinho.js) — o texto de
// send_message vem de um campo DERIVADO (a IA extrai de dentro da
// pergunta do usuário, não é a pergunta em si), então precisa da própria
// validação explícita: nada garante que a resposta da IA respeite um
// limite de caracteres só por causa do max_tokens da chamada (achado real
// do security-reviewer-agent, 2026-08-28 — sem isso, `gateway.sendMessage`
// mandaria qualquer tamanho que a IA decidisse ecoar no campo, sem teto).
const MAX_SEND_TEXT_LENGTH = 1000;

// Resolve a intenção detectada pra uma AÇÃO CONCRETA pendente de
// confirmação — ou devolve `null` com uma mensagem explicando por que não
// deu pra prosseguir (nome não achado, ambíguo, faltou texto). Nunca
// executa nada aqui — só prepara e descreve.
async function resolveAndDescribe(ownerId, intent) {
  if (intent.type === 'send_message') {
    if (!intent.text) {
      return { pendingAction: null, replyText: 'Entendi que você quer mandar uma mensagem, mas não peguei o texto — pode reformular incluindo o que quer dizer?' };
    }
    if (intent.text.length > MAX_SEND_TEXT_LENGTH) {
      return { pendingAction: null, replyText: `O texto ficou muito longo (${intent.text.length} caracteres, máximo ${MAX_SEND_TEXT_LENGTH}) — pode pedir de forma mais resumida?` };
    }
  }
  if (!intent.contactName) {
    return { pendingAction: null, replyText: 'Pra quem é essa ação? Preciso do nome do contato.' };
  }

  const matches = await findConversationsByName(ownerId, intent.contactName);
  if (!matches.length) {
    return { pendingAction: null, replyText: `Não encontrei nenhuma conversa com "${intent.contactName}" entre as suas. Confere o nome?` };
  }
  if (matches.length > 1) {
    const options = matches.slice(0, 6).map((c) => `- ${c.contactName || c.phone} (${c.phone})`).join('\n');
    return { pendingAction: null, replyText: `Achei mais de uma conversa parecida com "${intent.contactName}" — qual delas?\n${options}\n\nResponda com o nome completo ou o telefone certo.` };
  }

  const conv = matches[0];
  const pendingAction = {
    type: intent.type,
    params: { sessionId: conv.sessionId, phone: conv.phone, contactName: conv.contactName || conv.phone, text: intent.text || null },
    description: describeAction(intent.type, conv, intent.text),
  };
  return { pendingAction, replyText: `${pendingAction.description} Confirma? (sim/não)` };
}

// Executa de fato uma ação já confirmada. `deps` injeta o que este módulo
// não tem acesso direto (sessions/broadcast vêm de src/server.js, mesmo
// padrão de src/dapinho.js::configure) — passado explicitamente em vez de
// um configure() próprio, pra não duplicar estado de módulo com dapinho.js.
async function executeAction(ownerId, pendingAction, { sessions, broadcast, ownerName }) {
  const { type, params } = pendingAction;
  const { sessionId, phone, text } = params;

  if (type === 'send_message') {
    const gateway = sessions.get(sessionId);
    const message = await gateway.sendMessage(phone, text, null); // lança se a instância estiver offline (ver WhatsAppGateway.sendMessage)
    message.sentBy = ownerId;
    message.sentByName = ownerName || null;
    await store.addMessage(sessionId, phone, message, null);
    broadcast(sessionId, phone, { type: 'message', message });
    return `Mensagem enviada.`;
  }
  if (type === 'archive' || type === 'unarchive') {
    await store.setConversationArchived(sessionId, phone, type === 'archive');
    return type === 'archive' ? 'Conversa arquivada.' : 'Conversa restaurada.';
  }
  if (type === 'mark_pending' || type === 'unmark_pending') {
    await store.setConversationPendingManual(sessionId, phone, type === 'mark_pending');
    return type === 'mark_pending' ? 'Marcada como pendente.' : 'Pendência removida.';
  }
  throw new Error(`tipo de ação desconhecido: ${type}`);
}

// Relatório em PDF de TODAS as conversas ativas do dono — diferente de
// GET /conversations/export-pdf (routes/whatsapp.js, uma conversa completa
// mensagem a mensagem), este é um RESUMO por conversa (nome, telefone,
// última mensagem, se está aguardando resposta), uma linha por contato —
// senão um PDF de centenas de conversas inteiras ficaria enorme e lento de
// gerar. Sem confirmação (decisão de produto: só leitura, não grava/envia
// nada) — chamado direto pela rota GET /api/dapinho/report.
async function generateReportPdf(ownerId, res) {
  const accessible = await instancesStore.listAccessible(ownerId);
  const sessionIds = accessible.map((i) => i.id);
  const conversations = sessionIds.length ? await store.listConversations(sessionIds, null, { archived: false }) : [];

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="relatorio-dapinho-${Date.now()}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);

  doc.font('Helvetica-Bold').fontSize(16).text('Relatório de conversas — Dapinho');
  doc.font('Helvetica').fontSize(10).fillColor('#666666')
    .text(`Gerado em ${new Date().toLocaleString('pt-BR')} · ${conversations.length} conversa${conversations.length === 1 ? '' : 's'} ativa${conversations.length === 1 ? '' : 's'}`);
  doc.moveDown(1);
  doc.strokeColor('#cccccc').moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(1);

  if (!conversations.length) {
    doc.fontSize(11).fillColor('#333333').text('Nenhuma conversa ativa no momento.');
  }

  conversations.forEach((c) => {
    const name = c.contactName || c.phone;
    const waiting = c.lastDirection === 'in';
    const snippet = c.lastText ? c.lastText.slice(0, 200) : '(sem texto/mídia)';
    doc.font('Helvetica-Bold').fontSize(10).fillColor(waiting ? '#b3312c' : '#1a1408')
      .text(`${name} (${c.phone})${waiting ? ' — aguardando resposta' : ''}`);
    doc.font('Helvetica').fontSize(9).fillColor('#666666')
      .text(`Última mensagem em ${new Date(c.lastAt).toLocaleString('pt-BR')}`);
    doc.font('Helvetica').fontSize(10).fillColor('#333333').text(snippet);
    doc.moveDown(0.6);
  });

  doc.end();
}

module.exports = { detectIntent, resolveAndDescribe, executeAction, generateReportPdf, INTENT_TYPES };
