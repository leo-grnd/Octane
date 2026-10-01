#!/usr/bin/env node
// Génère les visuels raster d'Octane à partir de leurs sources vectorielles :
//   favicon.svg                → apple-touch-icon.png (180), icons/icon-192.png,
//                                icons/icon-512.png
//   scripts/brand/og-image.html → og-image.png (1200 × 630, aperçu de partage)
//
// Les réseaux sociaux (Facebook, X, LinkedIn, WhatsApp) n'affichent pas d'aperçu
// SVG et iOS ignore une apple-touch-icon SVG : il faut des PNG. Plutôt qu'une
// dépendance de rendu, on pilote le Chrome ou l'Edge déjà installé en headless.
// Zéro dépendance npm, comme les autres scripts.
//
// Usage :
//   node scripts/render-brand.mjs
//   BROWSER_PATH="/chemin/vers/chrome" node scripts/render-brand.mjs
//
// À relancer après toute modification de favicon.svg ou de og-image.html,
// puis committer les PNG produits.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge'
].filter(Boolean);

const browser = CANDIDATES.find(p => existsSync(p));
if (!browser) {
  console.error('✗ Aucun Chrome / Edge trouvé. Indique son chemin dans BROWSER_PATH.');
  process.exit(1);
}

const TARGETS = [
  { src: 'scripts/brand/og-image.html', out: 'og-image.png', w: 1200, h: 630 },
  { src: 'favicon.svg', out: 'apple-touch-icon.png', w: 180, h: 180 },
  { src: 'favicon.svg', out: 'icons/icon-192.png', w: 192, h: 192 },
  { src: 'favicon.svg', out: 'icons/icon-512.png', w: 512, h: 512 }
];

// Dimensions réelles lues dans l'en-tête IHDR du PNG : un écart signale un
// navigateur qui a rendu à une autre taille (barre d'UI, facteur d'échelle).
function pngSize(file) {
  const buf = readFileSync(file);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Sous Windows, msedge.exe rend la main avant d'avoir écrit la capture : on
// attend que le fichier existe et que sa taille se stabilise.
async function waitForFile(file, timeoutMs = 30000) {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) {
      const size = statSync(file).size;
      if (size > 0 && size === last) return true;
      last = size;
    }
    await sleep(500);
  }
  return false;
}

let failures = 0;
for (const t of TARGETS) {
  const out = join(ROOT, t.out);
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true }); // sinon une ancienne capture passerait pour la nouvelle
  // Un profil jetable PAR rendu : un profil partagé ou un Edge déjà ouvert
  // récupèrent l'appel suivant, qui ne produit alors aucune capture.
  const profile = mkdtempSync(join(tmpdir(), 'octane-render-'));
  try {
    // Edge headless impose une largeur de fenêtre minimale (~500 px) : un SVG
    // ouvert directement s'étire à cette largeur et la capture 180 × 180 n'en
    // garde qu'un morceau. On le pose donc à sa taille exacte, en haut à gauche.
    let url = pathToFileURL(join(ROOT, t.src)).href;
    if (t.src.endsWith('.svg')) {
      const wrapper = join(profile, 'icon.html');
      writeFileSync(wrapper, `<!DOCTYPE html><html><body style="margin:0">` +
        `<img src="${url}" style="position:fixed;left:0;top:0;width:${t.w}px;height:${t.h}px" alt="">` +
        `</body></html>`);
      url = pathToFileURL(wrapper).href;
    }
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--user-data-dir=${profile}`,
      `--window-size=${t.w},${t.h}`,
      // Laisse le temps aux polices web (og-image) de se charger avant la capture.
      '--virtual-time-budget=5000',
      `--screenshot=${out}`,
      url
    ];
    const run = spawnSync(browser, args, { encoding: 'utf8', timeout: 60000 });
    if (run.status !== 0 || !(await waitForFile(out))) {
      console.error(`✗ ${t.out} : ${run.stderr || run.error || 'aucune capture produite'}`);
      failures++;
      continue;
    }
    const { w, h } = pngSize(out);
    const ok = w === t.w && h === t.h;
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} ${t.out.padEnd(22)} ${w}×${h}${ok ? '' : ` (attendu ${t.w}×${t.h})`}  ${Math.round(statSync(out).size / 1024)} Ko`);
  } finally {
    // Le navigateur peut tenir le profil encore un instant : on réessaie, et
    // un échec de nettoyage d'un dossier temporaire n'est pas une erreur.
    await sleep(1000);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
  }
}
process.exitCode = failures ? 1 : 0;
