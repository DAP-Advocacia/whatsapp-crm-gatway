/**
 * Autorização do painel admin (tela `/admin.html`) — restrito a uma lista
 * pequena e configurável de ownerId, sem relação com dono de instância nem
 * hierarquia de departamento/gestor (src/authz.js, src/bitrixHierarchy.js).
 * `req.ownerId` já foi resolvido e verificado contra o Bitrix real por
 * `requireAuth` (src/auth.js) antes de chegar aqui — isto só confere se
 * essa identidade está na lista.
 *
 * SUPER_ADMIN_OWNER_IDS vem SEMPRE de configuração do servidor (.env),
 * nunca de dado enviado pelo cliente — mesmo motivo de BITRIX_PORTAL_DOMAIN
 * em src/auth.js. CSV (não uma constante única) de propósito: pensado pra
 * aceitar mais de um ownerId no futuro sem precisar mudar código.
 */

const SUPER_ADMIN_OWNER_IDS = (process.env.SUPER_ADMIN_OWNER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isSuperAdmin(ownerId) {
  return SUPER_ADMIN_OWNER_IDS.includes(ownerId);
}

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req.ownerId)) {
    return res.status(403).json({ error: 'acesso restrito' });
  }
  next();
}

const conversationAnalysisGrants = require('./conversationAnalysisGrants');

/**
 * Acesso à Auditoria de Conversas (ver src/conversationAnalysisGrants.js
 * pro porquê) — super admin SEMPRE tem acesso (checado aqui, não
 * duplicado na tabela); qualquer outro owner precisa estar em
 * conversation_analysis_grants, concedido explicitamente pelo super
 * admin via Admin > Usuários. Verificado a cada request (não cacheado)
 * — mesmo raciocínio de blockedOwners.isBlocked em requireAuth.
 */
async function hasConversationAnalysisAccess(ownerId) {
  return isSuperAdmin(ownerId) || (await conversationAnalysisGrants.hasAccess(ownerId));
}

async function requireConversationAnalysisAccess(req, res, next) {
  if (await hasConversationAnalysisAccess(req.ownerId)) return next();
  res.status(403).json({ error: 'acesso restrito' });
}

module.exports = {
  requireSuperAdmin,
  isSuperAdmin,
  SUPER_ADMIN_OWNER_IDS,
  hasConversationAnalysisAccess,
  requireConversationAnalysisAccess,
};
