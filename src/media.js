const { createClient } = require('@supabase/supabase-js');

/**
 * Salva bytes de mídia (imagem/áudio/vídeo) recebida ou enviada no bucket
 * "media" do Supabase Storage (ver db/create-bucket.js e
 * db/make-bucket-private.js — o bucket é privado). Devolve um caminho
 * relativo (`/api/whatsapp/media/<filename>`), não a URL do Supabase — quem
 * for exibir a mídia busca por essa rota autenticada (ver
 * GET /media/:filename em src/routes/whatsapp.js), que gera uma signed URL
 * de curta duração na hora. O frontend (chat.html/index.html,
 * `hydrateMedia()`) já sabe buscar URLs relativas de forma autenticada.
 */

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const BUCKET = 'media';

const EXT_BY_MIMETYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/vnd.rar': 'rar',
  'application/json': 'json',
};

function extFor(mimetype) {
  // navegadores mandam mimetype com parâmetros extras, ex: "audio/webm;codecs=opus"
  // (o gravador de áudio embutido na aba faz isso) — ignora tudo depois do ';'
  const base = String(mimetype || '').split(';')[0].trim();
  return EXT_BY_MIMETYPE[base] || 'bin';
}

// `id` é o WA_MSG_ID que o próprio WhatsApp/Baileys atribui à mensagem —
// único DENTRO de uma conta/instância, mas não entre instâncias diferentes
// (cada número gera o próprio espaço de ids, sem coordenação entre eles).
// Sem o prefixo de sessionId, duas instâncias distintas podiam gerar o
// mesmo key.id pra mensagens diferentes; como o upload usa upsert:true, a
// segunda sobrescrevia o arquivo da primeira no Storage — e as DUAS
// mensagens no banco ficavam apontando pro mesmo mediaUrl, exibindo o
// mesmo áudio/imagem em conversas de instâncias diferentes (bug real
// reportado pelo usuário: mesmo áudio aparecendo em duas conversas).
async function saveMedia(sessionId, id, buffer, mimetype) {
  const filename = `${encodeURIComponent(sessionId)}/${id}.${extFor(mimetype)}`;
  const { error } = await supabase.storage.from(BUCKET).upload(filename, buffer, {
    contentType: mimetype,
    upsert: true,
  });
  if (error) throw error;

  return `/api/whatsapp/media/${encodeURIComponent(filename)}`;
}

// Signed URL de curta duração pra um arquivo já salvo — usada pela rota
// GET /media/:filename (redireciona pra ela em vez de expor o filename cru).
async function getSignedMediaUrl(filename, expiresIn = 300) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(filename, expiresIn);
  if (error) throw error;
  return data.signedUrl;
}

// Busca os bytes de uma mídia já salva a partir do caminho relativo devolvido
// por saveMedia (`/api/whatsapp/media/<filename>`) — uso server-to-server
// (ver src/scheduler.js), sem passar pela rota HTTP nem gerar signed URL.
async function downloadMedia(relativeUrl) {
  const filename = decodeURIComponent(String(relativeUrl).split('/').pop());
  const { data, error } = await supabase.storage.from(BUCKET).download(filename);
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

module.exports = { saveMedia, getSignedMediaUrl, downloadMedia };
