// Roda db/schema.sql contra o Postgres do Supabase. Usa DIRECT_URL (pooler de
// sessão) — o pooler de transação (DATABASE_URL/pgbouncer) não suporta bem
// múltiplos statements/DDL na mesma conexão.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  const client = new Client({ connectionString: process.env.DIRECT_URL });
  await client.connect();
  try {
    await client.query(sql);
    console.log('[migrate] schema aplicado com sucesso.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[migrate] falhou:', err.message);
  process.exit(1);
});
