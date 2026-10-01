#!/usr/bin/env node
// Génère les visuels raster d'Octane à partir de leurs sources vectorielles :
//   scripts/brand/app-icon.svg  → public/apple-touch-icon.png (180),
//                                 public/icons/icon-192.png, public/icons/icon-512.png
//                                 (public/favicon.svg, la jauge seule sur fond
//                                 transparent, est servi tel quel)
//   scripts/brand/og-image.html → public/og-image.png (1200 × 630, aperçu de partage)
//   scripts/brand/backdrop.html → public/backdrop.webp (1408 × 1024, fond de carte
//                                 du haut des pages, assemblé depuis le Plan IGN)
//
// Les réseaux sociaux (Facebook, X, LinkedIn, WhatsApp) n'affichent pas d'aperçu
// SVG et iOS ignore une apple-touch-icon SVG : il faut des PNG. Plutôt qu'une
// dépendance de rendu, on pilote le Chrome ou l'Edge déjà installé en headless.
// Zéro dépendance npm, comme les autres scripts.
//
// Usage :
//   node scripts/render-brand.mjs              (toutes les cibles)
//   node scripts/render-brand.mjs backdrop     (seulement celles dont le chemin contient « backdrop »)
//   BROWSER_PATH="/chemin/vers/chrome" node scripts/render-brand.mjs
//
// À relancer après toute modification d'une source (scripts/brand/*), puis
// committer les images produites. Node 22 ou plus.

import { spawn, spawnSync } from 'node:child_process';
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
  { src: 'scripts/brand/og-image.html', out: 'public/og-image.png', w: 1200, h: 630 },
  { src: 'scripts/brand/app-icon.svg', out: 'public/apple-touch-icon.png', w: 180, h: 180 },
  { src: 'scripts/brand/app-icon.svg', out: 'public/icons/icon-192.png', w: 192, h: 192 },
  { src: 'scripts/brand/app-icon.svg', out: 'public/icons/icon-512.png', w: 512, h: 512 },
  // Image encodée par la page elle-même (canvas → data: URL dans #out), et non
  // capturée : une capture ne sait produire que du PNG, ~5 fois plus lourd ici.
  { src: 'scripts/brand/backdrop.html', out: 'public/backdrop.webp', w: 1408, h: 1024, encoded: true }
];

// Dimensions réelles lues dans l'en-tête du fichier (IHDR du PNG, VP8/VP8L/VP8X
// du WebP) : un écart signale un navigateur qui a rendu à une autre taille
// (barre d'UI, facteur d'échelle).
function imageSize(file) {
  const buf = readFileSync(file);
  if (buf.toString('ascii', 0, 4) === 'RIFF') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    const bits = buf.readUInt32LE(21); // VP8L
    return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
  }
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

// Capture d'écran de la page (ou du SVG) à la taille exacte de la cible.
async function renderScreenshot(url, t, profile, out) {
  // Edge headless impose une largeur de fenêtre minimale (~500 px) : un SVG
  // ouvert directement s'étire à cette largeur et la capture 180 × 180 n'en
  // garde qu'un morceau. On le pose donc à sa taille exacte, en haut à gauche.
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
    // og-image.html charge la police du site par un chemin file:// : sans ce
    // drapeau, le navigateur bloque la police et rend en police système.
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    `--window-size=${t.w},${t.h}`,
    // Laisse le temps aux polices web (og-image) de se charger avant la capture.
    '--virtual-time-budget=5000',
    `--screenshot=${out}`,
    url
  ];
  const run = spawnSync(browser, args, { encoding: 'utf8', timeout: 60000 });
  if (run.status !== 0 || !(await waitForFile(out))) {
    throw new Error(run.stderr || run.error || 'aucune capture produite');
  }
}

// Image encodée par la page : on lit le contenu de #out par le protocole
// DevTools (WebSocket natif depuis Node 22). --dump-dom serait plus simple,
// mais Edge sous Windows n'écrit rien sur la sortie standard.
async function renderEncoded(url, profile, out) {
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'
  ], { stdio: 'ignore' });
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    if (!(await waitForFile(portFile, 20000))) throw new Error('DevTools injoignable');
    const [port, browserPath] = readFileSync(portFile, 'utf8').split('\n').map(s => s.trim());
    const page = await (await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: 'PUT' })).json();

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket DevTools')); });
    let nextId = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = (method, params) => new Promise(res => {
      const id = ++nextId;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

    // Interrogé toutes les 500 ms : un appel qui tombe pendant la navigation
    // échoue (« context destroyed ») et le suivant prend le relais.
    let value = '';
    const start = Date.now();
    while (!value && Date.now() - start < 60000) {
      const msg = await send('Runtime.evaluate', {
        expression: "(document.getElementById('out') || {}).textContent || ''",
        returnByValue: true
      });
      value = (msg.result && msg.result.result && msg.result.result.value) || '';
      if (!value) await sleep(500);
    }
    ws.close();

    const m = /^data:image\/\w+;base64,(.+)$/.exec(value);
    if (!m) throw new Error(value || 'délai dépassé');
    writeFileSync(out, Buffer.from(m[1], 'base64'));

    const browserWs = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
    await new Promise(res => { browserWs.onopen = res; browserWs.onerror = res; });
    try { browserWs.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch {}
  } finally {
    await sleep(500);
    proc.kill();
  }
}

// Arguments facultatifs : ne régénérer que les cibles dont le chemin contient
// l'un d'eux (`node scripts/render-brand.mjs backdrop`).
const only = process.argv.slice(2);
const selected = only.length ? TARGETS.filter(t => only.some(o => t.out.includes(o))) : TARGETS;

let failures = 0;
for (const t of selected) {
  const out = join(ROOT, t.out);
  mkdirSync(dirname(out), { recursive: true });
  rmSync(out, { force: true }); // sinon une ancienne capture passerait pour la nouvelle
  // Un profil jetable PAR rendu : un profil partagé ou un Edge déjà ouvert
  // récupèrent l'appel suivant, qui ne produit alors aucune capture.
  const profile = mkdtempSync(join(tmpdir(), 'octane-render-'));
  try {
    const url = pathToFileURL(join(ROOT, t.src)).href;
    await (t.encoded ? renderEncoded(url, profile, out) : renderScreenshot(url, t, profile, out));
    const { w, h } = imageSize(out);
    const ok = w === t.w && h === t.h;
    if (!ok) failures++;
    console.log(`${ok ? '✓' : '✗'} ${t.out.padEnd(22)} ${w}×${h}${ok ? '' : ` (attendu ${t.w}×${t.h})`}  ${Math.round(statSync(out).size / 1024)} Ko`);
  } catch (err) {
    console.error(`✗ ${t.out} : ${err.message}`);
    failures++;
  } finally {
    // Le navigateur peut tenir le profil encore un instant : on réessaie, et
    // un échec de nettoyage d'un dossier temporaire n'est pas une erreur.
    await sleep(1000);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
  }
}
process.exitCode = failures ? 1 : 0;
