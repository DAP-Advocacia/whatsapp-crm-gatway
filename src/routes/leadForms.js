const express = require('express');
const leadForms = require('../leadForms');
const abTests = require('../abTests');
const publicAssets = require('../publicAssets');
const { assertOwnsSession } = require('../authz');

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // logo — imagem só, fica pequeno
const MAX_HERO_MEDIA_BYTES = 25 * 1024 * 1024; // hero aceita vídeo — mesmo teto do bucket (ver db/create-public-bucket.js)

// Todas as LPs lançam negócio no MESMO pipeline compartilhado (ver
// src/bitrixCrm.js) — um único link de kanban pra tela toda, não mais um
// por LP. Calculado server-side porque o frontend não conhece o domínio
// do portal (env var do servidor).
const BITRIX_PORTAL_DOMAIN = process.env.BITRIX_PORTAL_DOMAIN;
const BITRIX_LEADS_CATEGORY_ID = process.env.BITRIX_LEADS_CATEGORY_ID;
const LEADS_KANBAN_URL =
  BITRIX_LEADS_CATEGORY_ID && BITRIX_PORTAL_DOMAIN
    ? `https://${BITRIX_PORTAL_DOMAIN}/crm/deal/kanban/category/${BITRIX_LEADS_CATEGORY_ID}/`
    : null;

/**
 * CRUD dos formulários públicos de captura de lead ("Sites",
 * public/sites.html) — escopado por req.ownerId direto, igual contatos
 * (ver src/routes/crm.js). Montado em /api/lead-forms, atrás de
 * requireAuth (ver server.js).
 */

// `logoUrl`/`heroImageUrl` viram `<img src>`/`background-image` na página
// pública sem login (ver src/routes/leads.js) — restringe a http(s) pra
// não aceitar `javascript:`/`data:` etc coladas ali por engano ou de
// propósito.
function validateAppearance({ accentColor, logoUrl, heroImageUrl, heroMediaType }) {
  if (accentColor && !/^#[0-9a-f]{6}$/i.test(accentColor)) {
    return 'accentColor precisa ser uma cor hex, ex: #d8ab4f';
  }
  if (logoUrl && !/^https?:\/\//i.test(logoUrl)) {
    return 'logoUrl precisa começar com http:// ou https://';
  }
  if (heroImageUrl && !/^https?:\/\//i.test(heroImageUrl)) {
    return 'heroImageUrl precisa começar com http:// ou https://';
  }
  if (heroMediaType && !['image', 'video'].includes(heroMediaType)) {
    return 'heroMediaType precisa ser "image" ou "video"';
  }
  return null;
}

// Conteúdo de todas as seções de lista (depoimentos, estatísticas,
// diferenciais, FAQ) é sempre escrito pelo próprio dono do formulário — este
// app nunca gera/inventa conteúdo. `sanitizeList` só confere formato
// (limite de itens, campos obrigatórios presentes, tamanho razoável) e
// devolve a lista já limpa (trim) ou uma mensagem de erro; `spec` descreve
// os campos esperados de cada item: `{ field: {required, maxLength} }`.
// `singular` é passado explícito (em vez de tentar derivar de `label` no
// plural) porque português não pluraliza cortando só o "s" — "diferenciais"
// não vira "diferencial" removendo a última letra.
function sanitizeList(raw, { maxItems, fields, label, singular }) {
  if (raw == null) return { list: undefined };
  if (!Array.isArray(raw)) return { error: `${label} precisa ser uma lista` };
  if (raw.length > maxItems) return { error: `no máximo ${maxItems} ${label}` };
  const list = [];
  for (const item of raw) {
    const clean = {};
    for (const [field, spec] of Object.entries(fields)) {
      const value = (item?.[field] || '').trim();
      if (spec.required && !value) return { error: `cada ${singular} precisa de ${spec.label || field}` };
      if (value.length > spec.maxLength) return { error: `${label} com texto muito longo` };
      clean[field] = value || null;
    }
    list.push(clean);
  }
  return { list };
}

