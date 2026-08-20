/**
 * Resolução do nome técnico (UF_CRM_*) do campo customizado do negócio
 * "[AUT] Resp. Ver. Contratos" — usado pela feature "Criar grupo" do card
 * (ver src/routes/cardGroup.js) pra descobrir quem é a pessoa de Verificação
 * atribuída a um negócio específico.
 *
 * Não empilhado em src/bitrixCrm.js (que é especificamente sobre CRIAÇÃO de
 * entidades pra feature de Sites/LP) nem em src/bitrix.js (cliente genérico
 * do webhook) — módulo dedicado, reusando `callBitrix`.
 *
 * ATENÇÃO — NÃO VALIDADO CONTRA O PORTAL REAL ainda: no momento em que este
 * arquivo foi escrito (2026-08-20), o webhook configurado em
 * BITRIX_WEBHOOK_URL (.env local) devolvia "Invalid request credentials"
 * em QUALQUER chamada crm.deal.* (testado crm.deal.fields e crm.deal.get) —
 * não foi possível confirmar a forma exata do payload de resposta. O código
 * abaixo segue a forma documentada mais comum da API REST do Bitrix24
 * (`crm.deal.fields` devolve um objeto {NOME_CAMPO: {type, formLabel/
 * listLabel/..., ...}}), mas isso é uma HIPÓTESE, não um fato confirmado —
 * usuário está ciente e pediu explicitamente pra prosseguir assim. Primeiro
 * teste real (quando o webhook estiver funcionando) deve rodar
 * `resolveCustomFieldName()` sozinho e conferir o console.error de diagnóstico
 * abaixo antes de confiar em qualquer rota que dependa disto.
 */

const { callBitrix } = require('./bitrix');

const CUSTOM_FIELD_LABEL = '[AUT] Resp. Ver. Contratos';
const FIELD_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — nome de campo não muda em produção; reiniciar o processo já refaz a busca.

let fieldNameCache = null; // { fieldName, cachedAt } | null

// Todas as sub-chaves de rótulo que campos customizados do Bitrix24 podem
// usar, dependendo da versão/tipo do campo — tentamos todas, não uma só,
// já que a forma exata não pôde ser confirmada contra o portal real (ver
// aviso no topo do arquivo).
const LABEL_KEYS = ['formLabel', 'listLabel', 'editFormLabel', 'filterLabel'];

function extractLabels(fieldDef) {
  const labels = [];
  for (const key of LABEL_KEYS) {
    const value = fieldDef?.[key];
    if (!value) continue;
    if (typeof value === 'string') {
      labels.push(value);
    } else if (typeof value === 'object') {
      // Rótulo por locale, ex: { pt: '...', en: '...', ru: '...' }
      labels.push(...Object.values(value));
    }
  }
  return labels;
}

/**
 * Descobre o UF_CRM_* correspondente ao rótulo "[AUT] Resp. Ver.
 * Contratos" via crm.deal.fields — cacheado em memória por processo (não
 * persiste, não precisa: nome de campo não muda numa instalação já
 * configurada; reiniciar o processo já refaz a busca).
 *
 * Devolve `null` se o webhook não estiver configurado/autorizado
 * (callBitrix já loga o erro original) ou se nenhum campo bater com o
 * rótulo esperado — quem chama trata isso como "sem resolução",
 * best-effort, nunca lança.
 */
async function resolveCustomFieldName() {
  if (fieldNameCache && Date.now() - fieldNameCache.cachedAt < FIELD_CACHE_TTL_MS) {
    return fieldNameCache.fieldName;
  }

  const fields = await callBitrix('crm.deal.fields', {});
  if (!fields) return null;

  for (const [key, def] of Object.entries(fields)) {
    if (!key.startsWith('UF_CRM_')) continue;
    const labels = extractLabels(def);
    if (labels.some((l) => String(l).trim() === CUSTOM_FIELD_LABEL)) {
      fieldNameCache = { fieldName: key, cachedAt: Date.now() };
      return key;
    }
  }

  console.error(
    `[bitrixDealFields] campo "${CUSTOM_FIELD_LABEL}" não encontrado em crm.deal.fields — ` +
      'confirmar rótulo exato no Bitrix ou ajustar LABEL_KEYS/CUSTOM_FIELD_LABEL neste arquivo.'
  );
  return null;
}

/**
 * ID do usuário Bitrix indicado no campo customizado de Verificação, pra um
 * `deal` JÁ CARREGADO por quem chama (não faz uma crm.deal.get nova — quem
 * chama já tem o deal completo em mãos, ver src/routes/cardGroup.js).
 *
 * Campo tipo "vínculo com usuário" pode vir como array (multi-seleção) ou
 * escalar — tratamos os dois, usando o primeiro quando array (critério já
 * confirmado com o usuário: "a pessoa" no campo, singular).
 */
async function getVerificationResponsibleUserId(deal) {
  const fieldName = await resolveCustomFieldName();
  if (!fieldName) return null;
  const value = deal[fieldName];
  if (value === undefined || value === null || value === '') return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

module.exports = { resolveCustomFieldName, getVerificationResponsibleUserId };
