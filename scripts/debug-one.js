/**
 * Debug de UMA tela: mostra no console todas as requests de API, os
 * status, e o que o BX24 mock respondeu. Uso:
 *   APP_TOKEN="Bearer eyJ..." OWNER_ID="2c39..._183168" node scripts/debug-one.js lead-metrics
 */
const { chromium } = require('playwright');

const BASE = 'https://whatsapp.bmdholding.com.br';
const APP_TOKEN = process.env.APP_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const SCREEN = process.argv[2] || 'lead-metrics';
const bareToken = (APP_TOKEN || '').replace(/^Bearer\s+/i, '');

if (!bareToken || !OWNER_ID) { console.error('faltam APP_TOKEN / OWNER_ID'); process.exit(1); }

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });

  await context.addInitScript(() => {
    const noop = () => {};
    window.BX24 = {
      init: (cb) => { console.log('[BX24] init chamado'); Promise.resolve().then(cb); },
      getAuth: () => { console.log('[BX24] getAuth chamado'); return { access_token: 'mock-access', refresh_token: 'mock-refresh', domain: 'bmdholding.bitrix24.com.br', member_id: 'mockmember', expires_in: 3600 }; },
      refreshAuth: (cb) => { console.log('[BX24] refreshAuth'); if (cb) cb({ access_token: 'mock-access', refresh_token: 'mock-refresh' }); },
      fitWindow: noop, resizeWindow: noop, scrollParentWindow: noop,
      openPath: noop, openApplication: noop, closeApplication: noop,
      getLang: () => 'br', getDomain: () => 'bmdholding.bitrix24.com.br',
      isAdmin: () => true, install: noop, installFinish: noop, ready: noop,
      loadScript: (s, cb) => { if (cb) cb(); },
      callMethod: (m, p, cb) => { console.log('[BX24] callMethod', m); if (cb) cb({ data: () => ({}), error: () => null, more: () => false, total: () => 0 }); },
      callBatch: (calls, cb) => { console.log('[BX24] callBatch'); if (cb) cb({}); },
      placement: { info: () => ({ placement: 'CRM_DEAL_DETAIL_TAB', options: {} }), getInterface: (cb) => cb && cb({}), call: noop, bindEvent: noop },
      im: { callTo: noop, phoneTo: noop },
    };
  });

  // mata o SDK real do Bitrix (senão sobrescreve o mock acima)
  await context.route(/(^|\/\/)([a-z0-9-]+\.)?bitrix24\.com\//i, (route) => { console.log('[route] SDK bitrix24.com abortado'); route.abort(); });

  await context.route('**/api/auth/verify', (route) => {
    console.log('[route] /api/auth/verify interceptado → devolvendo app token');
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: bareToken, ownerId: OWNER_ID }) });
  });

  const page = await context.newPage();
  page.on('console', (m) => console.log(`  [page.${m.type()}]`, m.text().slice(0, 250)));
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/')) console.log(`  [resp ${r.status()}] ${u.replace(BASE, '')}`);
  });
  page.on('requestfailed', (r) => console.log(`  [reqfail] ${r.url().replace(BASE, '')} — ${r.failure()?.errorText}`));

  console.log(`\n=== abrindo ${SCREEN}.html ===\n`);
  await page.goto(`${BASE}/${SCREEN}.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);

  const bodyText = await page.locator('body').innerText().catch(() => '');
  console.log('\n=== texto visível (200 chars) ===');
  console.log(bodyText.slice(0, 200).replace(/\s+/g, ' '));

  await browser.close();
})();
