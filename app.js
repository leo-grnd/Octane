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
const $viewList = document.getElementById('viewList');
const $viewMap = document.getElementById('viewMap');

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
const TTL_OSM = 7 * 24 * 60 * 60 * 1000; // marques OSM : très stables

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

// OSM Overpass : récupère toutes les stations essence de la zone avec leur marque
async function fetchOSMFuelStations(lat, lon, radiusKm) {
  // Cache géo arrondi à 0.01° (~1 km) pour partager entre recherches voisines.
  // `v2` = bump de version pour invalider les anciens caches vides.
  const key = `osm:v2:${lat.toFixed(2)}:${lon.toFixed(2)}:${radiusKm}`;
  const cached = cacheGet(localStorage, key, TTL_OSM);
  if (cached && cached.length) return cached; // on ne réutilise PAS un cache vide

  const radiusM = Math.round(radiusKm * 1000 * 1.1);
  const query = `[out:json][timeout:25];(node["amenity"="fuel"](around:${radiusM},${lat},${lon});way["amenity"="fuel"](around:${radiusM},${lat},${lon}););out center tags;`;
  const endpoints = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ];
  for (const ep of endpoints) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(`${ep}?data=${encodeURIComponent(query)}`, { signal: ctrl.signal });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const data = await res.json();
      const out = (data.elements || []).map(e => {
        const elat = e.lat ?? e.center?.lat;
        const elon = e.lon ?? e.center?.lon;
        const t = e.tags || {};
        const brand = t.brand || t.operator || t.name || null;
        return elat != null && elon != null && brand
          ? { lat: elat, lon: elon, brand: brand.trim() }
          : null;
      }).filter(Boolean);
      console.log(`OSM: ${out.length} stations avec marque trouvées via ${ep}`);
      if (out.length) cacheSet(localStorage, key, out); // n'enregistre pas les réponses vides
      return out;
    } catch (err) {
      console.warn('Overpass endpoint failed:', ep, err);
    }
  }
  return [];
}

