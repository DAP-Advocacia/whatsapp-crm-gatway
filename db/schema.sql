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
