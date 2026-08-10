const store = require('./store');
const { getOwnNumbersBySession } = require('./ownNumbers');

/**
 * Calcula métricas agregadas em cima dos dados do Postgres (Supabase) para o
 * dashboard (/dashboard.html). Lê tudo (todas as sessões DO DONO autenticado,
 * ver `sessionIds` em computeMetrics) de uma vez via `store.getAll()` — se o
 * histórico crescer muito, vale trocar por consultas agregadas (SUM/COUNT/
 * GROUP BY) direto no banco em vez de somar em memória.
 */

// Entradas de sessões antigas (antes da refatoração multi-sessão) ficaram no
// mesmo arquivo com o formato antigo — o "telefone" era a própria chave de
// topo, então o valor tem `messages` direto, sem o nível intermediário por
// telefone. Detectamos e ignoramos essas entradas aqui.
function isLegacyFlatEntry(value) {
  return value && Array.isArray(value.messages);
}

function formatDuration(ms) {
  if (ms == null) return null;
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min ${s}s`;
  return `${s}s`;
}

// Recalcula o mesmo conjunto de métricas (total, recebidas, enviadas,
// conversas, sessões, taxa de resposta, tempo médio, msgs/conversa) só pras
// mensagens dentro de [rangeStart, rangeEnd) — usado pelos indicadores de
// variação MoM/YoY dos cards (ver §2 do HANDOFF, "AH"). É uma reconstrução
// simplificada: agrupa por conversa (sessão+telefone) só dentro do próprio
// recorte, então uma resposta dada nos primeiros minutos de um mês pode não
// encontrar a pergunta (recebida no mês anterior) — aceitável para um
// indicador de tendência, não precisa ter a mesma precisão do total geral.
function summarizeRange(messages, rangeStart, rangeEnd) {
  const inRange = messages.filter((m) => m.at >= rangeStart && m.at < rangeEnd);

  let totalIn = 0;
  let totalOut = 0;
  const conversas = new Set();
  const sessoes = new Set();
  const responseTimesMs = [];
  const byConv = new Map();

  for (const m of inRange) {
    sessoes.add(m.sessionId);
    if (m.direction === 'in') totalIn++;
    else totalOut++;
    if (m.dealId) conversas.add(`${m.sessionId}::${m.phone}`);

    const key = `${m.sessionId}::${m.phone}`;
    if (!byConv.has(key)) byConv.set(key, []);
    byConv.get(key).push(m);
  }

  for (const msgs of byConv.values()) {
    msgs.sort((a, b) => a.at - b.at);
    let lastInAt = null;
    for (const m of msgs) {
      if (m.direction === 'in') {
        lastInAt = m.at;
      } else if (lastInAt != null) {
        const delta = m.at - lastInAt;
        if (delta >= 0) responseTimesMs.push(delta);
        lastInAt = null;
      }
    }
  }

  const avgResponseMs = responseTimesMs.length
    ? responseTimesMs.reduce((a, b) => a + b, 0) / responseTimesMs.length
    : null;
  const responseRate = totalIn ? (responseTimesMs.length / totalIn) * 100 : null;
  const avgMessagesPerConversation = conversas.size ? (totalIn + totalOut) / conversas.size : null;

  return {
    total: totalIn + totalOut,
    in: totalIn,
    out: totalOut,
    conversas: conversas.size,
    sessoes: sessoes.size,
    responseRate,
    avgMessagesPerConversation,
    avgResponseMs,
  };
}

// Início (meia-noite) do mês `monthsAgo` meses atrás, em ms desde epoch.
function monthStart(monthsAgo) {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1).getTime();
}

// `originFilter`: 'interna' | 'externa' | undefined (undefined = todas).
// Filtra ANTES de contar qualquer coisa — os totais, o gráfico por dia, a
// quebra por tipo e a tabela por sessão passam a refletir só o que sobrar.
// `sessionIds`: OBRIGATÓRIO — as instâncias do dono que está pedindo o
// dashboard (ver GET /metrics em src/routes/whatsapp.js). Sem isso, métricas
// e a lista de conversas vazavam dados de TODOS os donos pra qualquer
// usuário autenticado (bug de isolamento corrigido em 2026-07-09, ver Parte
// AQ do HANDOFF) — "visão de time" válida é só entre as instâncias do
// próprio dono, nunca entre donos diferentes.
async function computeMetrics({ origin: originFilter, sessionIds } = {}) {
  if (!sessionIds || !sessionIds.length) {
    return {
      totals: { in: 0, out: 0, total: 0, conversas: 0, sessoes: 0 },
      avgResponseMs: null,
      avgResponseLabel: null,
      responseRate: null,
      avgMessagesPerConversation: null,
      byType: {},
      perDay: [],
      perSession: [],
      conversations: [],
      trend: {
        current: summarizeRange([], monthStart(0), Date.now()),
        prevMonth: summarizeRange([], monthStart(1), monthStart(0)),
        prevYear: summarizeRange([], monthStart(12), monthStart(11)),
      },
    };
  }
  const db = await store.getAll(sessionIds);
  const internalNumbers = new Set(Object.values(getOwnNumbersBySession()));

  let totalIn = 0;
  let totalOut = 0;
  const byType = {};
  const perDay = {}; // 'YYYY-MM-DD' -> { in, out }
  const perSession = {}; // sessionId -> { in, out, conversas: Set<phone> }
  const responseTimesMs = [];
  const conversations = []; // só as vinculadas a um negócio (dealId) — ver computeMetrics
  const flatMessages = []; // achatado (sessionId/phone/dealId/direction/at) — usado só pro recorte por mês do MoM/YoY

  for (const sessionId of Object.keys(db)) {
    const sessionEntry = db[sessionId];
    if (isLegacyFlatEntry(sessionEntry)) continue; // lixo de formato antigo

    if (!perSession[sessionId]) {
      perSession[sessionId] = { in: 0, out: 0, conversas: new Set() };
    }

    for (const phone of Object.keys(sessionEntry)) {
      const entry = sessionEntry[phone];
      if (!entry || !Array.isArray(entry.messages) || !entry.messages.length) continue;

      // "interna": o contato do outro lado é o WhatsApp de outro usuário do
      // Bitrix (ex: teste entre colegas) — "externa": cliente/lead de fora.
      const origin = internalNumbers.has(phone) ? 'interna' : 'externa';
      if (originFilter && origin !== originFilter) continue;

      perSession[sessionId].conversas.add(phone);

      const msgs = [...entry.messages].sort(
        (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
      );

      let lastInAt = null;
      for (const m of msgs) {
        const day = (m.createdAt || '').slice(0, 10);
        if (day) {
          if (!perDay[day]) perDay[day] = { in: 0, out: 0 };
          if (m.direction === 'in') perDay[day].in++;
          else perDay[day].out++;
        }

        const type = m.type || 'text';
        byType[type] = (byType[type] || 0) + 1;

        const at = new Date(m.createdAt).getTime();
        flatMessages.push({ sessionId, phone, dealId: entry.dealId || null, direction: m.direction, at });

        if (m.direction === 'in') {
          totalIn++;
          perSession[sessionId].in++;
          lastInAt = new Date(m.createdAt).getTime();
        } else {
          totalOut++;
          perSession[sessionId].out++;
          // tempo entre a mensagem recebida e a primeira resposta enviada depois
          if (lastInAt != null) {
            const delta = new Date(m.createdAt).getTime() - lastInAt;
            if (delta >= 0) responseTimesMs.push(delta);
            lastInAt = null;
          }
        }
      }

      // Só entra na lista de "Conversas" quem está vinculado a um negócio —
      // sem isso a lista fica poluída com grupos/spam do WhatsApp que não são
      // conversas de negócio de verdade e não têm pra onde abrir no CRM.
      if (entry.dealId) {
        const last = msgs[msgs.length - 1];
        conversations.push({
          sessionId,
          phone,
          dealId: entry.dealId,
          messageCount: msgs.length,
          lastMessageAt: last.createdAt,
          lastMessageDirection: last.direction,
          lastMessageText: last.type && last.type !== 'text' ? `[${last.type}]` : last.text,
          origin,
        });
      }
    }
  }

  const avgResponseMs = responseTimesMs.length
    ? responseTimesMs.reduce((a, b) => a + b, 0) / responseTimesMs.length
    : null;

  // Zero-fill: o gráfico "Mensagens por dia" sempre mostra o MÊS ATUAL
  // inteiro (dia 1 até hoje), não só os dias que têm mensagem — antes a
  // série só incluía dias com dado, então virava uma janela de tamanho
  // variável (ex: "últimos 5 dias" quando só 5 dias tinham alguma
  // mensagem). Mesma convenção de dia (UTC) já usada pra agrupar `perDay`
  // acima (`m.createdAt.slice(0,10)`), pra não desalinhar os 2.
  const now = new Date();
  const perDaySeries = [];
  for (let d = 1; d <= now.getUTCDate(); d++) {
    const key = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const entry = perDay[key];
    perDaySeries.push({ day: key, in: entry ? entry.in : 0, out: entry ? entry.out : 0 });
  }

  const perSessionList = Object.entries(perSession)
    .map(([sessionId, s]) => ({
      sessionId,
      in: s.in,
      out: s.out,
      conversas: s.conversas.size,
    }))
    .sort((a, b) => b.in + b.out - (a.in + a.out));

  const totalConversas = perSessionList.reduce((sum, s) => sum + s.conversas, 0);

  conversations.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

  // % das mensagens recebidas que tiveram alguma resposta enviada depois.
  const responseRate = totalIn ? (responseTimesMs.length / totalIn) * 100 : null;
  // Quantas mensagens, em média, cada conversa tem (recebidas + enviadas).
  const avgMessagesPerConversation = totalConversas ? (totalIn + totalOut) / totalConversas : null;

  // Indicadores de variação (AH — análise horizontal) dos cards: mês atual x
  // mês anterior (MoM) e mês atual x mesmo mês do ano passado (YoY). Cada
  // card mostra o total (histórico completo, como sempre), e essas 3 janelas
  // servem só pra calcular a variação percentual mostrada nos selos.
  const trend = {
    current: summarizeRange(flatMessages, monthStart(0), Date.now()),
    prevMonth: summarizeRange(flatMessages, monthStart(1), monthStart(0)),
    prevYear: summarizeRange(flatMessages, monthStart(12), monthStart(11)),
  };

  return {
    totals: {
      in: totalIn,
      out: totalOut,
      total: totalIn + totalOut,
      conversas: totalConversas,
      sessoes: perSessionList.length,
    },
    avgResponseMs,
    avgResponseLabel: formatDuration(avgResponseMs),
    responseRate,
    avgMessagesPerConversation,
    byType,
    perDay: perDaySeries,
    perSession: perSessionList,
    conversations,
    trend,
  };
}

// Métricas por ATENDENTE, pro Painel de atendimento (ver "Painel" em
// public/chat.html) — diferente de computeMetrics (agregado por
// instância, ignora quem atendeu). Usa conversation_assignment_history
// (store.getAssignmentPeriods), não conversations.assigned_to direto —
// cada "período" já vem só com as mensagens que caíram dentro da janela
// em que aquele atendente específico esteve responsável, então uma
// conversa que trocou de mão não conta o histórico inteiro pra quem
// pegou ela por último (ver Parte CI do HANDOFF).
//
// `viewerOwnerId`/`isManager`: quando quem está vendo o Painel NÃO é o
// dono real da instância (é um delegado comum), a visão é restrita ao
// próprio desempenho — os agregados de "equipe" (byAgent com todo mundo)
// só saem preenchidos pra quem é dono. Decisão de produto confirmada com
// o usuário: funcionário não vê o desempenho dos colegas, só o dele.
async function computeTeamMetrics(sessionIds, { viewerOwnerId, isManager } = {}) {
  const periods = await store.getAssignmentPeriods(sessionIds);
  const visiblePeriods = isManager ? periods : periods.filter((p) => p.assignedTo === viewerOwnerId);

  const byAgent = new Map(); // assignedTo -> { name, conversas: Set, in, out, responseTimesMs: [] }
  for (const period of visiblePeriods) {
    if (!byAgent.has(period.assignedTo)) {
      byAgent.set(period.assignedTo, {
        ownerId: period.assignedTo,
        name: period.assignedToName || 'Atendente',
        conversas: new Set(),
        in: 0,
        out: 0,
        responseTimesMs: [],
      });
    }
    const agent = byAgent.get(period.assignedTo);
    agent.conversas.add(period.conversationId);
    // nome mais recente ganha — mesma pessoa pode ter mudado de nome no
    // Bitrix entre um período antigo e um mais novo (ver limitação já
    // documentada nas Partes CD/CF sobre assigned_to_name congelado).
    if (period.assignedToName) agent.name = period.assignedToName;

    let lastInAt = null;
    for (const m of period.messages) {
      if (m.direction === 'in') {
        agent.in++;
        lastInAt = m.at;
      } else {
        agent.out++;
        if (lastInAt != null) {
          const delta = m.at - lastInAt;
          if (delta >= 0) agent.responseTimesMs.push(delta);
          lastInAt = null;
        }
      }
    }
  }

  const agents = [...byAgent.values()].map((a) => {
    const avgResponseMs = a.responseTimesMs.length
      ? a.responseTimesMs.reduce((x, y) => x + y, 0) / a.responseTimesMs.length
      : null;
    return {
      ownerId: a.ownerId,
      name: a.name,
      conversas: a.conversas.size,
      messagesIn: a.in,
      messagesOut: a.out,
      avgResponseMs,
      avgResponseLabel: formatDuration(avgResponseMs),
    };
  }).sort((x, y) => y.conversas - x.conversas);

  // "pendente" = conversa cujo período de atribuição está aberto
  // (ended_at null) e a última mensagem foi 'in' sem resposta ainda —
  // mesma heurística usada na tag "Pendente" da lista (chat.html), só
  // que aqui quebrado por atendente pra saber quem tem fila acumulada.
  const pendingByAgent = new Map();
  for (const period of visiblePeriods.filter((p) => !p.endedAt)) {
    const last = period.messages[period.messages.length - 1];
    if (last && last.direction === 'in') {
      pendingByAgent.set(period.assignedTo, (pendingByAgent.get(period.assignedTo) || 0) + 1);
    }
  }
  for (const agent of agents) agent.pending = pendingByAgent.get(agent.ownerId) || 0;

  return {
    isManager: !!isManager,
    agents,
    totals: {
      conversas: new Set(visiblePeriods.map((p) => p.conversationId)).size,
      pending: [...pendingByAgent.values()].reduce((a, b) => a + b, 0),
    },
  };
}

module.exports = { computeMetrics, computeTeamMetrics, getOwnNumbersBySession };
