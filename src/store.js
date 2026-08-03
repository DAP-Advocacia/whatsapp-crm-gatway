const { pool } = require('./db');
const { getOwnNumbersBySession } = require('./ownNumbers');

/**
 * Persistência em Postgres (Supabase), organizada por SESSÃO (usuário do
 * Bitrix) e, dentro dela, por telefone (E.164 sem '+'). Cada usuário tem seu
 * próprio WhatsApp, então o histórico do mesmo contato é separado por sessão.
 *
 * Schema em db/schema.sql: tabelas `conversations` (session_id + phone + deal_id)
 * e `messages` (uma linha por mensagem, com dedupe por wa_message_id).
 *
 * Todas as funções são assíncronas agora (antes eram síncronas, lendo um JSON
 * em disco) — todo código que chama isto precisa usar `await`.
 */

async function getOrCreateConversation(sessionId, phone, dealId, pushName) {
  const { rows } = await pool.query(
    `insert into conversations (session_id, phone, deal_id, push_name)
     values ($1, $2, $3, $4)
     on conflict (session_id, phone)
     do update set
       deal_id = coalesce($3, conversations.deal_id),
       push_name = coalesce($4, conversations.push_name),
       updated_at = now()
     returning id`,
    [sessionId, phone, dealId || null, pushName || null]
  );
  return rows[0].id;
}

// Retorna true se a mensagem foi de fato adicionada, false se já existia (mesmo
// `id` para essa conversa) — usado para não duplicar quando o WhatsApp ecoa de
// volta uma mensagem que nós mesmos já salvamos ao enviar (ver sendMessage/sendMedia).
async function addMessage(sessionId, phone, message, dealId, pushName) {
  const conversationId = await getOrCreateConversation(sessionId, phone, dealId, pushName);

  const { rowCount } = await pool.query(
    `insert into messages
       (conversation_id, wa_message_id, direction, type, text, media_url, mimetype, status, created_at, reply_to_id, file_name)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (conversation_id, wa_message_id) do nothing`,
    [
      conversationId,
      message.id,
      message.direction,
      message.type || 'text',
      message.text ?? null,
      message.mediaUrl ?? null,
      message.mimetype ?? null,
      message.status ?? null,
      message.createdAt,
      message.replyToId ?? null,
      message.fileName ?? null,
    ]
  );

  return rowCount > 0;
}

