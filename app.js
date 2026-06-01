// Timestamp
const updateTime = () => {
  const now = new Date();
  document.getElementById('timestamp').textContent = now.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit'
  });
};
updateTime();
setInterval(updateTime, 30000);

// Thème clair / sombre (persistence localStorage + prefers-color-scheme)
const $themeToggle = document.getElementById('themeToggle');
const $themeIcon = document.getElementById('themeIcon');
function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    $themeIcon.textContent = '☀';
  } else {
    document.documentElement.removeAttribute('data-theme');
    $themeIcon.textContent = '☾';
  }
}
const savedTheme = localStorage.getItem('octane-theme');
const initialTheme = savedTheme || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
applyTheme(initialTheme);
$themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  localStorage.setItem('octane-theme', next);
  applyTheme(next);
});

// Éléments
const $address = document.getElementById('address');
const $fuel = document.getElementById('fuel');
const $radius = document.getElementById('radius');
const $searchBtn = document.getElementById('searchBtn');
const $geolocBtn = document.getElementById('geolocBtn');
const $status = document.getElementById('status');
const $results = document.getElementById('results');
const $stationList = document.getElementById('stationList');
const $resultsTitle = document.getElementById('resultsTitle');
const $resultsCount = document.getElementById('resultsCount');
const $osmHint = document.getElementById('osmHint');
const $stationMap = document.getElementById('stationMap');
const $historyList = document.getElementById('historyList');
const $modeRadios = document.querySelectorAll('input[name="distanceMode"]');
const DISTANCE_MODE_KEY = 'octane-distance-mode';
function getDistanceMode() {
  const r = document.querySelector('input[name="distanceMode"]:checked');
  return r ? r.value : 'crow';
}
function setDistanceMode(mode) {
  const r = document.querySelector(`input[name="distanceMode"][value="${mode}"]`);
  if (r) r.checked = true;
}

const $tank = document.getElementById('tank');
const TANK_KEY = 'octane-tank-size';
const TANK_DEFAULT = 60;
// Clampé 1–200 L pour rester réaliste (un poids-lourd a typiquement 200 L max).
function getTankSize() {
  const v = parseInt($tank && $tank.value, 10);
  if (!Number.isFinite(v) || v <= 0) return TANK_DEFAULT;
  return Math.min(200, Math.max(1, v));
}
function setTankSize(liters) {
  const v = parseInt(liters, 10);
  if (!$tank || !Number.isFinite(v) || v <= 0) return;
  $tank.value = Math.min(200, Math.max(1, v));
}
const $viewList = document.getElementById('viewList');
const $viewMap = document.getElementById('viewMap');
const $viewHistory = document.getElementById('viewHistory');

const FUEL_LABELS = {
  sp95_e10_prix: 'SP95-E10',
  sp95_prix: 'SP95',
  sp98_prix: 'SP98',
  gazole_prix: 'Gazole',
  e85_prix: 'E85',
  gplc_prix: 'GPLc'
};

function showStatus(msg, isError = false) {
  $status.classList.remove('hidden');
  $status.classList.toggle('error', isError);
  $status.innerHTML = isError ? msg : `<span class="loader"></span>${msg}`;
}

function hideStatus() {
  $status.classList.add('hidden');
}

// Affiche un état d'erreur dans la barre de status AVEC une action de
// rattrapage cliquable. Pour les blocages côté utilisateur (géoloc refusée,
// 0 résultat, fetch raté), un cul-de-sac sans suite tue l'usage.
//   { label, action } — action = function appelée au clic
function showStatusAction(msg, actionLabel, onClick) {
  $status.classList.remove('hidden');
  $status.classList.add('error');
  $status.innerHTML = `${msg} <button type="button" class="status-cta">${actionLabel}</button>`;
  const btn = $status.querySelector('.status-cta');
  if (btn && onClick) btn.addEventListener('click', onClick, { once: true });
}

// Distance Haversine (km)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Cache léger (sessionStorage pour les données vivantes, localStorage pour OSM stable)
function cacheGet(store, key, ttlMs) {
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > ttlMs) { store.removeItem(key); return null; }
    return data;
  } catch { return null; }
}
function cacheSet(store, key, data) {
  const payload = JSON.stringify({ ts: Date.now(), data });
  try {
    store.setItem(key, payload);
  } catch (err) {
    // QuotaExceededError : on purge les entrées les plus vieilles (hist:*, fuel:*, geo:*)
    // puis on retente une fois. Sans ça, le cache se bloque silencieusement et
    // toutes les écritures suivantes échouent aussi.
    if (err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014)) {
      const victims = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k || !/^(hist:|fuel:|geo:|drive:|drive2:)/.test(k)) continue;
        try {
          const { ts } = JSON.parse(store.getItem(k)) || {};
          victims.push({ k, ts: ts || 0 });
        } catch { victims.push({ k, ts: 0 }); }
      }
      victims.sort((a, b) => a.ts - b.ts);
      const toDrop = Math.max(1, Math.floor(victims.length / 2));
      victims.slice(0, toDrop).forEach(v => { try { store.removeItem(v.k); } catch {} });
      try { store.setItem(key, payload); } catch {}
    }
  }
}
const TTL_GEO = 24 * 60 * 60 * 1000;   // adresse → coords stable
const TTL_FUEL = 5 * 60 * 1000;         // prix carburants : changent rarement

