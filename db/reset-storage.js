// Esvazia os buckets do Supabase Storage usados pelo app:
//   "media"         — mídia de conversa (privado, ver src/media.js)
//   "public-assets" — imagens/vídeos das LPs (público, ver src/publicAssets.js)
//
// Os buckets em si continuam existindo — só o conteúdo sai. IRREVERSÍVEL:
//   node db/reset-storage.js --yes
//   node db/reset-storage.js --yes --only=media     (só um bucket)
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const BUCKETS = ['media', 'public-assets'];

// A Storage API lista no máximo 100 itens por chamada e não remove recursivo,
// então precisamos paginar e descer nas subpastas (media usa uma pasta por
// sessão; public-assets tem a pasta de vídeo do hero).
async function listAll(supabase, bucket, prefix = '') {
  const files = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: pageSize, offset });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const item of data) {
      const full = prefix ? `${prefix}/${item.name}` : item.name;
      // item sem metadata (id null) = "pasta" virtual, precisa descer nela
      if (item.id === null) {
        files.push(...(await listAll(supabase, bucket, full)));
      } else {
        files.push(full);
      }
    }
    if (data.length < pageSize) break;
  }
  return files;
}

async function emptyBucket(supabase, bucket) {
  const files = await listAll(supabase, bucket);
  if (files.length === 0) {
    console.log(`[storage] ${bucket}: já está vazio.`);
    return;
  }
  // remove() também tem limite por chamada — vai em lotes.
  const CHUNK = 100;
  for (let i = 0; i < files.length; i += CHUNK) {
    const chunk = files.slice(i, i + CHUNK);
    const { error } = await supabase.storage.from(bucket).remove(chunk);
    if (error) throw new Error(`remove ${bucket}: ${error.message}`);
    console.log(`[storage] ${bucket}: removidos ${i + chunk.length}/${files.length}`);
  }
}

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error('[storage] isto APAGA os arquivos dos buckets e não tem volta.');
    console.error('[storage] confirme com: node db/reset-storage.js --yes');
    process.exit(1);
  }

  const only = process.argv.find((a) => a.startsWith('--only='));
  const targets = only ? [only.split('=')[1]] : BUCKETS;

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  for (const bucket of targets) {
    await emptyBucket(supabase, bucket);
  }
  console.log('[storage] concluído.');
}

main().catch((err) => {
  console.error('[storage] falhou:', err.message);
  process.exit(1);
});
