/**
 * Cliente mínimo pra Chat Completions da OpenAI — usado por:
 * 1) botão "Gerar com IA" ao encerrar um teste A/B (ver POST
 *    /api/ab-tests/:id/suggest-analysis, src/routes/abTests.js);
 * 2) botão de resumo da conversa no painel de detalhes do contato (ver
 *    POST /api/whatsapp/conversations/summary, src/routes/whatsapp.js).
 * Ambos geram uma SUGESTÃO/rascunho — nunca escrevem nada permanente
 * sozinhos; quem chama decide se salva.
 */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = 'gpt-4o-mini';

// Chamada real à API — devolve texto + tokens gastos (usage.total_tokens,
// prompt+completion). Privada (não exportada): `callChatCompletion` abaixo
// é a interface pública de sempre (só o texto), usada por 4 chamadas
// existentes (sugestão de A/B test, insights do dashboard) que nunca
// precisaram de contagem de tokens — mudar o retorno DELAS quebraria as 4.
// `summarizeConversation` (única que precisa da contagem, pra persistir no
// histórico de resumos) chama esta função diretamente.
async function _callOpenAI(systemPrompt, userPrompt, maxTokens, jsonMode) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada no servidor');
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.5,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message || 'erro na API da OpenAI');
  }
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('resposta vazia da OpenAI');
  return { text, tokensUsed: data.usage?.total_tokens ?? null };
}

async function callChatCompletion(systemPrompt, userPrompt, maxTokens, jsonMode) {
  return (await _callOpenAI(systemPrompt, userPrompt, maxTokens, jsonMode)).text;
}

// Interface pública que EXPÕE tokensUsed (diferente de
// callChatCompletion acima) — usada pelo Agente de IA
// (src/agent.js), que precisa da contagem de tokens pra métricas,
// mesmo padrão de summarizeConversation (única outra consumidora
// direta de _callOpenAI até agora). Repassa 1:1, sem lógica extra.
async function callOpenAIRaw(systemPrompt, userPrompt, maxTokens, jsonMode) {
  return _callOpenAI(systemPrompt, userPrompt, maxTokens, jsonMode);
}

// Resumo de uma conversa de WhatsApp (últimas até 80 mensagens, pra manter
// o prompt num tamanho razoável) — usado pelo painel de detalhes do
// contato na tela Chat. `messages`: mesmo formato de store.getHistory()
// (direction 'in'/'out', text, type, createdAt). Baseado SOMENTE no texto
// das mensagens; mídia sem legenda vira só "[tipo de mídia]" no prompt.
// Retorna {title, subtitle, summary} — pedido em JSON (response_format)
// pra vir sempre nesses 3 campos, sem parsing frágil de texto livre.
async function summarizeConversation({ contactName, messages }) {
  const recent = messages.slice(-80);
  if (!recent.length) throw new Error('não há mensagens nessa conversa ainda');

  const transcript = recent
    .map((m) => {
      const who = m.direction === 'out' ? 'Empresa' : (contactName || 'Contato');
      const body = m.text || (m.type && m.type !== 'text' ? `[${m.type}]` : '(mensagem vazia)');
      return `${who}: ${body}`;
    })
    .join('\n');

  const { text: raw, tokensUsed } = await _callOpenAI(
    'Você resume conversas de atendimento via WhatsApp entre uma empresa e um contato/cliente. ' +
      'Responda em JSON com exatamente 3 campos: ' +
      '"title" (bem curto, até 6 palavras, o assunto principal da conversa — ex: "Dúvida sobre atestado médico"), ' +
      '"subtitle" (uma frase curta com o status atual — ex: "Aguardando retorno da empresa") e ' +
      '"summary" (resumo detalhado, 3 a 6 frases, cobrindo o que o contato quer/precisa, o histórico ' +
      'da conversa até aqui e o status atual — respondido, pendente, resolvido, aguardando o quê). ' +
      'Baseie-se SOMENTE no texto da conversa — nunca invente informação que não apareceu nela. ' +
      'Responda em português do Brasil, direto, sem saudação nem introdução.',
    `Conversa com ${contactName || 'o contato'}:\n\n${transcript}`,
    420,
    true
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('resposta em formato inesperado da OpenAI');
  }
  if (!parsed.summary) throw new Error('resposta incompleta da OpenAI');
  return {
    title: parsed.title || null,
    subtitle: parsed.subtitle || null,
    summary: parsed.summary,
    tokensUsed,
  };
}