// Géocodage via API BAN (gouvernementale, gratuite)
async function geocode(address) {
  const key = `geo:${address.toLowerCase().trim()}`;
  const cached = cacheGet(localStorage, key, TTL_GEO);
  if (cached) return cached;
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=1`;
  const res = await fetchWithRetry(signal => fetch(url, { signal }));
  if (!res.ok) throw new Error('Erreur géocodage');
  const data = await res.json();
  if (!data.features || data.features.length === 0) {
    throw new Error('Adresse introuvable');
  }
  const [lon, lat] = data.features[0].geometry.coordinates;
  const result = { lat, lon, label: data.features[0].properties.label };
  cacheSet(localStorage, key, result);
  return result;
}

// Opendatasoft (data.economie.gouv.fr + public.opendatasoft.com) refuse les
// origins non-allowlistées avec un 403 `x-deny-reason: host_not_allowed`. En
// attendant un whitelisting officiel, on route ces deux hosts via un proxy CORS
// public. On garde une liste de miroirs : si le premier tombe (corsproxy.io
// monte/descend régulièrement), on bascule automatiquement sur le suivant.
const CORS_PROXIES = [
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
];
const PROXIED_HOSTS = /(?:data\.economie\.gouv\.fr|public\.opendatasoft\.com)/;

async function proxyFetch(url, opts) {
  if (!PROXIED_HOSTS.test(url)) return fetch(url, opts);
  let lastErr;
  for (const wrap of CORS_PROXIES) {
    try {
      const res = await fetch(wrap(url), opts);
      // 5xx côté proxy → essaie le suivant. 4xx côté API cible = vrai erreur, on propage.
      if (res.status >= 500 && res.status < 600) { lastErr = new Error(`proxy ${res.status}`); continue; }
      return res;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('Tous les proxies CORS sont indisponibles');
}

// Retry générique avec backoff exponentiel + timeout global. À utiliser pour
// les APIs publiques sans redondance native (BAN, Opendatasoft). Overpass a
// déjà sa propre stratégie multi-endpoint via Promise.any.
async function fetchWithRetry(fetcher, { tries = 3, backoff = [400, 1200, 2500], timeoutMs = 8000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetcher(ctrl.signal);
      clearTimeout(t);
      // On ne retry que les 5xx / erreurs réseau — 4xx c'est une vraie erreur.
      if (res.status >= 500 && res.status < 600) { lastErr = new Error(`HTTP ${res.status}`); }
      else return res;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
    }
    if (i < tries - 1) await new Promise(r => setTimeout(r, backoff[i] || 2500));
  }
  throw lastErr;
}

// Appel API prix carburants
async function fetchStations(lat, lon, radiusKm, fuelField) {
  const key = `fuel:${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusKm}:${fuelField}`;
  const cached = cacheGet(sessionStorage, key, TTL_FUEL);
  if (cached) return cached;
  const whereClause = `within_distance(geom, geom'POINT(${lon} ${lat})', ${radiusKm}km) AND ${fuelField} IS NOT NULL`;
  const url = `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records?` +
    `where=${encodeURIComponent(whereClause)}` +
    `&limit=100`;
  const res = await fetchWithRetry(signal => proxyFetch(url, { signal }));
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('API 4xx body:', body);
    throw new Error(`API carburants: ${res.status}`);
  }
  const data = await res.json();
  const results = data.results || [];
  cacheSet(sessionStorage, key, results);
  return results;
}

// ===== Routage routier (Valhalla primaire + OSRM fallback) =====
// Opendatasoft ne filtre qu'en haversine, donc pour le mode "voiture" on
// surfetch puis on mesure la distance routière via une matrice 1 origine × N.
// Valhalla (FOSSGIS) en primaire : costing plus nuancé qu'OSRM, respecte mieux
// les restrictions de virages et les classes de routes, donc précision > OSRM
// sur le terrain urbain. OSRM reste en fallback si Valhalla flanche.
const VALHALLA_ENDPOINT = 'https://valhalla.openstreetmap.de';
const OSRM_ENDPOINTS = [
  'https://router.project-osrm.org',
  'https://routing.openstreetmap.de/routed-car'
];
const ROUTING_BATCH_MAX = 90;            // limite douce côté démos publics
const TTL_DRIVE = 30 * 24 * 60 * 60 * 1000;  // distances routières ≈ stables
const DRIVE_INFLATE = 1.8;               // ratio max crow → route en France
const DRIVE_SAFETY_KM = 0.5;             // marge absolue pour zones tortueuses

function driveCacheKey(lat, lon, stationId) {
  // `drive3:` = v3 du schéma : ajoute le champ `seconds` (ETA) en plus de
  // `meters`. Les entrées v2 (sans ETA) sont ignorées pour forcer un recalcul.
  // Elles expireront seules grâce au TTL.
  return `drive3:${lat.toFixed(3)}:${lon.toFixed(3)}:${stationId}`;
}

// Valhalla `/sources_to_targets` : 1 origine × N destinations, JSON via GET
// pour éviter le preflight CORS (POST JSON déclenche un OPTIONS qui échoue
// parfois sur les démos publics). Distances en kilomètres, durée en secondes.
async function valhallaMatrix(originLat, originLon, stations, signal) {
  if (!stations.length) return [];
  const body = {
    sources: [{ lat: originLat, lon: originLon }],
    targets: stations.map(s => ({ lat: s.lat, lon: s.lon })),
    costing: 'auto',
    units: 'kilometers'
  };
  const url = `${VALHALLA_ENDPOINT}/sources_to_targets?json=${encodeURIComponent(JSON.stringify(body))}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Valhalla ${res.status}`);
  const data = await res.json();
  const row = (data.sources_to_targets && data.sources_to_targets[0]) || [];
  return stations.map((s, i) => {
    const cell = row[i];
    // `distance` / `time` null = destination inatteignable
    return {
      stationId: s.id,
      meters: cell && cell.distance != null ? Math.round(cell.distance * 1000) : null,
      seconds: cell && cell.time != null ? Math.round(cell.time) : null
    };
  });
}

// OSRM `/table` : 1 seul appel → matrice. Distances en mètres, durées en
// secondes (annotations=distance,duration → renvoie les deux matrices).
async function osrmTable(originLat, originLon, stations, signal) {
  if (!stations.length) return [];
  // Format OSRM : "lon,lat;lon,lat;..." — origine en index 0
  const coordParts = [`${originLon},${originLat}`]
    .concat(stations.map(s => `${s.lon},${s.lat}`));
  const destIdxs = stations.map((_, i) => i + 1).join(';');
  const path = `/table/v1/driving/${coordParts.join(';')}?sources=0&destinations=${destIdxs}&annotations=distance,duration`;
  let lastErr;
  for (const base of OSRM_ENDPOINTS) {
    try {
      const res = await fetch(base + path, { signal });
      if (!res.ok) { lastErr = new Error(`OSRM ${res.status}`); continue; }
      const data = await res.json();
      if (data.code !== 'Ok' || !data.distances || !data.distances[0]) {
        lastErr = new Error(`OSRM code=${data.code}`);
        continue;
      }
      const distRow = data.distances[0]; // distances[source][destination], en mètres
      const durRow = (data.durations && data.durations[0]) || []; // secondes
      return stations.map((s, i) => ({
        stationId: s.id,
        meters: distRow[i], // null si OSRM n'a pas trouvé de route
        seconds: durRow[i] != null ? Math.round(durRow[i]) : null
      }));
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('OSRM indisponible');
}

// Fusion de 2 matrices (rows [{stationId, meters, seconds}]).
// Pour chaque champ : null côté l'un = on prend l'autre. Les deux null = null.
// Les deux dispos = moyenne arrondie (médiane de 2 valeurs = moyenne).
function mergeDistanceRows(rowsA, rowsB) {
  const mapA = new Map(rowsA.map(r => [r.stationId, r]));
  const mapB = new Map(rowsB.map(r => [r.stationId, r]));
  const ids = new Set([...mapA.keys(), ...mapB.keys()]);
  const median = (a, b) => {
    if (a == null && b == null) return null;
    if (a == null) return b;
    if (b == null) return a;
    return Math.round((a + b) / 2);
  };
  const merged = [];
  for (const id of ids) {
    const a = mapA.get(id) || {};
    const b = mapB.get(id) || {};
    merged.push({
      stationId: id,
      meters: median(a.meters, b.meters),
      seconds: median(a.seconds, b.seconds)
    });
  }
  return merged;
}

// Lance Valhalla ET OSRM en parallèle (batchés si besoin). Fire `onPartial`
// dès que le 1er backend succès renvoie sa matrice → affichage rapide. Attend
// ensuite le 2e pour renvoyer la fusion (ou le seul succès si l'autre échoue).
async function raceDrivingBackends(originLat, originLon, stations, signal, onPartial) {
  const runBackend = async (fn) => {
    const rows = [];
    for (let i = 0; i < stations.length; i += ROUTING_BATCH_MAX) {
      const batch = stations.slice(i, i + ROUTING_BATCH_MAX);
      const r = await fn(originLat, originLon, batch, signal);
      rows.push(...r);
    }
    return rows;
  };

  const backends = [
    { name: 'valhalla', p: runBackend(valhallaMatrix).catch(e => ({ _error: e })) },
    { name: 'osrm',     p: runBackend(osrmTable).catch(e => ({ _error: e })) }
  ];

  let firstSuccess = null;
  const settled = await Promise.all(backends.map(async b => {
    const r = await b.p;
    if (r && r._error) {
      if (r._error.name === 'AbortError') throw r._error;
      console.warn(`[routing] ${b.name} échec :`, r._error.message);
      return { name: b.name, ok: false, err: r._error };
    }
    if (!firstSuccess) {
      firstSuccess = { name: b.name, rows: r };
      console.info(`[routing] 1er backend répondu : ${b.name} (${r.length} stations)`);
      try { onPartial && onPartial(r, b.name); } catch (e) { console.warn('onPartial threw:', e); }
    }
    return { name: b.name, ok: true, rows: r };
  }));

  const ok = settled.filter(s => s.ok);
  if (!ok.length) throw (settled[0] && settled[0].err) || new Error('Tous les backends de routage sont down');
  if (ok.length === 1) {
    console.info(`[routing] un seul backend a répondu : ${ok[0].name} — pas de fusion`);
    return { final: ok[0].rows, source: ok[0].name, merged: false };
  }
  const merged = mergeDistanceRows(ok[0].rows, ok[1].rows);
  console.info('[routing] fusion médiane des 2 backends appliquée');
  return { final: merged, source: 'median', merged: true };
}

// Entrée publique : résout les distances routières pour un batch de stations,
// en utilisant le cache localStorage et la race Valhalla/OSRM. `onPartial` est
// appelé dès que le 1er backend répond (affichage rapide). La Promise résout
// avec le résultat final (fusion si les deux ont répondu, sinon le survivant).
async function fetchDrivingDistances(originLat, originLon, stations, signal, onPartial) {
  // result: stationId → { meters, seconds }
  const result = new Map();
  const toQuery = [];
  for (const s of stations) {
    if (s.id == null) continue;
    const k = driveCacheKey(originLat, originLon, s.id);
    const cached = cacheGet(localStorage, k, TTL_DRIVE);
    if (cached && typeof cached.meters !== 'undefined') {
      result.set(s.id, { meters: cached.meters, seconds: cached.seconds ?? null });
    } else {
      toQuery.push(s);
    }
  }
  if (!toQuery.length) return { map: result, merged: false };

  const { final, merged } = await raceDrivingBackends(originLat, originLon, toQuery, signal, (partialRows) => {
    const partialMap = new Map(result);
    for (const row of partialRows) partialMap.set(row.stationId, { meters: row.meters, seconds: row.seconds });
    try { onPartial && onPartial(partialMap); } catch {}
  });

  for (const row of final) {
    result.set(row.stationId, { meters: row.meters, seconds: row.seconds });
    // On cache toujours la valeur FINALE (fusion si dispo, sinon single-backend)
    // pour que les visites suivantes n'aient pas à re-router.
    cacheSet(localStorage, driveCacheKey(originLat, originLon, row.stationId), { meters: row.meters, seconds: row.seconds });
  }
  return { map: result, merged };
}

// Base de marques OSM pré-calculée et shippée dans `data/osm/brands.json`.
// Généré par `scripts/build-brands.mjs` (ou `.py`). Format :
//   { brands: ["Total", "Shell", ...], stations: [[lat, lon, brandIdx], ...] }
// On la charge une seule fois par session (mise en cache mémoire), puis on
// cherche le plus proche voisin par haversine (≤ 150 m).
let osmBrandsData = null;     // { brands, stations, grid? } | null (404 / indispo)
let osmBrandsInflight = null; // Promise<...>

async function loadOSMBrands() {
  if (osmBrandsData !== null) return osmBrandsData;
  if (osmBrandsInflight) return osmBrandsInflight;
  osmBrandsInflight = (async () => {
    try {
      const res = await fetch('data/osm/brands.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Index spatial ultra simple : bucket par cellule de 0.1° (~10 km) pour
      // réduire le lookup de 12k candidats à ~dizaines.
      const grid = new Map();
      for (const st of data.stations) {
        const key = `${Math.round(st[0] * 10)}:${Math.round(st[1] * 10)}`;
        let bucket = grid.get(key);
        if (!bucket) { bucket = []; grid.set(key, bucket); }
        bucket.push(st);
      }
      data.grid = grid;
      osmBrandsData = data;
      console.log(`OSM brands : ${data.stations.length} stations, ${data.brands.length} marques`);
      return data;
    } catch (err) {
      console.warn('OSM brands JSON indispo :', err.message);
      osmBrandsData = false; // false = déjà tenté, inutile de retry
      return null;
    }
  })();
  const out = await osmBrandsInflight;
  osmBrandsInflight = null;
  return out;
}

// Cherche la marque OSM la plus proche (≤ 150 m) d'une station, via l'index grille.
function lookupOSMBrand(lat, lon, data) {
  if (!data || lat == null) return null;
  const MAX_KM = 0.15;
  // On inspecte la cellule + les 8 voisines pour couvrir les points près des bords
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
        if (d < minDist && d <= MAX_KM) {
          minDist = d;
          nearest = st;
        }
      }
    }
  }
  return nearest ? data.brands[nearest[2]] : null;
}

// Fallback n°4 : Overpass runtime. Appelé uniquement quand la base shippée +
// regex n'ont rien trouvé pour certaines stations (ex: POIs OSM ajoutés après
// notre dernier scrape mensuel). Silencieux, non bloquant.
const runtimeOverpassCache = {}; // session-only, par zone arrondie
async function fetchOSMFuelStationsRuntime(lat, lon, radiusKm) {
  const key = `${lat.toFixed(2)}:${lon.toFixed(2)}:${radiusKm}`;
  if (key in runtimeOverpassCache) return runtimeOverpassCache[key];

  const radiusM = Math.round(radiusKm * 1000 * 1.1);
  const query = `[out:json][timeout:20];(node["amenity"="fuel"](around:${radiusM},${lat},${lon});way["amenity"="fuel"](around:${radiusM},${lat},${lon}););out center tags;`;
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];
  const tryOne = (ep) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    return fetch(ep, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctrl.signal
    }).then(res => {
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }).then(data => {
      const out = (data.elements || []).map(e => {
        const elat = e.lat ?? e.center?.lat;
        const elon = e.lon ?? e.center?.lon;
        const t = e.tags || {};
        const brand = t.brand || t.operator || t.name || null;
        return elat != null && elon != null && brand
          ? { lat: elat, lon: elon, brand: brand.trim() }
          : null;
      }).filter(Boolean);
      if (!out.length) throw new Error('empty');
      return out;
    });
  };

  try {
    const out = await Promise.any(endpoints.map(tryOne));
    runtimeOverpassCache[key] = out;
    return out;
  } catch {
    runtimeOverpassCache[key] = [];
    return [];
  }
}

function findNearestRuntimeBrand(lat, lon, osmStations) {
  if (!osmStations.length || lat == null) return null;
  const MAX_KM = 0.15;
  let nearest = null;
  let minDist = Infinity;
  for (const osm of osmStations) {
    const d = haversine(lat, lon, osm.lat, osm.lon);
    if (d < minDist && d <= MAX_KM) {
      minDist = d;
      nearest = osm;
    }
  }
  return nearest?.brand || null;
}

// Parse tous les formats possibles retournés par Opendatasoft (geom GeoJSON, geo_point_2d {lon,lat} ou [lat,lon], WKT)
function extractCoords(s) {
  const g = s.geom;
  if (g) {
    if (Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
      return { lon: g.coordinates[0], lat: g.coordinates[1] };
    }
    if (g.lon != null && g.lat != null) return { lon: g.lon, lat: g.lat };
    if (typeof g === 'string') {
      const m = g.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
      if (m) return { lon: parseFloat(m[1]), lat: parseFloat(m[2]) };
    }
  }
  const p = s.geo_point_2d;
  if (p) {
    if (Array.isArray(p) && p.length >= 2) return { lat: p[0], lon: p[1] };
    if (p.lon != null && p.lat != null) return { lon: p.lon, lat: p.lat };
    if (p.longitude != null && p.latitude != null) return { lon: p.longitude, lat: p.latitude };
  }
  return { lat: null, lon: null };
}

// Liste ordonnée des enseignes françaises (les plus spécifiques en premier)
const KNOWN_BRANDS = [
  { re: /total\s*acc[eé]ss?/i, name: 'Total Access' },
  { re: /totalenergies/i, name: 'TotalEnergies' },
  { re: /total/i, name: 'Total' },
  { re: /e\.?\s*leclerc/i, name: 'E.Leclerc' },
  { re: /leclerc/i, name: 'E.Leclerc' },
  { re: /carrefour\s*market/i, name: 'Carrefour Market' },
  { re: /carrefour\s*contact/i, name: 'Carrefour Contact' },
  { re: /carrefour\s*express/i, name: 'Carrefour Express' },
  { re: /carrefour/i, name: 'Carrefour' },
  { re: /interm[aà]rch[eé]/i, name: 'Intermarché' },
  { re: /auchan/i, name: 'Auchan' },
  { re: /syst[eè]me\s*u|super\s*u|hyper\s*u|march[eé]\s*u\b|\bu\s*express/i, name: 'Super U' },
  { re: /esso\s*express/i, name: 'Esso Express' },
  { re: /\besso\b/i, name: 'Esso' },
  { re: /\bshell\b/i, name: 'Shell' },
  { re: /\bavia\b/i, name: 'Avia' },
  { re: /g[eé]ant\s*casino/i, name: 'Géant Casino' },
  { re: /\bcasino\b/i, name: 'Casino' },
  { re: /\bcora\b/i, name: 'Cora' },
  { re: /\bnetto\b/i, name: 'Netto' },
  { re: /leader\s*price/i, name: 'Leader Price' },
  { re: /colruyt/i, name: 'Colruyt' },
  { re: /\bbp\b/i, name: 'BP' },
  { re: /\belan\b/i, name: 'Elan' },
  { re: /\bagip\b/i, name: 'Agip' }
];

// ===== Services / amenities (champ services_service de l'API) =====
// L'API retourne un array de noms en français. On mappe vers une icône Unicode
// discrète + un label court pour l'a11y. Patterns d'ordre : variantes longues
// AVANT versions courtes (ex: "Lavage automatique" avant "Lavage").
const AMENITY_ICONS = [
  { re: /boutique\s*alim/i,         icon: '🛒', label: 'Boutique alimentaire' },
  { re: /boutique/i,                icon: '🏪', label: 'Boutique' },
  { re: /lavage\s*auto/i,           icon: '🧼', label: 'Lavage automatique' },
  { re: /lavage/i,                  icon: '🧽', label: 'Lavage manuel' },
  { re: /gonflage/i,                icon: '⊙',  label: 'Station de gonflage' },
  { re: /carburant\s*additiv/i,     icon: '⛽', label: 'Carburant additivé' },
  { re: /piste\s*poids\s*lourds/i,  icon: '🚛', label: 'Piste poids lourds' },
  { re: /gaz\s*domestique|butane|propane/i, icon: '🔥', label: 'Vente de gaz domestique' },
  { re: /automate\s*cb/i,           icon: '💳', label: 'Automate CB 24/24' },
  { re: /dab|distributeur\s*automatique\s*de\s*billets/i, icon: '💰', label: 'Distributeur de billets' },
  { re: /restauration\s*sur\s*place/i, icon: '🍽', label: 'Restauration sur place' },
  { re: /restauration\s*[aà]\s*emporter|snack/i, icon: '🥪', label: 'Restauration à emporter' },
  { re: /toilettes/i,               icon: '🚻', label: 'Toilettes' },
  { re: /\bbar\b/i,                 icon: '🍺', label: 'Bar' },
  { re: /wifi/i,                    icon: '📶', label: 'Wi-Fi' },
  { re: /borne|recharge|[eé]lectrique/i, icon: '⚡', label: 'Borne électrique' },
  { re: /fioul/i,                   icon: '🛢', label: 'Vente de fioul' },
  { re: /alcool/i,                  icon: '🍷', label: 'Vente d\'alcool' }
];

function getAmenities(servicesArray) {
  if (!Array.isArray(servicesArray) || !servicesArray.length) return [];
  const seen = new Set();
  const out = [];
  for (const raw of servicesArray) {
    if (typeof raw !== 'string') continue;
    for (const { re, icon, label } of AMENITY_ICONS) {
      if (re.test(raw)) {
        if (seen.has(icon)) break;
        seen.add(icon);
        out.push({ icon, label });
        break;
      }
    }
  }
  return out;
}

// Mapping enseigne → badge visuel (monogramme + couleur de marque).
// Liste ordonnée : variantes spécifiques (TotalEnergies, Total Access) AVANT
// la marque-mère (Total) pour que le bon match l'emporte. Si rien ne matche,
// on tombe sur un badge neutre gris avec l'initiale.
const BRAND_BADGES = [
  { re: /total\s*acc/i, mono: 'TA', bg: '#E5004B' },
  { re: /totalenergies/i, mono: 'TE', bg: '#E5004B' },
  { re: /total/i, mono: 'T', bg: '#E5004B' },
  { re: /e\.?\s*leclerc|leclerc/i, mono: 'L', bg: '#0066B3' },
  { re: /carrefour/i, mono: 'C', bg: '#004E9F' },
  { re: /interm[aà]rch[eé]/i, mono: 'IM', bg: '#E2001A' },
  { re: /auchan/i, mono: 'A', bg: '#E50019' },
  { re: /super\s*u|hyper\s*u|syst[eè]me\s*u|u\s*express/i, mono: 'U', bg: '#E51F3D' },
  { re: /esso\s*express/i, mono: 'EE', bg: '#003B7A' },
  { re: /esso/i, mono: 'E', bg: '#003B7A' },
  { re: /shell/i, mono: 'S', bg: '#FFC72C', fg: '#D8232A' },
  { re: /avia/i, mono: 'AV', bg: '#C8102E' },
  { re: /g[eé]ant\s*casino|casino/i, mono: 'CA', bg: '#DC0E37' },
  { re: /cora/i, mono: 'CO', bg: '#E2001A' },
  { re: /netto/i, mono: 'N', bg: '#FF6900' },
  { re: /\bbp\b/i, mono: 'BP', bg: '#006837' },
  { re: /leader\s*price/i, mono: 'LP', bg: '#E2001A' },
  { re: /colruyt/i, mono: 'CL', bg: '#003D7A' },
  { re: /elan/i, mono: 'EL', bg: '#0066B3' },
  { re: /agip/i, mono: 'AG', bg: '#FFCD00', fg: '#000' }
];
function getBrandBadge(name) {
  if (!name) return null;
  for (const b of BRAND_BADGES) {
    if (b.re.test(name)) return { mono: b.mono, bg: b.bg, fg: b.fg || '#fff' };
  }
  // Fallback : initiale du 1er mot signifiant, fond gris neutre
  const word = name.trim().split(/\s+/).find(w => /[a-z]/i.test(w));
  if (!word) return null;
  return { mono: word[0].toUpperCase(), bg: 'rgba(128,128,128,0.35)', fg: 'var(--ink)' };
}

// Nom commercial de la station (avec la ville si on peut)
function extractStationName(s) {
  // 1) Marque déjà matchée via OSM (priorité absolue, géospatial)
  if (s._osmBrand) {
    return s.ville ? `${s._osmBrand} ${s.ville}` : s._osmBrand;
  }
  // 2) Champs directs éventuels
  const raw = s.marque || s.brand || s.enseignes || s.nom_station || s.nom || null;
  if (raw && String(raw).trim()) {
    const brand = String(raw).trim();
    return s.ville ? `${brand} ${s.ville}` : brand;
  }
  // 3) Détection sur l'adresse (+ ville au cas où)
  const haystack = `${s.adresse || ''} ${s.ville || ''}`;
  for (const { re, name } of KNOWN_BRANDS) {
    if (re.test(haystack)) {
      return s.ville ? `${name} ${s.ville}` : name;
    }
  }
  return null;
}

// Couleur par rang (vert → rouge)
function getColorForRank(rank, total) {
  if (total === 1) return '#4ade80';
  const ratio = rank / (total - 1);
  const stops = [
    { t: 0, rgb: [74, 222, 128] },
    { t: 0.33, rgb: [250, 204, 21] },
    { t: 0.66, rgb: [251, 146, 60] },
    { t: 1, rgb: [239, 68, 68] }
  ];
  let lower = stops[0], upper = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (ratio >= stops[i].t && ratio <= stops[i + 1].t) {
      lower = stops[i];
      upper = stops[i + 1];
      break;
    }
  }
  const range = upper.t - lower.t;
  const localRatio = range === 0 ? 0 : (ratio - lower.t) / range;
  const rgb = lower.rgb.map((c, i) =>
    Math.round(c + (upper.rgb[i] - c) * localRatio)
  );
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function formatPrice(price) {
  const [euros, cents = '000'] = price.toFixed(3).split('.');
  return `${euros}<span class="cents">,${cents}</span> €`;
}

// "il y a 3h", "il y a 2j", "il y a 5 min" — pour l'horodatage de mise à jour.
// Retourne { text, tier } pour permettre une coloration selon la fraîcheur :
//   fresh = < 48 h (chip neutre, opacité faible)
//   stale = 48 h–7 j (chip orange, attention douce)
//   veryStale = > 7 j (chip rouge, donnée potentiellement obsolète)
function formatRelativeTime(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000));
  const diffH = diffMin / 60;
  const diffD = diffH / 24;
  let text;
  if (diffMin < 2) text = 'à l\'instant';
  else if (diffMin < 60) text = `il y a ${diffMin} min`;
  else if (diffH < 24) text = `il y a ${Math.round(diffH)} h`;
  else if (diffD < 30) text = `il y a ${Math.round(diffD)} j`;
  else text = `il y a ${Math.round(diffD / 30)} mois`;
  const tier = diffD > 7 ? 'veryStale' : diffD > 2 ? 'stale' : 'fresh';
  return { text, tier };
}

// Compare le prix actuel à la moyenne des 7 derniers jours d'historique
// (déjà chargé en mémoire par prefetchHistory). Retourne { sign, arrow, deltaCt }
// ou null si l'historique n'est pas encore là ou trop court.
function getStationTrend(stationId, fuelField, currentPrice) {
  if (stationId == null || !HIST_FUELS.has(fuelField) || !Number.isFinite(currentPrice)) return null;
  const points = historyMemCache[`${stationId}:${fuelField}`];
  if (!points || points.length < 3) return null;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  // points = [[tsMs, milliEuros], ...] triés du plus ancien au plus récent
  const recent = points.filter(p => p[0] >= cutoff).map(p => p[1] / 1000);
  // Fallback : si on a moins de 2 points sur 7j, on prend les 5 derniers globaux
  const series = recent.length >= 2 ? recent : points.slice(-5).map(p => p[1] / 1000);
  if (series.length < 2) return null;
  const avg = series.reduce((s, v) => s + v, 0) / series.length;
  const deltaEur = currentPrice - avg;
  const deltaCt = Math.round(deltaEur * 100); // centimes
  const sign = deltaCt <= -1 ? 'down' : deltaCt >= 1 ? 'up' : 'flat';
  const arrow = sign === 'down' ? '↘' : sign === 'up' ? '↗' : '→';
  return { sign, arrow, deltaCt };
}

// URL Google Maps pour itinéraire depuis la position de l'utilisateur
function directionsUrl(lat, lon, label) {
  const dest = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  const q = encodeURIComponent(label || dest);
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&destination_place_id=&travelmode=driving&query=${q}`;
}

