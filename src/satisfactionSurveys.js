const crypto = require('crypto');
const { pool } = require('./db');

/**
 * Pesquisa de Satisfação — tab nova no Painel Admin, restrita a super
 * admin (ver src/routes/satisfaction.js). Dois públicos possíveis por
 * survey: `client` (cliente final, responde via link público
 * /pesquisa/<slug>, sem login — mesmo padrão de src/leadForms.js) e
 * `internal` (atendente/usuário do próprio sistema, responde
 * autenticado). Formulário com perguntas FIXAS (até 5), não builder
 * livre tipo lead_forms.
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
  const { rows } = await pool.query('select 1 from satisfaction_surveys where slug = $1', [slug]);
  return rows.length > 0;
}

// Mesmo padrão exato de src/leadForms.js::generateSlug — tenta o nome
// puro primeiro, senão sufixo aleatório curto até achar livre.
async function generateSlug(title) {
  const base = slugify(title) || 'pesquisa';
  if (!(await isSlugTaken(base))) return base;
  for (let i = 0; i < 8; i++) {
    const candidate = `${base}-${crypto.randomBytes(3).toString('hex')}`;
    if (!(await isSlugTaken(candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

const SELECT_FIELDS = `
  id, owner_id as "ownerId", audience, slug, title, questions, active,
  created_at as "createdAt"
`;

function mapRow(r) {
  return { ...r, createdAt: r.createdAt.toISOString() };
}

// Máximo de 5 perguntas — validado aqui (não só no frontend), cada uma
// precisa de {id, text, type}. `id` da pergunta é usado como chave em
// `answers` na resposta — estável mesmo se o texto da pergunta mudar
// depois de já existirem respostas.
const MAX_QUESTIONS = 5;
const VALID_TYPES = ['rating', 'text'];

function validateQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) {
    throw new Error('a pesquisa precisa de pelo menos 1 pergunta');
  }
  if (questions.length > MAX_QUESTIONS) {
    throw new Error(`no máximo ${MAX_QUESTIONS} perguntas por pesquisa`);
  }
  questions.forEach((q, i) => {
    if (!q || typeof q.id !== 'string' || !q.id.trim()) {
      throw new Error(`pergunta ${i + 1}: "id" é obrigatório`);
    }
    if (typeof q.text !== 'string' || !q.text.trim()) {
      throw new Error(`pergunta ${i + 1}: "text" é obrigatório`);
    }
    if (!VALID_TYPES.includes(q.type)) {
      throw new Error(`pergunta ${i + 1}: "type" precisa ser "rating" ou "text"`);
    }
  });
  const ids = questions.map((q) => q.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('ids de pergunta duplicados dentro da mesma pesquisa');
  }
}

async function create(ownerId, { audience, title, questions }) {
  if (!['client', 'internal'].includes(audience)) {
    throw new Error('audience precisa ser "client" ou "internal"');
  }
  if (!title || !title.trim()) throw new Error('title é obrigatório');
  validateQuestions(questions);

  // slug só faz sentido pro público "client" (link público) — internal
  // nunca é acessado por slug, mas gera-se um mesmo assim por
  // simplicidade de schema (unique, nunca usado no fluxo interno).
  const slug = await generateSlug(title);

  const { rows } = await pool.query(
    `insert into satisfaction_surveys (owner_id, audience, slug, title, questions)
     values ($1, $2, $3, $4, $5)
     returning ${SELECT_FIELDS}`,
    [ownerId, audience, slug, title.trim(), JSON.stringify(questions)]
  );
  return mapRow(rows[0]);
}

async function update(id, patch) {
  const hasTitle = Object.prototype.hasOwnProperty.call(patch, 'title');
  const hasQuestions = Object.prototype.hasOwnProperty.call(patch, 'questions');
  const hasActive = Object.prototype.hasOwnProperty.call(patch, 'active');

  if (hasTitle && (!patch.title || !patch.title.trim())) throw new Error('title não pode ser vazio');
  if (hasQuestions) validateQuestions(patch.questions);

  const { rows } = await pool.query(
    `update satisfaction_surveys set
       title = case when $2 then $3 else title end,
       questions = case when $4 then $5::jsonb else questions end,
       active = case when $6 then $7 else active end
     where id = $1
     returning ${SELECT_FIELDS}`,
    [
      id,
      hasTitle, hasTitle ? patch.title.trim() : null,
      hasQuestions, hasQuestions ? JSON.stringify(patch.questions) : null,
      hasActive, hasActive ? !!patch.active : null,
    ]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

async function remove(id) {
  await pool.query('delete from satisfaction_surveys where id = $1', [id]);
}

async function getById(id) {
  const { rows } = await pool.query(`select ${SELECT_FIELDS} from satisfaction_surveys where id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

async function getBySlug(slug) {
  const { rows } = await pool.query(`select ${SELECT_FIELDS} from satisfaction_surveys where slug = $1`, [slug]);
  return rows[0] ? mapRow(rows[0]) : null;
}

// Todas as pesquisas — visão de admin (não filtrada por owner: só o
// super admin acessa a rota que chama isto, ver requireSuperAdmin em
// src/routes/satisfaction.js).
async function listAll() {
  const { rows } = await pool.query(`select ${SELECT_FIELDS} from satisfaction_surveys order by created_at desc`);
  return rows.map(mapRow);
}

// Pesquisas ATIVAS de um público específico — usado (a) pela rota
// pública pra achar qual pesquisa "client" mostrar, (b) pelo atendente
// pra ver a pesquisa "internal" que precisa responder.
async function listActiveByAudience(audience) {
  const { rows } = await pool.query(
    `select ${SELECT_FIELDS} from satisfaction_surveys where audience = $1 and active = true order by created_at desc`,
    [audience]
  );
  return rows.map(mapRow);
}

// Máximo de caracteres numa resposta de texto livre — mesma ordem de
// grandeza do limite de nota interna (MAX_TEXT_LENGTH em
// internalNotes.js), protege contra payload gigante mandado direto na
// API (bypassando o formulário), já que `answers` é gravado como jsonb
// livre e a rota pública não exige nenhuma autenticação.
const MAX_ANSWER_TEXT_LENGTH = 2000;

// Sanitiza `answers` contra o shape das perguntas de UMA survey —
// achado real de revisão de segurança (2026-08-27): antes disso,
// qualquer objeto (chave arbitrária, string gigante, valor
// profundamente aninhado) era gravado sem checagem, principalmente
// grave na rota PÚBLICA (sem autenticação nenhuma). Aceita só chaves
// que batem com um `id` de pergunta real; "rating" vira número 1-5 (ou
// é descartado se fora da faixa); "text" é truncado em
// MAX_ANSWER_TEXT_LENGTH. Nunca lança — resposta com tudo inválido vira
// objeto vazio, mesma filosofia best-effort do resto do módulo (a
// resposta ainda é gravada, só sem os campos ruins).
function sanitizeAnswers(survey, rawAnswers) {
  const clean = {};
  if (!rawAnswers || typeof rawAnswers !== 'object') return clean;

  survey.questions.forEach((q) => {
    const value = rawAnswers[q.id];
    if (value === undefined || value === null) return;

    if (q.type === 'rating') {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 1 && n <= 5) clean[q.id] = n;
    } else {
      clean[q.id] = String(value).slice(0, MAX_ANSWER_TEXT_LENGTH);
    }
  });

  return clean;
}

// `knownSurvey` opcional — quem chama normalmente já buscou a survey
// pra validar audience/active antes de chegar aqui (ver
// routes/satisfaction.js e routes/satisfactionPublic.js); passar
// evita uma 2ª busca redundante só pra sanitizeAnswers. Sem ele
// (chamado só com surveyId), busca sozinho.
async function recordResponse(surveyId, { sessionId, phone, respondentOwnerId, answers }, knownSurvey) {
  const survey = knownSurvey || await getById(surveyId);
  if (!survey) throw new Error('pesquisa não encontrada');
  const cleanAnswers = sanitizeAnswers(survey, answers);

  const { rows } = await pool.query(
    `insert into satisfaction_responses (survey_id, session_id, phone, respondent_owner_id, answers)
     values ($1, $2, $3, $4, $5)
     returning id, created_at as "createdAt"`,
    [surveyId, sessionId || null, phone || null, respondentOwnerId || null, JSON.stringify(cleanAnswers)]
  );
  return { id: rows[0].id, createdAt: rows[0].createdAt.toISOString() };
}

// Métricas de UMA pesquisa — mesmo padrão 3-partes de
// campaignStore.js::computeCampaignMetrics / leadForms.js::computeMetrics
// (totais + série diária + lista recente), adaptado pra distribuição de
// notas nas perguntas do tipo "rating" em vez de sent/failed.
async function computeMetrics(surveyId) {
  const survey = await getById(surveyId);
  if (!survey) return null;

  const { rows: totalsRows } = await pool.query(
    `select count(*)::int as "totalResponses" from satisfaction_responses where survey_id = $1`,
    [surveyId]
  );

  const { rows: byDay } = await pool.query(
    `select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int as count
     from satisfaction_responses
     where survey_id = $1 and created_at >= now() - interval '30 days'
     group by day
     order by day asc`,
    [surveyId]
  );

  const { rows: allAnswers } = await pool.query(
    `select answers from satisfaction_responses where survey_id = $1`,
    [surveyId]
  );

  // Distribuição de nota por pergunta "rating" — computada em memória
  // (volume de respostas de uma pesquisa é pequeno o bastante pra não
  // precisar de agregação SQL sobre jsonb aqui).
  const ratingQuestions = survey.questions.filter((q) => q.type === 'rating');
  const distributionByQuestion = {};
  ratingQuestions.forEach((q) => {
    distributionByQuestion[q.id] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  });
  let ratingSum = 0;
  let ratingCount = 0;
  allAnswers.forEach((r) => {
    ratingQuestions.forEach((q) => {
      const value = Number(r.answers?.[q.id]);
      if (value >= 1 && value <= 5 && distributionByQuestion[q.id]) {
        distributionByQuestion[q.id][value]++;
        ratingSum += value;
        ratingCount++;
      }
    });
  });

  const { rows: recent } = await pool.query(
    `select id, session_id as "sessionId", phone, respondent_owner_id as "respondentOwnerId",
            answers, created_at as "createdAt"
     from satisfaction_responses
     where survey_id = $1
     order by created_at desc
     limit 25`,
    [surveyId]
  );

  return {
    survey,
    totals: {
      totalResponses: totalsRows[0].totalResponses,
      averageRating: ratingCount ? Number((ratingSum / ratingCount).toFixed(2)) : null,
    },
    byDay,
    distributionByQuestion,
    recent: recent.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  };
}

module.exports = {
  create,
  update,
  remove,
  getById,
  getBySlug,
  listAll,
  listActiveByAudience,
  recordResponse,
  computeMetrics,
};
