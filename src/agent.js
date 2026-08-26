const { callOpenAIRaw } = require('./openai');
const { searchRelevantChunks } = require('./agentKnowledge');
const { searchRelevantExamples } = require('./agentExamples');
const store = require('./store');
const agentConfig = require('./agentConfig');

/**
 * Geração da resposta do Agente de IA — atendimento automático de
 * leads novos (ver src/agentDispatch.js, quem chama isto). Sempre
 * gpt-4o-mini (mesmo modelo já usado em todo o resto do projeto, ver
 * src/openai.js), sempre system+user (nunca multi-turno real na API
 * — o "histórico" entra como transcript de texto dentro do próprio
 * user prompt, mesmo padrão já usado por summarizeConversation).
 */

const DEFAULT_SYSTEM_MESSAGE =
  'Você é um assistente virtual de atendimento via WhatsApp, respondendo pela primeira vez a um ' +
  'lead que acabou de entrar em contato. Seja cordial, direto e breve — o objetivo é fazer uma ' +
  'triagem inicial (entender o que a pessoa precisa, coletar informação básica), não resolver o ' +
  'assunto por completo. Se não souber responder algo com certeza, diga que um atendente humano vai ' +
  'continuar a conversa em breve, em vez de inventar uma resposta. Responda em português do Brasil.';

// Mesmo formato de transcript já usado em summarizeConversation
// (openai.js) — "Empresa:"/"<nome do contato>:" por linha, mídia sem
// texto vira "[tipo]". Reaproveitado aqui em vez de duplicado, pra
// manter o mesmo padrão que a IA já "entende" bem no resto do app.
function buildTranscript(messages, contactName) {
  return messages
    .map((m) => {
      const who = m.direction === 'out' ? 'Empresa' : (contactName || 'Contato');
      const body = m.text || (m.type && m.type !== 'text' ? `[${m.type}]` : '(mensagem vazia)');
      return `${who}: ${body}`;
    })
    .join('\n');
}

// Monta o system message final: persona configurada pelo usuário (ou
// a genérica padrão, se a instância nunca configurou uma) + base de
// conhecimento em texto livre (colada direto) + trechos relevantes
// vindos da busca semântica de documentos + exemplos de conversas
// passadas boas (aprovadas manualmente e anonimizadas, ver
// src/exampleApproval.js — nunca contém dado sensível de verdade).
// Tudo isso é CONTEXTO estático — o histórico da conversa em si vai
// como transcript separado, no user prompt (buildTranscript acima).
// `relevantExamples` default [] pra retrocompatibilidade com qualquer
// chamador que ainda passe só 2 argumentos.
function buildSystemMessage(config, relevantChunks, relevantExamples = []) {
  const parts = [config.systemMessage?.trim() || DEFAULT_SYSTEM_MESSAGE];

  if (config.knowledgeText?.trim()) {
    parts.push(`Informações sobre a empresa/serviços:\n${config.knowledgeText.trim()}`);
  }

  if (relevantChunks.length) {
    const chunksText = relevantChunks.map((c) => `- ${c.content}`).join('\n');
    parts.push(`Trechos relevantes de documentos da empresa (pode não cobrir tudo — use só o que for pertinente):\n${chunksText}`);
  }

  if (relevantExamples.length) {
    const examplesText = relevantExamples.map((e, i) => `--- Exemplo ${i + 1} ---\n${e.text}`).join('\n\n');
    parts.push(
      `Exemplos de atendimentos anteriores bem avaliados (dados pessoais já removidos/substituídos ` +
      `por placeholders como [NOME], [TELEFONE], [VALOR] — use como referência de ESTILO e ESTRUTURA de ` +
      `resposta, nunca copie um placeholder literal na sua resposta real):\n${examplesText}`
    );
  }

  return parts.join('\n\n');
}

// Gera a resposta do agente pra uma conversa. Devolve `null` se a
// instância não tiver o agente ativo (quem chama, agentDispatch.js,
// já checa isso antes de chegar aqui — esta função também checa de
// novo, defensivamente, pra nunca gerar uma resposta indevida mesmo
// se for chamada de outro lugar no futuro). Devolve {text, tokensUsed}
// em caso de sucesso — mesmo contrato de callOpenAIRaw.
async function generateAgentReply(sessionId, phone, leadMessage) {
  const config = await agentConfig.get(sessionId);
  if (!config.active) return null;

  // Busca de chunks (documentos) e de exemplos (conversas passadas)
  // são independentes entre si — rodam em paralelo pra não somar as
  // duas latências. Ambas best-effort: nenhuma falha aqui impede a
  // resposta, só empobrece o contexto.
  const [relevantChunks, relevantExamples] = await Promise.all([
    searchRelevantChunks(sessionId, leadMessage).catch((err) => {
      console.error(`[agent] falha ao buscar conhecimento relevante (seguindo sem isso):`, err.message);
      return [];
    }),
    searchRelevantExamples(sessionId, leadMessage).catch((err) => {
      console.error(`[agent] falha ao buscar exemplos relevantes (seguindo sem isso):`, err.message);
      return [];
    }),
  ]);

  const history = await store.getHistory(sessionId, phone);
  const systemMessage = buildSystemMessage(config, relevantChunks, relevantExamples);
  const transcript = buildTranscript(history, null);

  const userPrompt = transcript
    ? `Histórico da conversa até agora:\n${transcript}\n\nResponda à última mensagem do contato.`
    : `Mensagem do contato: ${leadMessage}`;

  return callOpenAIRaw(systemMessage, userPrompt, 500, false);
}

module.exports = { generateAgentReply, buildSystemMessage, buildTranscript };