// ===== Mémoire "dernière recherche" =====
// Au chargement de l'app sans URL params, si une recherche a abouti il y a moins
// de 24h, on propose un bandeau "Reprendre : Gazole · Lyon · 5 km" en 1 clic.
// Évite à un utilisateur récurrent de retaper sa recherche habituelle.
const LAST_SEARCH_KEY = 'octane-last-search';
const LAST_SEARCH_TTL = 24 * 60 * 60 * 1000;
function saveLastSearch(q, fuel, radius, mode) {
  try {
    localStorage.setItem(LAST_SEARCH_KEY, JSON.stringify({ q, fuel, radius, mode, ts: Date.now() }));
  } catch {}
}
function loadLastSearch() {
  try {
    const raw = localStorage.getItem(LAST_SEARCH_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || Date.now() - data.ts > LAST_SEARCH_TTL) return null;
    return data;
  } catch { return null; }
}

// ===== Historique de recherches =====
const HISTORY_KEY = 'octane-history';
const HISTORY_MAX = 5;
function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; } }
function pushHistory(query, label) {
  const norm = (query || '').trim();
  if (!norm) return;
  const hist = loadHistory().filter(h => h.q.toLowerCase() !== norm.toLowerCase());
  hist.unshift({ q: norm, label: label || norm, ts: Date.now() });
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0, HISTORY_MAX))); } catch {}
}

