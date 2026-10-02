#!/usr/bin/env node
// Noms, enseignes et adresses officiels des stations.
//
// Le flux officiel des prix ne contient ni le nom ni l'enseigne des stations
// (« le nom des stations ; la marque des stations » sont exclus de l'open
// data), et ses adresses sont brutes (« 55 BLD DE PICPUS »). Le site
// prix-carburants.gouv.fr, lui, affiche nom et enseigne sur la fiche de chaque
// station. Ce script, lancé une fois par mois (build-stations.yml) :
//   1. liste les stations du flux (un export Opendatasoft) ;
//   2. lit la fiche officielle de chacune, à un rythme modéré (2 requêtes en
//      parallèle, pause entre chaque, User-Agent identifiable) ;
//   3. normalise les adresses : abréviations développées, puis géocodage IGN
//      en lot (CSV), retenu seulement s'il confirme le type de voie ;
//   4. écrit des tranches par préfixe d'identifiant, chargées à la demande
//      par le site.
// Incrémental : une fiche illisible garde l'entrée du mois précédent.
//
// Usage :
//   node scripts/build-stations.mjs                 collecte complète (~30 min)
//   node scripts/build-stations.mjs --limit=200     essai sur 200 stations
//   node scripts/build-stations.mjs --skip-pages    adresses seulement
//
// Sortie : public/data/stations/{2 premiers chiffres de l'id}.json
//   { "75012021": ["Relais Picpus", "TotalEnergies", "55 Boulevard de Picpus"] }
//   [nom, enseigne, adresse], chaque champ pouvant valoir null.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const arg = (name, fallback) => {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`));
  return raw ? raw.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const OUT_DIR = resolve(ROOT, arg('out', 'public/data/stations'));
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const SKIP_PAGES = flag('skip-pages');

const LIST_URL = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/' +
  'prix-des-carburants-en-france-flux-instantane-v2/exports/json?select=id,adresse,cp,ville';
const PAGE_URL = (id) => `https://www.prix-carburants.gouv.fr/map/recuperer_infos_pdv/${id}`;
const GEOCODE_CSV_URL = 'https://data.geopf.fr/geocodage/search/csv';

const USER_AGENT = 'octane-build/1.0 (+https://octane-carburant.fr)';
const CONCURRENCY = 2;          // fiches lues en parallèle
const PAUSE_MS = 250;           // pause de chaque lecteur entre deux fiches
const GEOCODE_CHUNK = 2000;     // lignes par lot CSV (limite IGN : 200 000)
const MIN_SCORE = 0.8;          // score IGN minimal pour remplacer une adresse

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (msg) => process.stderr.write(`${msg}\n`);

// ───────────────────────── 1. Liste des stations ─────────────────────────

