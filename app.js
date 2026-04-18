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

function renderStations(stations, fuelField, userLat, userLon) {
  $stationList.innerHTML = '';

  const enriched = stations.map(s => {
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

  const total = enriched.length;

  if (total === 0) {
    $stationList.innerHTML = `<div class="status">Aucune station trouvée avec ce carburant dans ce rayon. Essaie d'élargir.</div>`;
    $resultsCount.textContent = '0 station';
    $resultsTitle.textContent = FUEL_LABELS[fuelField];
    return;
  }

  const majField = fuelField.replace('_prix', '_maj');

  enriched.forEach((s, i) => {
    const color = getColorForRank(i, total);
    const brandName = extractStationName(s);
    const title = brandName || s.adresse || 'Station sans nom';
    const subParts = [];
    if (brandName && s.adresse) subParts.push(s.adresse);
    const cpVille = [s.cp, s.ville].filter(Boolean).join(' ');
    if (cpVille) subParts.push(cpVille);
    const subtitle = subParts.join(' · ');
    const freshness = formatRelativeTime(s[majField]);
    const dirUrl = directionsUrl(s.lat, s.lon, title);

    const el = document.createElement('div');
    el.className = 'station';
    el.style.setProperty('--rank-color', color);
    el.style.animationDelay = `${i * 0.04}s`;
    el.innerHTML = `
      <div class="rank">${String(i + 1).padStart(2, '0')}</div>
      <div class="info">
        <div class="name">${title}</div>
        <div class="addr">${subtitle}</div>
      </div>
      <div class="distance">
        <strong>${s.distance.toFixed(1)} km</strong>
        <span class="dist-label">à vol d'oiseau</span>
        <a class="dir-link" href="${dirUrl}" target="_blank" rel="noopener" aria-label="Itinéraire vers ${title}">Itinéraire ↗</a>
      </div>
      <div class="price">
        ${formatPrice(s.price)}
        <span class="unit">€ / L</span>
        ${freshness ? `<span class="freshness">${freshness}</span>` : ''}
      </div>
    `;
    $stationList.appendChild(el);
  });

  $resultsCount.textContent = `${total} station${total > 1 ? 's' : ''} trouvée${total > 1 ? 's' : ''}`;
  $resultsTitle.textContent = FUEL_LABELS[fuelField];
}

// Token de la recherche en cours (évite les races si on relance avant la fin)
let currentSearchToken = 0;

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
    // Lance OSM en parallèle SANS attendre — on rendra dès que les prix arrivent
    const osmPromise = fetchOSMFuelStations(lat, lon, radiusKm);
    const stations = await fetchStations(lat, lon, radiusKm, fuelField);
    if (token !== currentSearchToken) return;

    hideStatus();
    $results.classList.remove('hidden');
    $osmHint.classList.remove('hidden');
    renderStations(stations, fuelField, lat, lon);
    $results.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Patch des marques OSM dès qu'elles arrivent (souvent + lent)
    osmPromise.then(osm => {
      if (token !== currentSearchToken) return;
      $osmHint.classList.add('hidden');
      if (!osm.length) return;
      let changed = false;
      stations.forEach(s => {
        const { lat: sLat, lon: sLon } = extractCoords(s);
        if (sLat == null) return;
        const brand = findNearestOSMBrand({ lat: sLat, lon: sLon }, osm);
        if (brand && brand !== s._osmBrand) { s._osmBrand = brand; changed = true; }
      });
      if (changed) renderStations(stations, fuelField, lat, lon);
    }).catch(() => {
      if (token === currentSearchToken) $osmHint.classList.add('hidden');
    });
  } catch (err) {
    if (token !== currentSearchToken) return;
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
  updateUrlParams();
  runSearch(lat, lon, label);
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
  if (q.length < 3) { closeSuggestions(); return; }
  debouncedSuggest(q);
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
