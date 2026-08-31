/**
 * Monta o vídeo final de onboarding — concatena as cenas gravadas
 * (rec.mjs) com a narração (narracao.py), esticando cada cena via
 * freeze-frame no final até bater a duração real da fala daquela parte
 * (a gravação de tela é sempre mais curta que a locução, que detalha
 * mais do que dá pra mostrar só navegando).
 *
 * Abertura e encerramento não têm cena de tela — viram um cartão de
 * texto na paleta do projeto (ver docs/design-system.md), gerado aqui
 * mesmo via ffmpeg (drawtext), sem precisar de editor de imagem.
 *
 * Pré-requisito: rec.mjs e narracao.py já rodados (scenes/*.webm,
 * build/narracao/*.mp3, build/narracao-durations.json existem).
 *
 * Uso: node scripts/video/build.mjs
 * Saída: scripts/video/build/video-onboarding.mp4 (+ frame de capa
 * copiado depois pra public/video/ na etapa de publicação).
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = path.join(__dirname, 'build');
const SCENES_DIR = path.join(BUILD_DIR, 'scenes');
const OUT = path.join(BUILD_DIR, 'video-onboarding.mp4');

const W = 1440, H = 900, FPS = 24;

// Ordem final: abertura (cartão) -> 5 cenas de tela -> encerramento (cartão).
// slug bate com narracao-texto.json / narracao-durations.json.
const TIMELINE = [
  { slug: '00-abertura', kind: 'card', title: 'WhatsApp Gateway', subtitle: 'Tour rápido pelo sistema' },
  { slug: '01-dashboard', kind: 'scene', file: '01-01-dashboard.webm' },
  { slug: '02-contatos', kind: 'scene', file: '02-02-contatos.webm' },
  { slug: '03-campanha', kind: 'scene', file: '03-03-campanha.webm' },
  { slug: '04-agente-ia', kind: 'scene', file: '04-04-agente-ia.webm' },
  { slug: '05-configuracoes', kind: 'scene', file: '05-05-configuracoes.webm' },
  { slug: '06-encerramento', kind: 'card', title: 'WhatsApp Gateway', subtitle: 'Desenvolvido por Daniel Costa' },
];

function sh(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

function main() {
  const durations = JSON.parse(readFileSync(path.join(BUILD_DIR, 'narracao-durations.json'), 'utf8'));
  const segDir = path.join(BUILD_DIR, 'segments');
  mkdirSync(segDir, { recursive: true });

  const segmentFiles = [];

  for (const item of TIMELINE) {
    const targetDur = durations[item.slug];
    if (!targetDur) throw new Error(`sem duração de narração pra ${item.slug} — rode narracao.py primeiro`);
    const outSeg = path.join(segDir, `${item.slug}.mp4`);

    if (item.kind === 'card') {
      // Cartão de texto — paleta escura do projeto (--bg: #15120d, --gold: #d8ab4f).
      const escTitle = item.title.replace(/'/g, "\\'").replace(/:/g, '\\:');
      const escSub = item.subtitle.replace(/'/g, "\\'").replace(/:/g, '\\:');
      sh(
        `ffmpeg -y -f lavfi -i color=c=0x15120d:s=${W}x${H}:d=${targetDur}:r=${FPS} ` +
        `-vf "drawtext=fontfile='C\\:/Windows/Fonts/georgia.ttf':text='${escTitle}':fontcolor=0xd8ab4f:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2-30,` +
        `drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='${escSub}':fontcolor=0xa89a83:fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2+50" ` +
        `-pix_fmt yuv420p "${outSeg}"`
      );
    } else {
      const inputWebm = path.join(SCENES_DIR, item.file);
      if (!existsSync(inputWebm)) throw new Error(`cena não encontrada: ${inputWebm} — rode rec.mjs primeiro`);
      // Duração real da cena gravada; se a narração pedir mais tempo,
      // estica com freeze-frame do último frame (tpad); se pedir menos
      // (não deve acontecer no roteiro atual, mas por segurança), corta.
      sh(
        `ffmpeg -y -i "${inputWebm}" -t ${targetDur} ` +
        `-vf "tpad=stop_mode=clone:stop_duration=${targetDur},trim=duration=${targetDur},fps=${FPS},scale=${W}:${H}" ` +
        `-pix_fmt yuv420p -an "${outSeg}"`
      );
    }
    segmentFiles.push(outSeg);
  }

  // Concatena os segmentos de vídeo (sem áudio ainda).
  const concatList = path.join(segDir, 'concat.txt');
  writeFileSync(concatList, segmentFiles.map((f) => `file '${f}'`).join('\n'));
  const videoOnly = path.join(BUILD_DIR, 'video-only.mp4');
  sh(`ffmpeg -y -f concat -safe 0 -i "${concatList}" -c:v libx264 -pix_fmt yuv420p -r ${FPS} "${videoOnly}"`);

  // Junta com a narração completa (já concatenada por narracao.py).
  const narrPath = path.join(BUILD_DIR, 'narracao-full.mp3');
  sh(
    `ffmpeg -y -i "${videoOnly}" -i "${narrPath}" -c:v copy -c:a aac -b:a 160k -shortest "${OUT}"`
  );

  console.log(`\nVídeo final: ${OUT}`);
}

main();
