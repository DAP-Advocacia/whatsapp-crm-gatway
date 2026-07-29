// Migração ÚNICA de dados: copia todas as linhas do projeto Supabase antigo
// (conta pessoal) pro projeto novo (conta da empresa) — schema/buckets já
// precisam ter sido criados no destino antes (db/migrate.js,
// db/create-bucket.js, db/create-public-bucket.js).
//
// NÃO usa DATABASE_URL/DIRECT_URL do .env (esses continuam apontando pro
// banco antigo até o corte final) — lê OLD_DIRECT_URL e NEW_DIRECT_URL,
// passados na hora de rodar (nunca gravados em arquivo nenhum), ex:
//   OLD_DIRECT_URL="postgresql://...antigo..." NEW_DIRECT_URL="postgresql://...novo..." node db/migrate-to-company-supabase.js
//
// Ordem das tabelas respeita as foreign keys (pai antes do filho, ver
// db/schema.sql). IDs são preservados na cópia (senão as referências entre
// tabelas quebrariam) — por isso, ao final, cada sequência bigserial é
// resincronizada pro próximo valor livre, senão o primeiro INSERT novo
// depois do corte colidiria com um ID já migrado.
require('dotenv').config();
const { Client } = require('pg');

const TABLE_ORDER = [
  'conversations', 'contacts', 'contact_lists', 'message_templates', 'campaigns',
  'instances', 'tags', 'wa_groups', 'notifications', 'suggestions', 'app_settings', 'lead_forms',
  'conversation_summaries', 'messages', 'contact_list_members', 'campaign_results',
  'scheduled_campaigns', 'conversation_tags', 'lead_form_submissions', 'lead_form_views', 'ab_tests',
];

// Tabelas com id bigserial (precisam de setval no final) — as de fora dessa
// lista usam `id text` gerado pela própria aplicação (campaigns,
// scheduled_campaigns, instances, notifications) ou são tabelas de junção
// sem coluna `id` (ver CONFLICT_TARGET_BY_TABLE), nenhuma das duas usa
// sequência do Postgres.
const BIGSERIAL_TABLES = new Set([
  'conversations', 'contacts', 'contact_lists', 'message_templates',
  'tags', 'suggestions', 'app_settings', 'lead_forms',
  'conversation_summaries', 'messages', 'campaign_results',
  'lead_form_submissions', 'ab_tests',
]);

// Tabelas de junção (chave composta, sem coluna `id`) — conflito é pela
// combinação de FKs, não por `id` como nas demais.
const CONFLICT_TARGET_BY_TABLE = {
  contact_list_members: 'list_id, contact_id',
  conversation_tags: 'conversation_id, tag_id',
  lead_form_views: 'form_id, day',
};

// `pg` serializa array/objeto JS puro como array literal do Postgres, não
// como JSON — precisa stringificar à mão pra colunas jsonb (ex:
// scheduled_campaigns.recipients, lead_forms.testimonials/stats/...).
// Date passa direto (pg já sabe serializar timestamptz a partir de Date).
function normalize(value) {
  if (value === null || value instanceof Date) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

async function copyTable(oldClient, newClient, table) {
  const { rows } = await oldClient.query(`select * from ${table}`);
  if (!rows.length) {
    console.log(`[migrate-data] ${table}: 0 linhas, pulando.`);
    return;
  }
  const columns = Object.keys(rows[0]);
  const colList = columns.map((c) => `"${c}"`).join(', ');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const conflictTarget = CONFLICT_TARGET_BY_TABLE[table] || 'id';
  const insertSql = `insert into ${table} (${colList}) values (${placeholders}) on conflict (${conflictTarget}) do nothing`;

  let inserted = 0;
  for (const row of rows) {
    const values = columns.map((c) => normalize(row[c]));
    await newClient.query(insertSql, values);
    inserted++;
  }
  console.log(`[migrate-data] ${table}: ${inserted}/${rows.length} linhas copiadas.`);
}

async function resyncSequence(newClient, table) {
  await newClient.query(
    `select setval(pg_get_serial_sequence('${table}', 'id'), coalesce((select max(id) from ${table}), 1))`
  );
}

async function main() {
  const oldUrl = process.env.OLD_DIRECT_URL;
  const newUrl = process.env.NEW_DIRECT_URL;
  if (!oldUrl || !newUrl) {
    throw new Error('defina OLD_DIRECT_URL e NEW_DIRECT_URL antes de rodar (nunca em arquivo, só na hora de chamar o script)');
  }

  const oldClient = new Client({ connectionString: oldUrl });
  const newClient = new Client({ connectionString: newUrl });
  await oldClient.connect();
  await newClient.connect();

  try {
    for (const table of TABLE_ORDER) {
      await copyTable(oldClient, newClient, table);
    }
    console.log('[migrate-data] resincronizando sequências...');
    for (const table of TABLE_ORDER) {
      if (BIGSERIAL_TABLES.has(table)) await resyncSequence(newClient, table);
    }
    console.log('[migrate-data] concluído.');
  } finally {
    await oldClient.end();
    await newClient.end();
  }
}

main().catch((err) => {
  console.error('[migrate-data] falhou:', err.message);
  process.exit(1);
});
