#!/usr/bin/env node
// Envoi des alertes carburant quotidiennes.
//
// Octane n'a pas de backend : ce script est exécuté toutes les heures par
// GitHub Actions (.github/workflows/daily-alerts.yml). Il lit la liste des
// abonnés dans un secret de dépôt, ne retient que ceux dont l'heure d'envoi
// correspond à l'heure de Paris courante, interroge l'API prix carburants et
// envoie un email via l'API HTTP de Brevo. Zéro dépendance npm : Node 20+
// fournit `fetch` nativement.
//
// Usage :
//   node scripts/send-alerts.mjs                  # envoi réel
//   node scripts/send-alerts.mjs --dry-run        # affiche les emails, n'envoie rien
//   node scripts/send-alerts.mjs --force-hour=8   # simule qu'il est 8 h à Paris
//   node scripts/send-alerts.mjs --force          # ignore la garde anti-doublon
//
// Variables d'environnement :
//   OCTANE_ALERTS     (requis) tableau JSON des abonnements — voir validateAlert()
//   BREVO_API_KEY     (requis hors --dry-run) clé API Brevo
//   BREVO_SENDER      (requis hors --dry-run) adresse expéditrice validée chez Brevo
//   BREVO_SENDER_NAME (optionnel) nom affiché de l'expéditeur, défaut « Octane »
//   SITE_URL          (optionnel) racine du site pour les liens retour

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const arg = (name, fallback) => {
  const raw = process.argv.find(a => a.startsWith(`--${name}=`));
  return raw ? raw.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const DRY_RUN = flag('dry-run');
const FORCE = flag('force');
const STATE_PATH = resolve(ROOT, arg('state', 'data/alerts/state.json'));
const SITE_URL = (process.env.SITE_URL || 'https://leo-grnd.github.io/Octane/').replace(/\/?$/, '/');

const log = (msg) => process.stderr.write(`${msg}\n`);

// ===== Domaine =====
const DATASET = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/' +
  'prix-des-carburants-en-france-flux-instantane-v2/records';

// Sans ce filtre, le podium national est trusté par des stations qui ont cessé
// de déclarer depuis des mois : au 16/09/2026, le gazole le moins cher de France
// était affiché à Biscarrosse (2,09 €) sur un relevé du 24 juin. L'alerte
// enverrait l'abonné vers un prix qui n'existe plus.
const FRESH_DAYS = 3;
const TOP_N = 3;
// Garde anti-saisie erronée : un prix sous ce ratio de la médiane locale est
// écarté (gérant qui tape 0,199 au lieu de 1,99). N'est appliquée qu'au-delà de
// MIN_FOR_MEDIAN stations, en dessous la médiane n'est pas représentative —
// même seuil que la détection d'aberrations de l'interface.
const OUTLIER_FLOOR_RATIO = 0.6;
const MIN_FOR_MEDIAN = 5;
// Rattrapage : si un run horaire a été retardé ou sauté (les crons GitHub
// peuvent glisser de plusieurs dizaines de minutes), on traite aussi les heures
// manquées de la journée, dans la limite de 3 pour ne pas rejouer une nuit
// entière après une panne longue.
const MAX_CATCH_UP_HOURS = 3;

const FUEL_LABELS = {
  e10_prix: 'SP95-E10',
  sp95_prix: 'SP95',
  sp98_prix: 'SP98',
  gazole_prix: 'Gazole',
  e85_prix: 'E85',
  gplc_prix: 'GPLc'
};
const LEGACY_FUEL_FIELDS = { sp95_e10_prix: 'e10_prix' };

const majField = (fuel) => fuel.replace('_prix', '_maj');

// ===== Temps (Europe/Paris) =====
// Intl gère l'heure d'été/hiver sans logique maison. hourCycle h23 évite le
// « 24 » que renvoient certaines locales à minuit.
const HOUR_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' });
const DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const LONG_DATE_FMT = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });

const parisHour = (d = new Date()) => parseInt(HOUR_FMT.format(d), 10);
const parisDate = (d = new Date()) => DATE_FMT.format(d);

// ===== Helpers =====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const eur = (n) => n.toFixed(3).replace('.', ',');