// ===== État courant de la recherche (pour rerender) =====
let currentResults = null; // { stations (enrichies, triées), fuelField, userLat, userLon, label }
let currentView = 'list';

function buildStationCard(s, i, total, fuelField, refStation) {
  const color = getColorForRank(i, total);
  const brandName = extractStationName(s);
  const title = brandName || s.adresse || 'Station sans nom';
  const badge = getBrandBadge(brandName);
  const badgeHtml = badge
    ? `<span class="brand-badge" style="background:${badge.bg};color:${badge.fg}" aria-hidden="true">${badge.mono}</span>`
    : '';
  const subParts = [];
  if (brandName && s.adresse) subParts.push(s.adresse);
  const cpVille = [s.cp, s.ville].filter(Boolean).join(' ');
  if (cpVille) subParts.push(cpVille);
  const subtitle = subParts.join(' · ');
  const majField = fuelField.replace('_prix', '_maj');
  const freshness = formatRelativeTime(s[majField]);
  const freshnessTitle = freshness && freshness.tier !== 'fresh'
    ? (freshness.tier === 'veryStale'
        ? 'Prix possiblement obsolète : aucune mise à jour depuis plus d\'une semaine'
        : 'Prix relativement ancien : mise à jour il y a plus de 48 h')
    : '';
  const economyHint = i > 0 ? buildEconomyHint(s, refStation) : null;
  const economyHtml = economyHint
    ? `<div class="economy-hint">${economyHint}</div>` : '';
  const amenities = getAmenities(s.services_service);
  const amenitiesHtml = amenities.length
    ? `<div class="amenities" aria-label="Services disponibles">${amenities.map(a => `<span class="amenity" title="${a.label}" aria-label="${a.label}">${a.icon}</span>`).join('')}</div>`
    : '';
  const outlierHtml = s._outlier
    ? `<span class="outlier-chip" title="Prix qui s'écarte de ${Math.round(s._outlier.ratio * 100)}% de la médiane locale (${s._outlier.median.toFixed(3).replace('.', ',')} €). Peut indiquer une saisie erronée — à vérifier sur place.">⚠ À vérifier</span>`
    : '';
  const trend = s.id != null ? getStationTrend(String(s.id), fuelField, s.price) : null;
  const trendTitle = trend
    ? (trend.sign === 'flat'
        ? 'Prix stable par rapport à la moyenne 7 jours'
        : `${trend.deltaCt > 0 ? '+' : ''}${trend.deltaCt} ct/L vs moyenne 7 jours`)
    : '';
  const dirUrl = directionsUrl(s.lat, s.lon, title);
  const rankLabel = i === 0 ? 'moins cher' : (i === total - 1 && total > 1 ? 'plus cher' : `rang ${i + 1} sur ${total}`);

  const el = document.createElement('div');
  el.className = 'station';
  el.style.setProperty('--rank-color', color);
  el.style.animationDelay = `${Math.min(i, 8) * 0.04}s`;
  el.dataset.stationIdx = String(i);
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', `Voir les détails de ${title}, prix ${s.price.toFixed(3)} euros par litre`);
  el.innerHTML = `
    <div class="rank" aria-hidden="true">${String(i + 1).padStart(2, '0')}</div>
    <span class="sr-only">${rankLabel}. </span>
    <div class="info">
      <div class="name">${badgeHtml}<span class="name-text">${title}</span></div>
      <div class="addr">${subtitle}</div>
      ${amenitiesHtml}
      ${economyHtml}
    </div>
    <div class="distance">
      <strong>${(s.driveKm != null ? s.driveKm : s.distance).toFixed(1)} km</strong>
      <span class="dist-label">${s.driveKm != null ? 'par la route' : 'à vol d\'oiseau'}</span>
      ${s.driveMin != null ? `<span class="dist-eta" title="Temps de trajet estimé en voiture">≈ ${s.driveMin} min</span>` : ''}
      ${s.driveUnavailable ? `<span class="dist-warn" title="Trajet routier non disponible pour cette station — distance affichée à vol d'oiseau">⚠ routage indispo</span>` : ''}
      <a class="dir-link" href="${dirUrl}" target="_blank" rel="noopener" aria-label="Itinéraire vers ${title} (ouvre Google Maps)">Itinéraire ↗</a>
    </div>
    <div class="price">
      ${formatPrice(s.price)}${trend ? `<span class="trend trend-${trend.sign}" title="${trendTitle}" aria-label="${trendTitle}">${trend.arrow}</span>` : ''}
      <span class="unit">€ / L</span>
      ${outlierHtml}
      ${freshness ? `<span class="freshness freshness-${freshness.tier}"${freshnessTitle ? ` title="${freshnessTitle}"` : ''}>Mis à jour ${freshness.text}</span>` : ''}
    </div>
  `;
  return el;
}

function buildHistoryCard(s, i, total) {
  const color = getColorForRank(i, total);
  const brandName = extractStationName(s);
  const title = brandName || s.adresse || 'Station sans nom';
  const badge = getBrandBadge(brandName);
  const badgeHtml = badge
    ? `<span class="brand-badge" style="background:${badge.bg};color:${badge.fg}" aria-hidden="true">${badge.mono}</span>`
    : '';
  const subParts = [];
  if (brandName && s.adresse) subParts.push(s.adresse);
  const cpVille = [s.cp, s.ville].filter(Boolean).join(' ');
  if (cpVille) subParts.push(cpVille);
  const subtitle = subParts.join(' · ');

  const el = document.createElement('div');
  el.className = 'history-card';
  el.style.setProperty('--rank-color', color);
  el.style.animationDelay = `${Math.min(i, 8) * 0.04}s`;
  el.innerHTML = `
    <div class="rank" aria-hidden="true">${String(i + 1).padStart(2, '0')}</div>
    <div class="info">
      <div class="name">${badgeHtml}<span class="name-text">${title}</span></div>
      <div class="addr">${subtitle}</div>
    </div>
    <div class="hist-body"><div class="hist-empty"><span class="loader-sm" aria-hidden="true"></span>Chargement de l'historique…</div></div>
  `;
  return el;
}

// Petit hint par carte (rang ≥ 2) : combien tu paies en plus vs station n°1
// sur le volume du réservoir user, et est-ce que c'est plus près ou plus loin
// que n°1. Aide à arbitrer "vaut le coup de bouger ?" sans calcul mental.
function buildEconomyHint(s, ref) {
  if (!ref || s === ref) return null;
  const priceDelta = s.price - ref.price;
  if (priceDelta < 0.005) return null; // < 0,5 ct/L : bruit, on n'affiche pas
  const tankSize = getTankSize();
  const tankExtra = priceDelta * tankSize;
  const distS = s.driveKm != null ? s.driveKm : s.distance;
  const distR = ref.driveKm != null ? ref.driveKm : ref.distance;
  const tankStr = `+${tankExtra.toFixed(2).replace('.', ',')} € (${tankSize} L) vs n°1`;
  if (distS == null || distR == null) return tankStr;
  const distDelta = distR - distS; // > 0 si cette station est plus PROCHE que n°1
  if (Math.abs(distDelta) < 0.3) return `${tankStr} · même distance`;
  const distAbs = Math.abs(distDelta).toFixed(1).replace('.', ',');
  return distDelta > 0
    ? `${tankStr} mais ${distAbs} km plus près`
    : `${tankStr} et ${distAbs} km plus loin`;
}

