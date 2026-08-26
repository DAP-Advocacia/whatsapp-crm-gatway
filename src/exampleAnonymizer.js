const { callOpenAIRaw } = require('./openai');

/**
 * Anonimização de transcript de conversa pra virar exemplo few-shot
 * reutilizável do Agente de IA — escritório de advocacia, dado
 * sensível de um cliente (nome, CPF, telefone, valor de contrato,
 * detalhe de caso) NUNCA pode vazar de uma conversa-exemplo pra outro
 * lead. Abordagem HÍBRIDA, não só um dos dois:
 *
 * 1. Regex determinístico primeiro — cobre com CERTEZA MATEMÁTICA os
 *    padrões estruturados (CPF/CNPJ, telefone BR, e-mail, valor R$),
 *    sem depender de julgamento nenhum de IA pra esses casos.
 * 2. IA reescreve o que sobra — nome próprio em texto livre, endereço
 *    não estruturado, detalhe de caso jurídico — coisas que regex não
 *    reconhece por padrão fixo.
 * 3. REVERIFICAÇÃO determinística: os MESMOS regexes do passo 1 rodam
 *    de novo sobre a SAÍDA da IA. Isso é o que torna isso confiável
 *    em vez de best-effort frágil — nunca se confia só na palavra da
 *    IA de que "anonimizou tudo", sempre se reverifica.
 *
 * `findPiiLeaks` é exportada separadamente porque é reusada uma 3ª
 * vez fora deste módulo, em src/exampleApproval.js — depois que um
 * humano edita manualmente o texto anonimizado na tela de aprovação,
 * a mesma checagem roda de novo sobre o texto FINAL antes de gravar
 * (última rede de segurança contra edição humana reintroduzindo algo
 * sensível).
 */

