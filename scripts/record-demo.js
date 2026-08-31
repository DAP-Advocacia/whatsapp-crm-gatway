/**
 * Grava um screencast de demonstração do gateway navegando pela instância
 * de PRODUÇÃO (https://whatsapp.bmdholding.com.br) com um app token real.
 *
 * Uso:
 *   APP_TOKEN="Bearer eyJ..." OWNER_ID="2c39..._183168" node scripts/record-demo.js
 *
 * Saída em docs/demo-<timestamp>/:
 *   - video.webm            (screencast contínuo)
 *   - 01-dashboard.png ...  (screenshot de cada tela, fallback)
 *
 * COMO FUNCIONA:
 *   As telas carregam o SDK real do Bitrix (<script src="//api.bitrix24.com/api/v1/">),
 *   que só devolve um access_token de verdade quando a página roda DENTRO de
 *   um iframe do portal. Fora dele, verifyAuth() lança "abra esta página de
 *   dentro do Bitrix24" e as chamadas de API vão sem token (401).
 *   Solução: abortamos o request pra api.bitrix24.com (mata o SDK real),
 *   um addInitScript instala um BX24 mock no lugar, e interceptamos
 *   POST /api/auth/verify pra devolver o app token real que já temos.
 *
 * PII / LGPD: o nome do cliente ("Durão, Almeida & Pontes") está hardcoded
 * no HTML de cada tela (.firm-name / .firm-sub). O script troca por um nome
 * fictício antes de cada screenshot. Revisão manual do resultado continua
 * obrigatória antes de publicar no portfólio.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = 'https://whatsapp.bmdholding.com.br';
const APP_TOKEN = process.env.APP_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const FAKE_FIRM = process.env.FAKE_FIRM || 'Andrade & Camargo';
const FAKE_FIRM_SUB = process.env.FAKE_FIRM_SUB || 'Advogados Associados';

if (!APP_TOKEN || !OWNER_ID) {
  console.error('Faltam env APP_TOKEN e/ou OWNER_ID.');
  process.exit(1);
}
const bareToken = APP_TOKEN.replace(/^Bearer\s+/i, '');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.resolve(__dirname, '..', 'docs', `demo-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });

// Troca o nome real do cliente + borra PII. Duas frentes:
//  1. CSS de blur cobrindo TODAS as classes reais mapeadas do projeto
//     (dashboard .contact-cell, contacts td, campaign .recipient-row,
//     conversation-analysis .conv-*, admin .person-name, etc.)
//  2. Varredura de texto: qualquer nó de texto que case telefone BR,
//     "negócio #12345" ou o owner-id composto é mascarado.
const SANITIZE_JS = (firm, sub) => `
  (function () {
    document.querySelectorAll('.firm-name').forEach((e) => { e.textContent = ${JSON.stringify(firm)}; });
    document.querySelectorAll('.firm-sub').forEach((e) => { e.textContent = ${JSON.stringify(sub)}; });

    if (!document.getElementById('__demo_blur')) {
      var css = document.createElement('style');
      css.id = '__demo_blur';
      css.textContent = [
        // dashboard — tabela de conversas
        '.contact-cell', '.contact-cell .phone',
        // contacts — tabela + listas + grupos
        '#contactsTableWrap td', '.list-name', '.list-card label span', '.group-card label span',
        '.checkbox-list label span',
        // campaign — destinatários
        '.recipient-row .phone', '.recipient-row .meta',
        // conversation-analysis — tabela + histórico de mensagens
        'td.conv-name', 'td.conv-preview', 'td.conv-meta',
        '.bubble-row', '.caption-text', '.history-messages',
        // admin — lista de pessoas
        '.person-name', '#usersTable td:nth-child(1)', '#usersTable td:nth-child(5)',
        // notifications — cards do kanban / calendário
        '.notif-card .contact', '.notif-card .preview', '.notif-preview', '.notif-contact',
        // genéricos que várias telas usam
        '[data-phone]', '.chat-name'
      ].join(',') + '{ filter: blur(7px) !important; }';
      document.head.appendChild(css);
    }

    // Varredura de texto solto (IDs de negócio, telefones, owner-id).
    var reOwner = /[a-f0-9]{32}_\\d+/g;
    var reDeal  = /neg[óo]cio\\s*#\\s*\\d+/gi;
    var rePhone = /\\+?55\\s?\\d{2}\\s?\\d{4,5}[- ]?\\d{4}/g;
    var reBare  = /\\b\\d{12,13}\\b/g;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (n) {
      var v = n.nodeValue;
      if (!v) return;
      if (reOwner.test(v) || reDeal.test(v) || rePhone.test(v) || reBare.test(v)) {
        n.nodeValue = v
          .replace(reOwner, 'instância-demo')
          .replace(reDeal, 'negócio #####')
          .replace(rePhone, '+55 21 ####-####')
          .replace(reBare, '55219########');
      }
    });
  })();
`;

const SCREENS = [
  { slug: '01-dashboard',         name: 'Dashboard',            url: `${BASE}/dashboard.html`,            wait: '#content' },
  { slug: '02-contatos',          name: 'Contatos',             url: `${BASE}/contacts.html` },
  { slug: '03-campanhas',         name: 'Campanhas',            url: `${BASE}/campaign.html` },
  { slug: '04-campanha-metrics',  name: 'Métricas de campanha', url: `${BASE}/campaign-metrics.html` },
  { slug: '05-leads-metrics',     name: 'Métricas de leads',    url: `${BASE}/lead-metrics.html` },
  { slug: '06-sugestoes',         name: 'Sugestões da IA',      url: `${BASE}/suggestions.html` },
  { slug: '07-agente-ia',         name: 'Agente IA',            url: `${BASE}/agente-ia.html` },
  { slug: '08-analise-conversas', name: 'Análise de conversas', url: `${BASE}/conversation-analysis.html` },
  { slug: '09-instancias',        name: 'Instâncias',           url: `${BASE}/instances.html` },
  { slug: '10-configuracoes',     name: 'Configurações',        url: `${BASE}/settings.html` },
  { slug: '11-notificacoes',      name: 'Notificações',         url: `${BASE}/notifications.html` },
];

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: outDir, size: { width: 1440, height: 900 } },
    locale: 'pt-BR',
  });

  // 1. Instala o BX24 mock ANTES de qualquer script da página.
  await context.addInitScript(() => {
    const noop = () => {};
    const auth = { access_token: 'mock-access', refresh_token: 'mock-refresh', domain: 'bmdholding.bitrix24.com.br', member_id: 'mockmember', expires_in: 3600 };
    window.BX24 = {
      init: (cb) => { Promise.resolve().then(cb); },
      getAuth: () => auth,
      refreshAuth: (cb) => { if (cb) cb(auth); return auth; },
      getLang: () => 'br',
      getDomain: () => 'bmdholding.bitrix24.com.br',
      isAdmin: () => true,
      fitWindow: noop, resizeWindow: noop, scrollParentWindow: noop,
      openPath: noop, openApplication: noop, closeApplication: noop,
      install: noop, installFinish: noop, ready: noop,
      loadScript: (s, cb) => { if (cb) cb(); },
      callMethod: (m, p, cb) => { if (cb) cb({ data: () => ({}), error: () => null, more: () => false, total: () => 0, next: noop }); },
      callBatch: (calls, cb) => { if (cb) cb({}); },
      placement: { info: () => ({ placement: 'CRM_DEAL_DETAIL_TAB', options: {} }), getInterface: (cb) => cb && cb({ command: [] }), call: noop, bindEvent: noop },
      im: { callTo: noop, phoneTo: noop },
      proxy: (fn) => fn,
      bind: noop, unbind: noop,
    };
  });

  // 2. Mata o SDK real do Bitrix (sobrescreveria o mock).
  await context.route(/(^|\/\/)([a-z0-9-]+\.)?bitrix24\.com\//i, (route) => route.abort());
  await context.route('**/api/v1/**', (route) => {
    return route.request().url().includes('bitrix24.com') ? route.abort() : route.continue();
  });

  // 3. Devolve o app token real sem passar pelo Bitrix.
  await context.route('**/api/auth/verify', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ token: bareToken, ownerId: OWNER_ID }),
    })
  );

  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [err]', m.text().slice(0, 140)); });

  const results = [];
  for (const s of SCREENS) {
    process.stdout.write(`→ ${s.name} ... `);
    try {
      await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.evaluate(SANITIZE_JS(FAKE_FIRM, FAKE_FIRM_SUB));
      // dá tempo do boot autenticar + primeira leva de dados
      await page.waitForTimeout(6000);
      await page.evaluate(SANITIZE_JS(FAKE_FIRM, FAKE_FIRM_SUB)); // reaplica pós-render
      await page.evaluate(async () => {
        const h = document.body.scrollHeight;
        for (let y = 0; y < h; y += 320) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 130)); }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(1200);
      await page.evaluate(SANITIZE_JS(FAKE_FIRM, FAKE_FIRM_SUB)); // 3ª: pega o que o scroll lazy-renderizou
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(outDir, `${s.slug}.png`), fullPage: true });
      const t = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
      const fallback = /abra esta página de dentro do bitrix|não autenticado|falha ao carregar instâncias/i.test(t);
      results.push({ ...s, ok: !fallback, preview: t.slice(0, 90) });
      console.log(fallback ? 'FALLBACK' : 'ok');
    } catch (err) {
      results.push({ ...s, ok: false, err: err.message });
      console.log(`ERRO (${err.message})`);
    }
  }

  await page.waitForTimeout(800);
  await context.close();
  await browser.close();

  const vids = fs.readdirSync(outDir).filter((f) => f.endsWith('.webm'));
  if (vids.length === 1) fs.renameSync(path.join(outDir, vids[0]), path.join(outDir, 'video.webm'));

  console.log('\n─────────────────────────────');
  console.log('Saída:', outDir);
  console.log('Vídeo:', vids.length ? 'video.webm' : '(nenhum)');
  results.forEach((r) => console.log(`  ${r.ok ? '✓' : '✗'} ${r.slug}  ${r.ok ? '· ' + r.preview : '· ' + (r.err || 'fallback/vazio')}`));
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${okCount}/${results.length} telas renderizaram com dados.`);
})();
