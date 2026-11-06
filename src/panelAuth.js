const crypto = require('crypto');
const panelStore = require('./panelStore');

/**
 * Login do painel de auditoria (public/painel.html), SEPARADO do login do Bitrix: o painel
 * abre direto no navegador, fora do Bitrix, com usuário e senha (tabela panel_users).
 *
 *  - Senha: hash scrypt com sal, comparação em tempo constante. Nunca guardada nem logada.
 *  - Sessão: cookie HttpOnly + SameSite=Strict (+ Secure em HTTPS) com token assinado em HMAC,
 *    validade PANEL_SESSION_HOURS (8 h). Segredo separado do token do app (derivado de
 *    AUTH_TOKEN_SECRET com um rótulo próprio, ou PANEL_TOKEN_SECRET): um token do Bitrix não vale aqui.
 *  - Toda requisição que muda algo exige o cabeçalho X-Panel-CSRF (um formulário de outro site
 *    não consegue mandar cabeçalho próprio), além do SameSite=Strict.
 *  - Contra adivinhar senha: bloqueio por IP e por usuário depois de 5 erros (15 min).
 */

const SESSION_MS = (Number(process.env.PANEL_SESSION_HOURS) || 8) * 60 * 60 * 1000;
const COOKIE = 'panel_session';
const SECRET = () => {
  const base = process.env.PANEL_TOKEN_SECRET || process.env.AUTH_TOKEN_SECRET;
  if (!base) throw new Error('AUTH_TOKEN_SECRET (ou PANEL_TOKEN_SECRET) não configurado');
  return `${base}:painel-v1`;
};

// ---- senha -----------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptAsync(password, salt, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// Hash de mentira, para gastar o mesmo tempo quando o usuário não existe (não revela quem existe).
let dummyHash = null;
async function burnTime(password) {
  if (!dummyHash) dummyHash = await hashPassword('x');
  await verifyPassword(password, dummyHash);
}

// ---- limite de tentativas --------------------------------------------------

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map(); // chave -> { n, until, last }

function lockedFor(key) {
  const f = fails.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function registerFail(key) {
  const now = Date.now();
  const f = fails.get(key);
  const n = f && now - f.last < LOCK_MS ? f.n + 1 : 1;
  fails.set(key, { n, last: now, until: n >= MAX_FAILS ? now + LOCK_MS : 0 });
  if (fails.size > 5000) for (const [k, v] of fails) if (now - v.last > LOCK_MS) fails.delete(k);
}
function clearFails(key) { fails.delete(key); }

// ---- sessão ----------------------------------------------------------------

function sign(payloadB64) {
  return crypto.createHmac('sha256', SECRET()).update(payloadB64).digest('base64url');
}

function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ u: user.username, exp: Date.now() + SESSION_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return u && exp && Date.now() < exp ? u : null;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function isHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, token) {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, 'Path=/api/panel', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(SESSION_MS / 1000)}`];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${COOKIE}=`, 'Path=/api/panel', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Usuário ativo conferido a cada requisição (cache de 30 s): desativar alguém corta o acesso logo.
const userCache = new Map(); // username -> { at, user }
async function activeUser(username) {
  const hit = userCache.get(username);
  if (hit && Date.now() - hit.at < 30000) return hit.user;
  const user = await panelStore.getUserByName(username);
  const ok = user && user.active ? user : null;
  userCache.set(username, { at: Date.now(), user: ok });
  return ok;
}

async function requirePanelAuth(req, res, next) {
  try {
    const username = verifyToken(readCookie(req, COOKIE));
    const user = username ? await activeUser(username) : null;
    if (!user) return res.status(401).json({ error: 'não autenticado' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-panel-csrf'] !== '1') {
      return res.status(403).json({ error: 'requisição recusada' });
    }
    req.panelUser = { id: user.id, username: user.username, displayName: user.displayName || user.username };
    next();
  } catch (err) {
    if (panelStore.tablesMissing(err)) return res.status(503).json({ error: 'tabelas do painel ainda não foram criadas (db/painel.sql)', setup: true });
    console.error('[panel] erro de autenticação:', err.message);
    res.status(500).json({ error: 'erro interno' });
  }
}

async function login(req, res) {
  const username = String(req.body?.username || '').trim().slice(0, 80);
  const password = String(req.body?.password || '').slice(0, 200);
  if (!username || !password) return res.status(400).json({ error: 'informe usuário e senha' });
  if (req.headers['x-panel-csrf'] !== '1') return res.status(403).json({ error: 'requisição recusada' });
  const ipKey = `ip:${req.ip}`;
  const userKey = `u:${username.toLowerCase()}`;
  const wait = Math.max(lockedFor(ipKey), lockedFor(userKey));
  if (wait) return res.status(429).json({ error: `muitas tentativas — tente de novo em ${Math.ceil(wait / 60)} min` });
  try {
    const user = await panelStore.getUserByName(username);
    const ok = user && user.active ? await verifyPassword(password, user.passwordHash) : (await burnTime(password), false);
    if (!ok) {
      registerFail(ipKey);
      registerFail(userKey);
      console.warn(`[panel] login recusado (usuário "${username.slice(0, 40)}", ip ${req.ip})`);
      return res.status(401).json({ error: 'usuário ou senha incorretos' });
    }
    clearFails(ipKey);
    clearFails(userKey);
    userCache.delete(user.username);
    await panelStore.touchLogin(user.id).catch(() => {});
    setSessionCookie(req, res, issueToken(user));
    res.json({ ok: true, user: { username: user.username, displayName: user.displayName || user.username } });
  } catch (err) {
    if (panelStore.tablesMissing(err)) return res.status(503).json({ error: 'tabelas do painel ainda não foram criadas (db/painel.sql)', setup: true });
    console.error('[panel] erro no login:', err.message);
    res.status(500).json({ error: 'erro interno' });
  }
}

function forgetUser(username) { userCache.delete(username); }

module.exports = {
  hashPassword, verifyPassword, requirePanelAuth, login, setSessionCookie, clearSessionCookie, forgetUser,
  MIN_PASSWORD_LENGTH: 10,
};