// Cada entrada: { name, regex, placeholder }. `regex` sempre com flag
// 'g' — usado tanto pra REDIGIR (replace) quanto pra DETECTAR
// (test/match) depois da reescrita da IA.
const PII_PATTERNS = [
  {
    name: 'cpf',
    // CPF com pontuação (000.000.000-00). CPF sem pontuação (11
    // dígitos corridos) é coberto pelo pattern 'documento_11_digitos'
    // no final da lista — não aqui, porque um CPF sem pontuação e um
    // telefone BR sem formatação (DDD+9+8 dígitos) são
    // estruturalmente idênticos (ambos 11 dígitos corridos); ao
    // testar isso descobri que nenhum dos dois cobria sozinho todo
    // número real de 11 dígitos (um CPF sem o dígito 9 na posição de
    // celular escapava do pattern de telefone) — o fallback genérico
    // fecha essa lacuna. Qualquer pattern que "ganhar" primeiro já
    // redige o dado corretamente (o rótulo pode sair "errado", nunca
    // vaza sem redigir).
    regex: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,
    placeholder: '[CPF]',
  },
  {
    name: 'cnpj',
    regex: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g,
    placeholder: '[CNPJ]',
  },
  {
    name: 'telefone',
    // Telefone BR com DDD, com ou sem +55, com ou sem parênteses/
    // separadores — (11) 91234-5678 / 11912345678 / +55 11 91234-5678
    // etc. Sem \b no início: um \( logo antes do DDD não é fronteira
    // de palavra (não há transição letra/dígito), então um \b ali
    // "pula" o parêntese de abertura e deixa ele sobrando no texto
    // redigido — (?<!\d) evita isso sem esse efeito colateral,
    // continuando a rejeitar um número colado a outro dígito.
    regex: /(?<!\d)(?:\+?55\s?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g,
    placeholder: '[TELEFONE]',
  },
  {
    name: 'email',
    regex: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
    placeholder: '[EMAIL]',
  },
  {
    name: 'valor',
    // R$ 1.234,56 / R$1234 / R$ 1234.56 — variações comuns de valor
    // monetário mencionado em texto livre de WhatsApp.
    regex: /\bR\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?\b/g,
    placeholder: '[VALOR]',
  },
  {
    name: 'documento_11_digitos',
    // Fallback pra CPF sem pontuação que NÃO bateu no pattern de
    // telefone (ex: sem o dígito 9 na posição de celular) — roda por
    // ÚLTIMO, sobre o que sobrou depois de todos os patterns mais
    // específicos já terem redigido o que reconheceram. 11 dígitos
    // corridos, isolados, quase certamente é CPF ou telefone de
    // algum formato — redigir por segurança é preferível a arriscar
    // deixar passar (o rótulo genérico [DOCUMENTO] reflete a
    // incerteza sobre qual dos dois é, sem comprometer a garantia de
    // "sempre redige").
    regex: /(?<!\d)\d{11}(?!\d)/g,
    placeholder: '[DOCUMENTO]',
  },
];

// Passo 1 — redação determinística. Devolve o texto já com os
// padrões estruturados substituídos por placeholder.
function applyRegexRedactions(text) {
  let result = text;
  for (const pattern of PII_PATTERNS) {
    result = result.replace(pattern.regex, pattern.placeholder);
  }
  return { text: result };
}

// Detecção (sem substituir) — usada tanto na reverificação pós-IA
// quanto na reverificação pós-edição-humana (src/exampleApproval.js).
// Devolve a lista de NOMES de padrão encontrados (ex: ['cpf',
// 'telefone']), não as ocorrências em si — o motivo do erro basta
// pra decisão de bloquear, não precisa expor o dado sensível de volta
// numa mensagem de log/erro.
function findPiiLeaks(text) {
  const leaks = [];
  for (const pattern of PII_PATTERNS) {
    pattern.regex.lastIndex = 0; // regex global com estado — reseta antes de cada teste
    if (pattern.regex.test(text)) leaks.push(pattern.name);
  }
  return leaks;
}

const ANONYMIZATION_SYSTEM_PROMPT =
  'Você recebe o transcript de uma conversa de atendimento via WhatsApp entre uma empresa (advocacia) ' +
  'e um cliente/lead. Alguns dados óbvios (CPF, telefone, e-mail, valores em R$) já foram substituídos ' +
  'por placeholders como [CPF]/[TELEFONE]/[EMAIL]/[VALOR]. Sua tarefa é reescrever o MESMO texto, ' +
  'preservando toda a estrutura e o conteúdo relevante (perguntas, respostas, ordem, tom), mas ' +
  'substituindo QUALQUER outro dado que identifique a pessoa ou o caso específico: nome próprio da ' +
  'pessoa/empresa mencionada (troque por [NOME] ou [EMPRESA]), endereço (troque por [ENDERECO]), número ' +
  'de processo/protocolo/contrato específico, e qualquer outro detalhe que amarre este texto a um caso ' +
  'real e identificável. NUNCA invente informação nova. NUNCA remova a estrutura da conversa (quem fala ' +
  'o quê, "Empresa:"/"Contato:"). Responda em JSON com um único campo "anonymizedText" contendo o texto ' +
  'reescrito, em português do Brasil.';

// Nunca lança pra fora — sempre devolve { status: 'ok', anonymizedText,
// tokensUsed } ou { status: 'failed', reason }. Quem chama decide o
// que fazer com uma falha (marcar candidata como anonymization_failed).
async function anonymizeTranscript(rawTranscript) {
  const trimmed = String(rawTranscript || '').trim();
  if (!trimmed) return { status: 'failed', reason: 'transcript vazio' };

  const { text: afterRegex } = applyRegexRedactions(trimmed);

  let aiResult;
  try {
    aiResult = await callOpenAIRaw(ANONYMIZATION_SYSTEM_PROMPT, afterRegex, 1500, true);
  } catch (err) {
    return { status: 'failed', reason: `falha ao chamar IA de anonimização: ${err.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(aiResult.text);
  } catch {
    return { status: 'failed', reason: 'resposta em formato inesperado da IA' };
  }
  if (!parsed.anonymizedText || typeof parsed.anonymizedText !== 'string') {
    return { status: 'failed', reason: 'IA não devolveu texto anonimizado' };
  }

  // Reverificação — NUNCA confia só na palavra da IA. Se algum padrão
  // estruturado ainda sobreviveu na saída dela (ex: reescreveu um CPF
  // "por engano" ao parafrasear), a anonimização inteira é reprovada.
  const leaks = findPiiLeaks(parsed.anonymizedText);
  if (leaks.length) {
    return { status: 'failed', reason: `possível vazamento residual: ${leaks.join(', ')}` };
  }

  return { status: 'ok', anonymizedText: parsed.anonymizedText, tokensUsed: aiResult.tokensUsed };
}

module.exports = { anonymizeTranscript, applyRegexRedactions, findPiiLeaks };
