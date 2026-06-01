#!/usr/bin/env node
// Scrape OSM une fois pour toute la France : toutes les stations `amenity=fuel`
// avec une marque (tag `brand` / `operator` / `name`). Le résultat est shipppé
// dans le repo et chargé côté client en un seul fetch — plus d'appels Overpass
// au runtime, lookup en O(n~12k) par haversine (quelques ms).
//
// Usage :
//   node scripts/build-brands.mjs
//   node scripts/build-brands.mjs --out=data/osm/brands.json
//
// Sortie :
//   { generated, source, brands: ["Total", ...], stations: [[lat, lon, brandIdx], ...] }
// Le dictionnaire brands + index permet d'éviter de dupliquer les noms de marque.
// lat/lon arrondis à 5 décimales (~1 m, suffisant pour matcher à 150 m).

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const arg = (name, fallback) => {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`));
  return raw ? raw.slice(name.length + 3) : fallback;
};
const OUT_PATH = resolve(ROOT, arg('out', 'data/osm/brands.json'));

// Requête Overpass : toutes les stations essence en France (métropole + DOM via ISO3166-1).
// `out center tags` donne lat/lon (même pour les ways) + tags.
const query = `
[out:json][timeout:600];
area["ISO3166-1"="FR"]->.fr;
(
  node["amenity"="fuel"](area.fr);
  way["amenity"="fuel"](area.fr);
);
out center tags;
`.trim();

const endpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
];

// Overpass impose un User-Agent identifiable + Accept JSON depuis 2024.
// Sans ça → 403 (openstreetmap.fr) ou 406 (overpass-api.de). Le `+url` est
// la convention pour pouvoir nous joindre en cas d'abus.
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept': 'application/json',
  'User-Agent': 'octane-build/1.0 (+https://github.com/leo-grnd/Octane)'
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Tente un endpoint avec retry sur 429/503/504 (sleep 60s entre essais).
// Bouge au endpoint suivant sur erreurs définitives (403/406) ou réseau.
async function fetchFromEndpoint(ep, query) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
    try {
      const res = await fetch(ep, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: HEADERS,
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (res.ok) return await res.json();
      // 429 / 503 / 504 = transient → sleep + retry sur le même endpoint
      if ([429, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
        const wait = 60 * attempt; // 60s, 120s
        process.stderr.write(`  · HTTP ${res.status} (essai ${attempt}/${MAX_RETRIES}) — sleep ${wait}s\n`);
        await sleep(wait * 1000);
        continue;
      }
      // 4xx définitif → on bouge à l'endpoint suivant
      process.stderr.write(`  ✗ HTTP ${res.status}\n`);
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      clearTimeout(timer);
      if (attempt >= MAX_RETRIES || !err.message.startsWith('HTTP 5') && !err.message.startsWith('HTTP 429')) {
        throw err;
      }
    }
  }
  throw new Error('Retries exhausted');
}

async function fetchAll() {
  let lastErr;
  for (const ep of endpoints) {
    process.stderr.write(`→ ${ep}\n`);
    try {
      const data = await fetchFromEndpoint(ep, query);
      process.stderr.write(`  ✓ OK\n`);
      return data;
    } catch (err) {
      process.stderr.write(`  ✗ ${err.message}\n`);
      lastErr = err;
      // Petite pause entre endpoints pour ne pas tout enchaîner si on a été
      // rate-limited (l'IP de GHA est partagée → souvent throttled en cascade)
      await sleep(5000);
    }
  }
  throw lastErr ?? new Error('Tous les endpoints Overpass ont échoué');
}

function extractBrand(tags) {
  return (tags.brand || tags.operator || tags.name || '').trim();
}

async function main() {
  const data = await fetchAll();
  const elements = data.elements || [];
  process.stderr.write(`Total éléments OSM : ${elements.length}\n`);

  const brandMap = new Map();
  const stations = [];
  let skippedNoBrand = 0;
  let skippedNoCoords = 0;

  for (const e of elements) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat == null || lon == null) { skippedNoCoords++; continue; }
    const brand = extractBrand(e.tags || {});
    if (!brand) { skippedNoBrand++; continue; }
    let idx = brandMap.get(brand);
    if (idx == null) {
      idx = brandMap.size;
      brandMap.set(brand, idx);
    }
    stations.push([
      Math.round(lat * 1e5) / 1e5,
      Math.round(lon * 1e5) / 1e5,
      idx
    ]);
  }

  const brands = [...brandMap.keys()];
  process.stderr.write(`Stations avec marque : ${stations.length}\n`);
  process.stderr.write(`  ignorées (sans marque)    : ${skippedNoBrand}\n`);
  process.stderr.write(`  ignorées (sans coords)    : ${skippedNoCoords}\n`);
  process.stderr.write(`Marques uniques : ${brands.length}\n`);

  const payload = {
    generated: new Date().toISOString(),
    source: 'OSM Overpass · amenity=fuel · FR',
    brands,
    stations
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload));
  const sizeKb = (JSON.stringify(payload).length / 1024).toFixed(1);
  process.stderr.write(`✓ ${OUT_PATH} : ${sizeKb} Ko\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
