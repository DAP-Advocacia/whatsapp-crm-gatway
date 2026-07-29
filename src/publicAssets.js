const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

/**
 * Imagens públicas e permanentes de formulário de lead (logo, imagem de
 * fundo do hero — ver src/routes/leadForms.js) — bucket "public-assets" do
 * Supabase Storage, PÚBLICO de propósito (diferente do bucket "media"
 * usado pra mídia de WhatsApp, que é privado e servido por signed URL). Ver
 * db/create-public-bucket.js.
 */

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BUCKET = 'public-assets';

const EXT_BY_MIMETYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// Vídeo de fundo do hero — pasta própria (mesmo bucket público), mimetypes
// mais comuns exportados por celular (mp4/H.264) e navegador (webm).
const VIDEO_EXT_BY_MIMETYPE = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

async function saveAsset(ownerId, buffer, mimetype, folder, extByMimetype, errorLabel) {
  const ext = extByMimetype[mimetype];
  if (!ext) throw new Error(errorLabel);

  const filename = `${folder}/${ownerId}/${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(filename, buffer, {
    contentType: mimetype,
    upsert: true,
  });
  if (error) throw error;

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
  return data.publicUrl;
}

async function saveLogo(ownerId, buffer, mimetype) {
  return saveAsset(ownerId, buffer, mimetype, 'logos', EXT_BY_MIMETYPE, 'formato de imagem não suportado (use JPG, PNG, WEBP ou GIF)');
}

// Hero aceita imagem OU vídeo — `mimetype` decide qual pasta/validação usar;
// quem chama (ver src/routes/leadForms.js) descobre o `mediaType` resultante
// checando o próprio prefixo do mimetype recebido (mais simples que inspecionar
// o arquivo de novo aqui).
async function saveHeroImage(ownerId, buffer, mimetype) {
  if (mimetype.startsWith('video/')) {
    return saveAsset(ownerId, buffer, mimetype, 'hero', VIDEO_EXT_BY_MIMETYPE, 'formato de vídeo não suportado (use MP4, WEBM ou MOV)');
  }
  return saveAsset(ownerId, buffer, mimetype, 'hero', EXT_BY_MIMETYPE, 'formato de imagem não suportado (use JPG, PNG, WEBP ou GIF)');
}

module.exports = { saveLogo, saveHeroImage };