async function fetchStationList() {
  const res = await fetch(LIST_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Liste des stations : HTTP ${res.status}`);
  const rows = await res.json();
  return rows.filter(r => r.id != null).map(r => ({
    id: String(r.id),
    adresse: (r.adresse || '').trim(),
    cp: (r.cp || '').trim(),
    ville: (r.ville || '').trim()
  }));
}

const shardOf = (id) => id.padStart(8, '0').slice(0, 2);

function loadPrevious() {
  const prev = new Map();
  if (!existsSync(OUT_DIR)) return prev;
  for (const file of readdirSync(OUT_DIR)) {
    if (!/^\d\w\.json$/.test(file)) continue;
    const data = JSON.parse(readFileSync(join(OUT_DIR, file), 'utf8'));
    for (const [id, entry] of Object.entries(data)) prev.set(id, entry);
  }
  return prev;
}

// ───────────────────────── 2. Fiches officielles ─────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeHtml(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}
const clean = (s) => decodeHtml(s.replace(/<[^>]*>/g, ' ')).replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();

// Fiche : <h3>NOM</h3> puis <p><strong>Enseigne</strong><br />adresse…</p>.
// Retourne { name, brand }, null si la station est inconnue du site (HTTP 500
// « Erreur lors de la récupération »), ou lève une erreur passagère.
async function fetchOfficial(id) {
  const res = await fetch(PAGE_URL(id), { headers: { 'User-Agent': USER_AGENT } });
  const body = await res.text();
  if (res.status === 500 && body.includes('Erreur lors de la récupération')) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const h3 = body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  const strong = body.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
  return {
    name: h3 ? clean(h3[1]) || null : null,
    brand: strong ? clean(strong[1]) || null : null
  };
}

async function fetchWithRetry(id) {
  const waits = [2000, 10000, 30000];
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, data: await fetchOfficial(id) };
    } catch (err) {
      if (attempt >= waits.length) return { ok: false, error: err.message };
      await sleep(waits[attempt]);
    }
  }
}

async function collectOfficial(stations) {
  const out = new Map();
  let cursor = 0, done = 0, failed = 0, unknown = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (cursor < stations.length) {
      const { id } = stations[cursor++];
      const r = await fetchWithRetry(id);
      if (!r.ok) failed++;
      else if (r.data === null) unknown++;
      else out.set(id, r.data);
      done++;
      if (done % 500 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        log(`  ${done}/${stations.length} fiches · ${rate.toFixed(1)}/s · ` +
          `reste ~${Math.round((stations.length - done) / rate / 60)} min`);
      }
      await sleep(PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { official: out, failed, unknown };
}

// ───────────────────────── 3. Adresses ─────────────────────────

// Abréviations du flux, développées avant le géocodage : sans ça, l'IGN lit
// « 55 BLD DE PICPUS » comme « 55 Rue de Picpus » (score 0,68). Celles qui
// sont aussi des mots (« LOT » la rivière, « RES », « ALL »…) ne sont
// développées qu'à la place du type de voie, en tête d'adresse :
// « 74 AVENUE DU LOT » ne doit pas devenir « Avenue du Lotissement ».
const ABBREVIATIONS = {
  AV: 'AVENUE', AVE: 'AVENUE',
  BD: 'BOULEVARD', BLD: 'BOULEVARD', BVD: 'BOULEVARD', BOUL: 'BOULEVARD',
  RTE: 'ROUTE', CHE: 'CHEMIN', CHEM: 'CHEMIN', IMP: 'IMPASSE',
  FG: 'FAUBOURG', FBG: 'FAUBOURG', PTE: 'PORTE', RPT: 'ROND-POINT',
  CTRE: 'CENTRE', CCIAL: 'COMMERCIAL', CIAL: 'COMMERCIAL', INDUST: 'INDUSTRIELLE',
  AUT: 'AUTOROUTE', AUTOR: 'AUTOROUTE',
  PDT: 'PRESIDENT', GAL: 'GENERAL', GEN: 'GENERAL',
  MAL: 'MARECHAL', ST: 'SAINT', STE: 'SAINTE', DR: 'DOCTEUR', PROF: 'PROFESSEUR',
  CDT: 'COMMANDANT', CMDT: 'COMMANDANT', LT: 'LIEUTENANT', CNE: 'CAPITAINE', CPT: 'CAPITAINE'
};
const TYPE_ABBREVIATIONS = {
  AVEN: 'AVENUE', BOULV: 'BOULEVARD', PL: 'PLACE', ALL: 'ALLEE', QU: 'QUAI', CRS: 'COURS',
  ESP: 'ESPLANADE', SQ: 'SQUARE', PROM: 'PROMENADE', HAM: 'HAMEAU', RES: 'RESIDENCE',
  LOT: 'LOTISSEMENT', LD: 'LIEU-DIT'
};
const NUMBER_TOKEN = /^(\d+[A-Z]?(-\d+[A-Z]?)?|BIS|TER|QUATER)$/;
// Types de voie : celui de l'adresse d'origine doit se retrouver dans la
// réponse de l'IGN pour qu'on la retienne.
const STREET_TYPES = new Set([
  'RUE', 'AVENUE', 'BOULEVARD', 'ROUTE', 'CHEMIN', 'PLACE', 'IMPASSE', 'ALLEE', 'QUAI', 'COURS',
  'FAUBOURG', 'PORTE', 'ROND-POINT', 'ESPLANADE', 'SQUARE', 'PROMENADE', 'HAMEAU', 'RESIDENCE',
  'LOTISSEMENT', 'LIEU-DIT', 'VOIE', 'SENTIER', 'PASSAGE', 'RUELLE', 'TRAVERSE', 'MONTEE',
  'CHAUSSEE', 'PARVIS', 'CITE', 'DESCENTE', 'CARREFOUR', 'GRANDE RUE', 'GRAND RUE'
]);

const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

function expandAddress(raw) {
  let s = stripAccents(raw).toUpperCase()
    .replace(/[’`]/g, "'")
    .replace(/[.,;]+/g, ' ')
    .replace(/\bJ\s+JAURES\b/g, 'JEAN JAURES')
    .replace(/\bC(?:H)?\s+DE\s+GAULLE\b/g, 'CHARLES DE GAULLE')
    .replace(/\bLIEU\s+DIT\b/g, 'LIEU-DIT')
    .replace(/\bC\s+C?IAL\b|\bC\s+COMMERCIAL\b/g, 'CENTRE COMMERCIAL')
    // « SOISSONS- RN 31 » → « SOISSONS - RN 31 » ; « 207-213 » reste collé.
    .replace(/\s*[-–]\s+|\s+[-–]\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = s.split(' ');
  const typeAt = words.findIndex(w => !NUMBER_TOKEN.test(w));
  s = words.map((w, i) => ABBREVIATIONS[w] || (i === typeAt && TYPE_ABBREVIATIONS[w]) || w).join(' ');
  // « DE L HOPITAL » → « DE L'HOPITAL », « D ALSACE » → « D'ALSACE ».
  s = s.replace(/\b([LD]) (?=[A-Z])/g, "$1'");
  // « AUTOROUTE A 6 » → « AUTOROUTE A6 ».
  s = s.replace(/\bAUTOROUTE A (\d+)\b/g, 'AUTOROUTE A$1');
  return s;
}