// Calcule et insère le bandeau "gain potentiel" : écart max de prix × volume
// réservoir choisi par l'user (60L par défaut). Seulement si ≥ 2 stations
// avec un vrai écart (> 1 ct/L).
function buildSavingsBanner(stations) {
  if (!stations || stations.length < 2) return null;
  const min = stations[0].price;
  const max = stations[stations.length - 1].price;
  const delta = max - min;
  if (delta < 0.01) return null;
  const tankSize = getTankSize();
  const tankEur = delta * tankSize;
  const el = document.createElement('div');
  el.className = 'savings-banner';
  el.innerHTML = `
    <div class="savings-delta">${delta.toFixed(2).replace('.', ',')} € / L d'écart</div>
    <div class="savings-tank">soit <strong>${tankEur.toFixed(2).replace('.', ',')} €</strong> économisés sur un plein de ${tankSize} L</div>
  `;
  return el;
}

// Affiche un placeholder de chargement (5 cartes squelette + shimmer CSS) pour
// que l'utilisateur ait un feedback visuel pendant l'appel API au lieu d'une
// zone vide. Affiché dès le clic, retiré au premier render réel.
function renderSkeletons(count = 5) {
  $stationList.innerHTML = '';
  $stationList.setAttribute('aria-busy', 'true');
  $resultsTitle.textContent = '';
  $resultsCount.textContent = '';
  $results.classList.remove('hidden');
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'station station-skeleton';
    el.style.animationDelay = `${i * 0.06}s`;
    el.innerHTML = `
      <div class="sk-rank"></div>
      <div class="sk-info">
        <div class="sk-line sk-line-name"></div>
        <div class="sk-line sk-line-addr"></div>
      </div>
      <div class="sk-distance">
        <div class="sk-line sk-line-km"></div>
        <div class="sk-line sk-line-label"></div>
      </div>
      <div class="sk-price">
        <div class="sk-line sk-line-price"></div>
        <div class="sk-line sk-line-unit"></div>
      </div>
    `;
    $stationList.appendChild(el);
  }
}

function renderStations() {
  if (!currentResults) return;
  const { fuelField, stations } = currentResults;
  const total = stations.length;

  $stationList.innerHTML = '';
  $stationList.setAttribute('aria-busy', 'false');
  $resultsTitle.textContent = FUEL_LABELS[fuelField];

  if (total === 0) {
    const node = document.createElement('div');
    node.className = 'status empty-state';
    const currentR = currentResults.radiusKm || parseInt($radius.value, 10) || 5;
    const nextR = Math.min(50, currentR * 2);
    if (nextR > currentR) {
      node.innerHTML = `<div>Aucune station avec ce carburant dans un rayon de ${currentR} km.</div>
        <button type="button" class="status-cta">Élargir à ${nextR} km</button>`;
      node.querySelector('button').addEventListener('click', () => {
        $radius.value = String(nextR);
        doAddressSearch();
      }, { once: true });
    } else {
      node.innerHTML = `<div>Aucune station avec ce carburant dans un rayon de ${currentR} km. Essaie un autre carburant ou une autre zone.</div>`;
    }
    $stationList.appendChild(node);
    $resultsCount.textContent = '0 station';
    return;
  }

  const savings = buildSavingsBanner(stations);
  if (savings) $stationList.appendChild(savings);

  const refStation = stations[0];
  stations.forEach((s, i) => {
    $stationList.appendChild(buildStationCard(s, i, total, fuelField, refStation));
  });
  $resultsCount.textContent = `${total} station${total > 1 ? 's' : ''}`;

  if (currentView === 'map') {
    renderMap(stations);
  }
}

// Token de la recherche en cours (évite les races si on relance avant la fin)
let currentSearchToken = 0;

// Médiane simple sur un tableau de nombres (ignore NaN). Utilisée pour la
// détection de prix aberrants (saisie erronée côté station/gérant).
function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function enrichStations(rawStations, fuelField, userLat, userLon) {
  const enriched = rawStations.map(s => {
    const { lat, lon } = extractCoords(s);
    return {
      ...s,
      lat,
      lon,
      distance: lat != null && lon != null ? haversine(userLat, userLon, lat, lon) : null,
      price: parseFloat(s[fuelField])
    };
  }).filter(s => s.lat != null && s.lon != null && !isNaN(s.price) && s.price > 0)
    .sort((a, b) => a.price - b.price);

  // Détection des prix aberrants : écart > 25 % avec la médiane locale du set.
  // Au moins 5 stations pour que la médiane soit représentative, sinon on ne
  // marque rien (trop volatile sur les très petites zones rurales).
  if (enriched.length >= 5) {
    const med = median(enriched.map(s => s.price));
    if (med && med > 0) {
      const threshold = 0.25;
      for (const s of enriched) {
        const ratio = Math.abs(s.price - med) / med;
        if (ratio > threshold) {
          s._outlier = {
            ratio,
            direction: s.price > med ? 'high' : 'low',
            median: med
          };
        }
      }
    }
  }
  return enriched;
}

// Applique une matrice de distances routières au set de stations et refresh
// la liste. Utilisable autant pour le render "partial" (1er backend répondu)
// que "final" (fusion médiane des deux).
function applyDistMapAndRender(distMap, stations, radiusKm) {
  const kept = [];
  for (const s of stations) {
    const entry = distMap.get(s.id);
    const meters = entry && typeof entry === 'object' ? entry.meters : entry;
    const seconds = entry && typeof entry === 'object' ? entry.seconds : null;
    if (meters == null) {
      // Station non routable : on la garde SI elle est dans le rayon crow-flies
      // (sinon elle vient du surfetch uniquement, pas pertinente).
      if (s.distance != null && s.distance <= radiusKm + 0.05) {
        s.driveKm = null;
        s.driveMin = null;
        s.driveUnavailable = true;
        kept.push(s);
      }
      continue;
    }
    const km = meters / 1000;
    if (km <= radiusKm + 0.05) {
      s.driveKm = km;
      s.driveMin = seconds != null ? Math.max(1, Math.round(seconds / 60)) : null;
      s.driveUnavailable = false;
      kept.push(s);
    }
  }
  // Tri par prix inchangé (rang n°1 = moins cher).
  currentResults.stations = kept.sort((a, b) => a.price - b.price);
  renderStations();
}

// Pipeline drive-mode : lance la race Valhalla/OSRM, affiche dès le 1er
// backend, puis réaffiche avec la fusion médiane quand le 2e finit aussi.
async function applyDrivingDistances(stations, userLat, userLon, radiusKm, fuelField, token) {
  if (!stations.length) return;
  const ctrl = new AbortController();
  try {
    showStatus(`Calcul des distances routières pour ${stations.length} stations…`);
    const { map: finalMap, merged } = await fetchDrivingDistances(
      userLat, userLon, stations, ctrl.signal,
      // Partial : dès le 1er backend, on affiche. Masque le status pour donner
      // l'impression que c'est fini — la fusion se fait silencieusement après.
      (partialMap) => {
        if (token !== currentSearchToken) return;
        hideStatus();
        applyDistMapAndRender(partialMap, stations, radiusKm);
      }
    );
    if (token !== currentSearchToken) return;
    hideStatus();
    // 2e render uniquement si fusion effective (sinon identique au partial).
    if (merged) applyDistMapAndRender(finalMap, stations, radiusKm);
  } catch (err) {
    if (token !== currentSearchToken) return;
    console.warn('Routage indisponible, fallback vol d\'oiseau :', err);
    // Fallback : on applique le rayon en crow-flies sur le superset déjà fetché.
    const kept = stations.filter(s => s.distance != null && s.distance <= radiusKm + 0.05);
    currentResults.stations = kept;
    renderStations();
    showStatus('Routage indisponible — distances affichées à vol d\'oiseau', true);
    setTimeout(() => { if (token === currentSearchToken) hideStatus(); }, 4000);
  }
}

async function runSearch(lat, lon, label) {
  const fuelField = $fuel.value;
  const radiusKm = parseInt($radius.value, 10);
  const distanceMode = getDistanceMode(); // 'crow' | 'drive'

  if (!radiusKm || radiusKm <= 0) {
    showStatus('Rayon invalide', true);
    return;
  }

  const token = ++currentSearchToken;
  // En mode voiture, on sur-fetch en vol d'oiseau pour ne pas manquer de
  // stations accessibles qui sont au-delà du cercle haversine.
  const fetchRadiusKm = distanceMode === 'drive'
    ? Math.min(50, Math.ceil(radiusKm * DRIVE_INFLATE + DRIVE_SAFETY_KM))
    : radiusKm;

  try {
    showStatus(`Recherche des stations dans un rayon de ${radiusKm} km autour de ${label}...`);
    renderSkeletons(5);
    // Base de marques shippée statiquement : chargée une fois par session, < 1 s
    // même sur la toute première visite grâce à la taille (~200 Ko gzip).
    const brandsPromise = loadOSMBrands();
    const rawStations = await fetchStations(lat, lon, fetchRadiusKm, fuelField);
    if (token !== currentSearchToken) return;

    hideStatus();
    $results.classList.remove('hidden');
    // Si les marques sont déjà en mémoire, on les applique avant le premier render
    if (osmBrandsData && osmBrandsData.grid) {
      // pass: les stations seront enrichies juste en bas
    } else {
      $osmHint.classList.remove('hidden');
    }

    const enrichedAll = enrichStations(rawStations, fuelField, lat, lon);
    // Affichage initial : toujours filtré au rayon crow-flies demandé (même en
    // mode drive, pour ne pas montrer des stations "trop loin" en attendant le
    // routage). Le superset `enrichedAll` sert uniquement au routage ensuite.
    const enriched = enrichedAll.filter(s => s.distance != null && s.distance <= radiusKm + 0.05);
    currentResults = {
      stations: enriched,
      rawStations,
      fuelField,
      userLat: lat,
      userLon: lon,
      label,
      distanceMode,
      radiusKm
    };

    // Applique les marques déjà chargées sur TOUT le superset (les objets sont
    // partagés par référence avec `enriched`, donc le display en profite aussi).
    if (osmBrandsData && osmBrandsData.grid) {
      enrichedAll.forEach(s => {
        const b = lookupOSMBrand(s.lat, s.lon, osmBrandsData);
        if (b) s._osmBrand = b;
      });
    }

    renderStations();
    $results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Persiste la recherche réussie pour la "reprise" au prochain chargement.
    saveLastSearch($address.value.trim() || label, fuelField, radiusKm, distanceMode);

    // Mode voiture : en tâche de fond, on calcule les distances routières
    // via OSRM sur le SUPERSET (inclut les stations hors cercle crow-flies
    // qui peuvent néanmoins être accessibles en < radiusKm par la route).
    if (distanceMode === 'drive') {
      applyDrivingDistances(enrichedAll, lat, lon, radiusKm, fuelField, token);
    }

    // Pré-chauffe l'historique de chaque station en arrière-plan (pool de 4)
    // pour que l'onglet Historique soit instantané.
    prefetchHistory(enriched, fuelField, () => token === currentSearchToken);

    // Patch des marques quand le JSON finit d'arriver (1re visite uniquement)
    brandsPromise.then(data => {
      if (token !== currentSearchToken) return;
      $osmHint.classList.add('hidden');
      if (data) {
        let changed = false;
        // Itère sur le SUPERSET (enrichedAll) pour que les stations qui
        // apparaîtront après routage héritent aussi des marques.
        enrichedAll.forEach(s => {
          const brand = lookupOSMBrand(s.lat, s.lon, data);
          if (brand && brand !== s._osmBrand) { s._osmBrand = brand; changed = true; }
        });
        if (changed) renderStations();
      }
      // Fallback n°4 : si certaines stations n'ont toujours ni marque OSM ni
      // match regex, on tente un Overpass runtime ciblé (zone de recherche).
      // Silencieux et non bloquant — si Overpass est HS ou lent, on s'en fout.
      const unmatched = currentResults.stations.filter(s => extractStationName(s) === null);
      if (!unmatched.length) return;
      fetchOSMFuelStationsRuntime(lat, lon, radiusKm).then(osm => {
        if (token !== currentSearchToken || !osm.length) return;
        let changed = false;
        unmatched.forEach(s => {
          const brand = findNearestRuntimeBrand(s.lat, s.lon, osm);
          if (brand && brand !== s._osmBrand) { s._osmBrand = brand; changed = true; }
        });
        if (changed) renderStations();
      });
    });
  } catch (err) {
    if (token !== currentSearchToken) return;
    $stationList.setAttribute('aria-busy', 'false');
    $stationList.innerHTML = '';
    console.error(err);
    showStatusAction(
      `Erreur lors du chargement des prix : ${err.message}`,
      'Réessayer',
      () => { hideStatus(); runSearch(lat, lon, label); }
    );
  }
}

