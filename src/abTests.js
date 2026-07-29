const crypto = require('crypto');
const { pool } = require('./db');
const { slugify } = require('./leadForms');

/**
 * Testes A/B entre duas LPs ("Sites") — a URL pública /t/<slug> divide o
 * tráfego 50/50 entre as variantes (cookie sticky, ver GET /t/:slug em
 * src/server.js). Métricas por variante = views (lead_form_views) e leads
 * (lead_form_submissions) DENTRO da janela do teste (created_at..finished_at).
 *
 * Testes encerrados são imutáveis: são o HISTÓRICO de aprendizados (vencedor,
 * métricas congeladas, análise escrita pelo usuário) que servirá de base de
 * conhecimento pra futura IA geradora de LPs (ver history()).
 */

async function isSlugTaken(slug) {
  const { rows } = await pool.query('select 1 from ab_tests where slug = $1', [slug]);
  return rows.length > 0;
}

// Mesmo padrão de generateSlug em leadForms.js — nome puro primeiro, sufixo
// aleatório curto em colisão.
async function generateSlug(name) {
  const base = slugify(name) || 'teste';
  if (!(await isSlugTaken(base))) return base;
  for (let i = 0; i < 8; i++) {
    const candidate = `${base}-${crypto.randomBytes(3).toString('hex')}`;
    if (!(await isSlugTaken(candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// Métricas de uma variante dentro da janela do teste, como expressões SQL
// reutilizadas em listByOwner e finish() — views agregadas por dia (borda do
// teste tem granularidade de dia, irrelevante pra testes de dias/semanas).
const VARIANT_METRICS = (formCol, alias) => `
  (select coalesce(sum(v.count), 0) from lead_form_views v
    where v.form_id = t.${formCol}
      and v.day >= t.created_at::date
      and v.day <= coalesce(t.finished_at, now())::date)::int as "views${alias}",
  (select count(*) from lead_form_submissions s
    where s.form_id = t.${formCol}
      and s.created_at >= t.created_at
      and s.created_at <= coalesce(t.finished_at, now()))::int as "leads${alias}"
`;

const SELECT_TEST = `
  t.id, t.slug, t.name, t.status, t.analysis,
  t.form_a_id as "formAId", t.form_b_id as "formBId",
  t.winner_form_id as "winnerFormId",
  t.variant_snapshot as "variantSnapshot",
  t.final_metrics as "finalMetrics",
  t.created_at as "createdAt", t.finished_at as "finishedAt",
  fa.name as "formAName", fa.slug as "formASlug",
  fb.name as "formBName", fb.slug as "formBSlug"
`;

async function listByOwner(ownerId) {
  const { rows } = await pool.query(
    `select ${SELECT_TEST},
       ${VARIANT_METRICS('form_a_id', 'A')},
       ${VARIANT_METRICS('form_b_id', 'B')}
     from ab_tests t
     left join lead_forms fa on fa.id = t.form_a_id
     left join lead_forms fb on fb.id = t.form_b_id
     where t.owner_id = $1
     order by t.created_at desc`,
    [ownerId]
  );
  return rows;
}

async function get(id, ownerId) {
  const { rows } = await pool.query(
    `select ${SELECT_TEST},
       ${VARIANT_METRICS('form_a_id', 'A')},
       ${VARIANT_METRICS('form_b_id', 'B')}
     from ab_tests t
     left join lead_forms fa on fa.id = t.form_a_id
     left join lead_forms fb on fb.id = t.form_b_id
     where t.id = $1 and t.owner_id = $2`,
    [id, ownerId]
  );
  return rows[0] || null;
}

// Público — usado por GET /t/:slug (src/server.js) pra rotear o visitante.
async function getBySlugPublic(slug) {
  const { rows } = await pool.query(
    `select t.id, t.slug, t.status,
       t.form_a_id as "formAId", t.form_b_id as "formBId",
       t.winner_form_id as "winnerFormId",
       fa.slug as "formASlug", fa.active as "formAActive",
       fb.slug as "formBSlug", fb.active as "formBActive"
     from ab_tests t
     left join lead_forms fa on fa.id = t.form_a_id
     left join lead_forms fb on fb.id = t.form_b_id
     where t.slug = $1`,
    [slug]
  );
  return rows[0] || null;
}

async function isFormInRunningTest(formId) {
  const { rows } = await pool.query(
    `select 1 from ab_tests where status = 'running' and (form_a_id = $1 or form_b_id = $1) limit 1`,
    [formId]
  );
  return rows.length > 0;
}

// Resumo estruturado da config de uma LP no momento do snapshot — o
// suficiente pra futura IA entender O QUE estava sendo testado (título,
// seções usadas), sem duplicar o conteúdo inteiro.
function summarizeForm(form) {
  return {
    formId: form.id,
    slug: form.slug,
    name: form.name,
    title: form.title,
    subtitle: form.subtitle || null,
    accentColor: form.accentColor || null,
    hasLogo: !!form.logoUrl,
    hasHeroImage: !!form.heroImageUrl,
    sections: {
      testimonials: (form.testimonials || []).length,
      stats: (form.stats || []).length,
      differentials: (form.differentials || []).length,
      faq: (form.faq || []).length,
      story: !!(form.storyTitle || form.storyText),
    },
  };
}

async function create(ownerId, { name, formAId, formBId }) {
  if (String(formAId) === String(formBId)) {
    throw new Error('escolha duas LPs diferentes');
  }
  const { rows: forms } = await pool.query(
    `select id, slug, owner_id as "ownerId", name, title, subtitle,
       accent_color as "accentColor", logo_url as "logoUrl", hero_image_url as "heroImageUrl",
       testimonials, stats, differentials, faq, story_title as "storyTitle", story_text as "storyText"
     from lead_forms where id = any($1::bigint[]) and owner_id = $2`,
    [[formAId, formBId], ownerId]
  );
  if (forms.length !== 2) {
    throw new Error('LP não encontrada (as duas LPs precisam ser suas)');
  }
  for (const id of [formAId, formBId]) {
    if (await isFormInRunningTest(id)) {
      throw new Error('uma das LPs já está em outro teste em andamento');
    }
  }

  const formA = forms.find((f) => String(f.id) === String(formAId));
  const formB = forms.find((f) => String(f.id) === String(formBId));
  const slug = await generateSlug(name);
  const variantSnapshot = { a: summarizeForm(formA), b: summarizeForm(formB) };

  const { rows } = await pool.query(
    `insert into ab_tests (owner_id, slug, name, form_a_id, form_b_id, variant_snapshot)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     returning id`,
    [ownerId, slug, name, formAId, formBId, JSON.stringify(variantSnapshot)]
  );
  return get(rows[0].id, ownerId);
}

// Encerra o teste congelando as métricas do período — `winnerFormId` pode
// ser null ("sem vencedor claro"); `analysis` é obrigatória (validada na
// rota): é ela que dá valor ao histórico.
async function finish(id, ownerId, { winnerFormId, analysis }) {
  const test = await get(id, ownerId);
  if (!test) return null;
  if (test.status !== 'running') {
    throw new Error('este teste já foi encerrado');
  }
  if (winnerFormId != null && String(winnerFormId) !== String(test.formAId) && String(winnerFormId) !== String(test.formBId)) {
    throw new Error('o vencedor precisa ser uma das duas variantes do teste');
  }

  const conversion = (views, leads) => (views > 0 ? Math.round((leads / views) * 1000) / 10 : null);
  const finalMetrics = {
    a: { views: test.viewsA, leads: test.leadsA, conversionPct: conversion(test.viewsA, test.leadsA) },
    b: { views: test.viewsB, leads: test.leadsB, conversionPct: conversion(test.viewsB, test.leadsB) },
  };

  const { rows } = await pool.query(
    `update ab_tests
     set status = 'finished', winner_form_id = $1, analysis = $2,
         final_metrics = $3::jsonb, finished_at = now()
     where id = $4 and owner_id = $5 and status = 'running'
     returning id`,
    [winnerFormId || null, analysis, JSON.stringify(finalMetrics), id, ownerId]
  );
  if (!rows.length) return null;
  return get(id, ownerId);
}

// Cancelar um teste EM ANDAMENTO (sem valor de histórico ainda). Encerrados
// são imutáveis — são o histórico.
async function removeRunning(id, ownerId) {
  const { rowCount } = await pool.query(
    `delete from ab_tests where id = $1 and owner_id = $2 and status = 'running'`,
    [id, ownerId]
  );
  return rowCount > 0;
}

// Histórico estruturado dos testes encerrados — formato pensado pra ser
// consumido como contexto/system prompt por uma IA geradora de LPs:
// o que foi testado (snapshot das variantes), o que aconteceu (métricas
// finais), quem venceu e POR QUÊ (análise escrita pelo usuário).
async function history(ownerId) {
  const { rows } = await pool.query(
    `select t.id, t.name, t.slug,
       t.form_a_id as "formAId", t.form_b_id as "formBId",
       t.winner_form_id as "winnerFormId",
       t.variant_snapshot as "variantSnapshot",
       t.final_metrics as "finalMetrics",
       t.analysis,
       t.created_at as "startedAt", t.finished_at as "finishedAt"
     from ab_tests t
     where t.owner_id = $1 and t.status = 'finished'
     order by t.finished_at desc`,
    [ownerId]
  );
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    winner:
      t.winnerFormId == null ? null : String(t.winnerFormId) === String(t.formAId) ? 'a' : 'b',
    variants: {
      a: { snapshot: t.variantSnapshot?.a || null, metrics: t.finalMetrics?.a || null },
      b: { snapshot: t.variantSnapshot?.b || null, metrics: t.finalMetrics?.b || null },
    },
    analysis: t.analysis,
  }));
}

module.exports = {
  listByOwner,
  get,
  getBySlugPublic,
  isFormInRunningTest,
  create,
  finish,
  removeRunning,
  history,
};
