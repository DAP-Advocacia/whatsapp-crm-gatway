// Reescreve messages.media_url das URLs públicas antigas do Supabase Storage
// (`.../storage/v1/object/public/media/<filename>`) pro novo formato relativo
// (`/api/whatsapp/media/<filename>`), usado pela rota autenticada que gera
// signed URLs — necessário porque o bucket "media" vira privado (ver
// db/make-bucket-private.js). Rodar ANTES de flipar o bucket, senão a mídia
// antiga fica quebrada até essa migração rodar. Idempotente: mensagens já no
// formato novo (não batem no padrão de URL pública) são ignoradas.
require('dotenv').config();
const { pool } = require('../src/db');

const PUBLIC_URL_PREFIX = `${process.env.SUPABASE_URL}/storage/v1/object/public/media/`;

async function main() {
  const { rows } = await pool.query(
    `select id, media_url from messages where media_url like $1`,
    [`${PUBLIC_URL_PREFIX}%`]
  );

  if (!rows.length) {
    console.log('[migrate-media-urls] nenhuma URL pública antiga encontrada — nada a fazer.');
    return;
  }

  console.log(`[migrate-media-urls] ${rows.length} mensagem(ns) com URL pública antiga — reescrevendo...`);
  for (const row of rows) {
    const filename = row.media_url.slice(PUBLIC_URL_PREFIX.length);
    const newUrl = `/api/whatsapp/media/${encodeURIComponent(filename)}`;
    await pool.query(`update messages set media_url = $1 where id = $2`, [newUrl, row.id]);
  }
  console.log(`[migrate-media-urls] ${rows.length} mensagem(ns) atualizada(s) com sucesso.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate-media-urls] falhou:', err.message);
    process.exit(1);
  });