function conversionPct(views, leads) {
  return views > 0 ? Math.round((leads / views) * 1000) / 10 : null;
}

function describeVariant(label, name, snapshot, views, leads) {
  const sections = snapshot?.sections || {};
  const conv = conversionPct(views, leads);
  return [
    `Variante ${label} — ${name || '(sem nome)'}`,
    `Título: ${snapshot?.title || '(sem título)'}`,
    snapshot?.subtitle ? `Subtítulo: ${snapshot.subtitle}` : null,
    `Seções usadas: depoimentos=${sections.testimonials ?? 0}, estatísticas=${sections.stats ?? 0}, diferenciais=${sections.differentials ?? 0}, FAQ=${sections.faq ?? 0}, história=${sections.story ? 'sim' : 'não'}`,
    `Visualizações: ${views}`,
    `Leads: ${leads}`,
    `Conversão: ${conv != null ? conv + '%' : 'sem dados (0 visualizações)'}`,
  ].filter(Boolean).join('\n');
}

// `test`: o mesmo objeto de abTests.get()/listByOwner() — precisa de
// formAName/formBName, variantSnapshot.{a,b} e viewsA/leadsA/viewsB/leadsB.
async function suggestAbTestAnalysis(test) {
  const prompt = [
    `Teste A/B: "${test.name}"`,
    '',
    describeVariant('A', test.formAName, test.variantSnapshot?.a, test.viewsA, test.leadsA),
    '',
    describeVariant('B', test.formBName, test.variantSnapshot?.b, test.viewsB, test.leadsB),
  ].join('\n');

  return callChatCompletion(
    'Você é um analista de marketing digital especializado em otimização de conversão de landing pages (CRO). Escreva uma análise curta e objetiva (3 a 5 frases) sobre um teste A/B entre duas variantes de LP, baseada SOMENTE nos números fornecidos — nunca invente dado que não foi dado. Aponte o que provavelmente explica a diferença de performance e uma recomendação prática do que replicar ou evitar nas próximas LPs. Responda em português do Brasil, direto, sem saudação nem introdução.',
    prompt,
    300
  );
}

// Formata os dados já calculados por computeMetrics (src/metrics.js) num
// texto compacto pro prompt — nunca manda mensagem/conversa individual, só
// os números agregados que já aparecem nos cards/gráficos do Dashboard.
function describeMetricsForInsights(metrics, stages) {
  const t = metrics.totals;
  const trend = metrics.trend || {};
  const pctChange = (curr, prev) => {
    if (!prev || !prev.total) return curr && curr.total ? 'novo' : 'sem variação';
    const diff = ((curr.total - prev.total) / prev.total) * 100;
    return `${diff >= 0 ? '+' : ''}${Math.round(diff)}%`;
  };
  const byTypeStr = Object.entries(metrics.byType || {})
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ') || 'sem dados';
  const perSessionStr = (metrics.perSession || [])
    .map((s) => `${s.label || s.sessionId} (recebidas=${s.in}, enviadas=${s.out})`)
    .join('; ') || 'nenhuma';
  const stagesStr = (stages || []).map((s) => `${s.name}: ${s.count}`).join(', ') || 'sem dados do Bitrix';

  return [
    `Mensagens totais: ${t.total} (recebidas=${t.in}, enviadas=${t.out})`,
    `Conversas ativas: ${t.conversas} · Sessões (instâncias): ${t.sessoes}`,
    `Tempo médio de resposta: ${metrics.avgResponseLabel || 'sem dados'}`,
    `Taxa de resposta: ${metrics.responseRate != null ? Math.round(metrics.responseRate) + '%' : 'sem dados'}`,
    `Mensagens por conversa (média): ${metrics.avgMessagesPerConversation != null ? metrics.avgMessagesPerConversation.toFixed(1) : 'sem dados'}`,
    `Variação vs mês anterior (MoM): ${pctChange(trend.current, trend.prevMonth)}`,
    `Variação vs mesmo mês ano passado (YoY): ${pctChange(trend.current, trend.prevYear)}`,
    `Por tipo de mensagem: ${byTypeStr}`,
    `Por instância: ${perSessionStr}`,
    `Negócios por etapa no Bitrix: ${stagesStr}`,
  ].join('\n');
}

