// Migra data/messages.json (+ mídia local em data/media/) para o Supabase.
// Só migra conversas com dealId vinculado — o resto é ruído (grupos/spam do
// WhatsApp que uma das sessões participa, sem relação com nenhum negócio) e
// não vale gastar a cota de storage gratuita do Supabase com isso.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MESSAGES_FILE = path.join(__dirname, '..', 'data', 'messages.json');
const MEDIA_DIR = path.join(__dirname, '..', 'data', 'media');

function isLegacyFlatEntry(value) {
  return value && Array.isArray(value.messages);
}

async function uploadLocalMedia(localRelativeUrl, wantedFilename, mimetype) {
  // localRelativeUrl é algo como "/media/3EB0....jpg"
  const filename = path.basename(localRelativeUrl);
  const localPath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(localPath)) {
    console.warn(`  [aviso] arquivo de mídia não encontrado localmente: ${filename}`);
    return null;
  }
  const buffer = fs.readFileSync(localPath);
  const { error } = await supabase.storage
    .from('media')
    .upload(wantedFilename, buffer, { upsert: true, contentType: mimetype || undefined });
  if (error) {
    console.warn(`  [aviso] falha ao subir mídia ${filename}:`, error.message);
    return null;
  }
  const { data } = supabase.storage.from('media').getPublicUrl(wantedFilename);
  return data.publicUrl;
}

async function main() {
  const db = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'));

  let conversasMigradas = 0;
  let mensagensMigradas = 0;
  let midiasMigradas = 0;

  for (const sessionId of Object.keys(db)) {
    const sessionEntry = db[sessionId];
    if (isLegacyFlatEntry(sessionEntry)) continue;

    for (const phone of Object.keys(sessionEntry)) {
      const entry = sessionEntry[phone];
      if (!entry?.dealId || !Array.isArray(entry.messages) || !entry.messages.length) continue;

      console.log(`Migrando ${sessionId} / ${phone} (negócio #${entry.dealId}, ${entry.messages.length} mensagens)...`);

      const { rows } = await pool.query(
        `insert into conversations (session_id, phone, deal_id)
         values ($1, $2, $3)
         on conflict (session_id, phone) do update set deal_id = $3
         returning id`,
        [sessionId, phone, entry.dealId]
      );
      const conversationId = rows[0].id;
      conversasMigradas++;

      for (const m of entry.messages) {
        let mediaUrl = m.mediaUrl || null;

        if (mediaUrl && mediaUrl.startsWith('/media/')) {
          const ext = path.extname(mediaUrl);
          const newFilename = `${m.id}${ext}`;
          const uploaded = await uploadLocalMedia(mediaUrl, newFilename, m.mimetype);
          if (uploaded) {
            mediaUrl = uploaded;
            midiasMigradas++;
          }
        }

        const { rowCount } = await pool.query(
          `insert into messages
             (conversation_id, wa_message_id, direction, type, text, media_url, mimetype, status, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict (conversation_id, wa_message_id) do nothing`,
          [
            conversationId,
            m.id,
            m.direction,
            m.type || 'text',
            m.text ?? null,
            mediaUrl,
            m.mimetype ?? null,
            m.status ?? null,
            m.createdAt,
          ]
        );
        if (rowCount > 0) mensagensMigradas++;
      }
    }
  }

  console.log('');
  console.log(`Concluído: ${conversasMigradas} conversas, ${mensagensMigradas} mensagens, ${midiasMigradas} arquivos de mídia migrados.`);
  await pool.end();
}

main().catch((err) => {
  console.error('[import-legacy-data] falhou:', err);
  process.exit(1);
});
