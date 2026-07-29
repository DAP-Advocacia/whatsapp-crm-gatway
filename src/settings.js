const { pool } = require('./db');

/**
 * Configurações editáveis pela tela `public/settings.html` — linha única
 * (singleton, id=1), mesmo escopo "uma instalação = uma empresa" já usado
 * por BRAND_NAME/BRAND_COLOR (ver GET /api/brand em src/server.js). Paleta:
 * `accentColor` (dourado padrão), `accentColorDim` (tom secundário —
 * hovers/bordas), `greenColor`/`redColor` (sucesso/erro). Qualquer campo
 * null mantém a cor padrão do app pra aquele papel.
 */

const FIELDS = {
  accentColor: 'accent_color',
  accentColorDim: 'accent_color_dim',
  greenColor: 'green_color',
  redColor: 'red_color',
  bgColor: 'bg_color',
};

const SELECT_COLUMNS = Object.entries(FIELDS)
  .map(([apiField, column]) => `${column} as "${apiField}"`)
  .join(', ');

async function get() {
  const { rows } = await pool.query(`select ${SELECT_COLUMNS} from app_settings where id = 1`);
  if (rows[0]) return rows[0];
  return Object.fromEntries(Object.keys(FIELDS).map((k) => [k, null]));
}

// `patch`: objeto com qualquer subconjunto dos campos acima — só atualiza
// os que vierem definidos (permite salvar um de cada vez ou todos juntos).
async function update(patch) {
  const sets = [];
  const values = [];
  for (const [apiField, column] of Object.entries(FIELDS)) {
    if (!(apiField in patch)) continue;
    values.push(patch[apiField] || null);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return get();

  const { rows } = await pool.query(
    `update app_settings set ${sets.join(', ')}, updated_at = now() where id = 1 returning ${SELECT_COLUMNS}`,
    values
  );
  return rows[0];
}

module.exports = { get, update };