// Sérialise la recherche courante dans l'URL pour partage / reload (sans scroll, sans reload)
function updateUrlParams() {
  const params = new URLSearchParams();
  const q = $address.value.trim();
  if (q) params.set('q', q);
  params.set('fuel', $fuel.value);
  params.set('r', $radius.value);
  const mode = getDistanceMode();
  if (mode !== 'crow') params.set('mode', mode);
  const tank = getTankSize();
  if (tank !== TANK_DEFAULT) params.set('tank', String(tank));
  const url = `${location.pathname}?${params.toString()}${location.hash}`;
  history.replaceState(null, '', url);
}

// Garde anti-double-submit : désactivée pendant une recherche en cours pour
// éviter de lancer 3 fetch en parallèle si l'user clique plusieurs fois.
let searchBusy = false;
function setSearchBusy(busy) {
  searchBusy = busy;
  $searchBtn.disabled = busy;
  $geolocBtn.disabled = busy;
  $searchBtn.setAttribute('aria-busy', String(busy));
}

async function doAddressSearch() {
  if (searchBusy) return;
  const address = $address.value.trim();
  if (!address || address.length < 2) {
    showStatus('Entre une adresse ou une ville (2 caractères minimum)', true);
    return;
  }
  updateUrlParams();
  setSearchBusy(true);
  try {
    showStatus('Localisation de l\'adresse...');
    const { lat, lon, label } = await geocode(address);
    pushHistory(address, label);
    await runSearch(lat, lon, label);
  } catch (err) {
    showStatusAction(
      `Erreur : ${err.message}`,
      'Réessayer',
      () => { hideStatus(); doAddressSearch(); }
    );
  } finally {
    setSearchBusy(false);
  }
}

$searchBtn.addEventListener('click', doAddressSearch);

// ================== AUTOCOMPLETE BAN ==================
const $suggestions = document.getElementById('suggestions');
let suggestionIdx = -1;
let lastSuggestionQuery = '';

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function closeSuggestions() {
  $suggestions.classList.add('hidden');
  $suggestions.innerHTML = '';
  $address.setAttribute('aria-expanded', 'false');
  suggestionIdx = -1;
}

function highlightSuggestion(idx) {
  const items = $suggestions.querySelectorAll('li');
  items.forEach((li, i) => li.setAttribute('aria-selected', i === idx ? 'true' : 'false'));
  if (idx >= 0 && items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  suggestionIdx = idx;
}

async function fetchSuggestions(q) {
  try {
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=6&autocomplete=1`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.features || [];
  } catch { return []; }
}

function renderSuggestions(features) {
  if (!features.length) { closeSuggestions(); return; }
  $suggestions.innerHTML = features.map((f, i) => {
    const label = f.properties.label || '';
    const context = f.properties.context || '';
    return `<li role="option" data-idx="${i}" aria-selected="false">${label}<span class="sg-ctx">${context}</span></li>`;
  }).join('');
  $suggestions.classList.remove('hidden');
  $address.setAttribute('aria-expanded', 'true');
  suggestionIdx = -1;
  // Click (utilise mousedown pour devancer le blur)
  $suggestions.querySelectorAll('li').forEach((li, i) => {
    li.addEventListener('mousedown', e => {
      e.preventDefault();
      selectSuggestion(features[i]);
    });
  });
  // Memorize features on the element for keyboard selection
  $suggestions._features = features;
}

function selectSuggestion(feature) {
  const label = feature.properties.label;
  const [lon, lat] = feature.geometry.coordinates;
  $address.value = label;
  closeSuggestions();
  // Cache le géocodage pour éviter un nouvel appel BAN
  cacheSet(localStorage, `geo:${label.toLowerCase().trim()}`, { lat, lon, label });
  pushHistory(label, label);
  updateUrlParams();
  runSearch(lat, lon, label);
}

function renderHistory() {
  const hist = loadHistory();
  if (!hist.length) { closeSuggestions(); return; }
  $suggestions.innerHTML =
    `<li class="sg-history" aria-hidden="true">Recherches récentes</li>` +
    hist.map((h, i) =>
      `<li role="option" class="sg-hist-item" data-idx="${i}" aria-selected="false">${h.label}</li>`
    ).join('');
  $suggestions.classList.remove('hidden');
  $address.setAttribute('aria-expanded', 'true');
  suggestionIdx = -1;
  $suggestions.querySelectorAll('li.sg-hist-item').forEach((li, i) => {
    li.addEventListener('mousedown', e => {
      e.preventDefault();
      $address.value = hist[i].q;
      closeSuggestions();
      doAddressSearch();
    });
  });
  $suggestions._history = hist;
}

const debouncedSuggest = debounce(async (q) => {
  if (q !== lastSuggestionQuery) return; // une frappe plus récente a pris la main
  if (q.length < 3) { closeSuggestions(); return; }
  const features = await fetchSuggestions(q);
  if (q !== lastSuggestionQuery) return;
  renderSuggestions(features);
}, 220);

$address.addEventListener('input', () => {
  const q = $address.value.trim();
  lastSuggestionQuery = q;
  if (q.length === 0) { renderHistory(); return; }
  if (q.length < 3) { closeSuggestions(); return; }
  debouncedSuggest(q);
});

$address.addEventListener('focus', () => {
  if (!$address.value.trim()) renderHistory();
});

$address.addEventListener('keydown', e => {
  const items = $suggestions.querySelectorAll('li');
  const open = !$suggestions.classList.contains('hidden') && items.length > 0;

  if (e.key === 'ArrowDown' && open) {
    e.preventDefault();
    highlightSuggestion((suggestionIdx + 1) % items.length);
  } else if (e.key === 'ArrowUp' && open) {
    e.preventDefault();
    highlightSuggestion((suggestionIdx - 1 + items.length) % items.length);
  } else if (e.key === 'Escape' && open) {
    closeSuggestions();
  } else if (e.key === 'Enter') {
    if (open && suggestionIdx >= 0 && $suggestions._features?.[suggestionIdx]) {
      e.preventDefault();
      selectSuggestion($suggestions._features[suggestionIdx]);
    } else {
      closeSuggestions();
      doAddressSearch();
    }
  }
});

$address.addEventListener('blur', () => {
  // Léger délai pour laisser passer le mousedown des items
  setTimeout(closeSuggestions, 150);
});

document.addEventListener('click', e => {
  if (!e.target.closest('.field-address')) closeSuggestions();
});

$geolocBtn.addEventListener('click', () => {
  if (searchBusy) return;
  if (!navigator.geolocation) {
    showStatusAction(
      'Géolocalisation non supportée par ton navigateur.',
      'Saisir une adresse',
      () => { hideStatus(); $address.focus(); }
    );
    return;
  }
  setSearchBusy(true);
  showStatus('Récupération de ta position...');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      $address.value = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      updateUrlParams();
      try { await runSearch(lat, lon, 'ta position actuelle'); }
      finally { setSearchBusy(false); }
    },
    (err) => {
      // err.code 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
      const isDenied = err.code === 1;
      const msg = isDenied
        ? 'Géolocalisation refusée. Tu peux saisir une adresse à la place.'
        : `Position indisponible (${err.message}).`;
      showStatusAction(msg, 'Saisir une adresse', () => {
        hideStatus();
        $address.focus();
        $address.select();
      });
      setSearchBusy(false);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ===== Historique des prix (runtime, dataset j-1 d'Opendatasoft) =====
// Pour chaque station, on récupère les 30 dernières mises à jour de prix sur
// le dataset public `prix-des-carburants-j-1` (12 mois glissants). Cache mémoire
// + localStorage (TTL 24h) + dédup des requêtes en vol. Aucun fichier généré :
// tout est calculé à la volée côté client, et pré-chargé en arrière-plan dès
// qu'une recherche retourne des résultats.

const TTL_HISTORY = 24 * 60 * 60 * 1000;
const HIST_KEEP = 30;                 // nb de points gardés après dédup
const HIST_FETCH_LIMIT = 100;         // nb de records bruts demandés (marge pour dédup)
const HIST_PREFETCH_CONCURRENCY = 4;

// Dataset `prix-des-carburants-j-1` (public.opendatasoft.com, 12 mois glissants).
// Schéma confirmé : champs plats `price_gazole`, `price_sp95`, `price_sp98`,
// `price_gplc`, `price_e10`, `price_e85` (préfixe `price_`, pas `prix_`).
// Timestamp ligne = `update`. 1 ligne par station par jour.
const HIST_FUELS = new Set([
  'gazole_prix', 'sp95_prix', 'sp95_e10_prix', 'sp98_prix', 'e85_prix', 'gplc_prix'
]);
const HIST_FUEL_COL = {
  gazole_prix: 'price_gazole',
  sp95_prix: 'price_sp95',
  sp95_e10_prix: 'price_e10',
  sp98_prix: 'price_sp98',
  e85_prix: 'price_e85',
  gplc_prix: 'price_gplc'
};

const historyMemCache = {};           // `${id}:${fuel}` → points[] | null
const historyInflight = {};

async function loadStationHistory(stationId, fuelField) {
  if (stationId == null || !HIST_FUELS.has(fuelField)) return null;
  const key = `${stationId}:${fuelField}`;
  if (key in historyMemCache) return historyMemCache[key];
  if (historyInflight[key]) return historyInflight[key];

  const storageKey = `hist:${key}`;
  const persisted = cacheGet(localStorage, storageKey, TTL_HISTORY);
  if (persisted) { historyMemCache[key] = persisted; return persisted; }

  historyInflight[key] = (async () => {
    try {
      const col = HIST_FUEL_COL[fuelField];
      // On filtre par id station ET exige un prix non-null pour ce carburant
      // (sinon on récupère 365 lignes dont la majorité inutiles).
      const where = `id="${stationId}" AND ${col} IS NOT NULL`;
      const url = `https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/prix-des-carburants-j-1/records?` +
        `where=${encodeURIComponent(where)}` +
        `&order_by=${encodeURIComponent('update desc')}` +
        `&limit=${HIST_FETCH_LIMIT}`;
      const res = await fetchWithRetry(signal => proxyFetch(url, { signal }));
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`API j-1: ${res.status} — ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      const raw = data.results || [];
      const sorted = raw.map(r => {
        const ts = r.update ? Date.parse(r.update) : NaN;
        const v = r[col] != null ? Number(r[col]) : NaN;
        if (!Number.isFinite(ts) || !Number.isFinite(v) || v <= 0) return null;
        return [ts, Math.round(v * 1000)]; // ms epoch, millièmes d'€
      }).filter(Boolean).sort((a, b) => a[0] - b[0]);
      const dedup = [];
      for (const p of sorted) {
        const prev = dedup[dedup.length - 1];
        if (!prev || prev[1] !== p[1]) dedup.push(p);
      }
      const points = dedup.slice(-HIST_KEEP);
      historyMemCache[key] = points;
      cacheSet(localStorage, storageKey, points);
      return points;
    } catch (err) {
      console.warn(`History load failed for ${stationId}/${fuelField}:`, err);
      historyMemCache[key] = null;
      return null;
    } finally {
      delete historyInflight[key];
    }
  })();
  return historyInflight[key];
}

