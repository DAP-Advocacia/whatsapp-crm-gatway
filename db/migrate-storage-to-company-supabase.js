// Migração ÚNICA dos arquivos de Storage (buckets "media" e
// "public-assets") do projeto Supabase antigo pro novo — roda depois de
// db/migrate-to-company-supabase.js (dados) e com os buckets já criados no
// destino (db/create-bucket.js, db/create-public-bucket.js).
//
// Credenciais nunca em arquivo — passadas na hora de rodar:
//   OLD_SUPABASE_URL=... OLD_SUPABASE_KEY=... NEW_SUPABASE_URL=... NEW_SUPABASE_KEY=... node db/migrate-storage-to-company-supabase.js
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BUCKETS = ['media', 'public-assets'];

// Storage do Supabase não tem "listar tudo recursivo" nativo — list() só
// devolve um nível; pasta é reconhecida por `id === null` (arquivo sempre
// tem um id). Percorre recursivamente pra achar todo arquivo, em qualquer
// profundidade (public-assets tem logos/<ownerId>/... e hero/<ownerId>/...).
async function listAllFiles(client, bucket, prefix = '') {
  const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error) throw error;
  let files = [];
  for (const entry of data) {
    const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.id === null) {
      files = files.concat(await listAllFiles(client, bucket, fullPath));
    } else {
      // `list()` já devolve o mimetype original guardado (entry.metadata.mimetype)
      // — sem passar isso de volta no upload, o SDK assume "text/plain" por
      // padrão, que o bucket "public-assets" rejeita (só aceita as extensões de
      // imagem/vídeo configuradas em db/create-public-bucket.js).
      files.push({ path: fullPath, mimetype: entry.metadata?.mimetype });
    }
  }
  return files;
}

async function copyBucket(oldClient, newClient, bucket) {
  const files = await listAllFiles(oldClient, bucket);
  console.log(`[migrate-storage] ${bucket}: ${files.length} arquivo(s) encontrados.`);
  let copied = 0;
  let failed = 0;
  for (const { path, mimetype } of files) {
    try {
      const { data, error: downloadError } = await oldClient.storage.from(bucket).download(path);
      if (downloadError) throw downloadError;
      const buffer = Buffer.from(await data.arrayBuffer());
      const { error: uploadError } = await newClient.storage
        .from(bucket)
        .upload(path, buffer, { upsert: true, contentType: mimetype || undefined });
      if (uploadError) throw uploadError;
      copied++;
    } catch (err) {
      failed++;
      console.error(`[migrate-storage] falha em ${bucket}/${path}:`, err.message);
    }
  }
  console.log(`[migrate-storage] ${bucket}: ${copied}/${files.length} copiados (${failed} falha(s)).`);
}

async function main() {
  const { OLD_SUPABASE_URL, OLD_SUPABASE_KEY, NEW_SUPABASE_URL, NEW_SUPABASE_KEY } = process.env;
  if (!OLD_SUPABASE_URL || !OLD_SUPABASE_KEY || !NEW_SUPABASE_URL || !NEW_SUPABASE_KEY) {
    throw new Error('defina OLD_SUPABASE_URL, OLD_SUPABASE_KEY, NEW_SUPABASE_URL, NEW_SUPABASE_KEY antes de rodar');
  }
  const oldClient = createClient(OLD_SUPABASE_URL, OLD_SUPABASE_KEY);
  const newClient = createClient(NEW_SUPABASE_URL, NEW_SUPABASE_KEY);

  for (const bucket of BUCKETS) {
    await copyBucket(oldClient, newClient, bucket);
  }
  console.log('[migrate-storage] concluído.');
}

main().catch((err) => {
  console.error('[migrate-storage] falhou:', err.message);
  process.exit(1);
});
