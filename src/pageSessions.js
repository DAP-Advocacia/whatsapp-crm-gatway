const { pool } = require('./db');

/**
 * Histórico de navegação por página, com duração REAL (entrada/saída via
 * navigator.sendBeacon no frontend) — diferente de src/presence.js
 * (admin_presence), que é só o estado ATUAL, sobrescrito a cada heartbeat,
 * sem histórico nenhum. Usado pelo Admin (ver HANDOFF, Parte CO) pra
 * "tempo total nos últimos 30 dias", "página favorita" e os gráficos de
 * "páginas mais acessadas"/"onde o time passa mais tempo".
 *
 * Uma linha por VISITA (não por pessoa) — abre quando uma tela carrega ou
 * troca de página, recebe um "ping" a cada 30s (mesmo ciclo do heartbeat
 * já existente) enquanto ficar aberta, e fecha quando a aba troca de
 * página ou é fechada. ended_at null = ainda aberta OU órfã (aba fechada
 * sem o beacon disparar — crash, queda de luz) — closeStaleSessions
 * fecha essas sozinha depois de 90s sem ping novo, sempre com
 * ended_at = last_ping_at (nunca "agora"), pra nunca inflar a duração
 * registrada com o tempo que ficou órfã até alguém notar.
 */

const STALE_TIMEOUT_SECONDS = 90;

async function openSession(ownerId, ownerName, page) {
  const { rows } = await pool.query(
    `insert into page_sessions (owner_id, owner_name, page)
     values ($1, $2, $3)
     returning id`,
    [ownerId, ownerName || null, page]
  );
  return rows[0].id;
}

async function pingSession(id) {
  await pool.query(
    `update page_sessions set last_ping_at = now() where id = $1 and ended_at is null`,
    [id]
  );
}

async function closeSession(id) {
  await pool.query(
    `update page_sessions set ended_at = now(), last_ping_at = now()
     where id = $1 and ended_at is null`,
    [id]
  );
}

// Chamado periodicamente (ver src/server.js) — nunca deixa uma sessão
// "aberta pra sempre" quando o beacon de saída nunca chegou a disparar.
// ended_at = last_ping_at (o último sinal de vida real), não now() (o
// momento em que este job rodou) — a duração fica correta mesmo que o job
// só passe por aqui minutos depois do timeout de fato ter vencido.
async function closeStaleSessions() {
  const { rowCount } = await pool.query(
    `update page_sessions set ended_at = last_ping_at
     where ended_at is null and last_ping_at < now() - interval '${STALE_TIMEOUT_SECONDS} seconds'`
  );
  return rowCount;
}

// "Último acesso" de um owner — null pra quem nunca abriu nenhuma página
// (usado pela tela de Usuários pra mostrar "—" em vez de esconder a
// pessoa da lista).
async function getLastAccess(ownerId) {
  const { rows } = await pool.query(
    `select max(started_at) as "lastAccess" from page_sessions where owner_id = $1`,
    [ownerId]
  );
  return rows[0]?.lastAccess ? rows[0].lastAccess.toISOString() : null;
}

// Mesma pergunta, em lote — evita 1 query por linha da tabela de Usuários.
async function getLastAccessByOwners(ownerIds) {
  const { rows } = await pool.query(
    `select owner_id as "ownerId", max(started_at) as "lastAccess"
     from page_sessions
     where owner_id = any($1::text[])
     group by owner_id`,
    [ownerIds]
  );
  return new Map(rows.map((r) => [r.ownerId, r.lastAccess.toISOString()]));
}