function esc(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function extractCoords(s) {
  const g = s.geom;
  if (g) {
    if (Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      return { lon: g.coordinates[0], lat: g.coordinates[1] };
    }
    if (g.lon != null && g.lat != null) return { lon: g.lon, lat: g.lat };
  }
  return { lat: null, lon: null };
}

async function fetchJson(url, opts = {}, { tries = 3, timeoutMs = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return res.json();
      const body = await res.text().catch(() => '');
      // 4xx = erreur définitive (requête fausse, clé invalide) : inutile d'insister.
      if (res.status < 500 && res.status !== 429) {
        throw new Error(`HTTP ${res.status} — ${body.slice(0, 300)}`);
      }
      lastErr = new Error(`HTTP ${res.status} — ${body.slice(0, 200)}`);
    } catch (err) {
      clearTimeout(timer);
      if (err.message && err.message.startsWith('HTTP 4')) throw err;
      lastErr = err;
    }
    if (i < tries - 1) await sleep(1000 * (i + 1));
  }
  throw lastErr;
}

// ===== Marques OSM =====
// Réutilise data/osm/brands.json, déjà présent dans le checkout et rafraîchi
// mensuellement par build-brands.mjs. Même logique de grille que app.js ; sans
// bundler, app.js n'est pas importable côté Node, d'où cette copie locale.
function loadBrands() {
  const path = resolve(ROOT, 'data/osm/brands.json');
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const grid = new Map();
    for (const st of data.stations) {
      const key = `${Math.round(st[0] * 10)}:${Math.round(st[1] * 10)}`;
      let bucket = grid.get(key);
      if (!bucket) { bucket = []; grid.set(key, bucket); }
      bucket.push(st);
    }
    return { brands: data.brands, grid };
  } catch (err) {
    log(`⚠ brands.json illisible (${err.message}) — les enseignes seront omises`);
    return null;
  }
}

function lookupBrand(lat, lon, data) {
  if (!data || lat == null) return null;
  const MAX_KM = 0.15;
  const gi = Math.round(lat * 10);
  const gj = Math.round(lon * 10);
  let nearest = null;
  let minDist = Infinity;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const bucket = data.grid.get(`${gi + di}:${gj + dj}`);
      if (!bucket) continue;
      for (const st of bucket) {
        const d = haversine(lat, lon, st[0], st[1]);
        if (d < minDist && d <= MAX_KM) { minDist = d; nearest = st; }
      }
    }
  }
  return nearest ? data.brands[nearest[2]] : null;
}

// ===== Validation des abonnements =====
// Une entrée invalide est signalée et ignorée : elle ne doit pas empêcher les
// autres abonnés de recevoir leur alerte. Le run sort malgré tout en échec pour
// que le problème soit visible dans l'onglet Actions.
function validateAlert(raw, idx) {
  const where = `alerte #${idx + 1}`;
  if (!raw || typeof raw !== 'object') return { errors: [`${where} : ce n'est pas un objet`] };
  const errors = [];
  const email = typeof raw.email === 'string' ? raw.email.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push(`${where} : email invalide`);

  const fuel = LEGACY_FUEL_FIELDS[raw.fuel] || raw.fuel;
  if (!FUEL_LABELS[fuel]) errors.push(`${where} : carburant inconnu (${raw.fuel})`);

  const hour = Number(raw.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) errors.push(`${where} : heure hors 0-23 (${raw.hour})`);

  const scope = raw.scope === 'radius' ? 'radius' : raw.scope === 'france' ? 'france' : null;
  if (!scope) errors.push(`${where} : scope doit valoir "france" ou "radius"`);

  const alert = { email, fuel, hour, scope };
  if (scope === 'radius') {
    const lat = Number(raw.lat), lon = Number(raw.lon), radius = Number(raw.radius);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.push(`${where} : latitude invalide`);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) errors.push(`${where} : longitude invalide`);
    if (!Number.isInteger(radius) || radius < 1 || radius > 50) errors.push(`${where} : rayon hors 1-50 km`);
    Object.assign(alert, { lat, lon, radius, label: String(raw.label || 'ta zone') });
  }
  return errors.length ? { errors } : { alert };
}

// Deux abonnés sur la même zone et le même carburant ne déclenchent qu'un appel
// API. La clé ne sert qu'au regroupement en mémoire.
function groupKey(a) {
  return a.scope === 'france'
    ? `france|${a.fuel}`
    : `radius|${a.fuel}|${a.lat.toFixed(4)}|${a.lon.toFixed(4)}|${a.radius}`;
}

// Clés persistées dans un dépôt PUBLIC : on ne stocke que des empreintes, ni
// email ni coordonnées en clair.
const stateKeyForGroup = (a) => sha(groupKey(a));
const stateKeyForAlert = (a) => sha(`${a.email}|${groupKey(a)}|${a.hour}`);

