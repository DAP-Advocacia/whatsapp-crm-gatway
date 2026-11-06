-- Painel de auditoria/monitoramento (public/painel.html, src/routes/panel.js).
-- SQL AVULSO: só cria tabelas NOVAS (nada de alterar tabela existente), então não trava
-- o app. Rodar no Supabase com:  set lock_timeout = '3s';  e depois este arquivo.
-- Sem estas tabelas o resto do DapZap funciona normal; só o painel mostra o aviso.

-- Quem entra no painel (login + senha). Senha guardada só como hash scrypt; criar/trocar
-- com:  node scripts/panel-user.js <login> "<Nome>"
create table if not exists panel_users (
  id bigserial primary key,
  username text not null unique,
  display_name text,
  password_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- Configurações do monitor (monitor_enabled, monitor_enabled_at, grace_minutes,
-- digest_enabled, digest_hour).
create table if not exists panel_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Regras de "quem recebe o alerta de quem". Prioridade: pessoa > departamento > gestor do
-- perfil no Bitrix ([GER]/[DIR]/chefe do departamento).
--   scope_type = 'person'      -> scope_value = ID do usuário no Bitrix
--   scope_type = 'department'  -> scope_value = nome do departamento de topo (como no Bitrix)
create table if not exists alert_routes (
  id bigserial primary key,
  scope_type text not null check (scope_type in ('person', 'department')),
  scope_value text not null,
  scope_label text,
  recipient_bitrix_id text not null,
  recipient_name text,
  note text,
  created_by text,
  created_at timestamptz not null default now(),
  unique (scope_type, scope_value)
);

-- Tudo que o monitor/painel decidiu enviar (ou deixou de enviar). A chave única impede
-- avisar duas vezes do mesmo evento para o mesmo destinatário.
--   kind:   deslogou_celular | removida_dapzap | substituida | queda_prolongada | resumo | manual
--   status: enviado | simulado (monitor desligado) | sem_destinatario | falhou
create table if not exists monitor_alerts (
  id bigserial primary key,
  kind text not null,
  instance_id text not null default '',
  owner_id text,
  person_name text,
  phone text,
  reason text,
  event_at timestamptz not null default now(),
  recipient_bitrix_id text not null default '',
  recipient_name text,
  route_source text,
  status text not null check (status in ('enviado', 'simulado', 'sem_destinatario', 'falhou')),
  detail text,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_monitor_alerts_event
  on monitor_alerts (kind, instance_id, event_at, recipient_bitrix_id)
  where kind <> 'manual';
create index if not exists idx_monitor_alerts_created on monitor_alerts (created_at desc);
create index if not exists idx_monitor_alerts_recipient on monitor_alerts (recipient_bitrix_id, created_at desc);

-- Quem fez o quê no painel (disparo manual, regra criada/removida, monitor ligado...).
create table if not exists panel_audit (
  id bigserial primary key,
  username text not null,
  action text not null,
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists idx_panel_audit_created on panel_audit (created_at desc);
