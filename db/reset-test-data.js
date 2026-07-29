// Roda db/reset-test-data.sql contra o Postgres do Supabase — apaga os dados
// de teste (conversas, instâncias, contatos, campanhas, LPs) preservando
// app_settings e message_templates. Usa DIRECT_URL, igual db/migrate.js.
//
// IRREVERSÍVEL. Por isso exige --yes explícito:
//   node db/reset-test-data.js --yes
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Contagem antes/depois pra ficar registrado no terminal o que de fato saiu —
// TRUNCATE não devolve rowcount, então sem isso o script roda em silêncio e
// não dá pra saber se apagou 5 mil mensagens ou nenhuma.
const TABLES = [
  'conversations',
  'messages',
  'instances',
  'contacts',
  'campaigns',
  'lead_forms',
  'lead_form_submissions',
];

async function counts(client) {
  const out = {};
  for (const t of TABLES) {
    const { rows } = await client.query(`select count(*)::int as n from ${t}`);
    out[t] = rows[0].n;
  }
  return out;
}

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error('[reset] isto APAGA os dados de teste e não tem volta.');
    console.error('[reset] confirme com: node db/reset-test-data.js --yes');
    process.exit(1);
  }

  const sql = fs.readFileSync(path.join(__dirname, 'reset-test-data.sql'), 'utf-8');
  const client = new Client({ connectionString: process.env.DIRECT_URL });
  await client.connect();
  try {
    const before = await counts(client);
    console.log('[reset] antes:', before);

    await client.query(sql);

    const after = await counts(client);
    console.log('[reset] depois:', after);
    console.log('[reset] concluído. app_settings e message_templates preservadas.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[reset] falhou:', err.message);
  process.exit(1);
});
