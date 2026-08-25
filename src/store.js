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
       (conversation_id, wa_message_id, direction, type, text, media_url, mimetype, status, created_at, reply_to_id, file_name, sent_by, sent_by_name, group_sender_phone, group_sender_name)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
      message.sentBy ?? null,
      message.sentByName ?? null,
      // Só preenchido em mensagem 'in' de grupo de card (quem mandou DENTRO
      // do grupo, não a conversa em si — ver bypass em whatsapp.js e
      // db/schema.sql). DM nunca preenche isso.
      message.groupSenderPhone ?? null,
      message.groupSenderName ?? null,
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
         m.sent_by as "sentBy",
         m.sent_by_name as "sentByName",
         m.group_sender_phone as "groupSenderPhone",
         m.group_sender_name as "groupSenderName",
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
//
// Também mantém conversation_assignment_history (ver Painel de
// atendimento, chat.html): fecha o período vigente (se houver) e abre um
// novo se `assignedTo` não for null — é o que permite calcular métricas
// por atendente (tempo de resposta, volume) sem atribuir o histórico
// inteiro da conversa a quem só pegou ela hoje. `ownerId` é sempre o dono
// real da instância (resolvido pela rota via instancesStore.get), não o
// atendente — grava certo mesmo quando quem está atendendo é um delegado.
async function assignConversation(sessionId, phone, assignedTo, assignedToName, ownerId) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `update conversations set assigned_to = $1, assigned_to_name = $2, updated_at = now()
       where session_id = $3 and phone = $4
       returning id`,
      [assignedTo, assignedTo ? assignedToName : null, sessionId, phone]
    );
    const conversationId = rows[0]?.id;
    if (conversationId) {
      await client.query(
        `update conversation_assignment_history set ended_at = now()
         where conversation_id = $1 and ended_at is null`,
        [conversationId]
      );
      if (assignedTo) {
        await client.query(
          `insert into conversation_assignment_history (conversation_id, owner_id, assigned_to, assigned_to_name)
           values ($1, $2, $3, $4)`,
          [conversationId, ownerId, assignedTo, assignedToName || null]
        );
      }
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
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
async function setConversationSummary(sessionId, phone, { title, subtitle, summary, tokensUsed }) {
  await pool.query(
    `with updated as (
       update conversations set ai_summary = $1, ai_summary_updated_at = now()
       where session_id = $2 and phone = $3
       returning id
     )
     insert into conversation_summaries (conversation_id, title, subtitle, summary, tokens_used)
     select id, $4, $5, $6, $7 from updated`,
    [JSON.stringify({ title, subtitle, summary }), sessionId, phone, title || null, subtitle || null, summary, tokensUsed ?? null]
  );
}

// Todo resumo já gerado pra essa conversa (não só o atual, ver
// getConversationSummary acima) — ordem cronológica REVERSA (mais recente
// primeiro), já que quem consome isso quer ver "como o caso evoluiu" a
// partir de agora, olhando pra trás. `conversation_summaries` já é
// alimentada automaticamente por setConversationSummary, uma linha por
// geração — sem migração de dado antigo (o histórico só existe a partir
// de quando essa tabela foi criada; resumos gerados antes disso não
// deixaram rastro além do snapshot único que já havia em ai_summary).
async function listConversationSummaryHistory(sessionId, phone) {
  const { rows } = await pool.query(
    `select cs.title, cs.subtitle, cs.summary, cs.tokens_used as "tokensUsed", cs.created_at as "createdAt"
     from conversation_summaries cs
     join conversations c on c.id = cs.conversation_id
     where c.session_id = $1 and c.phone = $2
     order by cs.created_at desc`,
    [sessionId, phone]
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
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

// Só as N mais recentes NÃO LIDAS — pro toast em tempo real (HANDOFF Parte
// DG), reaproveitando o heartbeat de 30s que já roda em toda tela. O
// frontend decide o que é "novo" comparando IDs (não timestamp — nunca
// comparar relógio do client com o do servidor, mesma regra já seguida em
// outras partes desta base de código), então esta query só precisa
// devolver uma amostra pequena e recente, não todo o histórico.
async function listLatestUnreadNotifications(ownerId, limit = 5) {
  const { rows } = await pool.query(
    `select id, title, body, target, created_at as "createdAt"
     from notifications where owner_id = $1 and read = false
     order by created_at desc limit $2`,
    [ownerId, limit]
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

// Dados-base pro Painel de atendimento (chat.html) — períodos de
// atribuição (conversation_assignment_history) de todas as sessões
// pedidas, cada um já trazendo as próprias mensagens (só as que caem
// dentro do período, via filtro de created_at entre started_at/ended_at)
// pra computeTeamMetrics (src/metrics.js) calcular volume/tempo de
// resposta por atendente sem atribuir o histórico inteiro da conversa a
// quem só pegou ela hoje. `ended_at is null` (período ainda vigente) usa
// `now()` como fim só pro filtro de mensagens, sem alterar a tabela.
async function getAssignmentPeriods(sessionIds) {
  const { rows } = await pool.query(
    `select
       h.id as "periodId", h.conversation_id as "conversationId", h.owner_id as "ownerId",
       h.assigned_to as "assignedTo", h.assigned_to_name as "assignedToName",
       h.started_at as "startedAt", h.ended_at as "endedAt",
       c.session_id as "sessionId", c.phone
     from conversation_assignment_history h
     join conversations c on c.id = h.conversation_id
     where c.session_id = any($1::text[])
     order by h.started_at asc`,
    [sessionIds]
  );
  if (!rows.length) return [];

  const conversationIds = [...new Set(rows.map((r) => r.conversationId))];
  const { rows: msgRows } = await pool.query(
    `select conversation_id as "conversationId", direction, created_at as "createdAt"
     from messages
     where conversation_id = any($1::bigint[])
     order by conversation_id, created_at asc`,
    [conversationIds]
  );
  const messagesByConv = new Map();
  for (const m of msgRows) {
    if (!messagesByConv.has(m.conversationId)) messagesByConv.set(m.conversationId, []);
    messagesByConv.get(m.conversationId).push({ direction: m.direction, at: m.createdAt.getTime() });
  }

  return rows.map((r) => {
    const startMs = r.startedAt.getTime();
    // período ainda vigente (ended_at null) não tem fim de verdade — não usa
    // Date.now() aqui (relógio do processo Node) porque pode ficar
    // dessincronizado em segundos com o relógio do Postgres/Supabase que
    // gerou started_at, e ficar "no passado" em relação a ele derrubava
    // TODA mensagem do período pro filtro (bug real encontrado testando
    // isto contra produção — nunca comparar timestamp de dois relógios
    // diferentes). Sem endedAt, aceita qualquer mensagem >= startMs.
    const endMs = r.endedAt ? r.endedAt.getTime() : null;
    const allMsgs = messagesByConv.get(r.conversationId) || [];
    const messages = allMsgs.filter((m) => m.at >= startMs && (endMs === null || m.at < endMs));
    return {
      periodId: r.periodId,
      conversationId: r.conversationId,
      ownerId: r.ownerId,
      assignedTo: r.assignedTo,
      assignedToName: r.assignedToName,
      sessionId: r.sessionId,
      phone: r.phone,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
      messages,
    };
  });
}

// Métricas de uso "de verdade" por pessoa, pro Admin (tela Usuários, ver
// HANDOFF Parte CZ) — diferente de getAssignmentPeriods (escopado a
// sessionIds específicos, carrega mensagens inteiras em memória, pensado
// pro Painel de atendimento de UM time), aqui é agregação SQL pura, SEM
// escopo de sessionIds (o Admin precisa ver TODO o universo de
// funcionários, não só quem tem acesso a alguma instância).
//
// Mensagens enviadas: junta conversation_assignment_history com messages
// por período (mesma lógica de "quem estava atendendo quando a mensagem
// foi enviada" já usada em getAssignmentPeriods, só que em SQL em vez de
// JS) — não é só "quem é o dono da conversa hoje", é o histórico real de
// quem atendeu cada trecho.
//
// Contatos/campanhas: contatos já é por owner_id direto (ver
// src/contacts.js, migração documentada lá). Campanhas é por session_id
// (INSTÂNCIA, não pessoa) — sem registro de quem de fato criou, só a
// instância; aproximado atribuindo ao DONO da instância via join com
// `instances` (usuário confirmado aceitar essa aproximação, HANDOFF Parte
// CZ — pode distorcer se um delegado criar numa instância de outra
// pessoa, caso raro).
async function getUsabilityStatsByOwner(sinceDate) {
  const [messagesSent, contactCounts, campaignCounts] = await Promise.all([
    pool.query(
      `select h.assigned_to as "ownerId", count(*)::int as sent
       from conversation_assignment_history h
       join messages m on m.conversation_id = h.conversation_id
         and m.direction = 'out'
         and m.created_at >= h.started_at
         and m.created_at < coalesce(h.ended_at, now())
         and m.created_at >= $1
       group by h.assigned_to`,
      [sinceDate]
    ),
    pool.query(`select owner_id as "ownerId", count(*)::int as total from contacts group by owner_id`),
    pool.query(
      `select i.owner_id as "ownerId", count(*)::int as total
       from campaigns c
       join instances i on i.id = c.session_id
       group by i.owner_id`
    ),
  ]);

  const byOwner = new Map();
  const ensure = (ownerId) => {
    if (!byOwner.has(ownerId)) byOwner.set(ownerId, { messagesSent: 0, contactsTotal: 0, campaignsTotal: 0 });
    return byOwner.get(ownerId);
  };
  for (const r of messagesSent.rows) ensure(r.ownerId).messagesSent = r.sent;
  for (const r of contactCounts.rows) ensure(r.ownerId).contactsTotal = r.total;
  for (const r of campaignCounts.rows) ensure(r.ownerId).campaignsTotal = r.total;
  return byOwner;
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
// `opts.source`/`opts.dealId` são novos e opcionais (default preserva o
// comportamento de sempre — grupo "manual", sem negócio associado) — usados
// pela feature de "Criar grupo" do card (src/routes/cardGroup.js), que passa
// { source: 'card', dealId }. POST /groups (tela Contatos/Chat) continua
// chamando sem o 3º argumento, sem nenhuma mudança de comportamento.
async function createGroupRecord(id, sessionId, name, participantCount, opts = {}) {
  const { source = 'manual', dealId = null } = opts;
  await pool.query(
    `insert into wa_groups (id, session_id, name, participant_count, source, deal_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (id) do update set name = $3, participant_count = $4, source = $5, deal_id = $6`,
    [id, sessionId, name, participantCount, source, dealId]
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

// Grupo de card já criado pra este negócio, se houver — alimenta o switch
// "Cliente"/"Grupo" na aba do card (GET /api/card-group) decidir se mostra
// a opção "Grupo". `sessionIds` é a lista de instâncias do dono autenticado
// (mesmo padrão de posse do resto do app, nunca busca fora disso).
async function getCardGroupForDeal(sessionIds, dealId) {
  const { rows } = await pool.query(
    `select id, session_id as "sessionId", name, participant_count as "participantCount", created_at as "createdAt"
     from wa_groups
     where session_id = any($1::text[]) and deal_id = $2 and source = 'card'
     limit 1`,
    [sessionIds, dealId]
  );
  if (!rows.length) return null;
  return { ...rows[0], createdAt: rows[0].createdAt.toISOString() };
}

// Direção oposta de getCardGroupForDeal (que busca "o grupo deste
// negócio") — aqui já se tem o JID do grupo (é o "phone" de uma mensagem
// recebida de grupo de card, ver src/server.js onMessage) e se precisa do
// negócio dele, pra logar na timeline/gerar dealId corretamente (nunca via
// getDealForPhone, que é por telefone de CLIENTE — um JID de grupo nunca
// teria linha lá com esse sentido).
async function getDealForGroup(groupId) {
  const { rows } = await pool.query(`select deal_id from wa_groups where id = $1`, [groupId]);
  return rows[0]?.deal_id || null;
}

// Usado pelo bypass condicional em src/whatsapp.js (WhatsAppGateway,
// injetado via construtor — ver src/sessions.js/src/server.js) — decide se
// uma mensagem recebida de um JID de grupo deve ser processada/salva
// (source='card') ou descartada por completo, como qualquer outro grupo
// (comportamento padrão desde antes desta feature, decisão deliberada do
// usuário — ver comentário em whatsapp.js).
async function isCardGroupId(groupId) {
  const { rows } = await pool.query(
    `select 1 from wa_groups where id = $1 and source = 'card' limit 1`,
    [groupId]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------
// Nota interna — visível SÓ para internos, NUNCA enviada ao WhatsApp nem
// exposta pelas rotas normais de histórico (ver db/schema.sql,
// src/routes/internalNotes.js). Serve conversa 1-a-1 e grupo-com-cliente
// igualmente — ambos já são linhas de `conversations`.
// ---------------------------------------------------------------
async function listInternalNotes(sessionId, phone) {
  const { rows } = await pool.query(
    `select n.id, n.text, n.author_owner_id as "authorOwnerId", n.author_name as "authorName", n.created_at as "createdAt"
     from internal_notes n
     join conversations c on c.id = n.conversation_id
     where c.session_id = $1 and c.phone = $2
     order by n.created_at asc`,
    [sessionId, phone]
  );
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

async function addInternalNote(sessionId, phone, { text, authorOwnerId, authorName }) {
  const conversationId = await getOrCreateConversation(sessionId, phone, null, null);
  const { rows } = await pool.query(
    `insert into internal_notes (conversation_id, text, author_owner_id, author_name)
     values ($1, $2, $3, $4)
     returning id, created_at as "createdAt"`,
    [conversationId, text, authorOwnerId, authorName || null]
  );
  return { id: rows[0].id, text, authorOwnerId, authorName: authorName || null, createdAt: rows[0].createdAt.toISOString() };
}

// "Esse telefone já me respondeu alguma vez de verdade?" — usado antes de
// disparar uma campanha (ver POST /campaign/classify-recipients) pra
// avisar o risco de erro 463 do WhatsApp ("account restricted or missing
// tctoken" — exige token de privacidade antes de deixar iniciar conversa
// NOVA com quem nunca respondeu; conversas com histórico de resposta real
// não são afetadas). Telefones sem NENHUMA conversation (contato 100% novo,
// nunca trocou mensagem em nenhuma direção) simplesmente não aparecem no
// resultado — quem chama trata a ausência como hasReplied:false.
async function classifyRecipients(sessionId, phones) {
  const { rows } = await pool.query(
    `select c.phone,
            exists(select 1 from messages m where m.conversation_id = c.id and m.direction = 'in') as "hasReplied"
     from conversations c
     where c.session_id = $1 and c.phone = any($2::text[])`,
    [sessionId, phones]
  );
  return rows;
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
  getAssignmentPeriods,
  getUsabilityStatsByOwner,
  moveConversationToInstance,
  setConversationNotifications,
  getConversationNotifPrefs,
  getConversationSummary,
  setConversationSummary,
  listConversationSummaryHistory,
  addNotification,
  listNotifications,
  listLatestUnreadNotifications,
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
  getCardGroupForDeal,
  getDealForGroup,
  isCardGroupId,
  listInternalNotes,
  addInternalNote,
  classifyRecipients,
};
