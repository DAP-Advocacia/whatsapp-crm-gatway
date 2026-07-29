-- Limpeza dos dados de teste — mantém só app_settings e message_templates.
-- Rodar via `node db/reset-test-data.js` (usa DIRECT_URL, igual migrate.js).
--
-- ATENÇÃO: TRUNCATE é irreversível e não dá pra desfazer com rollback depois
-- do commit. As tabelas em si continuam existindo (schema intacto) — só os
-- registros vão embora. Feito num TRUNCATE único porque as FKs entre elas
-- exigem que caiam juntas.
--
-- RESTART IDENTITY zera os bigserial, então a próxima conversa volta a ser
-- id=1 (senão continuaria de onde os testes pararam).
--
-- CASCADE aqui é o do TRUNCATE (arrasta tabelas que referenciam estas), não
-- o `on delete cascade` do schema — por isso as filhas estão listadas
-- explicitamente: fica óbvio no diff o que exatamente é apagado.

begin;

truncate table
  -- conversas e tudo que pende delas
  conversations,
  conversation_summaries,
  conversation_tags,
  messages,
  -- instâncias conectadas / grupos / avisos
  instances,
  wa_groups,
  notifications,
  -- contatos e listas
  contacts,
  contact_lists,
  contact_list_members,
  tags,
  -- campanhas
  campaigns,
  campaign_results,
  scheduled_campaigns,
  -- landing pages e testes A/B
  lead_forms,
  lead_form_submissions,
  lead_form_views,
  ab_tests,
  -- sugestões (feedback interno)
  suggestions
restart identity cascade;

commit;

-- PRESERVADAS de propósito:
--   app_settings      — configuração do app (marca, tokens de API, etc)
--   message_templates — modelos de mensagem reaproveitáveis