// Insights curtos pro topo do Dashboard — 3 a 5 cards, cada um com um
// diagnóstico ou recomendação prática baseado SOMENTE nos números já
// mostrados nos outros cards/gráficos (nunca inventa dado). `tone` decide a
// cor do card no front: 'positive' (verde, algo indo bem), 'warning'
// (vermelho, precisa de atenção) ou 'neutral' (dourado, observação neutra).
async function generateDashboardInsights(metrics, stages) {
  const description = describeMetricsForInsights(metrics, stages);
  const raw = await callChatCompletion(
    'Você é um analista de operações que olha os números de atendimento via WhatsApp de uma equipe ' +
      'e escreve alertas/observações curtas e acionáveis pra quem gerencia o time. ' +
      'Responda em JSON com um campo "insights": uma lista de 3 a 5 objetos, cada um com ' +
      '"title" (bem curto, até 6 palavras), "text" (1 a 2 frases, direto, com um diagnóstico ou recomendação prática) ' +
      'e "tone" (exatamente "positive", "warning" ou "neutral"). ' +
      'Baseie-se SOMENTE nos números fornecidos — nunca invente dado que não apareceu neles. ' +
      'Se algum número estiver "sem dados", não invente insight sobre ele. ' +
      'Priorize o que for mais acionável: quedas/altas relevantes, tempo de resposta, distribuição desigual entre ' +
      'instâncias, gargalos de etapa no funil. Responda em português do Brasil, sem saudação nem introdução.',
    description,
    500,
    true
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('resposta em formato inesperado da OpenAI');
  }
  if (!Array.isArray(parsed.insights) || !parsed.insights.length) {
    throw new Error('resposta sem insights da OpenAI');
  }
  return parsed.insights
    .filter((i) => i && i.title && i.text)
    .map((i) => ({
      title: i.title,
      text: i.text,
      tone: ['positive', 'warning', 'neutral'].includes(i.tone) ? i.tone : 'neutral',
    }));
}

// Formata computeTeamMetrics (src/metrics.js) num texto compacto pro
// prompt do Painel de atendimento (chat.html) — mesmo cuidado do
// describeMetricsForInsights: só números já agregados, nunca conteúdo de
// mensagem/conversa individual.
function describeTeamMetricsForInsights(teamMetrics) {
  const t = teamMetrics.totals;
  const agentsStr = (teamMetrics.agents || [])
    .map((a) => `${a.name}: ${a.conversas} conversa(s), ${a.pending} pendente(s), tempo médio de resposta ${a.avgResponseLabel || 'sem dados'}`)
    .join('; ') || 'nenhum atendente com histórico ainda';

  return [
    `Conversas com atendimento registrado: ${t.conversas}`,
    `Pendentes no total (aguardando resposta agora): ${t.pending}`,
    `Por atendente: ${agentsStr}`,
  ].join('\n');
}

// Insights/"storytelling" pro Painel de atendimento (pedido do gerente que
// compartilhou a própria instância, ver Parte CI do HANDOFF) — mesmo
// contrato de generateDashboardInsights (3 a 5 cards, tone
// positive/warning/neutral), mas focado em desempenho de EQUIPE, não
// volume geral da instância: quem está com fila acumulada, quem responde
// rápido, distribuição desigual de trabalho entre atendentes.
async function generateTeamInsights(teamMetrics) {
  const description = describeTeamMetricsForInsights(teamMetrics);
  const raw = await callChatCompletion(
    'Você é um analista de operações que olha o desempenho de atendimento via WhatsApp de uma equipe ' +
      '(um gerente que compartilhou o próprio número com funcionários) e escreve observações curtas em tom de ' +
      'história/narrativa (storytelling) sobre como a equipe está se saindo. ' +
      'Responda em JSON com um campo "insights": uma lista de 3 a 5 objetos, cada um com ' +
      '"title" (bem curto, até 6 palavras), "text" (1 a 2 frases, com um diagnóstico ou recomendação prática) ' +
      'e "tone" (exatamente "positive", "warning" ou "neutral"). ' +
      'Baseie-se SOMENTE nos números fornecidos — nunca invente dado que não apareceu neles. ' +
      'Se não houver atendente com histórico ainda, diga isso diretamente em vez de inventar um cenário. ' +
      'Priorize o que for mais acionável: quem está sobrecarregado (muita conversa/pendência), quem responde ' +
      'rápido ou lento, e se o trabalho está bem distribuído entre a equipe. ' +
      'Responda em português do Brasil, sem saudação nem introdução.',
    description,
    500,
    true
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('resposta em formato inesperado da OpenAI');
  }
  if (!Array.isArray(parsed.insights) || !parsed.insights.length) {
    throw new Error('resposta sem insights da OpenAI');
  }
  return parsed.insights
    .filter((i) => i && i.title && i.text)
    .map((i) => ({
      title: i.title,
      text: i.text,
      tone: ['positive', 'warning', 'neutral'].includes(i.tone) ? i.tone : 'neutral',
    }));
}

