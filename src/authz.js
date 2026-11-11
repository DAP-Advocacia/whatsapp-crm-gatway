const instancesStore = require('./instances');
const { getSubordinates } = require('./bitrixHierarchy');
const { isSuperAdmin } = require('./adminAuth');

/**
 * Checagem de posse/acesso: confirma que a(s) instância(s) de WhatsApp que a
 * requisição quer usar realmente pertence(m) — ou foram delegadas, manual
 * (ver db/schema.sql, instance_delegates) ou automaticamente via hierarquia
 * do Bitrix (ver src/bitrixHierarchy.js — gestor de departamento acessa
 * instâncias de todo subordinado) — ao dono autenticado (req.ownerId, já
 * verificado pelo middleware requireAuth em src/auth.js).
 */

function normalizeSessionIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

// session_id virtual do Dapinho (ver src/dapinho.js) — NUNCA passa por
// `instances`, de propósito: é uma conversa de sistema, não uma instância
// WhatsApp real, então não pode ser delegada nem herdada por hierarquia
// como as demais. Pertence estrita e exclusivamente ao ownerId embutido no
// próprio id — só o dono citado no sufixo acessa a própria conversa.
function isDapinhoSession(id) {
  return typeof id === 'string' && id.startsWith('dapinho::');
}

// Cobre dono com uma instância só (id === ownerId, ver
// instances.ensureDefault), dono com várias instâncias, e delegado (não é o
// dono, mas está em instance_delegates pra essa instância).
//
// Delegação AUTOMÁTICA por hierarquia (gestor acessa subordinado só por
// estar acima na árvore do Bitrix, via getSubordinates) DESATIVADA a pedido
// do usuário 2026-10-01 — questão de privacidade, até ele definir uma regra
// explícita de quem pode ver conversa de quem. getSubordinates/
// hierarchy_subordinates não foram removidos, só deixaram de ser
// consultados aqui — fácil reativar (descomentar o bloco abaixo) quando a
// regra nova estiver definida. Delegação MANUAL (instance_delegates)
// continua valendo normalmente — é o dono da instância escolhendo
// compartilhar, não algo concedido automaticamente pela hierarquia.
async function assertOwnsSession(sessionIdOrCsv, ownerId) {
  const ids = normalizeSessionIds(sessionIdOrCsv);
  if (!ids.length || !ownerId) return false;
  for (const id of ids) {
    if (id === ownerId) continue;
    if (isDapinhoSession(id)) {
      if (id === `dapinho::${ownerId}`) continue;
      return false; // Dapinho de OUTRO dono — nunca acessível, nem por hierarquia
    }
    const inst = await instancesStore.get(id);
    if (!inst) return false;
    if (inst.ownerId === ownerId) continue;
    const delegates = await instancesStore.listDelegates(id);
    if (delegates.some((d) => d.delegateOwnerId === ownerId)) continue;
    // const subordinates = await getSubordinates(ownerId);
    // if (subordinates.includes(inst.ownerId)) continue;
    return false;
  }
  return true;
}

// Middleware factory para rotas que recebem `session` (um id ou uma lista
// "a,b,c") via query ou body. `extractor(req)` devolve o valor bruto.
function requireSession(extractor) {
  return async (req, res, next) => {
    const raw = extractor(req);
    if (!raw) return res.status(400).json({ error: 'session é obrigatório' });
    if (!(await assertOwnsSession(raw, req.ownerId))) {
      return res.status(403).json({ error: 'sessão não pertence a este usuário' });
    }
    req.sessionIds = normalizeSessionIds(raw);
    next();
  };
}

// Lista de transmissão: o super admin pode disparar/agendar/acompanhar por
// QUALQUER instância real (linha em `instances`), mesmo sem ser dono nem
// delegado. Só é usada nas rotas de campanha (ver *OrAdmin abaixo) — de
// propósito NÃO foi colocada dentro de assertOwnsSession, que protege
// chat/conversas/contatos de todo mundo (mesmo motivo de a hierarquia do
// Bitrix estar desligada ali). Dapinho de outro dono nunca passa.
async function adminCanUseSession(sessionIdOrCsv, ownerId) {
  if (!isSuperAdmin(ownerId)) return false;
  const ids = normalizeSessionIds(sessionIdOrCsv);
  if (!ids.length) return false;
  for (const id of ids) {
    if (id === ownerId) continue;
    if (isDapinhoSession(id)) return false;
    if (!(await instancesStore.get(id))) return false;
  }
  return true;
}

