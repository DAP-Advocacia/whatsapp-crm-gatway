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

async function callChatCompletion(systemPrompt, userPrompt, maxTokens, jsonMode) {
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
  return text;
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

  const raw = await callChatCompletion(
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

module.exports = { suggestAbTestAnalysis, summarizeConversation, generateDashboardInsights };
