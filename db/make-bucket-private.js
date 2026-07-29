// Flipa o bucket "media" do Supabase Storage pra privado (roda uma vez).
// Rodar só DEPOIS de: (1) o código novo estar no ar (rota GET /media/:filename
// + src/media.js devolvendo caminho relativo) e (2) db/migrate-media-urls.js
// já ter reescrito o histórico antigo — senão mídia (nova ou antiga) fica
// inacessível entre este comando e os outros dois.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const { data, error } = await supabase.storage.updateBucket('media', { public: false });
  if (error) throw error;
  console.log('[make-bucket-private] bucket "media" agora é privado.', data);
}

main().catch((err) => {
  console.error('[make-bucket-private] falhou:', err.message);
  process.exit(1);
});
