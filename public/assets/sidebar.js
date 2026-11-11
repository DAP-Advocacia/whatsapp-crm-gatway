/*
 * Menu lateral ÚNICO do DapZap (2026-11-03).
 *
 * Antes, o <aside class="sidebar"> era copiado à mão em 19 telas e cada cópia
 * tinha sua própria lógica de "revelar Admin" — cada tela mostrava um conjunto
 * diferente de itens e o item Admin aparecia/sumia conforme a tela (e o
 * momento em que o whoami respondia). Agora o HTML do menu vive só aqui.
 *
 * Como usar numa tela:
 *   <aside class="sidebar" id="appSidebar"></aside>
 *   <script src="/assets/sidebar.js"></script>
 * O script é síncrono e roda logo após o <aside>, então os elementos (#themeToggleBtn,
 * #sidebarToggle, #notifDot...) já existem quando os scripts da tela rodam —
 * é o que as telas esperam.
 *
 * O item Admin continua sendo revelado pelo whoami de cada tela (a tela precisa
 * do token do Bitrix, que este arquivo não tem), mas o resultado fica em cache
 * no navegador: nas telas seguintes o item já nasce visível, sem "piscar".
 * A proteção real continua na API (requireSuperAdmin em /admin/*).
 */
(function () {
  var host = document.getElementById('appSidebar') || document.querySelector('aside.sidebar');
  if (!host) return;

  var ICONS = {
    chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    contacts: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    broadcast: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
    admin: '<path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    play: '<circle cx="12" cy="12" r="10"/><path d="M10 8.5v7l6-3.5-6-3.5Z" fill="currentColor" stroke="none"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    bellPlus: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M18 5v4"/><path d="M16 7h4"/>',
    tour: '<path d="M12 20h9"/><path d="M4 20h2"/><path d="M5 16 17.5 3.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
  };

  function svg(name, extra) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' + (extra || '') + '>' + ICONS[name] + '</svg>';
  }

  function item(href, icon, label, opts) {
    opts = opts || {};
    var cls = 'nav-item' + (opts.cls ? ' ' + opts.cls : '');
    var path = location.pathname.replace(/\/+$/, '') || '/';
    if (path === href) cls += ' active';
    return (
      '<a href="' + href + '" class="' + cls + '"' + (opts.id ? ' id="' + opts.id + '"' : '') + '>' +
      '<span class="nav-icon">' + svg(icon) + '</span>' +
      '<span class="nav-label">' + label + '</span>' +
      (opts.noTip ? '' : '<span class="nav-tip">' + label + '</span>') +
      '</a>'
    );
  }

  function button(id, icon, label) {
    return (
      '<button type="button" id="' + id + '" class="nav-item theme-toggle-item">' +
      '<span class="nav-icon">' + svg(icon) + '</span>' +
      '<span class="nav-label">' + label + '</span>' +
      '<span class="nav-tip">' + label + '</span>' +
      '</button>'
    );
  }

  // Cache do "é admin": expira em 12h (pra um acesso revogado sumir do menu).
  var CACHE_KEY = 'dapNavAdmin';
  var CACHE_TTL = 12 * 60 * 60 * 1000;
  function cachedAdmin() {
    try {
      var raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return !!(raw && raw.v === 1 && Date.now() - raw.at < CACHE_TTL);
    } catch (e) { return false; }
  }
  function cacheAdmin() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, at: Date.now() })); } catch (e) { /* modo privado */ }
  }

  var isChat = location.pathname === '/chat.html';
  var startRevealed = cachedAdmin();
  var rev = startRevealed ? ' revealed' : '';

  host.innerHTML =
    '<div class="sidebar-logo">' +
      '<img class="logo-mark" src="/assets/logo-icon.png?v=20260928" alt="Logo Durão, Almeida &amp; Pontes">' +
      '<div class="logo-text"><span class="firm-name">DapZap</span></div>' +
      '<button class="sidebar-toggle" id="sidebarToggle" title="Recolher/expandir menu">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + ICONS.back + '</svg>' +
      '</button>' +
    '</div>' +
    '<nav class="sidebar-nav">' +
      '<div class="nav-section">' +
        '<div class="nav-section-label">Workspace</div>' +
        item('/chat.html', 'chat', 'Chat') +
        (isChat ? '<div id="instanceShortcuts"></div>' : '') +
        item('/contacts.html', 'contacts', 'Contatos') +
      '</div>' +
      '<div class="nav-section">' +
        '<div class="nav-section-label">Configuração</div>' +
        item('/instances.html', 'phone', 'Conexões do WhatsApp') +
      '</div>' +
      // Seção Admin: só aparece pra super admin (ver comentário no topo).
      '<div class="nav-section' + rev + '" id="navSectionAdmin">' +
        '<div class="nav-section-label">Admin</div>' +
        item('/admin.html', 'admin', 'Admin', { id: 'navAdminItem', cls: startRevealed ? 'revealed' : '' }) +
        // Lista de transmissão: por enquanto só admin (11/11) — revela junto com o item Admin.
        item('/broadcast.html', 'broadcast', 'Lista de transmissão', { id: 'navBroadcastItem', cls: startRevealed ? 'revealed' : '' }) +
      '</div>' +
    '</nav>' +
    '<button type="button" id="themeToggleBtn" class="nav-item theme-toggle-item">' +
      '<span class="nav-icon">' +
        '<svg class="theme-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
        '<svg class="theme-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>' +
      '</span>' +
      '<span class="nav-label" id="themeToggleLabel">Tema claro</span>' +
      '<span class="nav-tip" id="themeToggleTip">Tema claro</span>' +
    '</button>' +
    button('shortcutsReopenBtn', 'help', 'Atalhos e recursos') +
    (isChat ? button('tourStartBtn', 'tour', 'Iniciar tour guiado') : '') +
    item('/how-to.html', 'play', 'Como usar?', { cls: 'theme-toggle-item' }) +
    '<div class="sidebar-bottom">' +
      '<a href="/notifications.html" class="nav-item bell-btn' + (location.pathname === '/notifications.html' ? ' active' : '') + '" id="notifBell">' +
        '<span class="nav-icon">' + svg('bell') + '</span>' +
        '<span class="nav-label">Notificações</span>' +
        '<span class="notif-dot" id="notifDot" hidden></span>' +
      '</a>' +
      '<button type="button" id="enableNativeNotifIconBtn" title="Ativar notificações do sistema" hidden>' + svg('bellPlus') + '</button>' +
    '</div>';

  // Quando a tela revela o item Admin (whoami), guarda no cache e abre a seção.
  var adminItem = document.getElementById('navAdminItem');
  var adminSection = document.getElementById('navSectionAdmin');
  var broadcastItem = document.getElementById('navBroadcastItem');
  if (adminItem && typeof MutationObserver === 'function') {
    new MutationObserver(function () {
      if (adminItem.classList.contains('revealed')) {
        cacheAdmin();
        if (adminSection) adminSection.classList.add('revealed');
        if (broadcastItem) broadcastItem.classList.add('revealed');
      }
    }).observe(adminItem, { attributes: true, attributeFilter: ['class'] });
  }
})();
