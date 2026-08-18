const { pool } = require('./db');
const store = require('./store');

/**
 * Consultas CROSS-OWNER pra Auditoria de Conversas (`/conversation-analysis.html`,
 * ver HANDOFF Parte DK, `src/adminAuth.js::requireConversationAnalysisAccess`).
 * SEM o parâmetro `sessionId`/`sessionIds` obrigatório que TODO o resto
 * do sistema exige (`store.listConversations`, `metrics.computeMetrics`
 * etc.) — isso é DELIBERADO, não uma reintrodução do bug de isolamento
 * já corrigido (HANDOFF Parte AQ): aquele bug era código que deveria
 * ter escopo de owner e não tinha; este é código cujo PROPÓSITO é não
 * ter escopo, atrás de um middleware de permissão explícita que não
 * existia quando aquele bug foi corrigido.
 *
 * NUNCA chamar nada deste arquivo fora de uma rota protegida por
 * requireConversationAnalysisAccess — nenhuma função aqui confere
 * permissão sozinha, todas assumem que quem chamou já verificou.
 */

// Monta a cláusula WHERE compartilhada entre listAll/computeAggregateMetrics
// — mesmos filtros, formato de parâmetro idêntico, pra não divergir sutilmente
// entre a lista e o agregado do mesmo filtro.
function buildConversationFilter({ sessionId, sentBy, from, to, search } = {}) {
  const conditions = [];
  const params = [];

  if (sessionId) {
    params.push(sessionId);
    conditions.push(`c.session_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`c.updated_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`c.updated_at <= $${params.length}`);
  }
  // Atendente: por MENSAGEM INDIVIDUAL (quem escreveu, messages.sent_by),
  // não por conversations.assigned_to (quem atende agora/por último) —
  // decisão confirmada com o usuário: acha a conversa mesmo que esse
  // atendente já não seja mais o responsável atual dela.
  if (sentBy) {
    params.push(sentBy);
    conditions.push(
      `exists (select 1 from messages m where m.conversation_id = c.id and m.sent_by = $${params.length})`
    );
  }
  // Busca por termo: EXISTS contra messages.text_search (tsvector gerado,
  // índice GIN, ver db/schema.sql) — filtra a CONVERSA que tem ao menos 1
  // mensagem batendo o termo (lista conversas, não mensagens soltas).
  // plainto_tsquery: usuário digita texto livre, sem precisar saber
  // sintaxe de operador de tsquery.
  if (search && search.trim()) {
    params.push(search.trim());
    conditions.push(
      `exists (select 1 from messages m where m.conversation_id = c.id and m.text_search @@ plainto_tsquery('portuguese', $${params.length}))`
    );
  }

  return { whereClause: conditions.length ? conditions.join(' and ') : '1=1', params };
}

// Lista conversas de QUALQUER instância/owner, paginada no SERVIDOR
// (diferente de store.listConversations, que devolve tudo de uma vez e
// pagina no cliente — ali o universo é as instâncias de 1 dono, aqui é
// o sistema todo, ordens de magnitude maior).
async function listAll({ search, sessionId, sentBy, from, to, page = 1, pageSize = 50 } = {}) {
  const { whereClause, params } = buildConversationFilter({ search, sessionId, sentBy, from, to });

  const countResult = await pool.query(
    `select count(*)::int as total from conversations c where ${whereClause}`,
    params
  );
  const total = countResult.rows[0].total;

  const listParams = [...params, pageSize, (page - 1) * pageSize];
  const { rows } = await pool.query(
    `select
       c.id as "conversationId", c.session_id as "sessionId", c.phone,
       c.deal_id as "dealId", coalesce(ct.name, c.push_name) as "contactName",
       c.assigned_to as "assignedTo", c.assigned_to_name as "assignedToName",
       c.updated_at as "updatedAt", i.owner_id as "ownerId",
       lm.text as "lastText", lm.type as "lastType", lm.direction as "lastDirection"
     from conversations c
     left join instances i on i.id = c.session_id
     left join contacts ct on ct.owner_id = i.owner_id and ct.phone = c.phone
     left join lateral (
       select text, type, direction from messages m
       where m.conversation_id = c.id order by m.created_at desc limit 1
     ) lm on true
     where ${whereClause}
     order by c.updated_at desc
     limit $${listParams.length - 1} offset $${listParams.length}`,
    listParams
  );

  return {
    conversations: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })),
    total,
  };
}

// Histórico de UMA conversa, qualquer dono — reusa store.getHistory
// direto. A query já é agnóstica de dono (só usa session_id+phone); o
// isolamento sempre esteve em QUEM CHAMA confirmar posse antes, nunca
// na query em si — aqui quem chama é este painel, atrás de
// requireConversationAnalysisAccess, que É a confirmação de acesso, só
// que a um universo maior de conversas.
const getHistory = store.getHistory;

// Métricas agregadas cross-owner pro mesmo filtro de listAll (sem
// paginação/busca por termo — período/instância/atendente). Agregação
// SQL direta (não reusa metrics.computeMetrics, que exige sessionIds e
// carrega tudo em memória via store.getAll — aqui o volume potencial é
// o sistema todo, agregação em SQL evita puxar cada mensagem pro
// processo Node).
async function computeAggregateMetrics({ sessionId, sentBy, from, to } = {}) {
  const conditions = ['1=1'];
  const params = [];
  if (sessionId) { params.push(sessionId); conditions.push(`c.session_id = $${params.length}`); }
  if (sentBy) { params.push(sentBy); conditions.push(`m.sent_by = $${params.length}`); }
  if (from) { params.push(from); conditions.push(`m.created_at >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`m.created_at <= $${params.length}`); }
  const whereClause = conditions.join(' and ');

  const totalsResult = await pool.query(
    `select
       count(*)::int as total,
       count(*) filter (where m.direction = 'in')::int as "totalIn",
       count(*) filter (where m.direction = 'out')::int as "totalOut",
       count(distinct c.id)::int as conversas,
       count(distinct c.session_id)::int as instancias
     from messages m
     join conversations c on c.id = m.conversation_id
     where ${whereClause}`,
    params
  );

  const perDayResult = await pool.query(
    `select date_trunc('day', m.created_at) as day, count(*)::int as count
     from messages m
     join conversations c on c.id = m.conversation_id
     where ${whereClause}
     group by day
     order by day asc`,
    params
  );

  return {
    totals: totalsResult.rows[0],
    perDay: perDayResult.rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), count: r.count })),
  };
}

module.exports = { listAll, getHistory, computeAggregateMetrics };
