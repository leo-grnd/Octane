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
  try { store.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}
const TTL_GEO = 24 * 60 * 60 * 1000;   // adresse → coords stable
const TTL_FUEL = 5 * 60 * 1000;         // prix carburants : changent rarement

// Géocodage via API BAN (gouvernementale, gratuite)
async function geocode(address) {
  const key = `geo:${address.toLowerCase().trim()}`;
  const cached = cacheGet(localStorage, key, TTL_GEO);
  if (cached) return cached;
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=1`;
  const res = await fetch(url);
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

// Appel API prix carburants
async function fetchStations(lat, lon, radiusKm, fuelField) {
  const key = `fuel:${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusKm}:${fuelField}`;
  const cached = cacheGet(sessionStorage, key, TTL_FUEL);
  if (cached) return cached;
  const whereClause = `within_distance(geom, geom'POINT(${lon} ${lat})', ${radiusKm}km) AND ${fuelField} IS NOT NULL`;
  const url = `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records?` +
    `where=${encodeURIComponent(whereClause)}` +
    `&limit=100`;
  const res = await fetch(url);
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

// "il y a 3h", "il y a 2j", "il y a 5 min" — pour l'horodatage de mise à jour
function formatRelativeTime(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (diffMin < 2) return 'à l\'instant';
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `il y a ${diffH} h`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 30) return `il y a ${diffD} j`;
  return `il y a ${Math.round(diffD / 30)} mois`;
}

// URL Google Maps pour itinéraire depuis la position de l'utilisateur
function directionsUrl(lat, lon, label) {
  const dest = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  const q = encodeURIComponent(label || dest);
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&destination_place_id=&travelmode=driving&query=${q}`;
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

function buildStationCard(s, i, total, fuelField) {
  const color = getColorForRank(i, total);
  const brandName = extractStationName(s);
  const title = brandName || s.adresse || 'Station sans nom';
  const subParts = [];
  if (brandName && s.adresse) subParts.push(s.adresse);
  const cpVille = [s.cp, s.ville].filter(Boolean).join(' ');
  if (cpVille) subParts.push(cpVille);
  const subtitle = subParts.join(' · ');
  const majField = fuelField.replace('_prix', '_maj');
  const freshness = formatRelativeTime(s[majField]);
  const dirUrl = directionsUrl(s.lat, s.lon, title);
  const rankLabel = i === 0 ? 'moins cher' : (i === total - 1 && total > 1 ? 'plus cher' : `rang ${i + 1} sur ${total}`);

  const el = document.createElement('div');
  el.className = 'station';
  el.style.setProperty('--rank-color', color);
  el.style.animationDelay = `${Math.min(i, 8) * 0.04}s`;
  el.innerHTML = `
    <div class="rank" aria-hidden="true">${String(i + 1).padStart(2, '0')}</div>
    <span class="sr-only">${rankLabel}. </span>
    <div class="info">
      <div class="name">${title}</div>
      <div class="addr">${subtitle}</div>
    </div>
    <div class="distance">
      <strong>${s.distance.toFixed(1)} km</strong>
      <span class="dist-label">à vol d'oiseau</span>
      <a class="dir-link" href="${dirUrl}" target="_blank" rel="noopener" aria-label="Itinéraire vers ${title} (ouvre Google Maps)">Itinéraire ↗</a>
    </div>
    <div class="price">
      ${formatPrice(s.price)}
      <span class="unit">€ / L</span>
      ${freshness ? `<span class="freshness">Mis à jour ${freshness}</span>` : ''}
    </div>
  `;
  return el;
}

function buildHistoryCard(s, i, total) {
  const color = getColorForRank(i, total);
  const brandName = extractStationName(s);
  const title = brandName || s.adresse || 'Station sans nom';
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
      <div class="name">${title}</div>
      <div class="addr">${subtitle}</div>
    </div>
    <div class="hist-body"><div class="hist-empty"><span class="loader-sm" aria-hidden="true"></span>Chargement de l'historique…</div></div>
  `;
  return el;
}

function renderStations() {
  if (!currentResults) return;
  const { fuelField, stations } = currentResults;
  const total = stations.length;

  $stationList.innerHTML = '';
  $stationList.setAttribute('aria-busy', 'false');
  $resultsTitle.textContent = FUEL_LABELS[fuelField];

  if (total === 0) {
    $stationList.innerHTML = `<div class="status">Aucune station trouvée avec ce carburant dans ce rayon. Essaie d'élargir.</div>`;
    $resultsCount.textContent = '0 station';
    return;
  }

  stations.forEach((s, i) => {
    $stationList.appendChild(buildStationCard(s, i, total, fuelField));
  });
  $resultsCount.textContent = `${total} station${total > 1 ? 's' : ''} trouvée${total > 1 ? 's' : ''}`;

  if (currentView === 'map') {
    renderMap(stations);
  }
}