// ===== Interrogation de l'API =====
function buildWhere(a) {
  const parts = [`${a.fuel} IS NOT NULL`, `${majField(a.fuel)} > now(days=-${FRESH_DAYS})`];
  if (a.scope === 'radius') {
    parts.unshift(`within_distance(geom, geom'POINT(${a.lon} ${a.lat})', ${a.radius}km)`);
  }
  return parts.join(' AND ');
}

async function fetchGroup(a) {
  const where = buildWhere(a);
  const select = `id,cp,ville,adresse,geom,${a.fuel},${majField(a.fuel)}`;
  // `order_by` trie côté serveur : le vrai top N sans pagination. `id` départage
  // les ex æquo, sinon l'ordre n'est pas déterministe.
  const topUrl = `${DATASET}?where=${encodeURIComponent(where)}` +
    `&select=${encodeURIComponent(select)}` +
    `&order_by=${encodeURIComponent(`${a.fuel},id`)}` +
    `&limit=${TOP_N + 2}`;
  const medUrl = `${DATASET}?where=${encodeURIComponent(where)}` +
    `&select=${encodeURIComponent(`median(${a.fuel}) as med`)}&limit=1`;

  const [top, med] = await Promise.all([fetchJson(topUrl), fetchJson(medUrl)]);
  const total = top.total_count || 0;
  const median = med.results && med.results[0] ? Number(med.results[0].med) : null;

  let rows = top.results || [];
  if (total >= MIN_FOR_MEDIAN && Number.isFinite(median) && median > 0) {
    const floor = median * OUTLIER_FLOOR_RATIO;
    const kept = rows.filter(r => Number(r[a.fuel]) >= floor);
    if (kept.length !== rows.length) {
      log(`  ⚠ ${rows.length - kept.length} prix écarté(s) sous ${eur(floor)} € (médiane ${eur(median)} €)`);
    }
    rows = kept;
  }
  return { rows: rows.slice(0, TOP_N), total, median };
}

// ===== Composition de l'email =====
function backLink(a) {
  const p = new URLSearchParams({ fuel: a.fuel });
  if (a.scope === 'radius') { p.set('q', a.label); p.set('r', String(a.radius)); }
  return `${SITE_URL}index.html?${p.toString()}`;
}

