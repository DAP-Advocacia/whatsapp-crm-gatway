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

module.exports = { requireSuperAdmin, isSuperAdmin, SUPER_ADMIN_OWNER_IDS };