function renderSparklineFromPoints(points) {
  if (!points || points.length < 2) {
    return `<div class="hist-empty">Pas assez de données pour tracer une courbe.</div>`;
  }
  const W = 260, H = 60, PAD_X = 6, PAD_Y = 10;
  const priceEur = points.map(p => p[1] / 1000);
  const min = Math.min(...priceEur);
  const max = Math.max(...priceEur);
  const avg = priceEur.reduce((s, v) => s + v, 0) / priceEur.length;
  const range = Math.max(max - min, 0.005);
  const tMin = points[0][0], tMax = points[points.length - 1][0];
  const tRange = Math.max(tMax - tMin, 1);
  const coord = (pt) => ({
    x: PAD_X + (pt[0] - tMin) / tRange * (W - PAD_X * 2),
    y: PAD_Y + (H - PAD_Y * 2) * (1 - (pt[1] / 1000 - min) / range)
  });
  const line = points.map(p => {
    const c = coord(p);
    return `${c.x.toFixed(1)},${c.y.toFixed(1)}`;
  }).join(' ');
  const last = coord(points[points.length - 1]);
  const first = priceEur[0], now = priceEur[priceEur.length - 1];
  const delta = now - first;
  const sign = delta > 0.003 ? 'up' : delta < -0.003 ? 'down' : 'flat';
  const arrow = sign === 'up' ? '↗' : sign === 'down' ? '↘' : '→';
  const fmt = (ts) => new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  const firstDate = fmt(tMin), lastDate = fmt(tMax);

  return `
    <svg viewBox="0 0 ${W} ${H}" class="sparkline" role="img" aria-label="Évolution de prix sur ${points.length} relevés, du ${firstDate} au ${lastDate}">
      <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3" fill="currentColor"/>
    </svg>
    <div class="hist-stats">
      <span>min <strong>${min.toFixed(3)} €</strong></span>
      <span>moy <strong>${avg.toFixed(3)} €</strong></span>
      <span>max <strong>${max.toFixed(3)} €</strong></span>
      <span class="hist-trend ${sign}">${arrow} ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} € · ${firstDate} → ${lastDate}</span>
    </div>
  `;
}

// Pré-charge en arrière-plan (pool de N) l'historique de chaque station juste
// après un render de liste : quand l'utilisateur ouvre l'onglet Historique, les
// données sont déjà en cache. Stoppe si la recherche courante a changé.
// Quand tout est chargé, déclenche un re-render unique pour faire apparaître
// les flèches de tendance qui dépendent de historyMemCache.
function prefetchHistory(stations, fuelField, tokenCheck) {
  if (!HIST_FUELS.has(fuelField)) return;
  const ids = stations.map(s => s.id != null ? String(s.id) : null).filter(Boolean);
  let cursor = 0;
  const workers = [];
  const worker = async () => {
    while (cursor < ids.length) {
      if (tokenCheck && !tokenCheck()) return;
      const id = ids[cursor++];
      await loadStationHistory(id, fuelField);
    }
  };
  for (let w = 0; w < HIST_PREFETCH_CONCURRENCY; w++) workers.push(worker());
  Promise.all(workers).then(() => {
    if (tokenCheck && !tokenCheck()) return;
    if (currentView === 'list') renderStations();
  });
}

function renderPriceHistory() {
  if (!currentResults) return;
  const { stations, fuelField } = currentResults;
  const total = stations.length;
  $historyList.innerHTML = '';
  if (!total) {
    $historyList.innerHTML = `<div class="status">Aucune station dans les résultats.</div>`;
    return;
  }
  if (!HIST_FUELS.has(fuelField)) {
    $historyList.innerHTML = `<div class="status">Historique non disponible pour ce carburant.</div>`;
    return;
  }
  const pendingToken = currentSearchToken;
  stations.forEach((s, i) => {
    const card = buildHistoryCard(s, i, total);
    $historyList.appendChild(card);
    const body = card.querySelector('.hist-body');
    const sid = s.id != null ? String(s.id) : null;
    if (!sid) {
      body.innerHTML = `<div class="hist-empty">Station sans identifiant, historique indisponible.</div>`;
      return;
    }
    loadStationHistory(sid, fuelField).then(points => {
      if (pendingToken !== currentSearchToken) return;
      body.innerHTML = points && points.length >= 2
        ? renderSparklineFromPoints(points)
        : `<div class="hist-empty">Historique indisponible pour cette station.</div>`;
    });
  });
}

// ===== Carte Leaflet =====
let map = null;
let markersLayer = null;     // L.markerClusterGroup | L.layerGroup (fallback)
let userMarker = null;

