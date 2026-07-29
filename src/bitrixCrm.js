const { callBitrix } = require('./bitrix');

/**
 * Criação de entidades de CRM no Bitrix24 (contato/negócio) pra feature
 * Sites: cada lead vira negócio em UM pipeline compartilhado (o mesmo pra
 * TODAS as LPs), atribuído ao SDR dono da LP via ASSIGNED_BY_ID — a
 * visibilidade "cada SDR só vê o próprio lead" é resolvida por permissão
 * nativa do Bitrix (escopo "somente próprios"), configurada manualmente no
 * portal, não por pipeline separado.
 *
 * HISTÓRICO: a primeira versão desta feature criava um pipeline NOVO por
 * LP (crm.category.add). Abandonado — uma automação de controle de
 * duplicidade já existente neste portal (checa o campo "Número do
 * Processo") apaga automaticamente negócios recém-criados quando esse
 * campo está vazio, tratando "vazio" como duplicata de "vazio". Isso
 * afetava QUALQUER negócio novo, não só duplicatas de verdade — ver
 * HANDOFF.md Parte AT/AV para o diagnóstico completo. Pipelines de teste
 * criados durante essa investigação (604, 606, 608, 610) foram apagados.
 *
 * TUDO best-effort: qualquer falha (webhook ausente, sem escopo CRM, rede)
 * vira `null` — quem chama segue em frente sem o dado do Bitrix. O lead
 * local (lead_form_submissions) NUNCA depende disto.
 */

// Pipeline ÚNICO (compartilhado por todas as LPs) onde os negócios de lead
// são criados. É o número depois de /category/ na URL do kanban. Sem essa
// env var configurada, negócios simplesmente não são criados (dealId fica
// null) — o lead continua salvo localmente normalmente.
const LEADS_CATEGORY_ID = Number(process.env.BITRIX_LEADS_CATEGORY_ID) || null;

// callBitrix já devolve null em erro de API/env ausente, mas pode LANÇAR em
// erro de rede (fetch rejeitado) ou resposta não-JSON — este wrapper garante
// o contrato "nunca lança" prometido por todas as funções deste módulo.
async function safeCall(method, params) {
  try {
    return await callBitrix(method, params);
  } catch (err) {
    console.error(`[bitrix] falha de rede em ${method}:`, err.message);
    return null;
  }
}

// Reusa um contato Bitrix existente com esse telefone (mesmo
// crm.duplicate.findbycomm que o Chat já usa client-side) ou cria um novo.
async function ensureBitrixContact({ name, phone }) {
  const dup = await safeCall('crm.duplicate.findbycomm', {
    entity_type: 'CONTACT',
    type: 'PHONE',
    values: [phone],
  });
  const existing = dup?.CONTACT?.[0];
  if (existing) return Number(existing);

  const created = await safeCall('crm.contact.add', {
    fields: {
      NAME: name || phone,
      PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }],
      OPENED: 'Y',
      SOURCE_ID: 'WEB',
    },
  });
  return created ? Number(created) : null;
}

async function createDealForLead({ categoryId, contactId, assignedById, title, sourceDescription }) {
  const fields = {
    TITLE: title,
    SOURCE_ID: 'WEB',
    SOURCE_DESCRIPTION: sourceDescription,
  };
  if (categoryId != null) fields.CATEGORY_ID = categoryId;
  if (contactId) fields.CONTACT_ID = contactId;
  if (assignedById) fields.ASSIGNED_BY_ID = assignedById;
  const id = await safeCall('crm.deal.add', { fields });
  return id ? Number(id) : null;
}

// Orquestração pós-submissão de lead. Roda em background depois da
// resposta ao visitante (ver src/routes/leads.js).
async function createBitrixArtifactsForLead({ form, name, phone }) {
  // ownerId = `${BITRIX_MEMBER_ID}_${userId do Bitrix}` (src/auth.js) — o
  // sufixo é o ID do SDR, usado pra atribuir o negócio a ele (RLS nativo
  // do Bitrix: permissão "somente próprios" no pipeline compartilhado).
  const assignedById = (form.ownerId || '').split('_').pop() || null;
  // Só o nome da LP no título — o nome do contato já aparece sozinho no
  // card via o vínculo CONTACT_ID, duplicar ali era redundante (pedido do
  // usuário ao ver os cards reais no Bitrix).
  const title = form.name;
  const sourceDescription = `LP: ${form.name} (/l/${form.slug})`;

  const contactId = await ensureBitrixContact({ name, phone });

  const dealId = LEADS_CATEGORY_ID
    ? await createDealForLead({
        categoryId: LEADS_CATEGORY_ID,
        contactId,
        assignedById,
        title,
        sourceDescription,
      })
    : null;

  return { contactId, dealId };
}

// Distribuição de negócios por etapa no Bitrix, pros `dealId` já vinculados
// a conversas de WhatsApp (usado no gráfico "Leads por etapa" do dashboard
// de Análise Conversas — src/routes/whatsapp.js GET /metrics). Best-effort
// (mesmo contrato "nunca lança" do resto do módulo): sem webhook ou em
// qualquer erro, devolve [] e o gráfico simplesmente não aparece.
//
// Etapas (`STAGE_ID`) só são únicas DENTRO de uma categoria — por isso a
// contagem agrupa por `categoryId:stageId`, e o nome de cada etapa vem de
// `crm.dealcategory.stage.list` por categoria encontrada entre os negócios.
async function getStageDistribution(dealIds) {
  const uniqueIds = [...new Set(dealIds)].filter(Boolean);
  if (!uniqueIds.length) return [];

  const chunks = [];
  for (let i = 0; i < uniqueIds.length; i += 50) chunks.push(uniqueIds.slice(i, i + 50));

  const deals = [];
  for (const chunk of chunks) {
    const result = await safeCall('crm.deal.list', {
      filter: { '@ID': chunk },
      select: ['ID', 'STAGE_ID', 'CATEGORY_ID'],
    });
    if (result) deals.push(...result);
  }
  if (!deals.length) return [];

  const categoryIds = [...new Set(deals.map((d) => d.CATEGORY_ID))];
  const stageInfoByKey = {};
  for (const categoryId of categoryIds) {
    const stages = await safeCall('crm.dealcategory.stage.list', { id: categoryId });
    (stages || []).forEach((s) => {
      stageInfoByKey[`${categoryId}:${s.STATUS_ID}`] = { name: s.NAME, sort: Number(s.SORT) || 0 };
    });
  }

  const counts = {};
  deals.forEach((d) => {
    const key = `${d.CATEGORY_ID}:${d.STAGE_ID}`;
    if (!counts[key]) counts[key] = { key, categoryId: d.CATEGORY_ID, stageId: d.STAGE_ID, count: 0 };
    counts[key].count++;
  });

  return Object.values(counts)
    .map((c) => ({
      name: stageInfoByKey[c.key]?.name || c.stageId,
      count: c.count,
      sort: stageInfoByKey[c.key]?.sort || 0,
    }))
    .sort((a, b) => a.sort - b.sort);
}

module.exports = {
  ensureBitrixContact,
  createDealForLead,
  createBitrixArtifactsForLead,
  getStageDistribution,
};