// Últimas 500 mensagens da conversa, em ordem cronológica (mais antiga primeiro).
async function getHistory(sessionId, phone) {
  const { rows } = await pool.query(
    `select * from (
       select
         m.wa_message_id as id,
         m.direction,
         m.type,
         m.text,
         m.media_url as "mediaUrl",
         m.mimetype,
         m.status,
         m.reaction,
         m.reaction_by as "reactionBy",
         m.reply_to_id as "replyToId",
         m.file_name as "fileName",
         m.created_at as "createdAt"
       from messages m
       join conversations c on c.id = m.conversation_id
       where c.session_id = $1 and c.phone = $2
       order by m.created_at desc
       limit 500
     ) recentes
     order by "createdAt" asc`,
    [sessionId, phone]
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

async function updateMessageStatus(sessionId, phone, messageId, status) {
  await pool.query(
    `update messages m set status = $1
     from conversations c
     where m.conversation_id = c.id
       and c.session_id = $2
       and c.phone = $3
       and m.wa_message_id = $4`,
    [status, sessionId, phone, messageId]
  );
}

// `emoji` vazio/null = reação removida (o WhatsApp manda reactionMessage com
// texto vazio quando alguém tira a própria reação). `direction` é quem reagiu
// ('in' = contato, 'out' = nosso lado, reagido direto do celular).
async function setMessageReaction(sessionId, phone, waMessageId, emoji, direction) {
  await pool.query(
    `update messages m set reaction = $1, reaction_by = $2
     from conversations c
     where m.conversation_id = c.id
       and c.session_id = $3
       and c.phone = $4
       and m.wa_message_id = $5`,
    [emoji || null, emoji ? direction : null, sessionId, phone, waMessageId]
  );
}

// Busca a mensagem original que está sendo citada, pra reconstruir o objeto
// "quoted" que o Baileys precisa ao enviar uma resposta (ver
// WhatsAppGateway.sendMessage/sendMedia em src/whatsapp.js).
async function getMessageForReply(sessionId, phone, waMessageId) {
  const { rows } = await pool.query(
    `select m.wa_message_id as id, m.direction, m.type, m.text
     from messages m
     join conversations c on c.id = m.conversation_id
     where c.session_id = $1 and c.phone = $2 and m.wa_message_id = $3
     limit 1`,
    [sessionId, phone, waMessageId]
  );
  return rows[0] || null;
}

async function setDealForPhone(sessionId, phone, dealId) {
  if (!phone || !dealId) return;
  await getOrCreateConversation(sessionId, phone, dealId);
}

async function getDealForPhone(sessionId, phone) {
  const { rows } = await pool.query(
    `select deal_id from conversations where session_id = $1 and phone = $2`,
    [sessionId, phone]
  );
  return rows[0]?.deal_id || null;
}

// Arquivar/desarquivar (tela Chat) — só organiza a lista (some da principal,
// aparece em "Arquivadas"); não afeta recebimento/envio. Só faz sentido numa
// conversa que já existe, por isso é um update direto (sem
// getOrCreateConversation).
async function setConversationArchived(sessionId, phone, archived) {
  await pool.query(
    `update conversations set archived = $1, updated_at = now() where session_id = $2 and phone = $3`,
    [archived, sessionId, phone]
  );
}

// Atribui (assignedTo preenchido) ou desatribui (null) o atendimento de uma
// conversa — ver POST /conversations/assign. `assignedToName` só faz
// sentido junto de um assignedTo; desatribuir sempre limpa os dois.
async function assignConversation(sessionId, phone, assignedTo, assignedToName) {
  await pool.query(
    `update conversations set assigned_to = $1, assigned_to_name = $2, updated_at = now()
     where session_id = $3 and phone = $4`,
    [assignedTo, assignedTo ? assignedToName : null, sessionId, phone]
  );
}

// "Resgata" uma conversa presa numa instância que caiu/desconectou (comum
// aqui — Baileys não é a API oficial, a sessão pode cair a qualquer
// momento) — troca o session_id da conversa pra outra instância do MESMO
// dono, sem perder mensagens/histórico (messages.conversation_id não muda,
// só o dono da conversa). Bloqueia se a instância de destino já tiver uma
// conversa própria com esse telefone (nunca faz merge automático — melhor
// falhar com um erro claro do que arriscar perder histórico de um dos
// dois lados).
async function moveConversationToInstance(oldSessionId, phone, newSessionId) {
  const { rows: clash } = await pool.query(
    `select id from conversations where session_id = $1 and phone = $2`,
    [newSessionId, phone]
  );
  if (clash.length) {
    throw new Error('essa instância já tem uma conversa própria com esse contato — continue por ela em vez de mover');
  }
  const { rowCount } = await pool.query(
    `update conversations set session_id = $1, updated_at = now() where session_id = $2 and phone = $3`,
    [newSessionId, oldSessionId, phone]
  );
  if (!rowCount) throw new Error('conversa não encontrada');
}

// Silenciar/dessilenciar notificações (tela Chat) — notifica por padrão;
// mesmo padrão de setConversationArchived acima.
async function setConversationNotifications(sessionId, phone, enabled) {
  await pool.query(
    `update conversations set notifications_enabled = $1, updated_at = now() where session_id = $2 and phone = $3`,
    [enabled, sessionId, phone]
  );
}

// Prefs mínimos pra decidir, ao chegar uma mensagem, se ela vira notificação
// persistida (ver onMessage em src/server.js) — devolve default (notifica,
// sem nome) se a conversa ainda nem existe.
async function getConversationNotifPrefs(sessionId, phone) {
  const { rows } = await pool.query(
    `select notifications_enabled as "notificationsEnabled", push_name as "pushName",
            assigned_to as "assignedTo"
     from conversations where session_id = $1 and phone = $2`,
    [sessionId, phone]
  );
  return rows[0] || { notificationsEnabled: true, pushName: null, assignedTo: null };
}

// Resumo da conversa gerado por IA (painel de detalhes do contato, tela
// Chat) — lido junto do histórico (GET /history) pra já vir pronto sem
// round-trip extra; `null` se nunca foi gerado. Guardado como JSON
// ({title, subtitle, summary}) na mesma coluna texto `ai_summary` — sem
// precisar de migração de schema. Resumos antigos (de antes desse formato
// estruturado, texto puro) viram {title: null, subtitle: null, summary: <texto>}.
function parseStoredSummary(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.summary) {
      return { title: parsed.title || null, subtitle: parsed.subtitle || null, summary: parsed.summary };
    }
  } catch {
    // não era JSON — formato antigo (texto puro), cai no fallback abaixo
  }
  return { title: null, subtitle: null, summary: raw };
}