const sanitizeTestimonials = (raw) => {
  const { list, error } = sanitizeList(raw, {
    maxItems: 5,
    label: 'depoimentos',
    singular: 'depoimento',
    fields: { name: { required: true, maxLength: 80 }, quote: { required: true, maxLength: 400 }, location: { maxLength: 80 } },
  });
  return { testimonials: list, error };
};

const sanitizeStats = (raw) => {
  const { list, error } = sanitizeList(raw, {
    maxItems: 4,
    label: 'estatísticas',
    singular: 'estatística',
    fields: {
      value: { required: true, maxLength: 20, label: 'um valor (ex: "500+")' },
      label: { required: true, maxLength: 60, label: 'uma legenda (ex: "clientes atendidos")' },
    },
  });
  return { stats: list, error };
};

const sanitizeDifferentials = (raw) => {
  const { list, error } = sanitizeList(raw, {
    maxItems: 6,
    label: 'diferenciais',
    singular: 'diferencial',
    fields: { title: { required: true, maxLength: 60, label: 'um título' }, description: { maxLength: 200 } },
  });
  return { differentials: list, error };
};

const sanitizeFaq = (raw) => {
  const { list, error } = sanitizeList(raw, {
    maxItems: 8,
    label: 'perguntas',
    singular: 'pergunta',
    fields: {
      question: { required: true, maxLength: 150, label: 'uma pergunta' },
      answer: { required: true, maxLength: 500, label: 'uma resposta' },
    },
  });
  return { faq: list, error };
};

