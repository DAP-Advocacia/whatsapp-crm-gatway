-- Schema do gateway WhatsApp <-> Bitrix24.
-- Substitui data/messages.json (ver src/store.js). Rodar uma vez via
-- `node db/migrate.js` (usa DIRECT_URL, a conexão de sessão do Supabase).

create table if not exists conversations (
  id bigserial primary key,
  session_id text not null,
  phone text not null,
  deal_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, phone)
);

-- `push_name`: nome que o próprio contato definiu no WhatsApp dele — chega
-- sozinho em toda mensagem recebida (ver src/whatsapp.js), sem precisar
-- cadastro manual. `avatar_url`: foto de perfil do WhatsApp, buscada sob
-- demanda (GET /api/whatsapp/avatar) e cacheada aqui porque a consulta na
-- API do WhatsApp é lenta pra fazer pra cada conversa toda vez.
alter table conversations add column if not exists push_name text;
alter table conversations add column if not exists avatar_url text;

-- Arquivamento manual (tela Chat) — some da lista principal, mas continua
-- acessível na aba "Arquivadas"; mensagem nova NÃO desarquiva sozinha.
alter table conversations add column if not exists archived boolean not null default false;

-- Silenciar notificações por conversa (tela Chat) — notifica por padrão;
-- silenciar é exceção manual, como no próprio WhatsApp.
alter table conversations add column if not exists notifications_enabled boolean not null default true;

-- Atribuição de atendimento (ver instance_delegates acima) — null significa
-- não atribuída (visível/atendível por qualquer um com acesso à instância:
-- dono + delegados). `assigned_to_name` evita ter que resolver o nome do
-- usuário do Bitrix de novo toda vez que a lista de conversas é montada.
alter table conversations add column if not exists assigned_to text;
alter table conversations add column if not exists assigned_to_name text;

-- Resumo da conversa gerado sob demanda por IA (botão no painel de detalhes
-- do contato, tela Chat) — persistido pra não precisar gerar de novo toda
-- vez que o painel é aberto; `ai_summary_updated_at` mostra quando foi
-- gerado, pra o usuário saber se está desatualizado.
alter table conversations add column if not exists ai_summary text;
alter table conversations add column if not exists ai_summary_updated_at timestamptz;

-- Histórico de todo resumo já gerado pra essa conversa (não só o atual,
-- guardado acima em conversations.ai_summary) — o resumo agora se atualiza
-- sozinho conforme a conversa continua (ver generateConversationSummary em
-- chat.html), então essa tabela vira um registro de como o caso foi
-- evoluindo, não só o snapshot mais recente.
create table if not exists conversation_summaries (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  title text,
  subtitle text,
  summary text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_conversation_summaries_conversation
  on conversation_summaries (conversation_id, created_at);

-- Tokens gastos (prompt+completion) na geração deste resumo — só
-- disponível a partir de quando esta coluna foi criada (2026-08-25); a
-- OpenAI devolve essa contagem só NA hora da chamada, nunca depois, então
-- as ~1800 linhas já existentes ANTES desta coluna ficam null pra sempre,
-- sem forma de recuperar retroativamente (decisão confirmada com o
-- usuário). Nulo = "não medido" — nunca 0 de verdade.
alter table conversation_summaries add column if not exists tokens_used int;

create table if not exists messages (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  wa_message_id text not null,
  direction text not null check (direction in ('in', 'out')),
  type text not null default 'text',
  text text,
  media_url text,
  mimetype text,
  status text,
  created_at timestamptz not null default now(),
  unique (conversation_id, wa_message_id)
);

create index if not exists idx_messages_conversation_created
  on messages (conversation_id, created_at);

-- Emoji da reação mais recente na mensagem (WhatsApp só mostra uma reação por
-- pessoa) e quem reagiu — 'in' (contato) ou 'out' (nosso lado, reagido pelo
-- celular). Ver src/whatsapp.js (evento 'reaction') e store.setMessageReaction.
alter table messages add column if not exists reaction text;
alter table messages add column if not exists reaction_by text check (reaction_by in ('in', 'out'));

-- Id (wa_message_id) da mensagem citada, quando esta é uma resposta ("reply")
-- a outra — tanto enviada pelo atendente quanto recebida do contato. Ver
-- src/whatsapp.js (_extractReplyToId / sendMessage·sendMedia) e store.js.
alter table messages add column if not exists reply_to_id text;

-- Nome original do arquivo, só preenchido pra type='document' (PDF, PPT,
-- DOCX etc. — anexo genérico, diferente de imagem/áudio/vídeo que o
-- WhatsApp já entrega/renderiza como mídia embutida). Ver sendMedia em
-- src/whatsapp.js e a rota POST /send-media.
alter table messages add column if not exists file_name text;

-- Quem enviou esta mensagem (só faz sentido pra direction='out') — o
-- OWNER_ID de quem apertou "enviar", capturado no momento do envio
-- (POST /send / /send-media), não inferido depois. Sem isso não havia
-- como mostrar avatar/nome do atendente na bolha nem detectar troca de
-- atendente entre mensagens consecutivas na mesma conversa (ver Painel
-- de atendimento, chat.html). `sent_by_name` cacheia o nome pra exibir
-- sem round-trip ao Bitrix, mesmo padrão de conversations.assigned_to_name.
-- Mensagens enviadas ANTES desta coluna existir ficam null pra sempre —
-- não há como recuperar quem enviou no passado, só a partir de agora.
alter table messages add column if not exists sent_by text;
alter table messages add column if not exists sent_by_name text;

create index if not exists idx_conversations_session
  on conversations (session_id);

-- Contatos "próprios" do gateway (independentes de já ter conversa/negócio),
-- usados pra montar listas personalizadas de disparo em massa (Campanha).
create table if not exists contacts (
  id bigserial primary key,
  session_id text not null,
  name text,
  phone text not null,
  deal_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, phone)
);