// Igual a requireSession, mas deixa o super admin usar instância de outra
// pessoa. `req.crossSession` fica true quando isso aconteceu (a rota usa
// pra registrar no histórico de ações).
function requireSessionOrAdmin(extractor) {
  return async (req, res, next) => {
    const raw = extractor(req);
    if (!raw) return res.status(400).json({ error: 'session é obrigatório' });
    if (await assertOwnsSession(raw, req.ownerId)) {
      req.crossSession = false;
    } else if (await adminCanUseSession(raw, req.ownerId)) {
      req.crossSession = true;
    } else {
      return res.status(403).json({ error: 'sessão não pertence a este usuário' });
    }
    req.sessionIds = normalizeSessionIds(raw);
    next();
  };
}

// Middleware factory para rotas que operam por :id de um recurso (campanha,
// agendamento, contato, lista, template) cujo dono não vem de um param que o
// client manda, mas do próprio registro no banco. `lookupSessionId(req)`
// deve devolver o session_id dono do recurso (ou null/undefined se não
// existir). 404 (não 403) para não revelar que o recurso existe.
function requireResourceSession(lookupSessionId) {
  return async (req, res, next) => {
    let sessionId;
    try {
      sessionId = await lookupSessionId(req);
    } catch (err) {
      console.error('[authz] falha ao resolver dono do recurso:', err.message);
      return res.status(502).json({ error: err.message });
    }
    if (!sessionId || !(await assertOwnsSession(sessionId, req.ownerId))) {
      return res.status(404).json({ error: 'não encontrado' });
    }
    req.resourceSessionId = sessionId;
    next();
  };
}

// Variante de requireResourceSession com a mesma exceção do super admin
// (ver adminCanUseSession) — pra acompanhar/gerenciar campanhas e
// agendamentos de uma instância alheia.
function requireResourceSessionOrAdmin(lookupSessionId) {
  return async (req, res, next) => {
    let sessionId;
    try {
      sessionId = await lookupSessionId(req);
    } catch (err) {
      console.error('[authz] falha ao resolver dono do recurso:', err.message);
      return res.status(502).json({ error: err.message });
    }
    if (!sessionId) return res.status(404).json({ error: 'não encontrado' });
    if (await assertOwnsSession(sessionId, req.ownerId)) {
      req.crossSession = false;
    } else if (await adminCanUseSession(sessionId, req.ownerId)) {
      req.crossSession = true;
    } else {
      return res.status(404).json({ error: 'não encontrado' });
    }
    req.resourceSessionId = sessionId;
    next();
  };
}

// Middleware factory para rotas de CRUD de instância, onde o client manda um
// `owner` que deveria SER o próprio usuário autenticado (não uma sessão
// alheia que ele possa ler) — compara direto contra req.ownerId, sem
// precisar ir ao banco.
function requireOwnerMatch(extractor) {
  return (req, res, next) => {
    const owner = extractor(req);
    if (!owner) return res.status(400).json({ error: 'owner é obrigatório' });
    if (owner !== req.ownerId) {
      return res.status(403).json({ error: 'owner não corresponde ao usuário autenticado' });
    }
    next();
  };
}

// Middleware factory para rotas por :id de um recurso dono direto de um
// owner_id (não de um session_id) — hoje só `notifications`. Espelha
// requireResourceSession acima, mas compara owner_id direto, sem a
// indireção de assertOwnsSession (que é pra recursos por sessão de
// WhatsApp). 404 (não 403) pra não revelar que o recurso existe.
function requireResourceOwner(lookupOwnerId) {
  return async (req, res, next) => {
    let ownerId;
    try {
      ownerId = await lookupOwnerId(req);
    } catch (err) {
      console.error('[authz] falha ao resolver dono do recurso:', err.message);
      return res.status(502).json({ error: err.message });
    }
    if (!ownerId || ownerId !== req.ownerId) {
      return res.status(404).json({ error: 'não encontrado' });
    }
    next();
  };
}

module.exports = {
  assertOwnsSession,
  requireSession,
  requireResourceSession,
  requireSessionOrAdmin,
  requireResourceSessionOrAdmin,
  requireOwnerMatch,
  requireResourceOwner,
  normalizeSessionIds,
  isDapinhoSession,
};
