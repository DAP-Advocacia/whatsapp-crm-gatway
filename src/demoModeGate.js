/**
 * Liga o MODO DEMO (dados 100% fictícios, ver src/demoData.js) — regra
 * global CLAUDE.md 2026-08-31: todo app com uso real precisa de um
 * ambiente de demonstração pra gravar vídeo/screenshot sem depender de
 * dado real de cliente.
 *
 * Gatilho: `?demo=1` em qualquer URL. Grava um cookie (não fica preso ao
 * query param — as telas fazem chamadas de API sem query string nenhuma
 * hoje, então recarregar a página ou navegar internamente perderia o
 * `?demo=1` se ele não persistisse) e redireciona pra mesma URL sem o
 * query param, pra não grudar em todo link clicado dali em diante.
 *
 * SEM dependência nova (`cookie-parser` não está instalado nem em uso
 * neste projeto) — parse manual do header `Cookie` é suficiente aqui.
 */

const COOKIE_NAME = 'demo_mode';
const COOKIE_MAX_AGE_SECONDS = 4 * 60 * 60; // 4h — dá pra gravar/testar sem precisar re-ligar toda hora

function hasDemoCookie(cookieHeader) {
  if (!cookieHeader) return false;
  return cookieHeader
    .split(';')
    .map((p) => p.trim())
    .some((p) => p === `${COOKIE_NAME}=1`);
}

// Achado real de revisão de segurança (2026-08-31, security-reviewer-agent):
// sem uma saída explícita, um usuário real que passou por `?demo=1` uma vez
// (link compartilhado, aba antiga, cache) fica "preso" mostrando dados
// fictícios por até 4h sem nenhum aviso — inclusive o super admin em
// admin.html, que perderia acesso ao painel real nesse meio-tempo. Rota
// dedicada de saída, montada ANTES do resto (mesmo raciocínio do gate em
// si) pra sempre estar disponível independente de auth.
function demoModeExit(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`);
  res.redirect(req.query.from || '/dashboard.html');
}

function demoModeGate(req, res, next) {
  if (req.path === '/api/demo/exit') return demoModeExit(req, res);
  if (req.query.demo === '1') {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=1; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`);
    const url = new URL(req.originalUrl, `http://${req.headers.host || 'localhost'}`);
    url.searchParams.delete('demo');
    return res.redirect(url.pathname + (url.search || ''));
  }
  req.isDemoMode = hasDemoCookie(req.headers.cookie);
  next();
}

module.exports = { demoModeGate, COOKIE_NAME };