function mapsUrl(lat, lon) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=driving`;
}

// Écart avec le dernier relevé d'un AUTRE jour, pour que deux abonnés à des
// heures différentes voient le même « vs hier » plutôt qu'un écart nul.
function describeDelta(previous, winnerPrice, winnerId) {
  if (!previous || !Number.isFinite(previous.price)) return null;
  const diff = winnerPrice - previous.price;
  const cts = Math.round(diff * 100);
  const changed = previous.stationId != null && String(previous.stationId) !== String(winnerId);
  if (Math.abs(cts) < 1) {
    return { text: changed ? 'même prix qu\'hier, autre station' : 'inchangé depuis hier', tone: 'flat' };
  }
  const sign = cts > 0 ? '+' : '−';
  return {
    text: `${sign}${Math.abs(cts)} ct/L vs hier${changed ? ' (autre station)' : ''}`,
    tone: cts > 0 ? 'up' : 'down'
  };
}

function stationLine(s, a, brandsData) {
  const { lat, lon } = extractCoords(s);
  const brand = lookupBrand(lat, lon, brandsData);
  const name = brand ? `${brand} ${s.ville || ''}`.trim() : (s.ville || 'Station');
  const addr = [s.adresse, [s.cp, s.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const dist = a.scope === 'radius' && lat != null
    ? `${haversine(a.lat, a.lon, lat, lon).toFixed(1).replace('.', ',')} km`
    : null;
  return { name, addr, dist, lat, lon, price: Number(s[a.fuel]), maj: s[majField(a.fuel)] };
}

const TONE_COLOR = { up: '#c0392b', down: '#1e8449', flat: '#6b6356' };

function buildEmail(a, { rows, total }, previous, brandsData) {
  const fuelLabel = FUEL_LABELS[a.fuel];
  const zone = a.scope === 'france' ? 'France entière' : `${a.radius} km autour de ${a.label}`;
  const today = LONG_DATE_FMT.format(new Date());

  if (!rows.length) {
    const subject = `Octane · ${fuelLabel} — aucune station à signaler`;
    const text = `Aucune station n'a mis à jour son prix ${fuelLabel} dans ${zone} depuis ${FRESH_DAYS} jours.\n\n${backLink(a)}`;
    const html = `<p style="font-family:Arial,sans-serif;font-size:15px;color:#141210">` +
      `Aucune station n'a mis à jour son prix <strong>${esc(fuelLabel)}</strong> dans ${esc(zone)} ` +
      `depuis ${FRESH_DAYS} jours.</p>` +
      `<p><a href="${esc(backLink(a))}" style="color:#e85f00">Ouvrir Octane</a></p>`;
    return { subject, text, html };
  }

  const podium = rows.map(s => stationLine(s, a, brandsData));
  const w = podium[0];
  const delta = describeDelta(previous, w.price, rows[0].id);

  const subject = `⛽ ${fuelLabel} ${eur(w.price)} €/L — ${w.name}${w.dist ? ` · ${w.dist}` : ''}`;

  // --- version texte (fallback + clients qui bloquent le HTML)
  const text = [
    `OCTANE — ${fuelLabel} · ${zone}`,
    today,
    '',
    `La moins chère : ${eur(w.price)} €/L`,
    `${w.name}`,
    `${w.addr}${w.dist ? ` (${w.dist})` : ''}`,
    delta ? delta.text : '',
    '',
    ...podium.slice(1).map((s, i) => `${i + 2}. ${eur(s.price)} €/L — ${s.name}${s.dist ? ` (${s.dist})` : ''}`),
    '',
    `${total} station(s) éligible(s), prix mis à jour il y a moins de ${FRESH_DAYS} jours.`,
    backLink(a)
  ].filter(l => l !== '').join('\n');

  // --- version HTML : styles en ligne, tableau simple. Les clients mail ne
  // supportent ni <style> fiable, ni flex/grid, ni les variables CSS.
  const runners = podium.slice(1).map((s, i) => `
    <tr>
      <td style="padding:8px 12px;border-top:1px solid #e3dcc9;font:13px Arial,sans-serif;color:#6b6356;width:28px">${i + 2}</td>
      <td style="padding:8px 12px;border-top:1px solid #e3dcc9;font:13px Arial,sans-serif;color:#141210">
        ${esc(s.name)}${s.dist ? ` <span style="color:#6b6356">· ${esc(s.dist)}</span>` : ''}
      </td>
      <td style="padding:8px 12px;border-top:1px solid #e3dcc9;font:bold 14px Arial,sans-serif;color:#141210;text-align:right;white-space:nowrap">${eur(s.price)} €</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f5f1e8">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f1e8;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fbf8ef;border:1px solid #ccc3ab">

        <tr><td style="padding:20px 24px;border-bottom:1px solid #ccc3ab">
          <div style="font:bold 20px Arial,sans-serif;color:#141210;letter-spacing:-0.5px">O<span style="color:#e85f00">CTANE</span></div>
          <div style="font:11px Arial,sans-serif;color:#6b6356;letter-spacing:1.5px;text-transform:uppercase;margin-top:4px">
            ${esc(fuelLabel)} · ${esc(zone)}
          </div>
        </td></tr>

        <tr><td style="padding:24px">
          <div style="font:12px Arial,sans-serif;color:#6b6356;text-transform:uppercase;letter-spacing:1.5px">${esc(today)}</div>
          <div style="font:bold 40px Arial,sans-serif;color:#e85f00;margin:10px 0 2px">${eur(w.price)} <span style="font-size:18px">€/L</span></div>
          ${delta ? `<div style="font:13px Arial,sans-serif;color:${TONE_COLOR[delta.tone]};margin-bottom:12px">${esc(delta.text)}</div>` : '<div style="height:12px"></div>'}
          <div style="font:bold 16px Arial,sans-serif;color:#141210">${esc(w.name)}</div>
          <div style="font:13px Arial,sans-serif;color:#6b6356;margin-top:4px;line-height:1.5">
            ${esc(w.addr)}${w.dist ? `<br>à ${esc(w.dist)} de ${esc(a.label)}` : ''}
          </div>
          ${w.lat != null ? `<div style="margin-top:16px">
            <a href="${esc(mapsUrl(w.lat, w.lon))}" style="display:inline-block;background:#e85f00;color:#ffffff;font:bold 13px Arial,sans-serif;text-decoration:none;padding:11px 18px">Itinéraire →</a>
          </div>` : ''}
        </td></tr>

        ${runners ? `<tr><td style="padding:0 12px 8px">
          <div style="font:11px Arial,sans-serif;color:#6b6356;letter-spacing:1.5px;text-transform:uppercase;padding:0 12px 6px">Juste derrière</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${runners}</table>
        </td></tr>` : ''}

        <tr><td style="padding:16px 24px 22px;border-top:1px solid #ccc3ab">
          <div style="font:12px Arial,sans-serif;color:#6b6356;line-height:1.6">
            ${total} station${total > 1 ? 's' : ''} éligible${total > 1 ? 's' : ''} — seuls les prix mis à jour
            depuis moins de ${FRESH_DAYS} jours sont retenus.<br>
            <a href="${esc(backLink(a))}" style="color:#e85f00">Voir le classement complet sur Octane</a>
          </div>
          <div style="font:11px Arial,sans-serif;color:#8a8278;margin-top:14px;line-height:1.6">
            Données · data.economie.gouv.fr (Ministère de l'Économie).<br>
            Pour modifier ou arrêter cette alerte, réponds simplement à cet email.
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

// ===== Envoi (Brevo) =====
async function sendEmail(to, { subject, text, html }, cfg) {
  const payload = {
    sender: { name: cfg.senderName, email: cfg.sender },
    to: [{ email: to }],
    subject,
    htmlContent: html,
    textContent: text,
    // Améliore la délivrabilité et donne une sortie explicite à l'abonné, la
    // désinscription n'étant pas automatisée.
    headers: { 'List-Unsubscribe': `<mailto:${cfg.sender}?subject=Desinscription%20Octane>` }
  };
  await fetchJson('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': cfg.apiKey,
      'content-type': 'application/json',
      'accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });
}

// ===== État persisté =====
function loadState() {
  if (!existsSync(STATE_PATH)) return { groups: {}, sent: {}, lastRun: null };
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { groups: s.groups || {}, sent: s.sent || {}, lastRun: s.lastRun || null };
  } catch (err) {
    log(`⚠ state.json illisible (${err.message}) — on repart de zéro`);
    return { groups: {}, sent: {}, lastRun: null };
  }
}

function saveState(state) {
  // Purge des marqueurs d'envoi des jours passés : sans ça le fichier grossit
  // indéfiniment dans le dépôt.
  const today = parisDate();
  for (const [k, v] of Object.entries(state.sent)) {
    if (v !== today) delete state.sent[k];
  }
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({
    updated: new Date().toISOString(),
    lastRun: state.lastRun,
    groups: state.groups,
    sent: state.sent
  }, null, 2) + '\n');
}

// Deux emplacements par groupe : le relevé du jour et celui du jour précédent.
// C'est ce qui permet à un abonné de 8 h et un autre de 19 h de lire le même
// « vs hier », au lieu d'un écart nul pour le second.
function rememberPrice(state, key, price, stationId, today) {
  const entry = state.groups[key];
  if (entry && entry.date === today) return entry.previous || null;
  const previous = entry ? { price: entry.price, stationId: entry.stationId, date: entry.date } : null;
  state.groups[key] = { date: today, price, stationId, previous };
  return previous;
}

function hoursToProcess(state, today, nowHour) {
  const last = state.lastRun;
  if (!last || last.date !== today || !Number.isInteger(last.hour)) return [nowHour];
  const hours = [];
  for (let h = Math.min(nowHour, last.hour + 1); h <= nowHour; h++) hours.push(h);
  if (!hours.length) hours.push(nowHour);
  return hours.slice(-MAX_CATCH_UP_HOURS);
}

// ===== Programme principal =====
async function main() {
  const now = new Date();
  const today = parisDate(now);
  const nowHour = Number.isFinite(parseInt(arg('force-hour', ''), 10))
    ? parseInt(arg('force-hour', ''), 10)
    : parisHour(now);

  const rawEnv = process.env.OCTANE_ALERTS;
  if (!rawEnv || !rawEnv.trim()) {
    log('OCTANE_ALERTS est vide — aucune alerte configurée, rien à faire.');
    return 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(rawEnv);
  } catch (err) {
    log(`✗ OCTANE_ALERTS n'est pas du JSON valide : ${err.message}`);
    return 1;
  }
  if (!Array.isArray(parsed)) {
    log('✗ OCTANE_ALERTS doit être un tableau JSON.');
    return 1;
  }

  const alerts = [];
  const validationErrors = [];
  parsed.forEach((raw, i) => {
    const { alert, errors } = validateAlert(raw, i);
    if (errors) validationErrors.push(...errors);
    else alerts.push(alert);
  });
  validationErrors.forEach(e => log(`✗ ${e}`));

  const state = loadState();
  const hours = hoursToProcess(state, today, nowHour);
  log(`Paris ${today} ${String(nowHour).padStart(2, '0')}h — heures traitées : ${hours.join(', ')}`);
  log(`${alerts.length} abonnement(s) valide(s), ${validationErrors.length} rejeté(s)`);

  const due = alerts.filter(a => hours.includes(a.hour)).filter(a => {
    if (FORCE || DRY_RUN) return true;
    // Au plus un envoi par abonné et par jour, même si un run est rejoué.
    if (state.sent[stateKeyForAlert(a)] === today) {
      log(`  · déjà envoyé aujourd'hui pour ${a.email} (${FUEL_LABELS[a.fuel]} ${a.hour}h)`);
      return false;
    }
    return true;
  });

  if (!due.length) {
    // On n'écrit PAS l'état ici : le cron tourne toutes les heures, et
    // persister `lastRun` à vide produirait 24 commits par jour dans le dépôt
    // pour rien. Le rattrapage supporte très bien un `lastRun` un peu ancien —
    // il est borné à MAX_CATCH_UP_HOURS et la garde anti-doublon fait le reste.
    log('Aucune alerte à envoyer sur ce créneau — état inchangé.');
    return validationErrors.length ? 1 : 0;
  }

  let cfg = null;
  if (!DRY_RUN) {
    const apiKey = process.env.BREVO_API_KEY;
    const sender = process.env.BREVO_SENDER;
    if (!apiKey || !sender) {
      log('✗ BREVO_API_KEY et BREVO_SENDER sont requis pour envoyer (ou utilise --dry-run).');
      return 1;
    }
    cfg = { apiKey, sender, senderName: process.env.BREVO_SENDER_NAME || 'Octane' };
  }

  const brandsData = loadBrands();

  // Un seul appel API par (zone, carburant), quel que soit le nombre d'abonnés.
  const groups = new Map();
  for (const a of due) {
    const k = groupKey(a);
    if (!groups.has(k)) groups.set(k, { sample: a, alerts: [] });
    groups.get(k).alerts.push(a);
  }
  log(`${due.length} envoi(s) à préparer sur ${groups.size} zone(s) distincte(s)`);

  let failures = 0;
  for (const [key, { sample, alerts: subscribers }] of groups) {
    const zone = sample.scope === 'france' ? 'France' : `${sample.radius} km / ${sample.label}`;
    log(`→ ${FUEL_LABELS[sample.fuel]} · ${zone} (${subscribers.length} abonné${subscribers.length > 1 ? 's' : ''})`);
    let data;
    try {
      data = await fetchGroup(sample);
    } catch (err) {
      log(`  ✗ API prix indisponible : ${err.message}`);
      failures += subscribers.length;
      continue;
    }
    const winner = data.rows[0];
    const previous = winner
      ? rememberPrice(state, stateKeyForGroup(sample), Number(winner[sample.fuel]), winner.id, today)
      : null;
    log(`  ${data.rows.length ? `gagnant ${eur(Number(winner[sample.fuel]))} € — ${winner.ville}` : 'aucune station éligible'} (${data.total} éligibles)`);

    for (const a of subscribers) {
      const mail = buildEmail(a, data, previous, brandsData);
      if (DRY_RUN) {
        log(`  [dry-run] → ${a.email}`);
        log(`  ┌ ${mail.subject}`);
        mail.text.split('\n').forEach(l => log(`  │ ${l}`));
        log('  └');
        continue;
      }
      try {
        await sendEmail(a.email, mail, cfg);
        state.sent[stateKeyForAlert(a)] = today;
        log(`  ✓ envoyé à ${a.email}`);
      } catch (err) {
        log(`  ✗ échec d'envoi à ${a.email} : ${err.message}`);
        failures++;
      }
    }
  }

  state.lastRun = { date: today, hour: nowHour };
  if (!DRY_RUN) saveState(state);
  else log('[dry-run] état non enregistré');

  if (failures) log(`✗ ${failures} envoi(s) en échec`);
  return failures || validationErrors.length ? 1 : 0;
}

// `process.exitCode` plutôt que `process.exit()` : sortir de force pendant que
// les sockets de `fetch` se referment déclenche une assertion libuv sur Windows
// (« UV_HANDLE_CLOSING », async.c:94) et rend un code 127 alors que le run a
// réussi — tous les runs seraient apparus en échec dans l'onglet Actions. On
// laisse la boucle d'évènements se vider d'elle-même.
main()
  .then(code => { process.exitCode = code; })
  .catch(err => { console.error(err); process.exitCode = 1; });
