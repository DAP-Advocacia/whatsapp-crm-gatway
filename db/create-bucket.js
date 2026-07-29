// Cria o bucket "media" no Supabase Storage (roda uma vez). Privado — mídia
// é servida via signed URL de curta duração pela rota autenticada
// GET /api/whatsapp/media/:filename (ver src/media.js), não por URL pública
// permanente. Instalação nova não precisa do passo de db/make-bucket-private.js,
// que existe só pra migrar um bucket já criado como público antes desta mudança.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;

  if (buckets.some((b) => b.name === 'media')) {
    console.log('[create-bucket] bucket "media" já existe.');
    return;
  }

  const { error } = await supabase.storage.createBucket('media', {
    public: false,
    fileSizeLimit: '25MB',
  });
  if (error) throw error;
  console.log('[create-bucket] bucket "media" criado com sucesso (privado).');
}

main().catch((err) => {
  console.error('[create-bucket] falhou:', err.message);
  process.exit(1);
});
