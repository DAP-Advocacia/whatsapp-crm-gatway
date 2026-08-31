/**
 * Grava as cenas do vídeo de onboarding — screencast real do MODO DEMO
 * (ver src/demoModeGate.js, src/demoData.js), seguindo docs/roteiro-video.md.
 *
 * Diferente do scripts/record-demo.js (tentativa anterior, apontava pra
 * PRODUÇÃO com mock de BX24 e blur de CSS — não funcionou, ver HANDOFF e
 * licoes-tecnicas.md), este script é bem mais simples: o modo demo já
 * resolve autenticação e dados fictícios, então só precisa navegar e
 * gravar. O banner vermelho "MODO DEMO" (correto para navegação manual)
 * é escondido via CSS injetado ANTES da gravação — nunca deve aparecer
 * no vídeo final publicado.
 *
 * Uso:
 *   node scripts/video/rec.mjs [--base=http://127.0.0.1:3333]
 *
 * Saída: scripts/video/build/scenes/<NN>-<slug>.webm (um arquivo por
 * cena) + build/scenes/manifest.json (ordem + slug, consumido por
 * build.mjs).
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readdirSync, renameSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv.find((a) => a.startsWith('--base='))?.split('=')[1] || 'http://127.0.0.1:3333';
const OUT_DIR = path.join(__dirname, 'build', 'scenes');
mkdirSync(OUT_DIR, { recursive: true });

// Esconde o banner de modo demo (necessário pra quem navega manualmente,
// não deve aparecer no vídeo publicado) e faz um scroll suave — mesma
// lógica já validada em scripts/record-demo.js.
const HIDE_BANNER_CSS = `.demo-mode-banner{ display: none !important; }`;

// Ordem e duração-alvo aproximada de cada cena, casando com
// docs/roteiro-video.md. A duração real da narração (gerada depois,
// ver narracao.py) é quem define o corte final em build.mjs — aqui só
// grava um pouco mais que o necessário, sobra é cortada na montagem.
const SCENES = [
  { slug: '01-dashboard', url: `${BASE}/dashboard.html`, seconds: 16 },
  { slug: '02-contatos', url: `${BASE}/contacts.html`, seconds: 10 },
  { slug: '03-campanha', url: `${BASE}/campaign.html`, seconds: 14 },
  { slug: '04-agente-ia', url: `${BASE}/agente-ia.html`, seconds: 14 },
  { slug: '05-configuracoes', url: `${BASE}/settings.html`, seconds: 12 },
];

(async () => {
  const browser = await chromium.launch();
  const manifest = [];

  for (let i = 0; i < SCENES.length; i++) {
    const scene = SCENES[i];
    const sceneDir = path.join(OUT_DIR, `_tmp-${scene.slug}`);
    mkdirSync(sceneDir, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir: sceneDir, size: { width: 1440, height: 900 } },
    });
    const page = await context.newPage();

    // Liga o modo demo uma vez por context (cookie persiste na sessão).
    await page.goto(`${BASE}/dashboard.html?demo=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);

    process.stdout.write(`→ ${scene.slug} (${scene.seconds}s) ... `);
    await page.goto(scene.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.addStyleTag({ content: HIDE_BANNER_CSS });
    await page.waitForTimeout(2500); // deixa os dados carregarem antes de começar a "atuar"

    // Scroll suave pra mostrar mais da tela (mesma lógica de record-demo.js)
    await page.evaluate(async () => {
      const h = document.body.scrollHeight;
      const viewport = window.innerHeight;
      if (h <= viewport * 1.2) return; // não vale a pena rolar se já cabe
      for (let y = 0; y < h - viewport; y += 220) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 180));
      }
      await new Promise((r) => setTimeout(r, 400));
      window.scrollTo(0, 0);
    });

    const elapsed = 2500 + 400; // aproximação; garante o mínimo de duração pedido
    const remaining = Math.max(0, scene.seconds * 1000 - elapsed);
    await page.waitForTimeout(remaining);

    await context.close(); // finaliza o .webm desta cena
    console.log('ok');

    // Playwright nomeia o arquivo sozinho dentro da pasta temp — move
    // pro nome final e limpa a pasta temp.
    const files = readdirSync(sceneDir).filter((f) => f.endsWith('.webm'));
    if (files.length !== 1) {
      console.warn(`  ! esperava 1 .webm em ${sceneDir}, achei ${files.length}`);
    }
    const finalPath = path.join(OUT_DIR, `${String(i + 1).padStart(2, '0')}-${scene.slug}.webm`);
    if (files[0]) renameSync(path.join(sceneDir, files[0]), finalPath);
    manifest.push({ order: i + 1, slug: scene.slug, file: path.basename(finalPath) });
  }

  await browser.close();
  writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n${manifest.length} cenas gravadas em ${OUT_DIR}`);
})();