// Trouve la station OSM la plus proche (< 150 m) d'une station donnée
function findNearestOSMBrand(station, osmStations) {
  if (!osmStations.length || station.lat == null) return null;
  const MAX_KM = 0.15;
  let nearest = null;
  let minDist = Infinity;
  for (const osm of osmStations) {
    const d = haversine(station.lat, station.lon, osm.lat, osm.lon);
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
  const sid = s.id != null ? String(s.id) : '';

  const el = document.createElement('div');
  el.className = 'station';
  el.style.setProperty('--rank-color', color);
  el.style.animationDelay = `${Math.min(i, 8) * 0.04}s`;
  if (sid) el.dataset.stationId = sid;
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
    ${sid ? `<button class="toggle-history" type="button" aria-expanded="false" aria-controls="hist-${sid}" aria-label="Afficher l'évolution du prix sur 12 semaines"><span class="th-label">Historique</span><span class="th-caret" aria-hidden="true">▾</span></button>
    <div class="history-panel hidden" id="hist-${sid}" role="region" aria-label="Évolution du prix"></div>` : ''}
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
    // Lance OSM en parallèle SANS attendre — on rendra dès que les prix arrivent
    const osmPromise = fetchOSMFuelStations(lat, lon, radiusKm);
    const rawStations = await fetchStations(lat, lon, radiusKm, fuelField);
    if (token !== currentSearchToken) return;

    hideStatus();
    $results.classList.remove('hidden');
    $osmHint.classList.remove('hidden');

    currentResults = {
      stations: enrichStations(rawStations, fuelField, lat, lon),
      rawStations,
      fuelField,
      userLat: lat,
      userLon: lon,
      label
    };
    renderStations();
    $results.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Patch des marques OSM dès qu'elles arrivent (souvent + lent)
    osmPromise.then(osm => {
      if (token !== currentSearchToken) return;
      $osmHint.classList.add('hidden');
      if (!osm.length) return;
      let changed = false;
      currentResults.stations.forEach(s => {
        const brand = findNearestOSMBrand({ lat: s.lat, lon: s.lon }, osm);
        if (brand && brand !== s._osmBrand) { s._osmBrand = brand; changed = true; }
      });
      if (changed) renderStations();
    }).catch(() => {
      if (token === currentSearchToken) $osmHint.classList.add('hidden');
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

// ===== Historique des prix (3.2 — sparkline dépliable) =====
const historyCache = {};   // fuelField → { weeks, stations } | null (404)
const historyInflight = {};

async function loadHistory(fuelField) {
  if (fuelField in historyCache) return historyCache[fuelField];
  if (historyInflight[fuelField]) return historyInflight[fuelField];
  historyInflight[fuelField] = (async () => {
    try {
      const res = await fetch(`data/history/${fuelField}.json`, { cache: 'force-cache' });
      if (!res.ok) throw new Error('404');
      const data = await res.json();
      historyCache[fuelField] = data;
      return data;
    } catch {
      historyCache[fuelField] = null;
      return null;
    } finally {
      delete historyInflight[fuelField];
    }
  })();
  return historyInflight[fuelField];
}

function renderSparkline(pricesInMilli, weeks) {
  const W = 260, H = 60, PAD_X = 6, PAD_Y = 10;
  const pts = pricesInMilli
    .map((p, i) => (p != null ? { i, p: p / 1000 } : null))
    .filter(Boolean);
  if (pts.length < 2) {
    return `<div class="hist-empty">Pas assez de données pour tracer une courbe.</div>`;
  }
  const min = Math.min(...pts.map(x => x.p));
  const max = Math.max(...pts.map(x => x.p));
  const avg = pts.reduce((s, x) => s + x.p, 0) / pts.length;
  const range = Math.max(max - min, 0.005);
  const stepX = (W - PAD_X * 2) / Math.max(pricesInMilli.length - 1, 1);
  const coord = (x) => ({
    x: PAD_X + x.i * stepX,
    y: PAD_Y + (H - PAD_Y * 2) * (1 - (x.p - min) / range)
  });
  const line = pts.map(p => {
    const c = coord(p);
    return `${c.x.toFixed(1)},${c.y.toFixed(1)}`;
  }).join(' ');
  const last = coord(pts[pts.length - 1]);
  const first = pts[0].p, now = pts[pts.length - 1].p;
  const delta = now - first;
  const sign = delta > 0.003 ? 'up' : delta < -0.003 ? 'down' : 'flat';
  const arrow = sign === 'up' ? '↗' : sign === 'down' ? '↘' : '→';
  const nbWeeks = pricesInMilli.length;
  const firstWeek = weeks[0] || '';
  const lastWeek = weeks[weeks.length - 1] || '';

  return `
    <svg viewBox="0 0 ${W} ${H}" class="sparkline" role="img" aria-label="Évolution hebdomadaire sur ${nbWeeks} semaines, de ${firstWeek} à ${lastWeek}">
      <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3" fill="currentColor"/>
    </svg>
    <div class="hist-stats">
      <span>min <strong>${min.toFixed(3)} €</strong></span>
      <span>moy <strong>${avg.toFixed(3)} €</strong></span>
      <span>max <strong>${max.toFixed(3)} €</strong></span>
      <span class="hist-trend ${sign}">${arrow} ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} € sur ${nbWeeks} sem.</span>
    </div>
  `;
}

async function expandHistoryPanel(card, btn) {
  const sid = card.dataset.stationId;
  if (!sid) return;
  const panel = card.querySelector('.history-panel');
  if (!panel) return;

  panel.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  btn.querySelector('.th-caret').textContent = '▴';

  if (panel.dataset.loaded) return;
  panel.innerHTML = `<span class="loader-sm" aria-hidden="true"></span>Chargement de l'historique…`;
  panel.dataset.loaded = 'loading';

  const fuelField = currentResults?.fuelField;
  const data = await loadHistory(fuelField);
  if (!data) {
    panel.innerHTML = `<div class="hist-empty">Historique indisponible. Lance le script <code>scripts/build-history.mjs</code> ou attends le prochain rafraîchissement.</div>`;
    panel.dataset.loaded = '1';
    return;
  }
  const prices = data.stations[sid];
  if (!prices) {
    panel.innerHTML = `<div class="hist-empty">Pas d'historique pour cette station dans les 12 dernières semaines.</div>`;
  } else {
    panel.innerHTML = renderSparkline(prices, data.weeks);
  }
  panel.dataset.loaded = '1';
}

function collapseHistoryPanel(card, btn) {
  const panel = card.querySelector('.history-panel');
  if (panel) panel.classList.add('hidden');
  btn.setAttribute('aria-expanded', 'false');
  btn.querySelector('.th-caret').textContent = '▾';
}

$stationList.addEventListener('click', e => {
  const btn = e.target.closest('.toggle-history');
  if (!btn) return;
  const card = btn.closest('.station');
  if (!card) return;
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  if (expanded) collapseHistoryPanel(card, btn);
  else expandHistoryPanel(card, btn);
});

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
  const isMap = view === 'map';
  $stationList.classList.toggle('hidden', isMap);
  $stationMap.classList.toggle('hidden', !isMap);
  $viewList.classList.toggle('active', !isMap);
  $viewMap.classList.toggle('active', isMap);
  $viewList.setAttribute('aria-selected', !isMap);
  $viewMap.setAttribute('aria-selected', isMap);
  if (isMap && currentResults) renderMap(currentResults.stations);
}
$viewList.addEventListener('click', () => setView('list'));
$viewMap.addEventListener('click', () => setView('map'));

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
