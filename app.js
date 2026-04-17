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

// Géocodage via API BAN (gouvernementale, gratuite)
async function geocode(address) {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Erreur géocodage');
  const data = await res.json();
  if (!data.features || data.features.length === 0) {
    throw new Error('Adresse introuvable');
  }
  const [lon, lat] = data.features[0].geometry.coordinates;
  return { lat, lon, label: data.features[0].properties.label };
}

// Appel API prix carburants
async function fetchStations(lat, lon, radiusKm, fuelField) {
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
  return data.results || [];
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

  enriched.forEach((s, i) => {
    const color = getColorForRank(i, total);
    const el = document.createElement('div');
    el.className = 'station';
    el.style.setProperty('--rank-color', color);
    el.style.animationDelay = `${i * 0.04}s`;
    el.innerHTML = `
      <div class="rank">${String(i + 1).padStart(2, '0')}</div>
      <div class="info">
        <div class="name">${s.adresse || 'Station sans nom'}</div>
        <div class="addr">${s.cp || ''} ${s.ville || ''}</div>
      </div>
      <div class="distance">
        <strong>${s.distance.toFixed(1)} km</strong>
        à vol d'oiseau
      </div>
      <div class="price">
        ${formatPrice(s.price)}
        <span class="unit">€ / L</span>
      </div>
    `;
    $stationList.appendChild(el);
  });

  $resultsCount.textContent = `${total} station${total > 1 ? 's' : ''} trouvée${total > 1 ? 's' : ''}`;
  $resultsTitle.textContent = FUEL_LABELS[fuelField];
}

async function runSearch(lat, lon, label) {
  const fuelField = $fuel.value;
  const radiusKm = parseInt($radius.value, 10);

  if (!radiusKm || radiusKm <= 0) {
    showStatus('Rayon invalide', true);
    return;
  }

  try {
    showStatus(`Recherche des stations dans un rayon de ${radiusKm} km autour de ${label}...`);
    const stations = await fetchStations(lat, lon, radiusKm, fuelField);
    hideStatus();
    $results.classList.remove('hidden');
    renderStations(stations, fuelField, lat, lon);
    $results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    showStatus(`Erreur: ${err.message}`, true);
  }
}

$searchBtn.addEventListener('click', async () => {
  const address = $address.value.trim();
  if (!address) {
    showStatus('Entre une adresse ou une ville', true);
    return;
  }
  try {
    showStatus('Localisation de l\'adresse...');
    const { lat, lon, label } = await geocode(address);
    await runSearch(lat, lon, label);
  } catch (err) {
    showStatus(`Erreur: ${err.message}`, true);
  }
});

$address.addEventListener('keydown', e => {
  if (e.key === 'Enter') $searchBtn.click();
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
      await runSearch(lat, lon, 'ta position actuelle');
    },
    (err) => showStatus(`Géoloc refusée: ${err.message}`, true),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});