function createLeadFormsRouter() {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const forms = await leadForms.listByOwner(req.ownerId);
      res.json({ forms, leadsKanbanUrl: LEADS_KANBAN_URL });
    } catch (err) {
      console.error('[lead-forms] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Métricas agregadas de todas as LPs do dono — alimenta
  // public/lead-metrics.html. Declarada antes de qualquer rota `/:id` por
  // clareza (não colide de verdade, já que não existe GET /:id genérico
  // aqui, só GET /:id/submissions).
  router.get('/metrics', async (req, res) => {
    try {
      res.json(await leadForms.computeMetrics(req.ownerId));
    } catch (err) {
      console.error('[lead-forms:metrics] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Upload de imagem pro campo "logo" ou pra imagem de fundo do hero
  // (alternativa a colar uma URL já hospedada) — body { mimetype,
  // dataBase64 }, mesmo formato simples usado no resto do app pra mídia em
  // base64 dentro do JSON (ver /send-media em src/routes/whatsapp.js), sem
  // precisar de multipart/multer. Devolve a URL pública permanente do
  // bucket "public-assets".
  router.post('/upload-logo', async (req, res) => {
    const { mimetype, dataBase64 } = req.body || {};
    if (!mimetype || !dataBase64) return res.status(400).json({ error: 'mimetype e dataBase64 são obrigatórios' });
    try {
      const buffer = Buffer.from(dataBase64, 'base64');
      if (buffer.length > MAX_IMAGE_BYTES) {
        return res.status(400).json({ error: 'imagem maior que 6MB' });
      }
      const url = await publicAssets.saveLogo(req.ownerId, buffer, mimetype);
      res.json({ url });
    } catch (err) {
      console.error('[lead-forms:upload-logo] erro:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // Hero aceita imagem OU vídeo — `mediaType` na resposta diz pro frontend
  // qual dos dois foi enviado (pra gravar em heroMediaType no salvar do
  // formulário e pra public/lead-form.html saber se renderiza <img> ou
  // <video>).
  router.post('/upload-hero-image', async (req, res) => {
    const { mimetype, dataBase64 } = req.body || {};
    if (!mimetype || !dataBase64) return res.status(400).json({ error: 'mimetype e dataBase64 são obrigatórios' });
    try {
      const buffer = Buffer.from(dataBase64, 'base64');
      if (buffer.length > MAX_HERO_MEDIA_BYTES) {
        return res.status(400).json({ error: 'arquivo maior que 25MB' });
      }
      const url = await publicAssets.saveHeroImage(req.ownerId, buffer, mimetype);
      const mediaType = mimetype.startsWith('video/') ? 'video' : 'image';
      res.json({ url, mediaType });
    } catch (err) {
      console.error('[lead-forms:upload-hero-image] erro:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  // Confere as 4 listas (depoimentos, estatísticas, diferenciais, FAQ) de
  // uma vez — devolve `{ error }` no primeiro problema encontrado, ou os
  // 4 campos já limpos.
  function sanitizeAllLists(body) {
    const { testimonials: cleanTestimonials, error: e1 } = sanitizeTestimonials(body.testimonials);
    if (e1) return { error: e1 };
    const { stats: cleanStats, error: e2 } = sanitizeStats(body.stats);
    if (e2) return { error: e2 };
    const { differentials: cleanDifferentials, error: e3 } = sanitizeDifferentials(body.differentials);
    if (e3) return { error: e3 };
    const { faq: cleanFaq, error: e4 } = sanitizeFaq(body.faq);
    if (e4) return { error: e4 };
    return { testimonials: cleanTestimonials, stats: cleanStats, differentials: cleanDifferentials, faq: cleanFaq };
  }

  router.post('/', async (req, res) => {
    const body = req.body || {};
    const { name, title, subtitle, welcomeMessage, sessionId, slug, accentColor, logoUrl, heroImageUrl, heroMediaType, storyTitle, storyText } = body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name é obrigatório' });
    if (!title || !title.trim()) return res.status(400).json({ error: 'title é obrigatório' });
    if (!sessionId) return res.status(400).json({ error: 'sessionId é obrigatório' });
    const appearanceError = validateAppearance({ accentColor, logoUrl, heroImageUrl, heroMediaType });
    if (appearanceError) return res.status(400).json({ error: appearanceError });
    const { testimonials, stats, differentials, faq, error: listError } = sanitizeAllLists(body);
    if (listError) return res.status(400).json({ error: listError });
    if (!(await assertOwnsSession(sessionId, req.ownerId))) {
      return res.status(403).json({ error: 'instância não pertence a este usuário' });
    }
    try {
      const form = await leadForms.create(req.ownerId, {
        name: name.trim(),
        title: title.trim(),
        subtitle: subtitle?.trim() || null,
        welcomeMessage: welcomeMessage?.trim() || null,
        sessionId,
        slug: slug?.trim() || null,
        accentColor: accentColor?.trim() || null,
        logoUrl: logoUrl?.trim() || null,
        heroImageUrl: heroImageUrl?.trim() || null,
        heroMediaType: heroMediaType || 'image',
        storyTitle: storyTitle?.trim() || null,
        storyText: storyText?.trim() || null,
        testimonials,
        stats,
        differentials,
        faq,
      });
      res.json(form);
    } catch (err) {
      console.error('[lead-forms] erro:', err.message);
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/:id', async (req, res) => {
    const body = req.body || {};
    const { name, title, subtitle, welcomeMessage, sessionId, active, accentColor, logoUrl, heroImageUrl, heroMediaType, storyTitle, storyText } = body;
    const appearanceError = validateAppearance({ accentColor, logoUrl, heroImageUrl, heroMediaType });
    if (appearanceError) return res.status(400).json({ error: appearanceError });
    const { testimonials, stats, differentials, faq, error: listError } = sanitizeAllLists(body);
    if (listError) return res.status(400).json({ error: listError });
    if (sessionId && !(await assertOwnsSession(sessionId, req.ownerId))) {
      return res.status(403).json({ error: 'instância não pertence a este usuário' });
    }
    try {
      const updated = await leadForms.update(req.params.id, req.ownerId, {
        name: name?.trim(),
        title: title?.trim(),
        subtitle: subtitle?.trim(),
        welcomeMessage: welcomeMessage?.trim(),
        sessionId,
        active,
        accentColor: accentColor?.trim(),
        logoUrl: logoUrl?.trim(),
        heroImageUrl: heroImageUrl?.trim(),
        heroMediaType: heroMediaType || undefined,
        storyTitle: storyTitle?.trim(),
        storyText: storyText?.trim(),
        testimonials,
        stats,
        differentials,
        faq,
      });
      if (!updated) return res.status(404).json({ error: 'formulário não encontrado' });
      res.json(updated);
    } catch (err) {
      console.error('[lead-forms] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      // LP em teste A/B em andamento não pode ser excluída (quebraria a URL
      // /t/ e as métricas do teste) — encerre/cancele o teste primeiro. O
      // pipeline do Bitrix NUNCA é excluído junto (não apagamos dados de
      // terceiros automaticamente).
      if (await abTests.isFormInRunningTest(req.params.id)) {
        return res.status(400).json({ error: 'esta LP está em um teste A/B em andamento — encerre o teste primeiro' });
      }
      const deleted = await leadForms.remove(req.params.id, req.ownerId);
      if (!deleted) return res.status(404).json({ error: 'formulário não encontrado' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[lead-forms] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  router.get('/:id/submissions', async (req, res) => {
    try {
      const submissions = await leadForms.listSubmissions(req.params.id, req.ownerId);
      if (submissions === null) return res.status(404).json({ error: 'formulário não encontrado' });
      res.json({ submissions });
    } catch (err) {
      console.error('[lead-forms] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // GET /:id/submissions/export?format=csv|xlsx
  // Baixa os mesmos leads de GET /:id/submissions, num arquivo — usado
  // pelo botão "Exportar" no modal "Leads recebidos" (public/sites.html).
  // CSV é montado à mão (sem dependência, mesmo padrão de src/csvImport.js);
  // XLSX usa exceljs (única lib de planilha no projeto, adicionada só pra
  // isso).
  // ---------------------------------------------------------------
  router.get('/:id/submissions/export', async (req, res) => {
    const format = req.query.format === 'xlsx' ? 'xlsx' : 'csv';
    try {
      const form = await leadForms.get(req.params.id, req.ownerId);
      if (!form) return res.status(404).json({ error: 'formulário não encontrado' });
      const submissions = await leadForms.listSubmissions(req.params.id, req.ownerId);

      const rows = submissions.map((s) => ({
        name: s.name || '',
        phone: s.phone,
        createdAt: new Date(s.createdAt).toLocaleString('pt-BR'),
        whatsappSent: s.whatsappSent ? 'Sim' : 'Não',
        bitrixDealId: s.bitrixDealId || '',
      }));
      const filenameBase = `leads-${form.slug}`;

      if (format === 'xlsx') {
        const ExcelJS = require('exceljs');
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Leads');
        sheet.columns = [
          { header: 'Nome', key: 'name', width: 28 },
          { header: 'Telefone', key: 'phone', width: 18 },
          { header: 'Data', key: 'createdAt', width: 20 },
          { header: 'WhatsApp enviado', key: 'whatsappSent', width: 16 },
          { header: 'Negócio Bitrix', key: 'bitrixDealId', width: 16 },
        ];
        sheet.getRow(1).font = { bold: true };
        rows.forEach((r) => sheet.addRow(r));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
        await workbook.xlsx.write(res);
        return res.end();
      }

      // CSV: `;` como separador (Excel em pt-BR usa `,` como decimal e só
      // reconhece `;` como separador de coluna por padrão) + BOM UTF-8 (sem
      // ele, acentuação abre corrompida ao clicar 2x no arquivo no Windows).
      const escapeCsv = (v) => {
        const s = String(v == null ? '' : v);
        return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = ['Nome', 'Telefone', 'Data', 'WhatsApp enviado', 'Negócio Bitrix'];
      const lines = [header.join(';')].concat(
        rows.map((r) => [r.name, r.phone, r.createdAt, r.whatsappSent, r.bitrixDealId].map(escapeCsv).join(';'))
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
      res.send('\uFEFF' + lines.join('\r\n'));
    } catch (err) {
      console.error('[lead-forms:export] erro:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createLeadFormsRouter };
