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
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

async function fetchAll() {
  let lastErr;
  for (const ep of endpoints) {
    process.stderr.write(`→ ${ep}\n`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000); // 10 min
    try {
      const res = await fetch(ep, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) {
        process.stderr.write(`  ✗ HTTP ${res.status}\n`);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      return data;
    } catch (err) {
      clearTimeout(timer);
      process.stderr.write(`  ✗ ${err.message}\n`);
      lastErr = err;
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