async function getConversationSummary(sessionId, phone) {
  const { rows } = await pool.query(
    `select ai_summary as "aiSummary", ai_summary_updated_at as "aiSummaryUpdatedAt"
     from conversations where session_id = $1 and phone = $2`,
    [sessionId, phone]
  );
  const row = rows[0];
  if (!row) return { aiSummary: null, aiSummaryUpdatedAt: null };
  return {
    aiSummary: parseStoredSummary(row.aiSummary),
    aiSummaryUpdatedAt: row.aiSummaryUpdatedAt ? row.aiSummaryUpdatedAt.toISOString() : null,
  };
}

// Atualiza o resumo "atual" (lido por getConversationSummary) e, na mesma
// consulta, guarda essa versão na tabela de histórico (conversation_summaries)
// — o resumo agora se regenera sozinho conforme a conversa continua (ver
// generateConversationSummary em chat.html), então isso vira um registro de
// como o caso foi evoluindo ao longo do atendimento, não só o snapshot mais
// recente.
async function setConversationSummary(sessionId, phone, { title, subtitle, summary }) {
  await pool.query(
    `with updated as (
       update conversations set ai_summary = $1, ai_summary_updated_at = now()
       where session_id = $2 and phone = $3
       returning id
     )
     insert into conversation_summaries (conversation_id, title, subtitle, summary)
     select id, $4, $5, $6 from updated`,
    [JSON.stringify({ title, subtitle, summary }), sessionId, phone, title || null, subtitle || null, summary]
  );
}

// Histórico persistido de notificações (db/schema.sql, tabela `notifications`)
// — por dono do Bitrix, não por instância. `target` é
// {sessionId, phone, contactName}, usado pra navegar ao clicar num card.
async function addNotification({ ownerId, title, body, target }) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await pool.query(
    `insert into notifications (id, owner_id, title, body, target) values ($1, $2, $3, $4, $5)`,
    [id, ownerId, title, body ?? null, target ? JSON.stringify(target) : null]
  );
  return { id, ownerId, title, body: body ?? null, target: target ?? null, read: false };
}

// Mais recentes primeiro; limit alto (não paginado ainda) — ver HANDOFF.
async function listNotifications(ownerId) {
  const { rows } = await pool.query(
    `select id, title, body, target, read, created_at as "createdAt"
     from notifications where owner_id = $1 order by created_at desc limit 500`,
    [ownerId]
  );
  return rows;
}

async function countUnreadNotifications(ownerId) {
  const { rows } = await pool.query(
    `select count(*)::int as count from notifications where owner_id = $1 and read = false`,
    [ownerId]
  );
  return rows[0].count;
}

// Dono de uma notificação por id — usado por requireResourceOwner (src/authz.js)
// pra conferir posse antes de marcar como lida.
async function getNotificationOwner(id) {
  const { rows } = await pool.query(`select owner_id as "ownerId" from notifications where id = $1`, [id]);
  return rows[0] ? rows[0].ownerId : null;
}

async function markNotificationRead(id, read) {
  await pool.query(`update notifications set read = $1 where id = $2`, [read, id]);
}

async function markAllNotificationsRead(ownerId) {
  await pool.query(`update notifications set read = true where owner_id = $1 and read = false`, [ownerId]);
}

// Marca como lidas todas as notificações de UMA conversa (sessionId+phone) —
// chamado ao abrir a conversa no Chat (ver POST /conversations/mark-read),
// pra sumir o indicador de não lida na lista sem precisar ir na Central de
// Notificações. Mesmo casamento por target->>'sessionId'/'phone' usado em
// listConversations (unreadCount).
async function markNotificationsReadForConversation(sessionId, phone) {
  await pool.query(
    `update notifications set read = true
     where read = false and target->>'sessionId' = $1 and target->>'phone' = $2`,
    [sessionId, phone]
  );
}