create table if not exists contact_lists (
  id bigserial primary key,
  session_id text not null,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists contact_list_members (
  list_id bigint not null references contact_lists(id) on delete cascade,
  contact_id bigint not null references contacts(id) on delete cascade,
  primary key (list_id, contact_id)
);

-- Modelos de mensagem reutilizáveis na Campanha (corpo pode usar {{nome}} e
-- {{telefone}}, substituídos por destinatário no momento do envio).
create table if not exists message_templates (
  id bigserial primary key,
  session_id text not null,
  name text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_templates_session on message_templates (session_id);

-- Histórico de campanhas (disparo em massa) — o progresso "ao vivo" de uma
-- campanha em andamento continua em memória (ver src/campaigns.js), mas cada
-- campanha e cada envio individual também são gravados aqui pra alimentar o
-- dashboard de métricas (public/campaign-metrics.html).
create table if not exists campaigns (
  id text primary key,
  session_id text not null,
  name text,
  total int not null,
  sent int not null default 0,
  failed int not null default 0,
  status text not null default 'running' check (status in ('running', 'done')),
  has_media boolean not null default false,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists campaign_results (
  id bigserial primary key,
  campaign_id text not null references campaigns(id) on delete cascade,
  phone text not null,
  ok boolean not null,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_campaigns_session on campaigns (session_id);
create index if not exists idx_campaigns_created on campaigns (created_at);
create index if not exists idx_campaign_results_campaign on campaign_results (campaign_id);

-- Campanhas agendadas pra disparo futuro (Kanban/Calendário em
-- public/campaign-schedule.html). Guarda o payload inteiro (destinatários,
-- texto, mídia em base64) porque, diferente de `campaigns`, ainda não existe
-- nenhuma mensagem enviada de fato — só quando o agendamento "vira" um envio
-- real é que uma linha em `campaigns` é criada e linkada via campaign_id.
create table if not exists scheduled_campaigns (
  id text primary key,
  session_id text not null,
  name text,
  recipients jsonb not null,
  template text not null,
  media_type text,
  media_mimetype text,
  media_base64 text,
  media_url text,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'sending', 'sent', 'canceled')),
  campaign_id text references campaigns(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_scheduled_campaigns_status_time on scheduled_campaigns (status, scheduled_at);
create index if not exists idx_scheduled_campaigns_session on scheduled_campaigns (session_id);

-- Mídia de agendamento pendente sobe pro Storage na hora de agendar (em vez
-- de ficar como base64 na própria linha) — só o caminho fica salvo aqui.
-- `media_base64` continua existindo pra agendamentos criados antes desta
-- coluna existir (src/scheduler.js lê os dois, dando preferência a media_url).
alter table scheduled_campaigns add column if not exists media_url text;

-- Um usuário do Bitrix (owner_id = member_id + id do usuário, igual ao
-- session_id de antes) pode conectar mais de um número de WhatsApp. Cada
-- número é uma "instância" — o `id` dela é o que continua sendo usado como
-- `session_id` em todas as tabelas acima (conversations, campaigns, etc), e
-- também como nome da pasta de credenciais em auth_session/<id>. Por
-- compatibilidade, a primeira instância de cada owner usa id = owner_id (os
-- dados já existentes de antes desta tabela continuam válidos sem migração).
create table if not exists instances (
  id text primary key,
  owner_id text not null,
  label text not null default 'Principal',
  created_at timestamptz not null default now()
);

create index if not exists idx_instances_owner on instances (owner_id);

-- Delegação de acesso: o dono de uma instância compartilha ela com outros
-- usuários do Bitrix (ex: gerente delegando pros próprios funcionários),
-- sem contar contra o limite de instâncias de quem recebe (ver
-- MAX_INSTANCES_PER_OWNER em src/routes/whatsapp.js — só usa listByOwner,
-- não listAccessible). `delegate_name` é capturado na hora de conceder (via
-- BX24.callMethod('user.search') no frontend) pra exibir sem precisar de um
-- diretório de usuários próprio no banco.
create table if not exists instance_delegates (
  instance_id text not null references instances(id) on delete cascade,
  delegate_owner_id text not null,
  delegate_name text,
  created_at timestamptz not null default now(),
  unique (instance_id, delegate_owner_id)
);

create index if not exists idx_instance_delegates_delegate on instance_delegates (delegate_owner_id);

-- Delegação AUTOMÁTICA via hierarquia do Bitrix (departamento/gestor) — em
-- vez de um gerente precisar compartilhar manualmente cada instância com
-- cada funcionário (instance_delegates acima), o gestor de um departamento
-- já enxerga automaticamente as instâncias de todo mundo abaixo dele na
-- árvore (cascateando sub-departamentos). Resolvido via department.get +
-- user.get (webhook dedicado BITRIX_HR_WEBHOOK_URL, ver src/bitrixHierarchy.js)
-- e cacheado aqui — consultar o Bitrix a cada request seria lento e
-- arriscaria rate limit. `manager_owner_id` é sempre o gestor (member_id_userId
-- do dono do departamento), `subordinate_owner_id` cada pessoa abaixo dele na
-- árvore (direta ou por sub-departamento). `refreshed_at` marca quando esta
-- linha foi calculada — ver HIERARCHY_CACHE_TTL_MS em src/bitrixHierarchy.js
-- pra quanto tempo até recalcular.
create table if not exists hierarchy_subordinates (
  manager_owner_id text not null,
  subordinate_owner_id text not null,
  refreshed_at timestamptz not null default now(),
  primary key (manager_owner_id, subordinate_owner_id)
);

create index if not exists idx_hierarchy_subordinates_manager on hierarchy_subordinates (manager_owner_id);

-- Histórico de atribuição de conversa (ver Painel de atendimento em
-- chat.html) — conversations.assigned_to guarda só QUEM ESTÁ atendendo
-- agora; sem isto não haveria como calcular métricas por atendente de
-- forma correta se uma conversa trocou de mão no meio do caminho (ex:
-- tempo de resposta contaria o histórico inteiro pro atendente atual,
-- mesmo que ele tenha pegado a conversa ontem). Cada linha é um período
-- em que a conversa esteve com um atendente: `started_at` quando a
-- atribuição começou, `ended_at` (null = ainda vigente) quando terminou
-- (por troca pra outra pessoa ou por "Liberar"). `owner_id` é sempre o
-- dono real da instância (não muda por período) — é o que permite ao
-- Painel achar rápido "todos os períodos de atendimento desta
-- instância" sem precisar de join extra por conversa.
create table if not exists conversation_assignment_history (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  owner_id text not null,
  assigned_to text not null,
  assigned_to_name text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index if not exists idx_assignment_history_conversation on conversation_assignment_history (conversation_id);
create index if not exists idx_assignment_history_owner on conversation_assignment_history (owner_id, assigned_to);
-- acelera "qual é o período vigente desta conversa" (ended_at is null),
-- consultado a cada nova atribuição pra fechar o período anterior.
create index if not exists idx_assignment_history_open on conversation_assignment_history (conversation_id) where ended_at is null;

-- Contatos e listas passam a ser do DONO (owner_id), não da instância —
-- assim, se uma instância cai e o usuário conecta outra (novo session_id),
-- os mesmos contatos/listas continuam aparecendo, em vez de ficar tudo
-- vazio pra instância nova. Diferente de conversations/messages (que
-- continuam por session_id de propósito: o histórico de mensagens é mesmo
-- específico de qual número trocou aquela conversa com o WhatsApp).
alter table contacts add column if not exists owner_id text;
alter table contact_lists add column if not exists owner_id text;

-- Guardado por EXECUTE dinâmico porque este script inteiro é reaplicado a
-- cada `node db/migrate.js` (não só na primeira vez) — depois que
-- `session_id` já foi removido de contacts/contact_lists (mais abaixo),
-- uma referência direta a `contacts.session_id` no texto da query pararia
-- de compilar mesmo dentro de um `where owner_id is null` que não bateria
-- em nenhuma linha. Sem esse guard, rodar a migração de novo (ex: junto
-- com uma mudança de schema não relacionada) quebraria com "column
-- contacts.session_id does not exist".
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'contacts' and column_name = 'session_id') then
    execute $sql$
      update contacts set owner_id = coalesce(
        (select owner_id from instances where instances.id = contacts.session_id),
        contacts.session_id
      ) where owner_id is null
    $sql$;
  end if;
  if exists (select 1 from information_schema.columns where table_name = 'contact_lists' and column_name = 'session_id') then
    execute $sql$
      update contact_lists set owner_id = coalesce(
        (select owner_id from instances where instances.id = contact_lists.session_id),
        contact_lists.session_id
      ) where owner_id is null
    $sql$;
  end if;
end $$;

-- Duas instâncias do mesmo dono podem ter cadastrado o mesmo telefone como
-- contato separadamente (quando ainda era por session_id) — mescla numa só
-- linha (mantém a mais recente, herda nome/negócio de qualquer uma das
-- duplicatas que tiver, e realoca a membresia em listas) antes de trocar a
-- constraint de unicidade pra (owner_id, phone). No-op se não houver
-- duplicata (grupo de 1 linha só, `having count(*) > 1` não bate).
with dup_groups as (
  select owner_id, phone, array_agg(id order by updated_at desc) as ids
  from contacts
  group by owner_id, phone
  having count(*) > 1
),
winners as (
  select owner_id, phone, ids[1] as winner_id, ids[2:array_length(ids,1)] as loser_ids
  from dup_groups
)
update contact_list_members m
set contact_id = w.winner_id
from winners w
where m.contact_id = any(w.loser_ids)
  and not exists (
    select 1 from contact_list_members m2 where m2.list_id = m.list_id and m2.contact_id = w.winner_id
  );

with dup_groups as (
  select owner_id, phone, array_agg(id order by updated_at desc) as ids
  from contacts
  group by owner_id, phone
  having count(*) > 1
)
update contacts c
set name = coalesce(c.name, (select name from contacts c2 where c2.id = any(d.ids) and c2.name is not null limit 1)),
    deal_id = coalesce(c.deal_id, (select deal_id from contacts c2 where c2.id = any(d.ids) and c2.deal_id is not null limit 1))
from dup_groups d
where c.id = d.ids[1];

delete from contacts c
using (
  select array_agg(id order by updated_at desc) as ids
  from contacts
  group by owner_id, phone
  having count(*) > 1
) d
where c.id = any(d.ids[2:array_length(d.ids,1)]);

alter table contacts alter column owner_id set not null;
alter table contact_lists alter column owner_id set not null;

alter table contacts drop constraint if exists contacts_session_id_phone_key;
alter table contacts drop constraint if exists contacts_owner_id_phone_key;
alter table contacts add constraint contacts_owner_id_phone_key unique (owner_id, phone);

alter table contacts drop column if exists session_id;
alter table contact_lists drop column if exists session_id;

create index if not exists idx_contacts_owner on contacts (owner_id);
create index if not exists idx_contact_lists_owner on contact_lists (owner_id);

-- Tags livres que o atendente pode criar e aplicar a conversas durante o
-- atendimento (tela Chat, public/chat.html) — ex: "Aguardando pagamento",
-- "VIP". Por instância (session_id), reutilizável entre conversas.
create table if not exists tags (
  id bigserial primary key,
  session_id text not null,
  name text not null,
  color text not null default '#d8ab4f',
  -- true pras tags aplicadas automaticamente pelo sistema (ex: nome da LP
  -- de origem do lead, ver src/routes/leads.js) — sem botão de remover no
  -- Chat, mesmo tratamento das tags sintéticas "Interno"/"Externo".
  fixed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (session_id, name)
);

-- `create table if not exists` acima não adiciona coluna em tabela já
-- existente (rodou antes da coluna `fixed` existir) — alter idempotente.
alter table tags add column if not exists fixed boolean not null default false;

create table if not exists conversation_tags (
  conversation_id bigint not null references conversations(id) on delete cascade,
  tag_id bigint not null references tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (conversation_id, tag_id)
);

create index if not exists idx_tags_session on tags (session_id);
create index if not exists idx_conversation_tags_tag on conversation_tags (tag_id);

-- Grupos de WhatsApp de verdade (criados via Baileys, sock.groupCreate) — um
-- disparo pro grupo é UMA mensagem só, entregue pelo próprio WhatsApp a todos
-- os participantes, diferente da Campanha (que manda uma DM por destinatário).
-- `id` é o JID do grupo (formato "xxxxx@g.us"), usado como "phone" nas rotas
-- de envio (/send, /send-media) e no histórico (conversations/messages) —
-- ver WhatsAppGateway._phoneToJid, que já entende JIDs prontos.
create table if not exists wa_groups (
  id text primary key,
  session_id text not null,
  name text not null,
  participant_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_wa_groups_session on wa_groups (session_id);

-- Grupos criados PELA feature "Criar grupo" do card do negócio (aba
-- DapZap, ver src/routes/cardGroup.js) — diferente de wa_groups "manuais"
-- (POST /groups já existente, tela Contatos/Chat, "grupo em comum"). Só
-- grupos com source='card' têm mensagem recebida processada/salva (ver
-- bypass condicional em src/whatsapp.js::_processIncomingMessage,
-- isCardGroup) — qualquer outro grupo continua descartando mensagem
-- recebida por completo, sem nenhuma mudança de comportamento.
alter table wa_groups add column if not exists deal_id text;
alter table wa_groups add column if not exists source text not null default 'manual' check (source in ('manual', 'card'));

create index if not exists idx_wa_groups_deal on wa_groups (deal_id) where deal_id is not null;

-- Histórico persistido de notificações (hoje: só mensagem recebida numa
-- conversa não silenciada) — por dono do Bitrix (owner_id), não por
-- instância, já que o mesmo usuário pode ter várias sessões de WhatsApp e
-- quer ver tudo junto na Central de Notificações (Kanban/Calendário,
-- public/notifications.html). `target` guarda pra onde navegar ao clicar
-- (sessionId/phone/contactName).
create table if not exists notifications (
  id text primary key,
  owner_id text not null,
  title text not null,
  body text,
  target jsonb,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_owner_created on notifications (owner_id, created_at desc);
create index if not exists idx_notifications_owner_unread on notifications (owner_id, read);

-- Histórico de AÇÕES reais por pessoa, pro Admin (modal Detalhado, tela
-- Usuários, ver HANDOFF Parte DB) — deliberadamente SEM conteúdo digitado
-- nem gravação de tela (decisão confirmada com o usuário: risco real de
-- capturar dado sigiloso de cliente/caso, sendo escritório de
-- advocacia/financeira). Só as 5 ações confirmadas: instância conectada,
-- campanha criada/agendada, contato criado/importado, grupo criado,
-- conversa atribuída a si mesmo. Mensagem enviada FICA DE FORA de
-- propósito — já tem contagem separada (messagesSentLast30d,
-- getUsabilityStatsByOwner em src/store.js); logar cada envio aqui
-- inundaria o histórico e esconderia as ações mais raras/significativas.
-- `detail` é texto livre JÁ FORMATADO no momento do registro (ex: "Grupo
-- Comercial VIP" pra grupo criado) — decisão de exibição fica no
-- momento em que a ação acontece, não recalculada depois.
create table if not exists action_log (
  id bigserial primary key,
  owner_id text not null,
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists idx_action_log_owner_created on action_log (owner_id, created_at desc);

-- Sugestões de melhoria enviadas pelos usuários (tela /suggestions.html) —
-- visão de TIME (todo mundo vê todas, igual Análise de Conversas), não só
-- as próprias. Ao marcar como lançada, uma notificação (tabela acima) é
-- criada pra quem sugeriu — ver src/routes/suggestions.js.
create table if not exists suggestions (
  id bigserial primary key,
  owner_id text not null,
  text text not null,
  status text not null default 'pending', -- 'pending' | 'released'
  created_at timestamptz not null default now(),
  released_at timestamptz
);

create index if not exists idx_suggestions_owner on suggestions (owner_id, created_at desc);
create index if not exists idx_suggestions_status on suggestions (status);

-- Configurações editáveis pela tela /settings.html — linha única (id fixo
-- 1, "singleton"), pensada pra uma instalação = uma empresa (mesmo escopo
-- do BRAND_NAME/BRAND_COLOR em .env, ver GET /api/brand em src/server.js).
-- accent_color tem prioridade sobre BRAND_COLOR do .env quando preenchido;
-- NULL em qualquer campo (o padrão, nunca editado) mantém a cor padrão do
-- app pra aquele papel específico. accent_color_dim (usado em hovers/bordas)
-- é auto-derivado do accent_color na tela quando não sobrescrito à mão.
create table if not exists app_settings (
  id int primary key default 1,
  accent_color text,
  accent_color_dim text,
  green_color text,
  red_color text,
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton check (id = 1)
);
insert into app_settings (id) values (1) on conflict (id) do nothing;
alter table app_settings add column if not exists accent_color_dim text;
alter table app_settings add column if not exists green_color text;
alter table app_settings add column if not exists red_color text;
-- Cor de fundo (base escura do app) — surface/surface-2 são derivadas dela
-- no cliente (clareando alguns pontos), não ficam guardadas à parte.
alter table app_settings add column if not exists bg_color text;

-- Formulários públicos de captura de lead ("Sites", public/sites.html) — o
-- usuário cria um ou mais, cada um com sua própria URL pública
-- (/l/<slug>, sem login/Bitrix). Por owner_id (não por instância) igual
-- contacts/contact_lists: o dono pode ter vários formulários, cada um
-- escolhendo qual instância manda a mensagem de boas-vindas.
create table if not exists lead_forms (
  id bigserial primary key,
  slug text not null unique,
  owner_id text not null,
  session_id text not null,
  name text not null,
  title text not null,
  subtitle text,
  welcome_message text not null default 'Olá {{nome}}! Recebemos seu contato, em breve falamos com você.',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Personalização visual da página pública (/l/<slug>) — cada formulário pode
-- ter uma cor de destaque e um logo próprios. `logo_url` é um link pra uma
-- imagem já hospedada em algum lugar (ex: no site do escritório) — não existe
-- upload de arquivo neste app pra nenhuma outra marca/imagem hoje (nem pra
-- marca do próprio sistema, ver /api/brand em src/server.js), então não faz
-- sentido introduzir isso só pra formulário de lead.
alter table lead_forms add column if not exists accent_color text;
alter table lead_forms add column if not exists logo_url text;

-- Imagem OU vídeo de fundo do banner de hero (topo da página pública) —
-- mesma regra do logo: link pra mídia já hospedada, ou upload de verdade
-- (armazenado no mesmo bucket público, pasta "hero/", ver
-- src/publicAssets.js). Opcional — some/vira fundo liso se não configurada.
-- `hero_media_type` diz pra public/lead-form.html se deve renderizar
-- <img> ou <video> ('image' por padrão, cobre todo dado já existente
-- gravado antes do vídeo virar suportado).
alter table lead_forms add column if not exists hero_image_url text;
alter table lead_forms add column if not exists hero_media_type text not null default 'image';

-- Depoimentos (nome, localização opcional, texto) pra virar prova social na
-- página pública — SEMPRE preenchidos pelo próprio dono do formulário, nunca
-- inventados por este app; a seção some por completo se o array estiver
-- vazio, em vez de mostrar depoimento fictício pra parecer mais confiável.
alter table lead_forms add column if not exists testimonials jsonb not null default '[]'::jsonb;

-- Seções adicionais de LP (inspiradas num painel de referência mostrado
-- pelo usuário) — todas opcionais, cada uma some da página pública se
-- vazia. Sem seção de "Planos" de propósito: este gateway não tem
-- Stripe/pagamento integrado, então preço sem botão de compra funcional
-- seria só decorativo — fora de escopo por agora.
alter table lead_forms add column if not exists stats jsonb not null default '[]'::jsonb;
alter table lead_forms add column if not exists differentials jsonb not null default '[]'::jsonb;
alter table lead_forms add column if not exists faq jsonb not null default '[]'::jsonb;
alter table lead_forms add column if not exists story_title text;
alter table lead_forms add column if not exists story_text text;

create index if not exists idx_lead_forms_owner on lead_forms (owner_id);

-- Histórico de leads recebidos por formulário — alimenta a contagem/lista
-- de leads em public/sites.html. `whatsapp_sent` fica false quando a
-- instância escolhida estava offline no momento (o lead ainda é salvo
-- como contato, só a mensagem automática que não saiu).
create table if not exists lead_form_submissions (
  id bigserial primary key,
  form_id bigint not null references lead_forms(id) on delete cascade,
  contact_id bigint references contacts(id) on delete set null,
  name text,
  phone text not null,
  whatsapp_sent boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_lead_form_submissions_form on lead_form_submissions (form_id, created_at desc);

-- Pipeline (categoria de negócio) do Bitrix criado automaticamente pra cada
-- LP (nome "[LP] <nome do form>", convenção já usada no portal do cliente).
-- NULL = criação falhou/webhook sem escopo CRM na hora — o PUT tenta de novo
-- ao salvar a LP. NUNCA é apagado junto com a LP (não excluímos dados de
-- terceiros automaticamente — mesma filosofia do resto do app).
alter table lead_forms add column if not exists bitrix_category_id bigint;

-- Negócio/contato criados no Bitrix pra cada submissão (negócio no pipeline
-- da LP, atribuído ao SDR dono). NULL = Bitrix indisponível na hora — o lead
-- local NUNCA se perde por causa disso (best-effort).
alter table lead_form_submissions add column if not exists bitrix_deal_id bigint;
alter table lead_form_submissions add column if not exists bitrix_contact_id bigint;

-- Visualizações da página pública por LP, agregadas por dia (incrementadas
-- em GET /api/leads/:slug/config, 1x por carregamento). Por dia (não um
-- contador único) de propósito: métricas de teste A/B precisam de views
-- dentro da janela do teste, e conversão diária precisa da série.
create table if not exists lead_form_views (
  form_id bigint not null references lead_forms(id) on delete cascade,
  day date not null,
  count integer not null default 0,
  primary key (form_id, day)
);

-- Testes A/B entre duas LPs existentes — URL pública única /t/<slug> divide
-- o tráfego 50/50 (cookie sticky por visitante). form_*_id com "set null" +
-- snapshot jsonb: o HISTÓRICO (base de aprendizados pra futura IA geradora
-- de LPs) sobrevive mesmo se as LPs forem excluídas depois.
create table if not exists ab_tests (
  id bigserial primary key,
  owner_id text not null,
  slug text not null unique,
  name text not null,
  form_a_id bigint references lead_forms(id) on delete set null,
  form_b_id bigint references lead_forms(id) on delete set null,
  status text not null default 'running', -- running | finished
  winner_form_id bigint references lead_forms(id) on delete set null,
  analysis text,
  variant_snapshot jsonb, -- resumo da config de cada variante (na criação)
  final_metrics jsonb,    -- views/leads/conversão congelados no encerramento
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists idx_ab_tests_owner on ab_tests (owner_id, created_at desc);

-- Painel admin (restrito, ver SUPER_ADMIN_OWNER_IDS em src/adminAuth.js) —
-- "quem está com o app aberto agora". Um upsert por owner_id a cada
-- heartbeat do navegador (POST /presence/heartbeat, a cada 30s enquanto a
-- aba estiver aberta) — não é histórico, só o estado mais recente; "online"
-- é calculado no FRONTEND a partir de last_seen_at (evita comparar
-- timestamp gerado pelo Postgres com Date.now() de outro processo — mesmo
-- bug de clock skew já documentado no Painel de atendimento, Parte CI).
create table if not exists admin_presence (
  owner_id text primary key,
  owner_name text,
  last_page text,
  last_seen_at timestamptz not null default now()
);

-- Mitigações contra o erro 463 do WhatsApp ("account restricted or
-- missing tctoken" — exige token de privacidade antes de deixar iniciar
-- conversa NOVA com quem nunca respondeu de verdade; conversas com
-- histórico de resposta real não são afetadas. Ver HANDOFF, Parte CM/CN).

-- Acelera classifyRecipients (src/store.js) — "esse telefone já me
-- respondeu alguma vez?", consultado pra até 100 telefones por disparo
-- (CAMPAIGN_MAX_RECIPIENTS) antes de mandar uma campanha, pra avisar o
-- risco de erro 463 (contato sem resposta prévia = maior risco). Sem este
-- índice, o exists(...) por conversation_id ainda funciona (usa
-- idx_messages_conversation_created), mas varre linhas 'out' que nunca
-- interessam pra essa pergunta.
create index if not exists idx_messages_conversation_direction
  on messages (conversation_id, direction);

-- retry_of_campaign_id: marca que este agendamento é um retry AUTOMÁTICO
-- (não criado à mão pelo usuário) de uma campanha anterior que teve
-- destinatários rejeitados com erro 463 — usado só pro Kanban/Calendário
-- (campaign-schedule.html) mostrar um selo distinto, não muda nenhum
-- comportamento de edição/cancelamento. retry_attempt = 0 é agendamento
-- normal; 1 é o próprio retry — nunca passa de 1 (decisão confirmada com o
-- usuário: só 1 tentativa, 24h depois, alinhado com o aviso do próprio
-- código-fonte do Baileys de que retry repetido piora a restrição em vez
-- de resolver).
alter table scheduled_campaigns add column if not exists retry_of_campaign_id text references campaigns(id);
alter table scheduled_campaigns add column if not exists retry_attempt int not null default 0;

-- Intervalo entre mensagens escolhido na hora de criar a campanha/agendar
-- (ver POST /campaign, POST /campaign/schedule) — nulo = usa o padrão
-- (CAMPAIGN_MIN_DELAY_MS/CAMPAIGN_MAX_DELAY_MS em src/routes/whatsapp.js).
-- Persistido aqui pra um agendamento futuro lembrar a escolha até a hora
-- de disparar de fato (sendScheduled, src/scheduler.js).
alter table scheduled_campaigns add column if not exists min_delay_ms int;
alter table scheduled_campaigns add column if not exists max_delay_ms int;

-- Gestão de usuários no Admin (ver HANDOFF, Parte CO) — trackeamento
-- ponta a ponta de navegação, diferente de admin_presence (que é só o
-- estado ATUAL, sobrescrito a cada heartbeat). Uma linha por VISITA a uma
-- página, com duração real (entrada/saída via navigator.sendBeacon, não
-- aproximação pelo intervalo do heartbeat). ended_at null = ainda aberta
-- OU órfã (aba fechada sem disparar o beacon de saída, crash, queda de
-- luz) — ver closeStaleSessions em src/pageSessions.js, chamada
-- periodicamente em src/server.js: fecha sozinha com ended_at =
-- last_ping_at (não now()) quando last_ping_at passa de 90s sem
-- atualização, nunca fica "aberta pra sempre".
create table if not exists page_sessions (
  id bigserial primary key,
  owner_id text not null,
  owner_name text,
  page text not null,
  started_at timestamptz not null default now(),
  last_ping_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists idx_page_sessions_owner on page_sessions (owner_id, started_at desc);
create index if not exists idx_page_sessions_open on page_sessions (owner_id) where ended_at is null;

-- Bloqueio de acesso individual (botão "Revogar" no Admin) — verificado
-- em TODA request autenticada (dentro de requireAuth, src/auth.js), não
-- só na emissão do token: quem já tem um token válido em uso (até 12h,
-- AUTH_TOKEN_TTL_HOURS) é cortado na PRÓXIMA chamada, não só depois do
-- token expirar sozinho. Decisão confirmada com o usuário — corte
-- imediato, não confiança em o token vencer. blocked_by é o ownerId do
-- super admin que bloqueou (nunca o próprio ownerId — trava aplicada na
-- rota, não aqui no schema).
create table if not exists blocked_owners (
  owner_id text primary key,
  blocked_by text not null,
  blocked_at timestamptz not null default now(),
  reason text
);

-- Kanban de Sugestões dentro do Admin (ver HANDOFF Parte CO) — status
-- ganha um 3º valor no meio do fluxo ('pending' -> 'in_review' ->
-- 'released'); sem CHECK constraint hoje (já era text livre antes), sem
-- migração de dado necessária pras linhas existentes. response/responded_at
-- alimentam a FAQ pública (GET /api/suggestions/faq) — resposta e
-- "lançada" são independentes (uma sugestão pode ter resposta sem nunca
-- ter sido lançada de fato, ex: "não vamos fazer isso porque...").
alter table suggestions add column if not exists response text;
alter table suggestions add column if not exists responded_at timestamptz;

-- Acesso à Auditoria de Conversas (/conversation-analysis.html, ver
-- HANDOFF Parte DK) — tela DIFERENTE do dashboard "Análise de
-- Conversas" já existente (agregado só das PRÓPRIAS instâncias, GET
-- /metrics); esta lê CONTEÚDO real de mensagens de QUALQUER owner do
-- sistema — acesso restrito, concedido nominalmente pelo super admin,
-- nunca por hierarquia/departamento automática (diferente de
-- hierarchy_subordinates, calculada sozinha a partir do Bitrix). Super
-- admin (SUPER_ADMIN_OWNER_IDS) sempre tem acesso e NÃO precisa de
-- linha aqui — granted_by é o ownerId de quem concedeu.
create table if not exists conversation_analysis_grants (
  owner_id text primary key,
  granted_by text not null,
  granted_at timestamptz not null default now()
);

-- Auditoria de acesso ao painel acima — DIFERENTE de action_log (ações
-- do PRÓPRIO uso do app, deliberadamente sem conteúdo digitado, ver
-- HANDOFF Parte DC) e de page_sessions (navegação genérica, sem saber
-- QUAL recurso foi olhado dentro da página). Aqui: qual conversa de
-- qual dono foi aberta, ou com quais filtros uma busca/insight foi
-- gerado — `detail` é estruturado (jsonb) e NUNCA guarda texto de
-- mensagem nem o texto do insight gerado, só o QUE foi acessado (é
-- sobre rastreabilidade de acesso privilegiado, não sobre duplicar
-- dado sensível em outro lugar).
create table if not exists conversation_analysis_audit (
  id bigserial primary key,
  owner_id text not null,
  action text not null, -- 'view_conversation' | 'search' | 'generate_insight'
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_conversation_analysis_audit_owner
  on conversation_analysis_audit (owner_id, created_at desc);

-- Busca por conteúdo de mensagem — só usada pela Auditoria de
-- Conversas acima (nenhuma outra tela busca por texto dentro do corpo
-- de uma mensagem hoje; a busca existente em listConversations é só
-- por telefone/nome de contato). Coluna GERADA — o Postgres mantém
-- sincronizada sozinho a cada insert/update de `text`, sem precisar de
-- trigger. 'portuguese' faz STEMMING (acha "atestados" ao buscar
-- "atestado"), não é busca por substring arbitrário dentro de uma
-- palavra — suficiente pro caso de uso (buscar um termo/palavra), mas
-- documentado aqui pra quem for usar não presumir que cobre qualquer
-- busca tipo grep. `coalesce` porque `text` é nulável (mensagem de
-- mídia sem legenda) — inofensivo, só nunca dá match.
alter table messages add column if not exists text_search tsvector
  generated always as (to_tsvector('portuguese', coalesce(text, ''))) stored;
create index if not exists idx_messages_text_search on messages using gin (text_search);

-- Paleta de cores POR USUÁRIO (tela Configurações/Aparência) — diferente
-- de `app_settings` (singleton, id=1, "uma instalação = uma empresa"),
-- que continua existindo mas deixa de ser lida/escrita pelas rotas de
-- settings a partir de agora. Nome/subtítulo da marca (GET /api/brand,
-- pública, usada até na LP sem login) continuam GLOBAIS de propósito —
-- só a paleta de cores de acento passa a ser por pessoa. Sem migração
-- de dado da tabela antiga: decisão confirmada com o usuário, todo
-- mundo começa do dourado padrão de fábrica, não herda a cor global
-- que já estava configurada.
create table if not exists user_palette (
  owner_id text primary key,
  accent_color text,
  accent_color_dim text,
  green_color text,
  red_color text,
  bg_color text,
  updated_at timestamptz not null default now()
);

-- Quem mandou a mensagem DENTRO de um grupo de card (telefone/nome de quem
-- está no grupo, não da empresa) — só preenchido em mensagens 'in' de
-- conversas cujo "phone" é o JID de um wa_groups.source='card' (ver
-- bypass em src/whatsapp.js). DM 1-a-1 nunca preenche isso: o remetente
-- já É a conversa inteira, sem ambiguidade. Necessário porque um grupo
-- tem N remetentes possíveis (a bolha recebida precisa mostrar "quem"),
-- enquanto uma DM sempre tem só 1.
alter table messages add column if not exists group_sender_phone text;
alter table messages add column if not exists group_sender_name text;

-- Nota interna — mensagem visível SÓ para internos (Responsável,
-- Verificação, atendente), NUNCA para o cliente, mesmo estando todos no
-- mesmo grupo de WhatsApp (feature de "Criar grupo" do card). Serve tanto
-- conversa 1-a-1 quanto grupo-com-cliente igualmente — associada a
-- `conversations` (não a `messages`/`wa_groups`), já que as duas já são
-- linhas de `conversations` (grupo entra ali pelo mesmo mecanismo que já
-- trata `phone` como JID de grupo). É a MESMA peça de infraestrutura
-- pedida antes (HANDOFF Parte DW: insight de IA em tempo real + nota do
-- gerente pro atendente) — tratada aqui como uma coisa só, não duas.
-- Nunca lida pelas rotas normais de histórico/envio (GET /history,
-- POST /send) — rota própria e dedicada (src/routes/internalNotes.js),
-- pra nunca vazar por engano no mesmo payload que alimenta a bolha de
-- conversa real, nem ser confundida com envio de verdade ao WhatsApp.
create table if not exists internal_notes (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  text text not null,
  author_owner_id text not null,
  author_name text,
  created_at timestamptz not null default now()
);

create index if not exists idx_internal_notes_conversation
  on internal_notes (conversation_id, created_at);

-- Edição com rastro (HANDOFF Parte EC) — texto pode mudar, mas o
-- anterior precisa ficar recuperável, nunca "sobrescreve e pronto".
-- edited_at é só uma flag rápida de "foi editada alguma vez"; o CORPO
-- do histórico mora na tabela satélite abaixo, buscado sob demanda.
alter table internal_notes add column if not exists edited_at timestamptz;

-- Conclusão — nota concluída continua na MESMA linha/posição
-- cronológica (decisão do usuário), nunca migra de tabela/seção.
alter table internal_notes add column if not exists completed_at timestamptz;
alter table internal_notes add column if not exists completed_by text;

-- Histórico de revisões — tabela satélite (não uma única coluna
-- "texto anterior", que perderia tudo antes da penúltima edição se a
-- nota for editada mais de uma vez). Cada linha é a versão que estava
-- valendo ANTES de uma edição específica.
create table if not exists internal_note_revisions (
  id bigserial primary key,
  note_id bigint not null references internal_notes(id) on delete cascade,
  text text not null,
  edited_at timestamptz not null default now(),
  edited_by text not null
);
create index if not exists idx_internal_note_revisions_note
  on internal_note_revisions (note_id, edited_at);

-- Histórico LOCAL de posts publicados no Feed (Live Feed) do Bitrix24
-- (src/bitrixFeed.js) — publicação é sempre MANUAL (usuário decide
-- quando). Nunca é a fonte de verdade (o Bitrix é o dono real do post) —
-- só um registro de "o que já foi anunciado", pra não duplicar. Registrado
-- mesmo em falha (status='failed'), pra nunca perder o rastro de uma
-- tentativa que não foi ao ar.
create table if not exists feed_posts (
  id bigserial primary key,
  owner_id text not null,
  title text,
  message text not null,
  bitrix_post_id text,
  status text not null default 'published' check (status in ('published', 'failed')),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists idx_feed_posts_created on feed_posts (created_at desc);

-- Alerta de instância caída/desconectada — histórico de QUEDAS (uma
-- linha por evento, não snapshot periódico, já que o dado é uma
-- transição discreta: caiu, voltou). `kind` distingue os 2 casos que o
-- usuário pediu (sem certeza de "banido pelo WhatsApp" especificamente
-- — decisão confirmada: "provavelmente perdida, reconecte" é
-- suficiente):
--   'temporary' -> gateway tentando reconectar sozinho (queda comum de
--                  rede, esperada e frequente nesse tipo de integração)
--   'attention' -> needsAttention ou loggedOut — parou de tentar
--                  reconectar sozinho, precisa ação manual (reconectar
--                  ou trocar de número)
-- `instance_id` é o session_id (mesmo identificador usado em
-- instances/conversations), não uma FK — histórico precisa sobreviver
-- mesmo se a instância for removida depois (mesmo padrão já usado pras
-- 27 instâncias órfãs, ver HANDOFF Parte ED).
create table if not exists instance_connection_events (
  id bigserial primary key,
  instance_id text not null,
  kind text not null check (kind in ('temporary', 'attention')),
  reason text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_ms bigint,
  created_at timestamptz not null default now()
);
create index if not exists idx_instance_conn_events_instance
  on instance_connection_events (instance_id, started_at desc);
-- Índice parcial — só a queda EM ABERTO de cada instância, consultada a
-- cada mudança de status (deve achar no máximo 1 linha instantaneamente).
create index if not exists idx_instance_conn_events_open
  on instance_connection_events (instance_id) where ended_at is null;

-- Alerta de instância caída — série de MÉTRICAS, snapshot diário (não
-- por evento, já que contagem de conversa/contato evolui devagar e
-- continuamente, sem uma transição discreta natural como a queda
-- acima). `contact_count_real` conta pela tabela `contacts` (dado
-- persistido e completo); `contact_count_baileys` é só
-- auxiliar/comparativo (o acumulado do Baileys zera a cada boot do
-- processo, não confiável como métrica histórica de longo prazo —
-- daria quedas artificiais na série a cada deploy).
create table if not exists instance_metrics_daily (
  instance_id text not null,
  snapshot_date date not null,
  conversation_count int not null default 0,
  contact_count_real int not null default 0,
  contact_count_baileys int,
  group_count int,
  created_at timestamptz not null default now(),
  primary key (instance_id, snapshot_date)
);

-- ================================================================
-- Agente de IA — atendimento automático de LEADS NOVOS via WhatsApp
-- (tela dedicada public/agente-ia.html). Responde AUTOMATICAMENTE
-- (não é sugestão que um humano aprova), focado em TRIAGEM INICIAL —
-- nunca em conversa já existente de cliente antigo.
--
-- Gatilho: quando o LEAD MANDA MENSAGEM (não mais quando o formulário
-- de LP é enviado, que é como a criação de negócio funcionava antes
-- desta feature) — cobre 2 origens: lead de LP (form -> boas-vindas
-- fixa, inalterada -> aguarda resposta -> IA assume) e lead de
-- Campanha/mensagem direta (número desconhecido manda a 1ª mensagem
-- sem ter passado por formulário nenhum). A IA nunca fala primeiro.
--
-- A IA nunca para de responder sozinha por heurística de linguagem —
-- só por: (a) botão manual "Desativar IA nesta conversa"
-- (conversations.agent_enabled) ou (b) HUMANO mandar mensagem manual
-- na própria conversa (detectado em POST /send e /send-media,
-- src/routes/whatsapp.js). Nunca reativa sozinha depois de false.
-- ================================================================

-- pgvector — necessário pra busca semântica na base de conhecimento
-- (embeddings da OpenAI, text-embedding-3-small, 1536 dimensões).
-- Confirmado disponível no catálogo de extensões do Supabase deste
-- projeto (versão 0.8.2, nunca habilitada antes) — roda com o mesmo
-- DIRECT_URL já usado por toda migração deste arquivo.
create extension if not exists vector;

-- Controle do agente POR CONVERSA (não por instância) — cada
-- conversa nova de lead começa com agent_enabled = null (estado
-- "nunca decidido"; conversa antiga de cliente já existente NUNCA
-- ganha valor aqui, fica null pra sempre), vira true no momento em
-- que o agente assume (src/agentDispatch.js) e false só quando: o
-- usuário aperta "Desativar IA nesta conversa" no Chat, OU um humano
-- manda mensagem manual nessa conversa (auto-desativação). NUNCA
-- volta a true sozinho depois de false — reativar exige ação manual
-- explícita.
-- `agent_activated_at`: quando a IA passou a responder esta conversa
-- pela 1ª vez — só pra diagnóstico/exibição, nunca pra lógica.
alter table conversations add column if not exists agent_enabled boolean;
alter table conversations add column if not exists agent_activated_at timestamptz;

-- Configuração do Agente de IA POR INSTÂNCIA (não por owner) — cada
-- número de WhatsApp conectado (instances.id, mesmo id usado como
-- session_id em todo o resto do app) tem sua própria configuração:
-- ativo/inativo, texto livre de base de conhecimento (colado direto
-- no prompt, sem embeddings) e a mensagem de sistema (persona/tom)
-- que a IA deve seguir. PK em session_id (mesmo padrão de
-- `instances`, não um id bigserial à parte) — uma linha por
-- instância, nunca mais de uma config simultânea faz sentido aqui.
-- `active`: false por padrão — a feature NUNCA liga sozinha numa
-- instância só porque a tabela existe; precisa ser ativada
-- explicitamente na tela /agente-ia.html.
create table if not exists agent_config (
  session_id text primary key references instances(id) on delete cascade,
  active boolean not null default false,
  system_message text,
  knowledge_text text,
  updated_at timestamptz not null default now()
);

-- Documentos enviados como base de conhecimento (PDF/DOCX/TXT/MD) —
-- por instância (mesma FK de agent_config). `content` é o TEXTO JÁ
-- EXTRAÍDO do arquivo (via pdf-parse/mammoth/leitura direta pra
-- txt/md, ver src/knowledgeDocs.js) — nunca o binário original em si
-- (isso fica só no Storage, ver `storage_path`, reaproveitando
-- saveMedia de src/media.js). `storage_path` permite reprocessar o
-- arquivo original no futuro sem pedir upload de novo. `status`:
-- 'processing' logo após o upload (extração/chunking/embeddings
-- ainda rodando em background), 'ready' quando os chunks já estão
-- prontos pra busca, 'error' se a extração falhou (ex: PDF escaneado
-- sem texto) — `error_message` guarda o motivo pra exibir na lista.
create table if not exists agent_knowledge_docs (
  id bigserial primary key,
  session_id text not null references instances(id) on delete cascade,
  file_name text not null,
  file_type text not null check (file_type in ('pdf', 'docx', 'txt', 'md')),
  content text,
  storage_path text,
  status text not null default 'processing' check (status in ('processing', 'ready', 'error')),
  error_message text,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_knowledge_docs_session on agent_knowledge_docs (session_id, created_at desc);

-- Chunks de um documento, cada um com seu próprio embedding — a
-- unidade real de busca semântica (nunca o documento inteiro de uma
-- vez: um PDF de 40 páginas não cabe inteiro num prompt, e buscar por
-- similaridade em pedaços menores acha o trecho relevante, não o
-- documento inteiro). `chunk_index` preserva a ordem original dentro
-- do documento (só pra eventual exibição ordenada/debug, não usado
-- pra ranquear busca). `embedding vector(1536)`: dimensão fixa do
-- modelo text-embedding-3-small da OpenAI (src/embeddings.js) — mudar
-- de modelo de embedding no futuro exigiria migrar esta coluna (fora
-- de escopo agora, mesma decisão implícita de fixar num modelo só que
-- o resto do app já faz com gpt-4o-mini).
create table if not exists agent_knowledge_chunks (
  id bigserial primary key,
  doc_id bigint not null references agent_knowledge_docs(id) on delete cascade,
  session_id text not null references instances(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_knowledge_chunks_doc on agent_knowledge_chunks (doc_id, chunk_index);

-- Índice IVFFlat pra acelerar a busca por similaridade (operador <=>,
-- distância de cosseno, ver src/agentKnowledge.js) — sem ele o
-- Postgres faz um scan sequencial calculando distância linha a linha.
-- `lists = 100` é um valor de partida razoável pra poucos milhares de
-- chunks (regra prática: lists ≈ sqrt(total de linhas) — reavaliar se
-- o volume real crescer muito além disso).
create index if not exists idx_agent_knowledge_chunks_embedding
  on agent_knowledge_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Fila de retry — resiliência pedida explicitamente: se TODAS as
-- instâncias do usuário caírem no momento em que o lead manda
-- mensagem, a intenção de resposta não pode se perder — fica
-- registrada aqui e um worker (src/agentRetryWorker.js) reprocessa
-- assim que a instância reconectar. `status`: 'pending' (aguardando
-- instância voltar), 'sent' (worker confirmou envio), 'failed'
-- (excedeu MAX_ATTEMPTS do worker — nunca fica tentando pra sempre).
-- `attempts`/`last_error` só pra diagnóstico. Deliberadamente SEM
-- guardar aqui a resposta já pronta da IA — o worker RE-GERA a
-- resposta do zero no momento do reenvio, usando o histórico real da
-- conversa até aquele ponto (que pode ter mudado enquanto a instância
-- estava offline) — mais robusto que reenviar um texto potencialmente
-- desatualizado.
create table if not exists agent_retry_queue (
  id bigserial primary key,
  session_id text not null references instances(id) on delete cascade,
  phone text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_agent_retry_queue_pending on agent_retry_queue (session_id, status) where status = 'pending';

-- ================================================================
-- Aprendizado por exemplos (few-shot) do Agente de IA — extensão da
-- base de conhecimento já existente (agent_knowledge_docs/chunks),
-- mas pra "conversas passadas boas" em vez de "documentos da
-- empresa". Aprovação SEMPRE manual (nunca heurística automática —
-- decisão confirmada com o usuário) e anonimização SEMPRE automática
-- + reverificada antes de um transcript virar exemplo reutilizável
-- (escritório de advocacia — dado de cliente nunca pode vazar de uma
-- conversa pra outra). Ver src/exampleCandidates.js,
-- src/exampleAnonymizer.js, src/exampleApproval.js, src/agentExamples.js.
-- ================================================================

-- Fila de candidatas — criada só pelo botão manual "Marcar como
-- exemplo" no painel de detalhes do Chat, nunca automaticamente.
-- `transcript_raw` é o histórico da conversa NO MOMENTO do clique,
-- COM dado sensível de verdade — necessário pro humano revisar o
-- conteúdo original ao decidir aprovar/rejeitar. `status`:
-- 'pending_review' -> 'approved' (anonimizado+revisado, virou linha
-- em agent_examples) | 'rejected' (humano descartou sem nunca
-- anonimizar) | 'anonymization_failed' (a reverificação
-- determinística achou vazamento residual — NUNCA vira exemplo
-- utilizável nesse estado). Sem CHECK constraint no texto do status
-- — mesmo padrão de `suggestions` (validação na aplicação, toda
-- transição via `where status = '<esperado>'`).
create table if not exists agent_example_candidates (
  id bigserial primary key,
  session_id text not null references instances(id) on delete cascade,
  phone text not null,
  contact_name text,
  transcript_raw text not null,
  status text not null default 'pending_review',
  anonymized_draft text,
  anonymization_error text,
  marked_by text not null,
  marked_by_name text,
  reviewed_by text,
  reviewed_by_name text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_example_candidates_session
  on agent_example_candidates (session_id, status, created_at desc);

-- Exemplos aprovados — só o texto FINAL (já anonimizado E revisado/
-- editado por um humano na tela de aprovação, ver src/exampleApproval.js).
-- NUNCA guarda o transcript bruto/com PII de verdade. `candidate_id`
-- nullable com "on delete set null" — rastreabilidade de qual
-- conversa originou o exemplo, mas o exemplo aprovado sobrevive
-- mesmo se a linha de candidata for removida depois.
create table if not exists agent_examples (
  id bigserial primary key,
  session_id text not null references instances(id) on delete cascade,
  candidate_id bigint references agent_example_candidates(id) on delete set null,
  anonymized_text text not null,
  embedding vector(1536),
  approved_by text not null,
  approved_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists idx_agent_examples_session on agent_examples (session_id, created_at desc);

-- Índice IVFFlat — mesmo padrão/parâmetro de
-- idx_agent_knowledge_chunks_embedding (lists=100, ponto de partida
-- razoável pra poucos milhares de linhas).
create index if not exists idx_agent_examples_embedding
  on agent_examples using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ============================================================
-- Copiloto comercial — insights de IA em tempo real (ver HANDOFF,
-- feature pedida em 2026-08-20/Parte DW, implementada 2026-08-27).
-- Distinto do Agente de IA (agent_config/agent_*): o Agente de IA
-- ATENDE o lead sozinho; o copiloto só SUGERE pro atendente humano
-- durante uma conversa em andamento, em instâncias marcadas
-- "comercial" (setor que vende precatórios).
-- ============================================================

-- Config por instância comercial — mesmo padrão exato de agent_config
-- (PK session_id, nasce enabled=false). `playbook` é texto livre com
-- as regras do negócio (ex: margem mínima aceitável, documento aceito,
-- prazo nunca prometido abaixo de X) — entra no prompt da IA junto do
-- transcript. `topics` é a lista fixa (mas editável) de tópicos que a
-- IA usa pra classificar cada insight — ver src/insightGenerator.js.
create table if not exists commercial_config (
  session_id text primary key references instances(id) on delete cascade,
  enabled boolean not null default false,
  playbook text,
  topics jsonb not null default '["Passo a passo de documento","Análise de contraproposta","Objeção de preço","Qualificação do lead","Próximo passo"]',
  updated_at timestamptz not null default now()
);

-- Estado de anti-flood — POR CONVERSA, não por instância (cada
-- conversa tem seu próprio ritmo de geração). Checado ANTES de chamar
-- a OpenAI (barato): se `last_generated_at` foi há menos de ~60s, ou
-- se `last_message_id_considered` já é a última mensagem da conversa,
-- a geração é pulada. Ver src/insightGenerator.js::shouldGenerate.
create table if not exists conversation_insight_state (
  conversation_id bigint primary key references conversations(id) on delete cascade,
  last_generated_at timestamptz,
  last_message_id_considered text
);

-- Um insight gerado pela IA sobre uma conversa comercial em andamento.
-- Tabela PRÓPRIA, não reaproveita internal_notes — ciclos de vida
-- diferentes (insight tem topic/confidence/feedback/status que nota
-- não tem; nota tem edição/revisões que insight não tem).
-- `status`: 'active' (visível, ação pendente) → 'dismissed' (atendente
-- descartou) ou 'sent' (texto foi enviado ao cliente via
-- POST /api/insights/:id/send). `feedback`: sinal do atendente sobre
-- a qualidade do insight, não afeta o comportamento da IA ainda (fica
-- registrado pra eventual ajuste de prompt no futuro).
create table if not exists conversation_insights (
  id bigserial primary key,
  conversation_id bigint not null references conversations(id) on delete cascade,
  topic text not null,
  title text not null,
  body text not null,
  confidence text check (confidence in ('high','medium','low')),
  status text not null default 'active' check (status in ('active','dismissed','sent')),
  feedback text check (feedback in ('useful','not_useful')),
  tokens_used int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_conversation_insights_conv
  on conversation_insights (conversation_id, created_at);

-- ================================================================
-- Web Push (Service Worker) — inscrições por DONO do Bitrix (não por
-- instância/sessão de WhatsApp: um push notifica o USUÁRIO, independente
-- de qual instância caiu). Um owner pode ter múltiplas subscriptions
-- (várias abas/navegadores/dispositivos já deram permissão) — todas
-- recebem. `endpoint` é o identificador único de verdade (dado pelo
-- próprio navegador via PushManager.subscribe) — unique sozinho, não
-- unique(owner_id, endpoint), porque já é globalmente único por definição
-- da Push API. `p256dh`/`auth` são as chaves de criptografia exigidas
-- pela lib `web-push`. Usado por src/webpush.js, chamado a partir de
-- src/alertDispatcher.js quando uma instância precisa de atenção
-- (ver HANDOFF Parte FC).
-- ================================================================
create table if not exists push_subscriptions (
  id bigserial primary key,
  owner_id text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_push_subscriptions_owner on push_subscriptions (owner_id);
