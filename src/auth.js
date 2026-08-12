const crypto = require('crypto');
const blockedOwners = require('./blockedOwners');

/**
 * Verificação de identidade real do usuário Bitrix + emissão do token de
 * sessão do próprio app (não confundir com o access_token do Bitrix).
 *
 * IMPORTANTE: BITRIX_PORTAL_DOMAIN e BITRIX_MEMBER_ID vêm SEMPRE de
 * configuração do servidor, nunca de dado enviado pelo cliente — senão um
 * client malicioso poderia apontar a verificação pro próprio portal Bitrix
 * dele (onde tem um token válido de verdade) e se passar por qualquer
 * ownerId deste portal.
 */

const BITRIX_PORTAL_DOMAIN = process.env.BITRIX_PORTAL_DOMAIN;
const BITRIX_MEMBER_ID = process.env.BITRIX_MEMBER_ID;
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET;
const TOKEN_TTL_MS = (Number(process.env.AUTH_TOKEN_TTL_HOURS) || 12) * 60 * 60 * 1000;
// Token de API (ver POST /api/settings/api-token, gerado à mão em
// /settings.html para uso em scripts/Postman/etc. da própria equipe) — TTL
// bem mais longo que o token de sessão do navegador, que expira rápido de
// propósito. Mesmo formato/verificação de sempre (verifyAppToken não
// distingue os dois); só muda a validade embutida no próprio token.
const API_TOKEN_TTL_MS = (Number(process.env.API_TOKEN_TTL_DAYS) || 90) * 24 * 60 * 60 * 1000;

// Confirma que o access_token pertence de verdade a um usuário logado no
// portal configurado, chamando o próprio Bitrix (não confia em nada que o
// cliente afirme sobre si mesmo). Devolve o ID do usuário Bitrix, ou null.
async function verifyBitrixToken(accessToken) {
  if (!accessToken || !BITRIX_PORTAL_DOMAIN) return null;
  try {
    const url = `https://${BITRIX_PORTAL_DOMAIN}/rest/user.current.json?auth=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error || !data.result?.ID) return null;
    return String(data.result.ID);
  } catch (err) {
    console.error('[auth] falha ao verificar token com o Bitrix:', err.message);
    return null;
  }
}

function ownerIdFor(bitrixUserId) {
  return `${BITRIX_MEMBER_ID}_${bitrixUserId}`;
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payloadB64).digest('base64url');
}

function issueAppToken(ownerId) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ ownerId, exp })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

// Mesmo token, só que de validade longa — pra usar fora do navegador
// (scripts, Postman, Excel/Power Query) sem precisar regenerar a cada
// poucas horas como o token de sessão normal.
function issueApiToken(ownerId) {
  const exp = Date.now() + API_TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ ownerId, exp })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(exp).toISOString() };
}

function verifyAppToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;

  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const { ownerId, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!ownerId || !exp || Date.now() > exp) return null;
    return ownerId;
  } catch {
    return null;
  }
}

// Middleware: só confirma que o token é de um usuário Bitrix real deste
// portal e ainda válido — NÃO confere que uma `session`/`owner` específica
// pertence a ele (isso é responsabilidade de src/authz.js, por rota).
//
// Também corta quem foi bloqueado no Admin (ver src/blockedOwners.js,
// HANDOFF Parte CO) — verificado AQUI, em toda request autenticada, não
// só na emissão do token: um token já emitido (válido até
// AUTH_TOKEN_TTL_HOURS) some de efeito na PRÓXIMA chamada depois do
// bloqueio, em vez de continuar valendo até expirar sozinho. Decisão
// consciente de custo (1 query extra por request) em troca de corte
// imediato de acesso.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const ownerId = verifyAppToken(token);
  if (!ownerId) return res.status(401).json({ error: 'não autenticado' });
  try {
    if (await blockedOwners.isBlocked(ownerId)) {
      return res.status(403).json({ error: 'acesso revogado' });
    }
  } catch (err) {
    console.error('[auth] falha ao checar bloqueio (seguindo sem bloquear):', err.message);
  }
  req.ownerId = ownerId;
  next();
}

module.exports = { verifyBitrixToken, ownerIdFor, issueAppToken, issueApiToken, verifyAppToken, requireAuth, TOKEN_TTL_MS };