// Devolve tudo (todas as sessões/conversas/mensagens), no mesmo formato que o
// antigo JSON tinha: { [sessionId]: { [phone]: { dealId, messages: [] } } }.
// Usado só pelo dashboard de métricas (src/metrics.js) — mantém o formato
// antigo pra não precisar reescrever o cálculo de métricas inteiro.
// `sessionIds`: escopo obrigatório de instâncias (ver computeMetrics em
// src/metrics.js) — sem isso, qualquer usuário autenticado veria as
// conversas de TODOS os donos no dashboard (bug de isolamento corrigido em
// 2026-07-09, ver Parte AQ do HANDOFF).
async function getAll(sessionIds) {
  const { rows } = await pool.query(
    `select
       c.session_id, c.phone, c.deal_id,
       m.wa_message_id as id, m.direction, m.type, m.text,
       m.media_url as "mediaUrl", m.mimetype, m.status, m.created_at as "createdAt"
     from conversations c
     left join messages m on m.conversation_id = c.id
     where c.session_id = any($1::text[])
     order by c.session_id, c.phone, m.created_at asc`,
    [sessionIds]
  );

  const db = {};
  for (const row of rows) {
    if (!db[row.session_id]) db[row.session_id] = {};
    if (!db[row.session_id][row.phone]) {
      db[row.session_id][row.phone] = { dealId: row.deal_id, messages: [] };
    }
    if (row.id) {
      db[row.session_id][row.phone].messages.push({
        id: row.id,
        direction: row.direction,
        type: row.type,
        text: row.text,
        mediaUrl: row.mediaUrl,
        mimetype: row.mimetype,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      });
    }
  }
  return db;
}

// Lista as conversas de uma ou mais sessões (instâncias), mais recente
// primeiro, para a tela Chat (public/chat.html) — nome do contato (se
// cadastrado em `contacts`), prévia da última mensagem e tags aplicadas.
// `search` (opcional) filtra por nome ou telefone.
async function listConversations(sessionIds, search, { archived = false } = {}) {
  const term = (search || '').trim();
  const params = [sessionIds, archived];
  let searchClause = '';
  if (term) {
    params.push(`%${term}%`);
    searchClause = `and (c.phone ilike $3 or ct.name ilike $3 or c.push_name ilike $3)`;
  }

  const { rows } = await pool.query(
    `select
       c.id as conversation_id,
       c.session_id as "sessionId",
       c.phone,
       c.deal_id as "dealId",
       coalesce(ct.name, c.push_name) as "contactName",
       c.avatar_url as "avatarUrl",
       c.notifications_enabled as "notificationsEnabled",
       lm.text as "lastText",
       lm.type as "lastType",
       lm.direction as "lastDirection",
       coalesce(lm.created_at, c.updated_at) as "lastAt",
       coalesce(tg.tags, '[]'::json) as tags,
       coalesce(un.count, 0)::int as "unreadCount",
       c.assigned_to as "assignedTo",
       c.assigned_to_name as "assignedToName"
     from conversations c
     left join instances i on i.id = c.session_id
     left join contacts ct on ct.owner_id = coalesce(i.owner_id, c.session_id) and ct.phone = c.phone
     left join lateral (
       select text, type, direction, created_at
       from messages m
       where m.conversation_id = c.id
       order by m.created_at desc
       limit 1
     ) lm on true
     left join lateral (
       select json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color, 'fixed', t.fixed) order by t.name) as tags
       from conversation_tags ctag
       join tags t on t.id = ctag.tag_id
       where ctag.conversation_id = c.id
     ) tg on true
     left join lateral (
       select count(*)::int as count
       from notifications n
       where n.read = false
         and n.target->>'sessionId' = c.session_id
         and n.target->>'phone' = c.phone
     ) un on true
     where c.session_id = any($1::text[]) and c.archived = $2
     ${searchClause}
     order by "lastAt" desc
     limit 200`,
    params
  );

  // Tag automática "Interno"/"Externo" — mesmo critério do dashboard de
  // métricas (ver src/metrics.js): "interno" quando o contato do outro lado
  // é, na verdade, o WhatsApp de OUTRO usuário do Bitrix (teste entre
  // colegas), não um cliente/lead de fora. Não é uma tag de verdade (não fica
  // em `tags`/`conversation_tags`) — é calculada na hora e não pode ser
  // removida pelo atendente.
  const ownNumbers = new Set(Object.values(getOwnNumbersBySession()));

  return rows.map((r) => {
    const isInternal = ownNumbers.has(r.phone);
    const originTag = {
      id: isInternal ? 'origin:interna' : 'origin:externa',
      name: isInternal ? 'Interno' : 'Externo',
      color: isInternal ? '#5b8dd8' : '#4caf6e',
      system: true,
    };
    return { ...r, lastAt: r.lastAt.toISOString(), tags: [originTag, ...r.tags] };
  });
}

