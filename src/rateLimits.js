const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { verifyAppToken } = require('./auth');

/**
 * Limite de requisições da API, por USUÁRIO autenticado (não por IP).
 *
 * Por quê (2026-10-30): o limite antigo era 600 req/min POR IP em toda a /api.
 * O escritório inteiro sai por UM IP público (todos atrás do mesmo NAT), então
 * o limite era dividido entre todo mundo. Medido no log do Traefik: 46.968
 * requisições /api em 2h vindas de um único IP, com picos de 1.705/min — 2.008
 * respostas 429 (avatar, heartbeat, instances, whoami e /auth/verify), que o
 * app mostra como "falha ao autenticar com o Bitrix" e deixa o Chat instável.
 *
 * Agora: quem manda um token de app válido (Bearer) tem o PRÓPRIO balde
 * (AUTH_LIMIT/min por ownerId) — um colaborador martelando não derruba os
 * outros, e a proteção contra abuso continua por conta. Quem NÃO tem token
 * (login /api/auth/verify, formulários públicos, beacons) continua por IP, com
 * um teto mais alto porque o IP do escritório é compartilhado
 * (ANON_LIMIT/min). O token é verificado por HMAC (verifyAppToken), então não
 * dá pra forjar um ownerId pra ganhar balde novo.
 */
const AUTH_LIMIT = Number(process.env.RATE_LIMIT_USER_PER_MIN || 600);
const ANON_LIMIT = Number(process.env.RATE_LIMIT_ANON_PER_MIN || 3000);

function ownerFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return token ? verifyAppToken(token) : null;
}

function createApiLimiter({ authLimit = AUTH_LIMIT, anonLimit = ANON_LIMIT, windowMs = 60 * 1000 } = {}) {
  return rateLimit({
    windowMs,
    limit: (req) => (ownerFromRequest(req) ? authLimit : anonLimit),
    keyGenerator: (req) => {
      const owner = ownerFromRequest(req);
      return owner ? `u:${owner}` : `ip:${ipKeyGenerator(req.ip)}`;
    },
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'muitas requisições, aguarde um momento e tente de novo' },
  });
}

module.exports = { createApiLimiter, ownerFromRequest };
