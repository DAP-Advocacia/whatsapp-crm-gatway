// Cria o bucket "public-assets" no Supabase Storage (roda uma vez). PÚBLICO
// de propósito — diferente do bucket "media" (mídia de WhatsApp, privada):
// aqui ficam imagens de logo, e imagem OU VÍDEO de fundo do hero dos
// formulários de lead (Sites), que precisam de uma URL permanente acessível
// por qualquer visitante da página pública (/l/<slug>), sem passar por
// signed URL. Ver src/publicAssets.js. Limite de 25MB cobre o pior caso
// (vídeo de hero) — Supabase não permite limite diferente por subpasta
// dentro do mesmo bucket, então logo/imagem (bem mais leves na prática)
// herdam o mesmo teto.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ALLOWED_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime'];

async function main() {
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;

  if (buckets.some((b) => b.name === 'public-assets')) {
    const { error } = await supabase.storage.updateBucket('public-assets', {
      public: true,
      fileSizeLimit: '25MB',
      allowedMimeTypes: ALLOWED_MIMETYPES,
    });
    if (error) throw error;
    console.log('[create-public-bucket] bucket "public-assets" já existia — limite atualizado pra 25MB (imagem + vídeo).');
    return;
  }

  const { error } = await supabase.storage.createBucket('public-assets', {
    public: true,
    fileSizeLimit: '25MB',
    allowedMimeTypes: ALLOWED_MIMETYPES,
  });
  if (error) throw error;
  console.log('[create-public-bucket] bucket "public-assets" criado com sucesso (público).');
}

main().catch((err) => {
  console.error('[create-public-bucket] falhou:', err.message);
  process.exit(1);
});