// Agregações desde `sinceDate`: por owner (tempo total + página favorita,
// pra tabela de Usuários) e globais (pros 2 gráficos de barra + cards do
// topo do Admin — "páginas mais acessadas" é CONTAGEM de visitas,
// "onde o time passa mais tempo" é DURAÇÃO somada — números diferentes de
// propósito, mesma distinção dos prints de referência do usuário).
// coalesce(ended_at, last_ping_at): sessão ainda aberta conta até o
// último sinal de vida visto até agora, não fica de fora do cálculo.
async function getUsageSince(sinceDate) {
  const { rows: byOwnerPage } = await pool.query(
    `select owner_id as "ownerId", page,
            count(*)::int as visits,
            extract(epoch from sum(coalesce(ended_at, last_ping_at) - started_at))::bigint as "durationSeconds"
     from page_sessions
     where started_at >= $1
     group by owner_id, page`,
    [sinceDate]
  );

  const totalByOwner = new Map(); // ownerId -> segundos totais
  const favoritePageByOwner = new Map(); // ownerId -> {page, durationSeconds}
  const totalsByPage = new Map(); // page -> {visits, durationSeconds}

  for (const row of byOwnerPage) {
    const dur = Number(row.durationSeconds) || 0;
    totalByOwner.set(row.ownerId, (totalByOwner.get(row.ownerId) || 0) + dur);

    const currentFav = favoritePageByOwner.get(row.ownerId);
    if (!currentFav || dur > currentFav.durationSeconds) {
      favoritePageByOwner.set(row.ownerId, { page: row.page, durationSeconds: dur });
    }

    const pageTotal = totalsByPage.get(row.page) || { visits: 0, durationSeconds: 0 };
    pageTotal.visits += row.visits;
    pageTotal.durationSeconds += dur;
    totalsByPage.set(row.page, pageTotal);
  }

  const byPageArray = [...totalsByPage.entries()].map(([page, v]) => ({ page, ...v }));
  const mostVisitedPages = [...byPageArray].sort((a, b) => b.visits - a.visits);
  const mostTimeSpentPages = [...byPageArray].sort((a, b) => b.durationSeconds - a.durationSeconds);

  return {
    totalByOwner, // Map<ownerId, segundos>
    favoritePageByOwner, // Map<ownerId, {page, durationSeconds}>
    mostVisitedPages, // [{page, visits, durationSeconds}], por contagem desc
    mostTimeSpentPages, // idem, por duração desc
  };
}

// Detalhamento DIA A DIA por página — usado só pelo tooltip dos 2 gráficos
// de barra do Admin (ver GET /admin/usage-metrics), separado de
// getUsageSince (que só soma o TOTAL do período, sem quebrar por data) —
// usuário pediu pra ver "por data a qtd de visitas" ao passar o mouse
// (sessão 2026-08-13). Query própria (não reaproveita o resultado de
// getUsageSince) porque o agrupamento por dia muda o group by inteiro —
// tentar derivar isso do agregado já feito não seria possível (a soma já
// perdeu a granularidade de dia). `date_trunc('day', started_at)` no fuso
// do banco (UTC) — mesmo padrão de qualquer outro corte por dia já usado
// no projeto, sem tentar converter fuso aqui (isso é decisão de exibição,
// não de armazenamento).
async function getDailyBreakdownByPage(sinceDate) {
  const { rows } = await pool.query(
    `select page,
            date_trunc('day', started_at) as day,
            count(*)::int as visits,
            extract(epoch from sum(coalesce(ended_at, last_ping_at) - started_at))::bigint as "durationSeconds"
     from page_sessions
     where started_at >= $1
     group by page, day
     order by page, day`,
    [sinceDate]
  );

  // Agrupa em { [page]: [{date, visits, durationSeconds}, ...] } — formato
  // já pronto pro frontend indexar por página sem precisar reagrupar de
  // novo no cliente.
  const byPage = new Map();
  for (const row of rows) {
    const list = byPage.get(row.page) || [];
    list.push({
      date: row.day.toISOString().slice(0, 10), // "YYYY-MM-DD", sem hora
      visits: row.visits,
      durationSeconds: Number(row.durationSeconds) || 0,
    });
    byPage.set(row.page, list);
  }
  return byPage;
}

// Histórico completo de UMA pessoa, mais recente primeiro — pro botão
// "Detalhado" na tabela de Usuários do Admin. Limitado a 200 linhas (não
// paginado ainda — volume baixo o suficiente pra não justificar
// paginação real por agora, mesmo raciocínio de listNotifications em
// src/store.js).
async function getSessionHistory(ownerId) {
  const { rows } = await pool.query(
    `select id, page, started_at as "startedAt", ended_at as "endedAt", last_ping_at as "lastPingAt"
     from page_sessions
     where owner_id = $1
     order by started_at desc
     limit 200`,
    [ownerId]
  );
  return rows.map((r) => ({
    id: r.id,
    page: r.page,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    durationSeconds: Math.round(((r.endedAt || r.lastPingAt).getTime() - r.startedAt.getTime()) / 1000),
  }));
}

module.exports = {
  openSession,
  pingSession,
  closeSession,
  closeStaleSessions,
  getLastAccess,
  getLastAccessByOwners,
  getUsageSince,
  getDailyBreakdownByPage,
  getSessionHistory,
};