function ensureMap() {
  if (map || typeof L === 'undefined') return map;
  map = L.map($stationMap, { scrollWheelZoom: true, zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(map);
  // Cluster si le plugin a chargé, sinon layerGroup simple. Le cluster ne se
  // déclenche qu'au-delà de 20 markers proches (default spiderfy/cluster radius).
  markersLayer = (typeof L.markerClusterGroup === 'function')
    ? L.markerClusterGroup({ showCoverageOnHover: false, spiderfyOnMaxZoom: true, maxClusterRadius: 50 })
    : L.layerGroup();
  markersLayer.addTo(map);
  return map;
}

function renderMap(stations) {
  if (!currentResults) return;
  const m = ensureMap();
  if (!m) return;
  const { userLat, userLon } = currentResults;

  markersLayer.clearLayers();
  if (userMarker) { m.removeLayer(userMarker); userMarker = null; }

  userMarker = L.circleMarker([userLat, userLon], {
    radius: 8, color: '#ff6b00', fillColor: '#ff6b00', fillOpacity: 0.9, weight: 2
  }).addTo(m).bindPopup('Ta position');

  const bounds = L.latLngBounds([[userLat, userLon]]);

  if (stations.length) {
    stations.forEach((s, i) => {
      const color = getColorForRank(i, stations.length);
      const icon = L.divIcon({
        className: 'map-pin',
        html: `<div class="map-pin-inner" style="background:${color}"><span>${i + 1}</span></div>`,
        iconSize: [28, 36],
        iconAnchor: [14, 32]
      });
      const marker = L.marker([s.lat, s.lon], { icon });
      const name = extractStationName(s) || s.adresse || 'Station';
      const addrLine = [s.adresse, s.cp, s.ville].filter(Boolean).join(' · ');
      const distStr = `${(s.driveKm != null ? s.driveKm : s.distance).toFixed(1)} km${s.driveKm != null ? ' (route)' : ''}`;
      const etaStr = s.driveMin != null ? ` · ≈ ${s.driveMin} min` : '';
      marker.bindPopup(
        `<strong>${name}</strong><br>` +
        (addrLine ? `<span style="color:#666;font-size:0.75rem">${addrLine}</span><br>` : '') +
        `<b style="color:${color}">${s.price.toFixed(3)} €/L</b> · ${distStr}${etaStr}`
      );
      markersLayer.addLayer(marker);
      bounds.extend([s.lat, s.lon]);
    });
    m.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  } else {
    m.setView([userLat, userLon], 13);
  }
  setTimeout(() => m.invalidateSize(), 80);
}

function setView(view) {
  currentView = view;
  const views = { list: $stationList, map: $stationMap, history: $historyList };
  const buttons = { list: $viewList, map: $viewMap, history: $viewHistory };
  for (const [name, el] of Object.entries(views)) el.classList.toggle('hidden', view !== name);
  for (const [name, btn] of Object.entries(buttons)) {
    const active = view === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
  if (view === 'map' && currentResults) renderMap(currentResults.stations);
  if (view === 'history' && currentResults) renderPriceHistory();
}
$viewList.addEventListener('click', () => setView('list'));
$viewMap.addEventListener('click', () => setView('map'));
$viewHistory.addEventListener('click', () => setView('history'));

// ===== Bottom sheet "détails station" =====
// Ouvert au clic sur une carte. Recyclable : un seul DOM, rempli dynamiquement.
const $stationSheet = document.getElementById('stationSheet');
const $sheetContent = $stationSheet ? $stationSheet.querySelector('.sheet-content') : null;
const $sheetPanel = $stationSheet ? $stationSheet.querySelector('.sheet-panel') : null;
let lastSheetTrigger = null; // pour rendre le focus à la card cliquée à la fermeture

const ALL_FUELS = [
  { field: 'gazole_prix', label: 'Gazole' },
  { field: 'sp95_prix', label: 'SP95' },
  { field: 'sp95_e10_prix', label: 'SP95-E10' },
  { field: 'sp98_prix', label: 'SP98' },
  { field: 'e85_prix', label: 'E85' },
  { field: 'gplc_prix', label: 'GPLc' }
];

// Liens deep-link natifs : Google Maps + Waze ouvrent l'app si installée, sinon le web.
function googleMapsUrl(lat, lon) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=driving`;
}
function wazeUrl(lat, lon) {
  return `https://waze.com/ul?ll=${lat.toFixed(6)}%2C${lon.toFixed(6)}&navigate=yes`;
}

function buildSheetContent(s, fuelField) {
  const brandName = extractStationName(s) || s.adresse || 'Station sans nom';
  const badge = getBrandBadge(brandName);
  const badgeHtml = badge
    ? `<span class="brand-badge" style="background:${badge.bg};color:${badge.fg}" aria-hidden="true">${badge.mono}</span>`
    : '';
  const fullAddr = [s.adresse, [s.cp, s.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  // --- Tous les prix : montre dispo + rupture (temporaire / définitive)
  const pricesRows = ALL_FUELS.map(f => {
    const v = s[f.field];
    const ruptureType = s[f.field.replace('_prix', '_rupture_type')];
    const ruptureLabel = ruptureType === 'definitive' ? 'Rupture définitive'
                       : ruptureType === 'temporaire' ? 'Rupture temporaire'
                       : null;
    const majIso = s[f.field.replace('_prix', '_maj')];
    const fresh = formatRelativeTime(majIso);
    const isCurrent = f.field === fuelField;
    let priceCell;
    if (typeof v === 'number' && v > 0) {
      priceCell = `<span class="sheet-price">${v.toFixed(3).replace('.', ',')} €</span>`;
      if (fresh) priceCell += ` <span class="sheet-fresh sheet-fresh-${fresh.tier}">${fresh.text}</span>`;
    } else if (ruptureLabel) {
      priceCell = `<span class="sheet-rupture">${ruptureLabel}</span>`;
    } else {
      priceCell = `<span class="sheet-unavailable">Non distribué</span>`;
    }
    return `<tr${isCurrent ? ' class="current"' : ''}>
      <th scope="row">${f.label}</th><td>${priceCell}</td>
    </tr>`;
  }).join('');

  // --- Services
  const amenities = getAmenities(s.services_service);
  const servicesHtml = amenities.length
    ? `<section class="sheet-section">
        <h3>Services</h3>
        <ul class="sheet-services">${amenities.map(a => `<li><span class="amenity-big">${a.icon}</span>${a.label}</li>`).join('')}</ul>
       </section>`
    : '';

  return `
    <header class="sheet-header">
      <div class="sheet-title-row">${badgeHtml}<h2 id="sheetTitle">${brandName}</h2></div>
      ${fullAddr ? `<div class="sheet-addr">${fullAddr}</div>` : ''}
      <div class="sheet-actions">
        <a class="sheet-btn sheet-btn-primary" href="${googleMapsUrl(s.lat, s.lon)}" target="_blank" rel="noopener">Google Maps ↗</a>
        <a class="sheet-btn" href="${wazeUrl(s.lat, s.lon)}" target="_blank" rel="noopener">Waze ↗</a>
        ${fullAddr ? `<button type="button" class="sheet-btn sheet-copy" data-copy="${fullAddr.replace(/"/g, '&quot;')}">Copier l'adresse</button>` : ''}
      </div>
    </header>
    <section class="sheet-section">
      <h3>Prix par carburant</h3>
      <table class="sheet-table sheet-prices">${pricesRows}</table>
    </section>
    ${servicesHtml}
  `;
}

function openStationSheet(s, fuelField, triggerEl) {
  if (!$stationSheet || !$sheetContent) return;
  $sheetContent.innerHTML = buildSheetContent(s, fuelField);
  $stationSheet.classList.remove('hidden');
  $stationSheet.setAttribute('aria-hidden', 'false');
  document.body.classList.add('sheet-open');
  lastSheetTrigger = triggerEl || null;
  // Focus dans le panneau pour piéger les flèches/tab
  setTimeout(() => $sheetPanel && $sheetPanel.focus(), 30);
  // Bouton "Copier l'adresse"
  const copyBtn = $sheetContent.querySelector('.sheet-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = copyBtn.dataset.copy || '';
      try {
        await navigator.clipboard.writeText(text);
        const prev = copyBtn.textContent;
        copyBtn.textContent = '✓ Copié';
        setTimeout(() => { copyBtn.textContent = prev; }, 1500);
      } catch {
        copyBtn.textContent = 'Copie impossible';
      }
    });
  }
}

function closeStationSheet() {
  if (!$stationSheet) return;
  $stationSheet.classList.add('hidden');
  $stationSheet.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('sheet-open');
  if (lastSheetTrigger && typeof lastSheetTrigger.focus === 'function') {
    lastSheetTrigger.focus();
  }
  lastSheetTrigger = null;
}

if ($stationSheet) {
  // Fermeture : backdrop, bouton ×, Escape
  $stationSheet.addEventListener('click', (e) => {
    if (e.target.dataset && e.target.dataset.close === '1') closeStationSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$stationSheet.classList.contains('hidden')) closeStationSheet();
  });
}

// Click handler global sur la liste : on remonte au .station, on retrouve
// l'objet station depuis currentResults.stations par index (data-station-idx
// posé au render). Ignore les clics sur les liens internes (Itinéraire).
function openCardFromEvent(e) {
  if (e.target.closest('a, button')) return; // laisse passer Itinéraire, etc.
  const card = e.target.closest('.station');
  if (!card || card.classList.contains('station-skeleton')) return;
  const idx = parseInt(card.dataset.stationIdx, 10);
  if (isNaN(idx) || !currentResults) return;
  const s = currentResults.stations[idx];
  if (s) openStationSheet(s, currentResults.fuelField, card);
}
$stationList.addEventListener('click', openCardFromEvent);
$stationList.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    const card = e.target.closest('.station');
    if (card && !card.classList.contains('station-skeleton')) {
      e.preventDefault();
      openCardFromEvent(e);
    }
  }
});

// ===== Détection offline =====
// On s'appuie sur navigator.onLine + les events online/offline. Ça couvre le
// cas "WiFi coupé" sans tracking bidon. Pas d'alerte quand on est online au
// reload — uniquement si la connexion chute pendant la session.
const $offlineBanner = document.getElementById('offlineBanner');
function syncOfflineBanner() {
  if ($offlineBanner) $offlineBanner.classList.toggle('hidden', navigator.onLine);
}
window.addEventListener('offline', syncOfflineBanner);
window.addEventListener('online', syncOfflineBanner);
syncOfflineBanner();

// ===== Service Worker (PWA) =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW register failed:', err));
  });
}

// Deep-link : au chargement, si ?q=...&fuel=...&r=... → préremplit et lance la recherche
(function applyUrlParams() {
  // Mode de distance : URL > localStorage > défaut (crow)
  const params = new URLSearchParams(location.search);
  const urlMode = params.get('mode');
  const storedMode = (() => { try { return localStorage.getItem(DISTANCE_MODE_KEY); } catch { return null; } })();
  const mode = (urlMode === 'drive' || urlMode === 'crow') ? urlMode
             : (storedMode === 'drive' || storedMode === 'crow') ? storedMode
             : 'crow';
  setDistanceMode(mode);

  // Taille réservoir : URL > localStorage > défaut (60)
  const urlTank = params.get('tank');
  const storedTank = (() => { try { return localStorage.getItem(TANK_KEY); } catch { return null; } })();
  setTankSize(urlTank || storedTank || TANK_DEFAULT);

  const q = params.get('q');
  const fuel = params.get('fuel');
  const r = params.get('r');
  if (fuel && [...$fuel.options].some(o => o.value === fuel)) $fuel.value = fuel;
  if (r && !isNaN(parseInt(r, 10))) $radius.value = r;
  if (q) {
    $address.value = q;
    // Laisse le temps au DOM / cache de s'initialiser avant de lancer
    setTimeout(doAddressSearch, 50);
    return;
  }
  // Pas de query string : si une recherche récente existe, proposer un bandeau
  // de reprise au-dessus du hero. Un clic suffit à relancer.
  const last = loadLastSearch();
  if (last && last.q) showResumeBanner(last);
})();

function showResumeBanner(last) {
  if (document.getElementById('resumeBanner')) return;
  const fuelLabel = FUEL_LABELS[last.fuel] || 'carburant';
  const banner = document.createElement('div');
  banner.id = 'resumeBanner';
  banner.className = 'resume-banner';
  banner.innerHTML = `
    <div class="resume-text">
      <span class="resume-dot" aria-hidden="true">↻</span>
      Reprendre votre dernière recherche : <strong>${fuelLabel}</strong> autour de <strong>${last.q}</strong> (${last.radius} km)
    </div>
    <div class="resume-actions">
      <button type="button" class="resume-btn resume-go" aria-label="Reprendre la recherche">Reprendre</button>
      <button type="button" class="resume-btn resume-dismiss" aria-label="Ignorer">✕</button>
    </div>
  `;
  const hero = document.querySelector('.hero');
  if (hero && hero.parentNode) {
    hero.parentNode.insertBefore(banner, hero);
  }
  banner.querySelector('.resume-go').addEventListener('click', () => {
    $address.value = last.q;
    if (last.fuel && [...$fuel.options].some(o => o.value === last.fuel)) $fuel.value = last.fuel;
    if (last.radius) $radius.value = String(last.radius);
    if (last.mode) setDistanceMode(last.mode);
    banner.remove();
    doAddressSearch();
  });
  banner.querySelector('.resume-dismiss').addEventListener('click', () => banner.remove());
}

// Persiste le choix du mode + relance la recherche si on en a déjà une en cours
$modeRadios.forEach(r => {
  r.addEventListener('change', () => {
    const mode = getDistanceMode();
    try { localStorage.setItem(DISTANCE_MODE_KEY, mode); } catch {}
    updateUrlParams();
    if (currentResults) {
      runSearch(currentResults.userLat, currentResults.userLon, currentResults.label);
    }
  });
});

// Taille réservoir : persiste + re-render des stations (le bandeau d'économie
// recalcule avec le nouveau volume). Pas besoin de re-fetcher l'API.
if ($tank) {
  $tank.addEventListener('change', () => {
    const v = getTankSize();
    setTankSize(v); // clamp visible immédiat si l'user a tapé 300
    try { localStorage.setItem(TANK_KEY, String(v)); } catch {}
    updateUrlParams();
    if (currentResults) renderStations();
  });
}
