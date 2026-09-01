const { pool } = require('./db');

/**
 * Paleta de cores editável pela tela `public/settings.html` — POR
 * USUÁRIO (`user_palette`, `owner_id` como chave), não mais um singleton
 * global (a tabela antiga `app_settings` existe ainda, mas deixou de ser
 * lida/escrita por aqui). Nome/subtítulo da marca (GET /api/brand,
 * pública) continuam globais de propósito — isto aqui é só a paleta:
 * `accentColor` (dourado padrão), `accentColorDim` (tom secundário —
 * hovers/bordas), `greenColor`/`redColor` (sucesso/erro). Qualquer campo
 * `null` mantém a cor padrão do app pra aquele papel — cada usuário sem
 * linha salva ainda usa o padrão de fábrica.
 *
 * `bgColor` (2026-08-30): coluna `bg_color` MANTIDA no schema/aqui por
 * compatibilidade, mas nunca mais lida/escrita — a versão original
 * dava à paleta pessoal o poder de escrever `--bg`, colidindo com o
 * switch de tema claro/escuro (corrida real). `bgColorDark`/
 * `bgColorLight` (2026-09-01) trazem cor de fundo de volta, mas
 * redesenhada: 1 cor POR TEMA, cada uma só aplicada quando o tema
 * correspondente está ativo — nunca competindo com o CSS do tema (ver
 * public/settings.html, applyCachedBgPalette nas páginas com sidebar).
 */

const FIELDS = {
  accentColor: 'accent_color',
  accentColorDim: 'accent_color_dim',
  greenColor: 'green_color',
  redColor: 'red_color',
  bgColor: 'bg_color',
  bgColorDark: 'bg_color_dark',
  bgColorLight: 'bg_color_light',
};

const SELECT_COLUMNS = Object.entries(FIELDS)
  .map(([apiField, column]) => `${column} as "${apiField}"`)
  .join(', ');

async function get(ownerId) {
  const { rows } = await pool.query(`select ${SELECT_COLUMNS} from user_palette where owner_id = $1`, [ownerId]);
  if (rows[0]) return rows[0];
  return Object.fromEntries(Object.keys(FIELDS).map((k) => [k, null]));
}

// `patch`: objeto com qualquer subconjunto dos campos acima — só atualiza
// os que vierem definidos (permite salvar um de cada vez ou todos juntos).
// Upsert: primeira vez que este owner salva algo, cria a linha; depois,
// atualiza só os campos enviados, preservando os demais já salvos.
async function update(ownerId, patch) {
  const fieldsToSet = Object.keys(FIELDS).filter((apiField) => apiField in patch);
  if (!fieldsToSet.length) return get(ownerId);

  const columns = ['owner_id', ...fieldsToSet.map((f) => FIELDS[f])];
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const values = [ownerId, ...fieldsToSet.map((f) => patch[f] || null)];
  const updateSets = fieldsToSet.map((f) => `${FIELDS[f]} = excluded.${FIELDS[f]}`).join(', ');

  const { rows } = await pool.query(
    `insert into user_palette (${columns.join(', ')})
     values (${placeholders.join(', ')})
     on conflict (owner_id) do update set ${updateSets}, updated_at = now()
     returning ${SELECT_COLUMNS}`,
    values
  );
  return rows[0];
}

module.exports = { get, update };
