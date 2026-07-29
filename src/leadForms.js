const crypto = require('crypto');
const { pool } = require('./db');

/**
 * Formulários públicos de captura de lead ("Sites") — cada um vira uma
 * página pública em /l/<slug> (sem login/Bitrix, ver src/routes/leads.js).
 * CRUD abaixo é do DONO (owner_id), igual contacts/contact_lists.
 */

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acento
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function isSlugTaken(slug) {
  const { rows } = await pool.query('select 1 from lead_forms where slug = $1', [slug]);
  return rows.length > 0;
}

// Gera um slug único a partir do nome do formulário — tenta o nome puro
// primeiro, senão acrescenta um sufixo aleatório curto até achar um livre.
async function generateSlug(name) {
  const base = slugify(name) || 'lead';
  if (!(await isSlugTaken(base))) return base;
  for (let i = 0; i < 8; i++) {
    const candidate = `${base}-${crypto.randomBytes(3).toString('hex')}`;
    if (!(await isSlugTaken(candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

const SELECT_FIELDS = `
  id, slug, owner_id as "ownerId", session_id as "sessionId", name, title, subtitle,
  welcome_message as "welcomeMessage", active, accent_color as "accentColor", logo_url as "logoUrl",
  hero_image_url as "heroImageUrl", hero_media_type as "heroMediaType",
  testimonials, stats, differentials, faq, story_title as "storyTitle", story_text as "storyText",
  created_at as "createdAt", updated_at as "updatedAt"
`;

// Mapa campo-da-API -> { coluna, jsonb } usado tanto por create() quanto por
// update() — evita repetir a lista de colunas em dois lugares conforme mais
// seções de LP forem adicionadas (stats, differentials, faq, depoimentos...).
const FIELD_COLUMNS = {
  name: { column: 'name' },
  title: { column: 'title' },
  subtitle: { column: 'subtitle' },
  welcomeMessage: { column: 'welcome_message' },
  sessionId: { column: 'session_id' },
  accentColor: { column: 'accent_color' },
  logoUrl: { column: 'logo_url' },
  heroImageUrl: { column: 'hero_image_url' },
  heroMediaType: { column: 'hero_media_type' },
  testimonials: { column: 'testimonials', jsonb: true },
  stats: { column: 'stats', jsonb: true },
  differentials: { column: 'differentials', jsonb: true },
  faq: { column: 'faq', jsonb: true },
  storyTitle: { column: 'story_title' },
  storyText: { column: 'story_text' },
};

async function listByOwner(ownerId) {
  const { rows } = await pool.query(
    `select f.*, coalesce(s.count, 0)::int as "leadCount",
       coalesce(s.sent_count, 0)::int as "whatsappSentCount",
       coalesce(v.views, 0)::int as "viewCount"
     from (select ${SELECT_FIELDS} from lead_forms where owner_id = $1) f
     left join (
       select form_id, count(*) as count, count(*) filter (where whatsapp_sent) as sent_count
       from lead_form_submissions group by form_id
     ) s on s.form_id = f.id
     left join (
       select form_id, sum(count)::int as views
       from lead_form_views group by form_id
     ) v on v.form_id = f.id
     order by f."createdAt" desc`,
    [ownerId]
  );
  return rows;
}

// Visualização da página pública — 1 incremento por carregamento (chamado
// em GET /api/leads/:slug/config), agregado por dia (ver schema).
async function recordView(formId) {
  await pool.query(
    `insert into lead_form_views (form_id, day, count) values ($1, current_date, 1)
     on conflict (form_id, day) do update set count = lead_form_views.count + 1`,
    [formId]
  );
}

async function get(id, ownerId) {
  const { rows } = await pool.query(
    `select ${SELECT_FIELDS} from lead_forms where id = $1 and owner_id = $2`,
    [id, ownerId]
  );
  return rows[0] || null;
}

// Público — usado pela página /l/<slug> e pela rota de submissão, sem
// checagem de owner (o slug em si é o "segredo" de acesso, como qualquer
// link público de formulário).
async function getBySlug(slug) {
  const { rows } = await pool.query(`select ${SELECT_FIELDS} from lead_forms where slug = $1`, [slug]);
  return rows[0] || null;
}

const DEFAULT_WELCOME_MESSAGE = 'Olá {{nome}}! Recebemos seu contato, em breve falamos com você.';
const JSONB_DEFAULTS = { testimonials: [], stats: [], differentials: [], faq: [] };

async function create(ownerId, fields) {
  const finalSlug = fields.slug ? slugify(fields.slug) : await generateSlug(fields.name);
  if (fields.slug && (await isSlugTaken(finalSlug))) {
    throw new Error('essa URL já está em uso, escolha outra');
  }

  const columns = ['slug', 'owner_id', 'session_id', 'welcome_message'];
  const placeholders = ['$1', '$2', '$3', '$4'];
  const values = [finalSlug, ownerId, fields.sessionId, fields.welcomeMessage || DEFAULT_WELCOME_MESSAGE];

  for (const [apiField, { column, jsonb }] of Object.entries(FIELD_COLUMNS)) {
    if (apiField === 'welcomeMessage' || apiField === 'sessionId') continue; // já incluídos acima
    const value = jsonb ? (fields[apiField] ?? JSONB_DEFAULTS[apiField]) : (fields[apiField] ?? null);
    columns.push(column);
    placeholders.push(jsonb ? `$${values.length + 1}::jsonb` : `$${values.length + 1}`);
    values.push(jsonb ? JSON.stringify(value) : value);
  }

  const { rows } = await pool.query(
    `insert into lead_forms (${columns.join(', ')}) values (${placeholders.join(', ')}) returning ${SELECT_FIELDS}`,
    values
  );
  return rows[0];
}

async function update(id, ownerId, fields) {
  const existing = await get(id, ownerId);
  if (!existing) return null;

  const sets = ['session_id = $1', 'active = $2', 'welcome_message = $3'];
  const values = [fields.sessionId ?? existing.sessionId, fields.active ?? existing.active, fields.welcomeMessage ?? existing.welcomeMessage];

  for (const [apiField, { column, jsonb }] of Object.entries(FIELD_COLUMNS)) {
    if (apiField === 'sessionId' || apiField === 'welcomeMessage') continue; // já incluídos acima
    const value = jsonb ? (fields[apiField] ?? existing[apiField]) : (fields[apiField] ?? existing[apiField]);
    sets.push(`${column} = $${values.length + 1}${jsonb ? '::jsonb' : ''}`);
    values.push(jsonb ? JSON.stringify(value) : value);
  }

  values.push(id, ownerId);
  const { rows } = await pool.query(
    `update lead_forms set ${sets.join(', ')}, updated_at = now()
     where id = $${values.length - 1} and owner_id = $${values.length}
     returning ${SELECT_FIELDS}`,
    values
  );
  return rows[0];
}

async function remove(id, ownerId) {
  const { rowCount } = await pool.query('delete from lead_forms where id = $1 and owner_id = $2', [id, ownerId]);
  return rowCount > 0;
}

async function listSubmissions(formId, ownerId) {
  const form = await get(formId, ownerId);
  if (!form) return null;
  const { rows } = await pool.query(
    `select id, name, phone, whatsapp_sent as "whatsappSent",
       bitrix_deal_id as "bitrixDealId", created_at as "createdAt"
     from lead_form_submissions where form_id = $1 order by created_at desc limit 200`,
    [formId]
  );
  return rows;
}

async function recordSubmission(formId, { name, phone, contactId, whatsappSent }) {
  const { rows } = await pool.query(
    `insert into lead_form_submissions (form_id, contact_id, name, phone, whatsapp_sent)
     values ($1, $2, $3, $4, $5) returning id`,
    [formId, contactId || null, name || null, phone, !!whatsappSent]
  );
  return rows[0].id;
}

// Preenchido depois da resposta ao visitante, quando a criação do negócio
// no Bitrix (background, best-effort) dá certo — ver src/routes/leads.js.
async function setSubmissionBitrixIds(submissionId, { dealId, contactId }) {
  await pool.query(
    `update lead_form_submissions set bitrix_deal_id = $1, bitrix_contact_id = $2 where id = $3`,
    [dealId || null, contactId || null, submissionId]
  );
}

// Métricas agregadas de TODAS as LPs do dono — alimenta
// public/lead-metrics.html (mesmo padrão de computeCampaignMetrics em
// src/campaignStore.js): totais gerais, série diária de views/leads dos
// últimos 30 dias (com zero preenchido nos dias sem dado, pra o gráfico
// ficar com o espaçamento certo por calendário) e o breakdown por
// formulário (reaproveita listByOwner, que já calcula leadCount/
// whatsappSentCount/viewCount).
async function computeMetrics(ownerId) {
  const { rows: totalsRows } = await pool.query(
    `select
       count(*)::int as "totalForms",
       count(*) filter (where active)::int as "activeForms",
       coalesce(sum(v.views), 0)::int as "totalViews",
       coalesce(sum(s.count), 0)::int as "totalLeads",
       coalesce(sum(s.sent_count), 0)::int as "totalWhatsappSent"
     from lead_forms f
     left join (
       select form_id, sum(count)::int as views from lead_form_views group by form_id
     ) v on v.form_id = f.id
     left join (
       select form_id, count(*) as count, count(*) filter (where whatsapp_sent) as sent_count
       from lead_form_submissions group by form_id
     ) s on s.form_id = f.id
     where f.owner_id = $1`,
    [ownerId]
  );

  const { rows: viewsByDay } = await pool.query(
    `select to_char(v.day, 'YYYY-MM-DD') as day, sum(v.count)::int as views
     from lead_form_views v
     join lead_forms f on f.id = v.form_id
     where f.owner_id = $1 and v.day >= current_date - interval '29 days'
     group by v.day`,
    [ownerId]
  );

  const { rows: leadsByDay } = await pool.query(
    `select to_char(date_trunc('day', s.created_at), 'YYYY-MM-DD') as day, count(*)::int as leads
     from lead_form_submissions s
     join lead_forms f on f.id = s.form_id
     where f.owner_id = $1 and s.created_at >= current_date - interval '29 days'
     group by day`,
    [ownerId]
  );

  const viewsMap = new Map(viewsByDay.map((r) => [r.day, r.views]));
  const leadsMap = new Map(leadsByDay.map((r) => [r.day, r.leads]));
  const byDay = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = d.toISOString().slice(0, 10);
    byDay.push({ day, views: viewsMap.get(day) || 0, leads: leadsMap.get(day) || 0 });
  }

  const forms = await listByOwner(ownerId);

  return {
    totals: totalsRows[0],
    byDay,
    forms: forms.map((f) => ({
      id: f.id,
      name: f.name,
      slug: f.slug,
      active: f.active,
      viewCount: f.viewCount,
      leadCount: f.leadCount,
      whatsappSentCount: f.whatsappSentCount,
    })),
  };
}

module.exports = {
  listByOwner,
  get,
  getBySlug,
  create,
  update,
  remove,
  listSubmissions,
  recordSubmission,
  recordView,
  setSubmissionBitrixIds,
  computeMetrics,
  slugify,
};
