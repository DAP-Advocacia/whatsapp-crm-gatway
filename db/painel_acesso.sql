-- Acesso do painel por hierarquia (public/painel.html aberto pelo Bitrix, src/panelScope.js).
-- SQL AVULSO: só cria tabela NOVA. Rodar no Supabase com:  set lock_timeout = '3s';  e este arquivo.
-- Sem esta tabela tudo funciona: vale só a regra "quem chefia um departamento [CEO]/[DIR] vê a
-- subárvore dele". Esta tabela soma acessos que o Bitrix não expõe (supervisor adjunto) e exceções.
create table if not exists panel_access_grants (
  id bigserial primary key,
  bitrix_user_id text not null,        -- quem ganha o acesso (ID do usuário no Bitrix)
  user_label text,
  department_id text not null,         -- passa a ver este departamento e todos abaixo dele
  department_label text,
  note text,
  created_by text,
  created_at timestamptz not null default now(),
  unique (bitrix_user_id, department_id)
);

-- Auxiliares (adjuntos) e exceções combinadas em 06/11/2026.
insert into panel_access_grants (bitrix_user_id, user_label, department_id, department_label, note, created_by) values
  ('146542', 'Thais Maia',            '153',  '[CEO] Ana Caroline Carvalho Vital de Paula Pereira', 'adjunta da Ana Caroline', 'gabriel'),
  ('193286', 'Monalisa Figueiredo',   '1170', '[CEO] Adriano Santos de Almeida',                    'auxiliar do Adriano',     'gabriel'),
  ('193286', 'Monalisa Figueiredo',   '1491', '[CEO] Lorena Pontes',                                'auxiliar do Adriano',     'gabriel'),
  ('623',    'Adriano Santos de Almeida', '1491', '[CEO] Lorena Pontes',                            'Lorena atua como diretora da equipe do Adriano', 'gabriel')
on conflict do nothing;