async function listTags(sessionIds) {
  const { rows } = await pool.query(
    `select id, session_id as "sessionId", name, color, fixed
     from tags
     where session_id = any($1::text[])
     order by name`,
    [sessionIds]
  );
  return rows;
}

// `fixed`: true pra tags aplicadas automaticamente pelo sistema (ex: nome da
// LP de origem do lead, ver src/routes/leads.js) — sem botão de remover no
// Chat (ver tagChip() em public/chat.html). "fixed or excluded.fixed" no
// conflict: uma vez marcada fixa, continua fixa mesmo se chamada de novo
// sem o parâmetro (nunca "desmarca" por acidente).
async function createTag(sessionId, name, color, fixed) {
  const { rows } = await pool.query(
    `insert into tags (session_id, name, color, fixed)
     values ($1, $2, coalesce($3, '#d8ab4f'), coalesce($4, false))
     on conflict (session_id, name) do update set name = tags.name, fixed = tags.fixed or excluded.fixed
     returning id, session_id as "sessionId", name, color, fixed`,
    [sessionId, name, color || null, !!fixed]
  );
  return rows[0];
}

async function deleteTag(sessionId, tagId) {
  await pool.query(`delete from tags where id = $1 and session_id = $2`, [tagId, sessionId]);
}

async function addTagToConversation(sessionId, phone, tagId) {
  const conversationId = await getOrCreateConversation(sessionId, phone);
  await pool.query(
    `insert into conversation_tags (conversation_id, tag_id)
     select $1, id from tags where id = $2 and session_id = $3
     on conflict do nothing`,
    [conversationId, tagId, sessionId]
  );
}

async function removeTagFromConversation(sessionId, phone, tagId) {
  await pool.query(
    `delete from conversation_tags
     using conversations c
     where conversation_tags.conversation_id = c.id
       and c.session_id = $1 and c.phone = $2
       and conversation_tags.tag_id = $3`,
    [sessionId, phone, tagId]
  );
}

// Foto de perfil cacheada (ver GET /api/whatsapp/avatar) — evita consultar a
// API do WhatsApp de novo pra cada contato toda vez que a lista carrega.
async function getAvatarUrl(sessionId, phone) {
  const { rows } = await pool.query(
    `select avatar_url from conversations where session_id = $1 and phone = $2`,
    [sessionId, phone]
  );
  return rows[0]?.avatar_url || null;
}

async function setAvatarUrl(sessionId, phone, url) {
  await getOrCreateConversation(sessionId, phone);
  await pool.query(
    `update conversations set avatar_url = $1 where session_id = $2 and phone = $3`,
    [url || null, sessionId, phone]
  );
}

// ---------------------------------------------------------------
// Grupos de WhatsApp (ver src/whatsapp.js — WhatsAppGateway.createGroup).
// ---------------------------------------------------------------
async function createGroupRecord(id, sessionId, name, participantCount) {
  await pool.query(
    `insert into wa_groups (id, session_id, name, participant_count)
     values ($1, $2, $3, $4)
     on conflict (id) do update set name = $3, participant_count = $4`,
    [id, sessionId, name, participantCount]
  );
}

async function listGroups(sessionIds) {
  const { rows } = await pool.query(
    `select id, session_id as "sessionId", name, participant_count as "participantCount", created_at as "createdAt"
     from wa_groups
     where session_id = any($1::text[])
     order by created_at desc`,
    [sessionIds]
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

module.exports = {
  addMessage,
  getHistory,
  updateMessageStatus,
  setMessageReaction,
  getMessageForReply,
  setDealForPhone,
  getDealForPhone,
  setConversationArchived,
  assignConversation,
  moveConversationToInstance,
  setConversationNotifications,
  getConversationNotifPrefs,
  getConversationSummary,
  setConversationSummary,
  addNotification,
  listNotifications,
  countUnreadNotifications,
  getNotificationOwner,
  markNotificationRead,
  markAllNotificationsRead,
  markNotificationsReadForConversation,
  getAll,
  listConversations,
  listTags,
  createTag,
  deleteTag,
  addTagToConversation,
  removeTagFromConversation,
  getAvatarUrl,
  setAvatarUrl,
  createGroupRecord,
  listGroups,
};