// Token de la recherche en cours (évite les races si on relance avant la fin)
let currentSearchToken = 0;

function enrichStations(rawStations, fuelField, userLat, userLon) {
  return rawStations.map(s => {
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
}

async function runSearch(lat, lon, label) {
  const fuelField = $fuel.value;
  const radiusKm = parseInt($radius.value, 10);

  if (!radiusKm || radiusKm <= 0) {
    showStatus('Rayon invalide', true);
    return;
  }

  const token = ++currentSearchToken;

  try {
    showStatus(`Recherche des stations dans un rayon de ${radiusKm} km autour de ${label}...`);
    $stationList.setAttribute('aria-busy', 'true');
    // Base de marques shippée statiquement : chargée une fois par session, < 1 s
    // même sur la toute première visite grâce à la taille (~200 Ko gzip).
    const brandsPromise = loadOSMBrands();
    const rawStations = await fetchStations(lat, lon, radiusKm, fuelField);
    if (token !== currentSearchToken) return;

    hideStatus();
    $results.classList.remove('hidden');
    // Si les marques sont déjà en mémoire, on les applique avant le premier render
    if (osmBrandsData && osmBrandsData.grid) {
      // pass: les stations seront enrichies juste en bas
    } else {
      $osmHint.classList.remove('hidden');
    }

    const enriched = enrichStations(rawStations, fuelField, lat, lon);
    currentResults = {
      stations: enriched,
      rawStations,
      fuelField,
      userLat: lat,
      userLon: lon,
      label
    };

    // Applique les marques déjà chargées (cas 2e+ recherche)
    if (osmBrandsData && osmBrandsData.grid) {
      enriched.forEach(s => {
        const b = lookupOSMBrand(s.lat, s.lon, osmBrandsData);
        if (b) s._osmBrand = b;
      });
    }

    renderStations();
    $results.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Pré-chauffe l'historique de chaque station en arrière-plan (pool de 4)
    // pour que l'onglet Historique soit instantané.
    prefetchHistory(enriched, fuelField, () => token === currentSearchToken);

    // Patch des marques quand le JSON finit d'arriver (1re visite uniquement)
    brandsPromise.then(data => {
      if (token !== currentSearchToken) return;
      $osmHint.classList.add('hidden');
      if (data) {
        let changed = false;
        currentResults.stations.forEach(s => {
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
    console.error(err);
    showStatus(`Erreur: ${err.message}`, true);
  }
}

// Sérialise la recherche courante dans l'URL pour partage / reload (sans scroll, sans reload)
function updateUrlParams() {
  const params = new URLSearchParams();
  const q = $address.value.trim();
  if (q) params.set('q', q);
  params.set('fuel', $fuel.value);
  params.set('r', $radius.value);
  const url = `${location.pathname}?${params.toString()}${location.hash}`;
  history.replaceState(null, '', url);
}

async function doAddressSearch() {
  const address = $address.value.trim();
  if (!address) {
    showStatus('Entre une adresse ou une ville', true);
    return;
  }
  updateUrlParams();
  try {
    showStatus('Localisation de l\'adresse...');
    const { lat, lon, label } = await geocode(address);
    pushHistory(address, label);
    await runSearch(lat, lon, label);
  } catch (err) {
    showStatus(`Erreur: ${err.message}`, true);
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
  if (!navigator.geolocation) {
    showStatus('Géolocalisation non supportée par ton navigateur', true);
    return;
  }
  showStatus('Récupération de ta position...');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      $address.value = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      updateUrlParams();
      await runSearch(lat, lon, 'ta position actuelle');
    },
    (err) => showStatus(`Géoloc refusée: ${err.message}`, true),
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

// Mapping entre les champs du flux instantané et les libellés `prix_nom` du j-1.
const FUEL_API_NAMES = {
  gazole_prix: 'Gazole',
  sp95_prix: 'SP95',
  sp95_e10_prix: 'SP95-E10',
  sp98_prix: 'SP98',
  e85_prix: 'E85',
  gplc_prix: 'GPLc'
};

const historyMemCache = {};           // `${id}:${fuel}` → points[] | null
const historyInflight = {};

async function loadStationHistory(stationId, fuelField) {
  if (stationId == null) return null;
  const fuelName = FUEL_API_NAMES[fuelField];
  if (!fuelName) return null;
  const key = `${stationId}:${fuelField}`;
  if (key in historyMemCache) return historyMemCache[key];
  if (historyInflight[key]) return historyInflight[key];

  const storageKey = `hist:${key}`;
  const persisted = cacheGet(localStorage, storageKey, TTL_HISTORY);
  if (persisted) { historyMemCache[key] = persisted; return persisted; }

  historyInflight[key] = (async () => {
    try {
      const where = `id="${stationId}" AND prix_nom="${fuelName}"`;
      const url = `https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/prix-des-carburants-j-1/records?` +
        `where=${encodeURIComponent(where)}` +
        `&order_by=${encodeURIComponent('prix_maj DESC')}` +
        `&select=${encodeURIComponent('prix_maj,prix_valeur')}` +
        `&limit=${HIST_FETCH_LIMIT}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`API j-1: ${res.status}`);
      const data = await res.json();
      const raw = data.results || [];
      // Tri chronologique asc, points valides uniquement, puis dédup consécutif
      // (supprime les répétitions du même prix quand seule l'heure change).
      const sorted = raw.map(r => {
        const ts = r.prix_maj ? Date.parse(r.prix_maj) : NaN;
        const v = r.prix_valeur != null ? Number(r.prix_valeur) : NaN;
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
    } catch {
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
function prefetchHistory(stations, fuelField, tokenCheck) {
  if (!FUEL_API_NAMES[fuelField]) return;
  const ids = stations.map(s => s.id != null ? String(s.id) : null).filter(Boolean);
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      if (tokenCheck && !tokenCheck()) return;
      const id = ids[cursor++];
      await loadStationHistory(id, fuelField);
    }
  };
  for (let w = 0; w < HIST_PREFETCH_CONCURRENCY; w++) worker();
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
  if (!FUEL_API_NAMES[fuelField]) {
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
let mapMarkers = [];
let userMarker = null;

function ensureMap() {
  if (map || typeof L === 'undefined') return map;
  map = L.map($stationMap, { scrollWheelZoom: true, zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(map);
  return map;
}

function renderMap(stations) {
  if (!currentResults) return;
  const m = ensureMap();
  if (!m) return;
  const { userLat, userLon } = currentResults;

  mapMarkers.forEach(mk => m.removeLayer(mk));
  mapMarkers = [];
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
      const marker = L.marker([s.lat, s.lon], { icon }).addTo(m);
      const name = extractStationName(s) || s.adresse || 'Station';
      const addrLine = [s.adresse, s.cp, s.ville].filter(Boolean).join(' · ');
      marker.bindPopup(
        `<strong>${name}</strong><br>` +
        (addrLine ? `<span style="color:#666;font-size:0.75rem">${addrLine}</span><br>` : '') +
        `<b style="color:${color}">${s.price.toFixed(3)} €/L</b> · ${s.distance.toFixed(1)} km`
      );
      mapMarkers.push(marker);
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

// ===== Service Worker (PWA) =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW register failed:', err));
  });
}

// Deep-link : au chargement, si ?q=...&fuel=...&r=... → préremplit et lance la recherche
(function applyUrlParams() {
  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  const fuel = params.get('fuel');
  const r = params.get('r');
  if (fuel && [...$fuel.options].some(o => o.value === fuel)) $fuel.value = fuel;
  if (r && !isNaN(parseInt(r, 10))) $radius.value = r;
  if (q) {
    $address.value = q;
    // Laisse le temps au DOM / cache de s'initialiser avant de lancer
    setTimeout(doAddressSearch, 50);
  }
})();