// Teto rígido de conversas/mensagens amostradas pro insight abaixo — sem
// isso, um filtro amplo (ex: 1 ano, sem outro filtro, na Auditoria de
// Conversas) geraria um prompt de centenas de milhares de tokens: custo
// alto, risco real de exceder o limite de contexto do modelo, latência
// inaceitável numa chamada síncrona de request/response.
const INSIGHT_MAX_CONVERSATIONS = 60;
const INSIGHT_MAX_MESSAGES = 400;

// Insight de IA sobre um CONJUNTO de conversas filtradas — Auditoria de
// Conversas (`/conversation-analysis.html`, HANDOFF Parte DK).
// DIFERENTE de summarizeConversation (1 conversa só, até 80 mensagens) e
// de generateDashboardInsights (só números agregados, nunca texto de
// mensagem): aqui o pedido explícito é ler CONTEÚDO real de várias
// conversas de qualquer owner. `conversationsWithMessages`: array de
// {contactName, phone, messages} já ordenado mais-recente-primeiro (é o
// chamador — a rota — que decide o critério de "mais relevante"; esta
// função só corta pelo teto). Amostra as `INSIGHT_MAX_CONVERSATIONS`
// primeiras, dividindo o orçamento de `INSIGHT_MAX_MESSAGES` entre elas.
// `sampledConversations`/`totalMatching` na resposta são OBRIGATÓRIOS
// pro chamador exibir "baseado em X de Y conversas" — nunca dar a
// entender que o insight cobriu o filtro inteiro quando é uma amostra.
async function generateConversationAnalysisInsight(conversationsWithMessages, totalMatching) {
  const sample = conversationsWithMessages.slice(0, INSIGHT_MAX_CONVERSATIONS);
  if (!sample.length) throw new Error('nenhuma conversa nesse filtro ainda');

  const perConversationBudget = Math.max(1, Math.floor(INSIGHT_MAX_MESSAGES / sample.length));
  const transcript = sample
    .map((conv) => {
      const msgs = conv.messages.slice(-perConversationBudget);
      const body = msgs
        .map((m) => {
          const who = m.direction === 'out' ? 'Empresa' : (conv.contactName || 'Contato');
          const text = m.text || (m.type && m.type !== 'text' ? `[${m.type}]` : '(mensagem vazia)');
          return `${who}: ${text}`;
        })
        .join('\n');
      return `--- Conversa com ${conv.contactName || conv.phone} ---\n${body}`;
    })
    .join('\n\n');

  const raw = await callChatCompletion(
    'Você analisa um CONJUNTO de conversas de atendimento via WhatsApp de várias equipes/contatos ' +
      'diferentes, já filtradas por quem está investigando (pode ser por período, atendente, instância ou ' +
      'termo de busca). Responda em JSON com um campo "insights": uma lista de 3 a 6 objetos, cada um com ' +
      '"title" (bem curto, até 6 palavras), "text" (1 a 3 frases sobre um padrão recorrente, problema comum, ' +
      'ou observação relevante sobre o CONTEÚDO dessas conversas) e "tone" (exatamente "positive", "warning" ' +
      'ou "neutral"). Baseie-se SOMENTE no texto fornecido — nunca invente informação que não apareceu nele. ' +
      'Se as conversas não tiverem nada em comum relevante, diga isso diretamente em vez de forçar um padrão. ' +
      'Responda em português do Brasil, sem saudação nem introdução.',
    transcript,
    700,
    true
  );

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('resposta em formato inesperado da OpenAI');
  }
  if (!Array.isArray(parsed.insights) || !parsed.insights.length) {
    throw new Error('resposta sem insights da OpenAI');
  }
  return {
    insights: parsed.insights
      .filter((i) => i && i.title && i.text)
      .map((i) => ({
        title: i.title,
        text: i.text,
        tone: ['positive', 'warning', 'neutral'].includes(i.tone) ? i.tone : 'neutral',
      })),
    sampledConversations: sample.length,
    totalMatching,
  };
}

module.exports = {
  suggestAbTestAnalysis,
  summarizeConversation,
  generateDashboardInsights,
  generateTeamInsights,
  generateConversationAnalysisInsight,
  callOpenAIRaw,
};
