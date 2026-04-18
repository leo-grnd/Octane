#!/usr/bin/env node
// Pré-calcule l'historique hebdomadaire des prix carburants par station.
//
// Source : archives annuelles officielles publiées par le Ministère de l'Économie
//   https://donnees.roulez-eco.fr/opendata/annee/YYYY (ZIP → XML)
//
// Le dataset Opendatasoft "prix-des-carburants-fichier-annuel-YYYY" n'est plus publié
// sous ce slug côté API (rend 404). On repasse par la source amont.
//
// Dépendance runtime : `unzip` dans le PATH (présent sur ubuntu-latest GH Actions).
//
// Usage :
//   node scripts/build-history.mjs              # 12 dernières semaines, année courante
//   node scripts/build-history.mjs --weeks=24   # 24 semaines
//   node scripts/build-history.mjs --year=2025  # force une année
//
// Sortie : data/history/<fuel_field>.json
// Format : { generated, source, fuel, weeks, stations: { id_pdv: [p_milli | null, ...] } }

import { writeFileSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const arg = (name, fallback) => {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`));
  return raw ? raw.slice(name.length + 3) : fallback;
};

const WEEKS = parseInt(arg('weeks', '12'), 10);
const YEAR = parseInt(arg('year', String(new Date().getFullYear())), 10);

const FUELS = {
  Gazole: 'gazole_prix',
  SP95: 'sp95_prix',
  'SP95-E10': 'sp95_e10_prix',
  SP98: 'sp98_prix',
  E85: 'e85_prix',
  GPLc: 'gplc_prix'
};

const now = new Date();
const sinceDate = new Date(now);
sinceDate.setDate(sinceDate.getDate() - WEEKS * 7);

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function weekList() {
  const out = [];
  const cursor = new Date(sinceDate);
  for (let i = 0; i < WEEKS; i++) {
    out.push(isoWeek(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  const lastNow = isoWeek(now);
  if (out[out.length - 1] !== lastNow) out.push(lastNow);
  return [...new Set(out)];
}

async function downloadZip(year, destPath) {
  const url = `https://donnees.roulez-eco.fr/opendata/annee/${year}`;
  process.stderr.write(`  ↓ téléchargement annuel ${year}…\n`);
  const res = await fetch(url, { headers: { 'User-Agent': 'octane-builder/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return buf.length;
}

function unzipToDir(zipPath, outDir) {
  mkdirSync(outDir, { recursive: true });
  const r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', outDir]);
  if (r.status !== 0) {
    throw new Error(`unzip a échoué (code ${r.status}). stderr: ${r.stderr?.toString() || ''}`);
  }
  const files = readdirSync(outDir).filter(f => f.toLowerCase().endsWith('.xml'));
  if (!files.length) throw new Error(`Pas de XML dans ${outDir}`);
  return join(outDir, files[0]);
}

function parsePrice(raw) {
  if (!raw) return null;
  const p = parseFloat(raw);
  if (!isFinite(p) || p <= 0) return null;
  // Ancien format : millièmes d'€ ('1789' = 1.789 €)
  return p > 10 ? p / 1000 : p;
}

function parseMaj(raw) {
  if (!raw) return null;
  // formats : "2025-06-15 12:30:00", "2025-06-15T12:30:00", "2025-06-15"
  const s = String(raw).trim().replace(' ', 'T');
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// Parse flat-XML ligne par ligne. Le format gouv met généralement chaque balise
// <pdv> / <prix> / </pdv> sur une ligne dédiée. On tolère les attributs dans n'importe
// quel ordre via une extraction clé="valeur".
function parseAttrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/(\w+)="([^"]*)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

function aggregate(xmlPath, weeks, fuelName) {
  const weekIdx = Object.fromEntries(weeks.map((w, i) => [w, i]));
  const buckets = new Map();
  let currentId = null;

  // Lit tout le XML en mémoire (archives ~100-500 Mo décompressées, OK sur runner)
  const content = readFileSync(xmlPath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('<pdv ')) {
      const a = parseAttrs(line);
      currentId = a.id || null;
    } else if (line.startsWith('</pdv')) {
      currentId = null;
    } else if (line.startsWith('<prix ') && currentId) {
      const a = parseAttrs(line);
      if (a.nom !== fuelName) continue;
      const price = parsePrice(a.valeur);
      const d = parseMaj(a.maj);
      if (price == null || d == null) continue;
      const idx = weekIdx[isoWeek(d)];
      if (idx == null) continue;
      let slots = buckets.get(currentId);
      if (!slots) {
        slots = Array.from({ length: weeks.length }, () => ({ sum: 0, n: 0 }));
        buckets.set(currentId, slots);
      }
      slots[idx].sum += price;
      slots[idx].n += 1;
    }
  }

  const stations = {};
  for (const [id, slots] of buckets) {
    const arr = slots.map(s => (s.n ? Math.round((s.sum / s.n) * 1000) : null));
    if (arr.some(v => v != null)) stations[id] = arr;
  }
  return stations;
}

async function tryYear(year, tmpRoot) {
  const zipPath = join(tmpRoot, `octane-${year}.zip`);
  try {
    await downloadZip(year, zipPath);
  } catch (err) {
    process.stderr.write(`  ⚠ année ${year} indispo (${err.message})\n`);
    return null;
  }
  try {
    const extractDir = join(tmpRoot, `octane-${year}`);
    const xmlPath = unzipToDir(zipPath, extractDir);
    process.stderr.write(`  ✓ XML ${year} extrait → ${xmlPath}\n`);
    return { year, xmlPath, extractDir };
  } catch (err) {
    process.stderr.write(`  ⚠ ZIP ${year} illisible (${err.message})\n`);
    return null;
  }
}

async function main() {
  const outDir = resolve(ROOT, 'data/history');
  mkdirSync(outDir, { recursive: true });
  const weeks = weekList();
  process.stderr.write(
    `Période : ${sinceDate.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)} (${weeks.length} semaines)\n`
  );

  const tmpRoot = tmpdir();
  let archive = await tryYear(YEAR, tmpRoot);
  if (!archive) archive = await tryYear(YEAR - 1, tmpRoot);
  if (!archive) {
    process.stderr.write(`✗ Impossible de récupérer les archives annuelles ${YEAR} ni ${YEAR - 1}\n`);
    process.exit(1);
  }

  const source = `donnees.roulez-eco.fr/opendata/annee/${archive.year}`;

  for (const [apiName, fieldKey] of Object.entries(FUELS)) {
    process.stderr.write(`\n→ ${apiName} (${fieldKey})\n`);
    try {
      const stations = aggregate(archive.xmlPath, weeks, apiName);
      const payload = {
        generated: new Date().toISOString(),
        source,
        fuel: apiName,
        weeks,
        stations
      };
      const out = resolve(outDir, `${fieldKey}.json`);
      writeFileSync(out, JSON.stringify(payload));
      const nStations = Object.keys(stations).length;
      const sizeKb = (JSON.stringify(payload).length / 1024).toFixed(1);
      process.stderr.write(`  ✓ ${fieldKey}.json : ${nStations} stations, ${sizeKb} Ko\n`);
    } catch (err) {
      process.stderr.write(`  ✗ ${fieldKey} : ${err.message}\n`);
    }
  }

  // Cleanup temp files
  try {
    rmSync(archive.extractDir, { recursive: true, force: true });
    rmSync(join(tmpRoot, `octane-${archive.year}.zip`), { force: true });
  } catch {}
}

main().catch(err => { console.error(err); process.exit(1); });
