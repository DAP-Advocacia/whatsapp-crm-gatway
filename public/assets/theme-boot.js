/*
 * Fase 0 do redesign — script de boot compartilhado (roda no <head>,
 * ANTES do primeiro paint, para nunca piscar o tema/paleta errados).
 * Espelha o comportamento do IIFE inline hoje duplicado em cada página
 * com sidebar (ver public/dashboard.html).
 *
 * Nesta fase o arquivo é linkado mas NÃO é a única fonte de verdade
 * ainda — as páginas continuam com o próprio bloco inline (que vence
 * por rodar depois, tarde o bastante, e por chamar a MESMA função só
 * que definida duas vezes). A migração de fato (apagar o bloco inline
 * de cada página e depender só deste arquivo) acontece na Fase 1, junto
 * da remoção da paleta personalizável — só então esta chamada dupla é
 * desfeita.
 */
if (localStorage.getItem('sidebarCollapsed') === '1') {
  document.documentElement.classList.add('sidebar-collapsed');
}
if (localStorage.getItem('theme') === 'light') {
  document.documentElement.setAttribute('data-theme', 'light');
}

/*
 * Aviso de "atualize a página" (2026-11-04) — compartilhado por todas as telas
 * (este arquivo já é carregado no <head> de todas).
 *
 * Aparece quando:
 *  - o login com o Bitrix falha/expira e a tela não consegue se recuperar sozinha
 *    (as telas chamam window.showReloadBanner('auth'));
 *  - o DapZap foi atualizado (deploy) enquanto a tela estava aberta: o servidor
 *    manda a versão em X-App-Version e, se ela mudar, a tela está com código antigo.
 */
(function () {
  var shown = false;
  var MESSAGES = {
    auth: 'Sua sessão com o Bitrix expirou ou falhou.',
    update: 'O DapZap foi atualizado.',
    generic: 'Algo deu errado nesta tela.',
  };
  function render(reason) {
    if (shown || !document.body) return;
    shown = true;
    var bar = document.createElement('div');
    bar.id = 'reloadBanner';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:10px 16px;background:#b45309;color:#fff;font:600 14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35);text-align:center';
    var text = document.createElement('span');
    text.innerHTML = (MESSAGES[reason] || MESSAGES.generic) +
      ' <strong>Atualize a página com Ctrl + F5</strong> (no Mac: Cmd + Shift + R).';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Atualizar agora';
    btn.style.cssText = 'padding:5px 14px;border:0;border-radius:6px;background:#fff;color:#b45309;font:700 13px system-ui,sans-serif;cursor:pointer';
    btn.onclick = function () { window.location.reload(); };
    bar.appendChild(text);
    bar.appendChild(btn);
    document.body.appendChild(bar);
  }
  window.showReloadBanner = function (reason) {
    if (document.body) render(reason);
    else document.addEventListener('DOMContentLoaded', function () { render(reason); });
  };

  // Versão do servidor: a 1ª resposta fixa a versão desta tela; se mudar, avisa.
  var pageVersion = null;
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function () {
      return origFetch.apply(this, arguments).then(function (res) {
        try {
          var v = res.headers && res.headers.get('X-App-Version');
          if (v) {
            if (!pageVersion) pageVersion = v;
            else if (v !== pageVersion) window.showReloadBanner('update');
          }
        } catch (e) { /* resposta opaca/sem cabeçalhos */ }
        return res;
      });
    };
  }
})();
