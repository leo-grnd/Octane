#!/usr/bin/env node
// Pré-calcule l'historique hebdomadaire des prix carburants par station.
// Source : dataset annuel "prix-des-carburants-fichier-annuel-YYYY" (data.economie.gouv.fr)
//
// Usage :
//   node scripts/build-history.mjs              # 12 dernières semaines, année courante
//   node scripts/build-history.mjs --weeks=24   # 24 semaines
//   node scripts/build-history.mjs --year=2025  # force une année (si celle en cours n'est pas dispo)
//
// Sortie : data/history/<fuel_field>.json
// Format : { generated, weeks: ["2026-W12", ...], stations: { "id_pdv": [p1, p2, ...] } }
// Les prix sont stockés en millièmes d'€ (entiers), ou null si pas de donnée pour cette semaine.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const arg = (name, fallback) => {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`));
  return raw ? raw.slice(name.length + 3) : fallback;
};

const WEEKS = parseInt(arg('weeks', '12'), 10);
const YEAR = parseInt(arg('year', String(new Date().getFullYear())), 10);
const DATASET = arg('dataset', `prix-des-carburants-fichier-annuel-${YEAR}`);
const DATASET_FALLBACK = `prix-des-carburants-fichier-annuel-${YEAR - 1}`;

// Nom côté API (dataset annuel) → clé de champ côté client (dataset temps réel)
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
const sinceISO = sinceDate.toISOString().slice(0, 10);

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

async function fetchExport(dataset, fuelName) {
  const params = new URLSearchParams({
    select: 'id_pdv, prix_valeur, prix_maj',
    where: `prix_nom = "${fuelName}" AND prix_maj >= date'${sinceISO}'`,
    limit: '-1'
  });
  const url = `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/${dataset}/exports/json?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${dataset}`);
  return res.json();
}

async function fetchWithFallback(fuelName) {
  try {
    return { dataset: DATASET, rows: await fetchExport(DATASET, fuelName) };
  } catch (err) {
    process.stderr.write(`  ⚠ ${DATASET} a échoué (${err.message}), fallback ${DATASET_FALLBACK}\n`);
    return { dataset: DATASET_FALLBACK, rows: await fetchExport(DATASET_FALLBACK, fuelName) };
  }
}

function aggregate(rows, weeks) {
  const weekIdx = Object.fromEntries(weeks.map((w, i) => [w, i]));
  const bucket = new Map();
  for (const r of rows) {
    const id = r.id_pdv != null ? String(r.id_pdv) : null;
    const price = parseFloat(r.prix_valeur);
    if (!id || !isFinite(price) || price <= 0) continue;
    const d = new Date(r.prix_maj);
    if (isNaN(d)) continue;
    const idx = weekIdx[isoWeek(d)];
    if (idx == null) continue;
    let slots = bucket.get(id);
    if (!slots) {
      slots = Array.from({ length: weeks.length }, () => ({ sum: 0, n: 0 }));
      bucket.set(id, slots);
    }
    slots[idx].sum += price;
    slots[idx].n += 1;
  }
  const stations = {};
  for (const [id, slots] of bucket) {
    const arr = slots.map(s => (s.n ? Math.round((s.sum / s.n) * 1000) : null));
    if (arr.some(v => v != null)) stations[id] = arr;
  }
  return stations;
}

async function main() {
  const outDir = resolve(ROOT, 'data/history');
  mkdirSync(outDir, { recursive: true });
  const weeks = weekList();
  process.stderr.write(`Période : ${sinceISO} → ${now.toISOString().slice(0, 10)} (${weeks.length} semaines)\n`);

  for (const [apiName, fieldKey] of Object.entries(FUELS)) {
    process.stderr.write(`\n→ ${apiName} (${fieldKey})\n`);
    try {
      const { dataset, rows } = await fetchWithFallback(apiName);
      const stations = aggregate(rows, weeks);
      const payload = {
        generated: new Date().toISOString(),
        source: dataset,
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
}

main().catch(err => { console.error(err); process.exit(1); });