// Numéro en tête (« 207-213 », « 12 BIS », « 4B »), puis le reste.
function splitNumber(expanded) {
  const m = expanded.match(/^(\d+[A-Z]?(?:\s*-\s*\d+[A-Z]?)?(?:\s+(?:BIS|TER|QUATER))?)\s+(.*)$/);
  if (!m) return { number: null, rest: expanded };
  return { number: m[1].replace(/\s*-\s*/, '-').replace(/\s+(BIS|TER|QUATER)$/, (_, x) => ` ${x.toLowerCase()}`), rest: m[2] };
}

function streetTypeOf(text) {
  const up = stripAccents(text).toUpperCase();
  for (const two of ['GRANDE RUE', 'GRAND RUE']) if (up.startsWith(two)) return two;
  const first = up.split(' ')[0];
  return STREET_TYPES.has(first) ? first : null;
}

// Mise en casse d'un libellé en capitales, quand l'IGN n'a pas confirmé
// l'adresse : « CENTRE COMMERCIAL BORDENEUVE » → « Centre Commercial
// Bordeneuve ». Petits mots en minuscules, sigles et mots à chiffres intacts,
// et quelques accents usuels rétablis.
// « A » n'y est pas : dans les adresses, c'est presque toujours une initiale
// (« 45 RUE A.PEZE »), rarement la préposition.
const SMALL_WORDS = new Set(['DE', 'DU', 'DES', 'LA', 'LE', 'LES', 'ET', 'EN', 'SUR', 'SOUS', 'AU', 'AUX']);
const KEEP_UPPER = new Set(['ZI', 'ZA', 'ZAC', 'ZAE', 'ZAI', 'ZUP', 'RN', 'RD', 'CD', 'CC', 'BP', 'SARL', 'SAS', 'SA', 'EURL', 'SNC', 'II', 'III', 'IV']);
const ACCENTS = {
  GENERAL: 'Général', PRESIDENT: 'Président', MARECHAL: 'Maréchal', ETATS: 'États', EGLISE: 'Église',
  ECOLE: 'École', REPUBLIQUE: 'République', LIBERATION: 'Libération', CHATEAU: 'Château',
  HOPITAL: 'Hôpital', COTE: 'Côte', ETANG: 'Étang', ALLEE: 'Allée', MONTEE: 'Montée',
  CHAUSSEE: 'Chaussée', CITE: 'Cité', RESIDENCE: 'Résidence', GARE: 'Gare', VERDUN: 'Verdun',
  MEDITERRANEE: 'Méditerranée', LEGION: 'Légion', ELYSEES: 'Élysées', EUROPEENNE: 'Européenne',
  DEPARTEMENTALE: 'Départementale', NATIONALE: 'Nationale', ZONE: 'Zone', ARTISANALE: 'Artisanale',
  INDUSTRIELLE: 'Industrielle', ACTIVITES: 'Activités', ECONOMIQUE: 'Économique',
  DEVIATION: 'Déviation', INTERMARCHE: 'Intermarché', 'LIEU-DIT': 'Lieu-dit', EGALITE: 'Égalité',
  FRATERNITE: 'Fraternité', ELECTRICITE: 'Électricité', PREFECTURE: 'Préfecture', LYCEE: 'Lycée'
};
function capitalizePart(part) {
  // Codes de voie et numéros (« RN7 », « A5B », « RD523 », « 4C ») intacts ;
  // « RÉCUP'44 » redevient « Récup'44 ».
  if (!part || KEEP_UPPER.has(part) || /^[A-Z]{0,3}\d+[A-Z]{0,2}$/.test(part)) return part;
  if (ACCENTS[stripAccents(part)]) return ACCENTS[stripAccents(part)];
  // Initiales : « E.LECLERC » → « E.Leclerc », « J.V.F » → « J.V.F ».
  return part.toLowerCase().replace(/(^|\.)(\p{L})/gu, (_, dot, ch) => dot + ch.toUpperCase());
}
function capitalizeWord(word, isFirst) {
  if (!word) return word;
  if (ACCENTS[word]) return ACCENTS[word];
  if (!isFirst && SMALL_WORDS.has(word)) return word.toLowerCase();
  // Élision : « L'HOPITAL » → « l'Hôpital », « D'ALSACE » → « d'Alsace ».
  const elision = word.match(/^([LD])'(.+)$/);
  if (elision) return `${isFirst ? elision[1] : elision[1].toLowerCase()}'${capitalizeWord(elision[2], true)}`;
  return word.split('-').map(capitalizePart).join('-');
}
function titleCase(upper) {
  return upper.split(' ').map((w, i) => capitalizeWord(w, i === 0)).join(' ');
}
// L'IGN peut répondre une autre voie du même type dans la commune (« Route de
// Saint-Quentin » → « Route de Tullins », score 0,8). On n'accepte sa réponse
// que si les mots du nom de voie concordent, à une faute de frappe près
// (« BEGUES » → « Bergues », « ANESSAN » → « Lanessan ») ou collés
// (« VERNIER FONTAINE » → « Vernierfontaine »).
function significantWords(s) {
  return stripAccents(s).toUpperCase().replace(/['’]/g, ' ').split(/[\s\-\/]+/)
    .filter(w => w.length > 2 && !SMALL_WORDS.has(w) && !STREET_TYPES.has(w) && !/^\d/.test(w));
}
function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
const nearlySame = (a, b) => a === b || levenshtein(a, b) <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 4));
function streetsAgree(input, ign) {
  const a = significantWords(input), b = significantWords(ign);
  if (!a.length) return true;
  const matched = a.filter(w => b.some(x => nearlySame(w, x))).length;
  return matched * 2 >= a.length || nearlySame(a.join(''), b.join(''));
}
// Libellé de voie de l'IGN, sans la commune déléguée qu'il ajoute parfois
// (« Avenue de Paris, Couhé », « Avenue de la Riottiere (Ingrandes) »).
const cleanIgnStreet = (street) => street.replace(/\s*[,(].*$/, '');

// Casse d'un libellé de voie déjà écrit en minuscules accentuées : petits
// mots en minuscules, le reste avec une capitale, noms composés compris
// (« rue de la république » → « Rue de la République », « Rue De La
// Riviere » → « Rue de la Riviere », « saint-rémy » → « Saint-Rémy »).
const upperFirst = (w) => w.charAt(0).toUpperCase() + w.slice(1);
// Mot resté en capitales dans une saisie mixte (« Avenue du GENERAL DE
// GAULLE ») : remis en casse, accents usuels compris.
const isShouted = (w) => /^\p{Lu}{2,}$/u.test(w) && !KEEP_UPPER.has(stripAccents(w));
function caseWord(w, isFirst) {
  if (!isFirst && SMALL_WORDS.has(stripAccents(w).toUpperCase())) {
    // « Le », « La », « Les » déjà en capitale appartiennent souvent à un nom
    // propre (« Rue Jean Le Guennec », « Route de La Clusaz ») : intacts.
    return /^(Le|La|Les)$/.test(w) ? w : w.toLowerCase();
  }
  if (/^[ld]['’]$/i.test(w)) return isFirst ? upperFirst(w.toLowerCase()) : w.toLowerCase();
  const elision = w.match(/^([ld])(['’])(.+)$/i);
  if (elision) return (isFirst ? elision[1].toUpperCase() : elision[1].toLowerCase()) + elision[2] + caseWord(elision[3], true);
  const [head, ...tail] = w.split('-');
  return [isShouted(head) ? capitalizePart(head) : upperFirst(head), ...tail.map(part => caseWord(part, false))].join('-');
}
const smartCase = (s) => s.replace(/(['’])\s+/g, '$1').split(' ').map((w, i) => caseWord(w, i === 0)).join(' ');

// Apostrophe typographique, comme le reste du site.
const typo = (s) => s && s.replace(/'/g, '’');
const accentCount = (s) => (s.normalize('NFD').match(/[̀-ͯ]/g) || []).length;
// Même libellé aux accents, à la casse et à la ponctuation près
// (« Route de Saint-Rémy » / « Route de Saint Remy »).
const lettersOnly = (s) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const sameLetters = (a, b) => lettersOnly(a) === lettersOnly(b);

// Une adresse déjà en minuscules dans le flux (« Rue Joliot Curie ») a été
// saisie à la main : on la garde telle quelle si l'IGN ne fait pas mieux.
const isAllCaps = (s) => s === s.toUpperCase();
function tidyAddress(raw, expanded) {
  if (!isAllCaps(raw)) {
    const s = raw.replace(/\s*[-–]\s+|\s+[-–]\s*/g, ' - ').replace(/\s+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const { number, rest } = splitNumber(expanded);
  return [number, titleCase(rest)].filter(Boolean).join(' ');
}

// Analyseur CSV minimal (RFC 4180 : guillemets, virgules et sauts de ligne
// dans les champs) pour la réponse de l'IGN.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  return data.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
const csvField = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function geocodeBatch(lines) {
  const csv = ['id,adresse,cp,ville', ...lines.map(l => [l.id, l.query, l.cp, l.ville].map(csvField).join(','))].join('\n');
  const form = new FormData();
  form.append('data', new Blob([csv], { type: 'text/csv' }), 'stations.csv');
  form.append('columns', 'adresse');
  form.append('columns', 'ville');
  form.append('postcode', 'cp');
  form.append('indexes', 'address');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(GEOCODE_CSV_URL, { method: 'POST', body: form, headers: { 'User-Agent': USER_AGENT } });
    if (res.ok) return parseCsv(await res.text());
    if (attempt >= 3) throw new Error(`Géocodage par lot : HTTP ${res.status}`);
    await sleep(10000 * attempt);
  }
}

async function normalizeAddresses(stations) {
  const lines = stations.filter(s => s.adresse).map(s => ({ ...s, expanded: expandAddress(s.adresse) }));
  const results = new Map();
  for (let i = 0; i < lines.length; i += GEOCODE_CHUNK) {
    const chunk = lines.slice(i, i + GEOCODE_CHUNK).map(l => ({ ...l, query: l.expanded }));
    for (const r of await geocodeBatch(chunk)) results.set(r.id, r);
    log(`  géocodage : ${Math.min(i + GEOCODE_CHUNK, lines.length)}/${lines.length}`);
  }
  const out = new Map();
  const stats = { ign: 0, tidy: 0, kept: 0 };
  for (const l of lines) {
    const r = results.get(l.id);
    const { number, rest } = splitNumber(l.expanded);
    const wanted = streetTypeOf(rest);
    const street = r && r.result_street && cleanIgnStreet(r.result_street);
    const ok = r && wanted && street &&
      ['housenumber', 'street'].includes(r.result_type) &&
      Number(r.result_score) >= MIN_SCORE &&
      streetTypeOf(street) === wanted &&
      streetsAgree(rest, street);
    if (ok) {
      // Selon les communes, l'IGN a moins d'accents ou de traits d'union que
      // la saisie d'origine (« Rue des Ecoles », « Route de Saint Remy »). À
      // lettres égales, on garde la mieux écrite, puis on en refait la casse.
      const typed = !isAllCaps(l.adresse) && splitNumber(l.adresse.trim()).rest;
      const dashes = (s) => (s.match(/-/g) || []).length;
      const better = typed && sameLetters(typed, street) &&
        (accentCount(typed) > accentCount(street) ||
          (accentCount(typed) === accentCount(street) && dashes(typed) > dashes(street)));
      out.set(l.id, typo([number, smartCase(better ? typed : street)].filter(Boolean).join(' ')));
      stats.ign++;
    } else {
      out.set(l.id, typo(tidyAddress(l.adresse, l.expanded)));
      if (isAllCaps(l.adresse)) stats.tidy++; else stats.kept++;
    }
  }
  return { addresses: out, stats };
}

// Nom de station remis en casse, qu'il soit en capitales (« RELAIS DES
// INVALIDES ») ou mélangé (« ESSO BOBIGNY J JAURES Carrefour express ») :
// « Relais des Invalides », « Esso Bobigny J Jaures Carrefour Express ».
// Idempotente : elle s'applique aussi aux noms repris du mois précédent.
function tidyName(raw) {
  if (!raw) return null;
  return typo(titleCase(raw.replace(/[’`]/g, "'").toUpperCase().replace(/\s+/g, ' ').trim()));
}

// ───────────────────────── 4. Écriture ─────────────────────────

async function main() {
  log('→ Liste des stations');
  let stations = await fetchStationList();
  if (LIMIT) stations = stations.slice(0, LIMIT);
  log(`  ${stations.length} stations`);

  const previous = loadPrevious();
  log(`  ${previous.size} entrées déjà connues`);

  let official = new Map(), failed = 0, unknown = 0;
  if (!SKIP_PAGES) {
    log('→ Fiches officielles');
    ({ official, failed, unknown } = await collectOfficial(stations));
  }

  log('→ Adresses');
  const { addresses, stats: addrStats } = await normalizeAddresses(stations);

  const shards = new Map();
  let withName = 0, withBrand = 0, fromPrevious = 0;
  const brandCount = new Map();
  for (const s of stations) {
    const prev = previous.get(s.id);
    let name, brand;
    if (official.has(s.id)) {
      ({ name, brand } = official.get(s.id));
      name = tidyName(name);
    } else if (prev) {
      [name, brand] = prev;
      name = tidyName(name);
      fromPrevious++;
    }
    const entry = [name || null, brand || null, addresses.get(s.id) || (prev && prev[2]) || null];
    if (entry[0]) withName++;
    if (entry[1]) {
      withBrand++;
      brandCount.set(entry[1], (brandCount.get(entry[1]) || 0) + 1);
    }
    const key = shardOf(s.id);
    if (!shards.has(key)) shards.set(key, {});
    shards.get(key)[s.id] = entry;
  }

  // Les tranches sont réécrites en entier : une station sortie du flux sort
  // aussi des données.
  mkdirSync(OUT_DIR, { recursive: true });
  if (!LIMIT) {
    for (const file of readdirSync(OUT_DIR)) if (/^\d\w\.json$/.test(file)) rmSync(join(OUT_DIR, file));
  }
  let bytes = 0;
  for (const [key, data] of [...shards].sort()) {
    const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
    const json = JSON.stringify(sorted);
    bytes += json.length;
    writeFileSync(join(OUT_DIR, `${key}.json`), json);
  }

  const pct = (n) => `${(100 * n / stations.length).toFixed(1)} %`;
  log('');
  log(`✓ ${shards.size} tranches, ${(bytes / 1024).toFixed(0)} Ko au total, dans ${OUT_DIR}`);
  log(`  fiches lues        : ${official.size} (inconnues du site : ${unknown}, en échec : ${failed}, reprises du mois précédent : ${fromPrevious})`);
  log(`  avec nom           : ${withName} (${pct(withName)})`);
  log(`  avec enseigne      : ${withBrand} (${pct(withBrand)})`);
  log(`  adresses IGN       : ${addrStats.ign} (${pct(addrStats.ign)})`);
  log(`  adresses remises en casse : ${addrStats.tidy} · gardées telles quelles : ${addrStats.kept}`);
  log('  enseignes les plus fréquentes :');
  for (const [b, n] of [...brandCount].sort((a, b) => b[1] - a[1]).slice(0, 40)) log(`    ${String(n).padStart(5)}  ${b}`);
}

main().catch(err => { console.error(err); process.exit(1); });
