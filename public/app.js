// Thème clair / sombre : site.js, commun à toutes les pages.

// Éléments
const $address = document.getElementById('address');
const $fuel = document.getElementById('fuel');
const $radius = document.getElementById('radius');
const $searchBtn = document.getElementById('searchBtn');
const $geolocBtn = document.getElementById('geolocBtn');
const $status = document.getElementById('status');
const $results = document.getElementById('results');
const $resultsTop = document.getElementById('resultsTop');
const $resultsBottom = document.getElementById('resultsBottom');
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
  e10_prix: 'SP95-E10',
  sp95_prix: 'SP95',
  sp98_prix: 'SP98',
  gazole_prix: 'Gazole',
  e85_prix: 'E85',
  gplc_prix: 'GPLc'
};

// Le dataset a renommé `sp95_e10_prix` en `e10_prix` : l'ancien nom renvoie
// désormais un 400 `ODSQLError: Unknown field`. Les liens partagés et les
// recherches sauvegardées d'avant le renommage le contiennent encore, donc on
// les migre à la volée sur chaque point d'entrée hérité (URL, localStorage).
const LEGACY_FUEL_FIELDS = { sp95_e10_prix: 'e10_prix' };
function normalizeFuelField(field) {
  if (!field) return field;
  return LEGACY_FUEL_FIELDS[field] || field;
}

// Échappe une valeur avant de l'injecter dans du HTML. À appliquer à tout ce qui
// vient de l'extérieur : APIs (adresses, villes, libellés BAN), localStorage et
// saisie utilisateur. Les données sont gouvernementales donc le risque
// d'injection est faible, mais une apostrophe dans une adresse — « Avenue de
// l'Opéra » — suffit déjà à casser un attribut title="…" ou data-copy="…".
// L'esperluette doit être remplacée en premier, sinon on double-échappe.
function esc(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// `msg` et `actionLabel` sont du texte brut par contrat — aucun appelant ne
// passe de balise —, donc on échappe ici plutôt qu'à chaque point d'appel.
function showStatus(msg, isError = false) {
  $status.classList.remove('hidden');
  $status.classList.toggle('error', isError);
  $status.innerHTML = isError ? esc(msg) : `<span class="loader"></span>${esc(msg)}`;
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
  $status.innerHTML = `<span>${esc(msg)}</span> <button type="button" class="btn btn-secondary btn-sm status-cta">${esc(actionLabel)}</button>`;
  const btn = $status.querySelector('.status-cta');
  if (btn && onClick) btn.addEventListener('click', onClick, { once: true });
}

// ===== Erreurs réseau lisibles =====
// Les messages bruts (« Failed to fetch », « HTTP 503 », « API carburants:
// 429 ») ne disent rien à l'utilisateur. Le cas qui compte le plus pour un
// lancement public est le 429 : l'API prix limite chaque IP à 50 000 appels
// par jour, et les opérateurs mobiles partagent une même IP entre de nombreux
// abonnés (CGNAT). L'API expose son compteur via CORS, ce qui permet de dire
// précisément quand la recherche refonctionnera.
const SERVICE_NAMES = {
  prix: 'le service officiel des prix',
  adresses: 'le service d’adresses de l’IGN'
};
const RESET_FMT = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

// Erreur HTTP d'une réponse non-ok, déjà formulée pour l'utilisateur. Pas de
// retry sur 429 (fetchWithRetry ne rejoue que les 5xx) : un quota épuisé ne se
// débloquera pas en quelques secondes.
function httpError(res, service) {
  const name = SERVICE_NAMES[service];
  if (res.status === 429) {
    const remaining = res.headers.get('X-RateLimit-Remaining');
    // Format Opendatasoft : « 2026-10-02 00:00:00+00:00 »
    const reset = new Date(String(res.headers.get('X-RateLimit-Reset') || '').replace(' ', 'T'));
    if (remaining === '0' && !isNaN(reset)) {
      return new Error(`${capitalize(name)} limite le nombre de recherches par réseau, et la limite du jour ` +
        `est atteinte pour le tien. Elle se réinitialise à ${RESET_FMT.format(reset)}.`);
    }
    return new Error(`Trop de recherches en peu de temps depuis ton réseau. Réessaie dans quelques minutes.`);
  }
  if (res.status >= 500) {
    return new Error(`${capitalize(name)} est momentanément indisponible (erreur ${res.status}). Réessaie dans un instant.`);
  }
  return new Error(`${capitalize(name)} a refusé la requête (erreur ${res.status}).`);
}

// Traduit une erreur levée pendant un appel réseau. Les messages déjà
// lisibles (httpError, « Adresse introuvable »…) passent tels quels.
function friendlyError(err, service) {
  const name = SERVICE_NAMES[service];
  if (err && err.name === 'AbortError') {
    return `${capitalize(name)} met trop de temps à répondre. Réessaie dans un instant.`;
  }
  // Libellés d'échec réseau de fetch selon le moteur : Chromium, Firefox, WebKit.
  if (err instanceof TypeError && /Failed to fetch|NetworkError|Load failed/i.test(err.message)) {
    return `Impossible de joindre ${name}. Vérifie ta connexion puis réessaie.`;
  }
  // 5xx persistant après les retries de fetchWithRetry
  const http = /^HTTP (\d{3})$/.exec(err && err.message);
  if (http) return `${capitalize(name)} est momentanément indisponible (erreur ${http[1]}). Réessaie dans un instant.`;
  return (err && err.message) || 'Erreur inattendue.';
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

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
    // QuotaExceededError : on purge les entrées les plus vieilles (hist:*, fuel:*,
    // geo:*, drive:*) puis on retente une fois. Sans ça, le cache se bloque
    // silencieusement et toutes les écritures suivantes échouent aussi.
    // Les préfixes sont versionnés (hist2:, drive3:, fuel2:…), d'où le `\d*` :
    // une liste en dur laissait échapper le plus gros poste de cache dès qu'un
    // schéma changeait de version.
    if (err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014)) {
      const victims = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k || !/^(hist\d*:|fuel\d*:|geo\d*:|drive\d*:)/.test(k)) continue;
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

// Géocodage : Base Adresse Nationale, servie par la Géoplateforme de l'IGN.
// L'ancienne adresse `api-adresse.data.gouv.fr` est fermée depuis le 31/01/2026
// (en-têtes `Sunset` / `Deprecation`) ; elle répondait encore mais pouvait
// s'éteindre à tout moment. Même moteur, même format GeoJSON, mêmes scores —
// vérifié requête par requête — donc les entrées de cache restent valables.
const GEOCODER_URL = 'https://data.geopf.fr/geocodage/search';

// `geo2:` = v2 du schéma : la sélection du résultat privilégie la commune.
// Les entrées v1 pointent potentiellement sur le mauvais lieu, on change donc
// de préfixe plutôt que d'attendre 24 h d'expiration.
function geoCacheKey(address) {
  return `geo2:${address.toLowerCase().trim()}`;
}

// BAN classe parfois une VOIE homonyme au-dessus de la commune cherchée, à un
// millième de score près. « Avignon » renvoyait ainsi la rue Avignon de
// Combourg (0,9570) plutôt que la ville d'Avignon (0,9562) — 800 km d'écart.
// Même piège pour « Bourges » (→ Laroque-d'Olmes, Ariège) et « Châteauroux »
// (→ Tonnay-Charente). À score quasi équivalent, on privilégie donc la commune.
// Sans risque pour les recherches d'adresse précise : dès que la requête
// contient une voie ou un numéro, BAN ne remonte aucune commune dans son top 5.
const GEO_MUNICIPALITY_TOLERANCE = 0.02;
function pickBestGeoFeature(features) {
  const top = features[0];
  if (!top) return null;
  if (top.properties && top.properties.type === 'municipality') return top;
  const topScore = (top.properties && top.properties.score) || 0;
  const municipality = features.find(f =>
    f.properties &&
    f.properties.type === 'municipality' &&
    topScore - (f.properties.score || 0) <= GEO_MUNICIPALITY_TOLERANCE
  );
  return municipality || top;
}

async function geocode(address) {
  const key = geoCacheKey(address);
  const cached = cacheGet(localStorage, key, TTL_GEO);
  if (cached) return cached;
  // limit=5 (et non 1) : il faut voir les suivants pour repérer la commune
  // homonyme coiffée au poteau par une voie.
  const url = `${GEOCODER_URL}?q=${encodeURIComponent(address)}&limit=5`;
  const res = await fetchWithRetry(signal => fetch(url, { signal }));
  if (!res.ok) throw httpError(res, 'adresses');
  const data = await res.json();
  const best = pickBestGeoFeature(data.features || []);
  if (!best) throw new Error('Adresse introuvable');
  const [lon, lat] = best.geometry.coordinates;
  const result = { lat, lon, label: best.properties.label };
  cacheSet(localStorage, key, result);
  return result;
}

// Adresse la plus proche d'une position, pour remplir le champ après une
// géolocalisation (« 15 Place de l'Horloge 84000 Avignon » plutôt que des
// coordonnées). Même service que le géocodage ; position arrondie à 4
// décimales (~10 m). Facultatif : null en cas d'échec, l'appelant garde alors
// les coordonnées.
const REVERSE_GEOCODER_URL = 'https://data.geopf.fr/geocodage/reverse';
async function reverseGeocode(lat, lon) {
  try {
    const url = `${REVERSE_GEOCODER_URL}?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&limit=1`;
    const res = await fetchWithRetry(signal => fetch(url, { signal }), { tries: 1, timeoutMs: 4000 });
    if (!res.ok) return null;
    const feature = ((await res.json()).features || [])[0];
    return (feature && feature.properties && feature.properties.label) || null;
  } catch {
    return null;
  }
}

// Historique : `data.economie.gouv.fr` et `public.opendatasoft.com` refusaient
// autrefois les origins non-allowlistées (403 `x-deny-reason: host_not_allowed`),
// ce qui imposait de router leurs appels via un proxy CORS public. Les deux
// portails renvoient désormais `Access-Control-Allow-Origin: *`, donc on tape
// en direct. Le proxy a été retiré : corsproxy.io est passé en freemium (401
// sans clé API) et faisait tomber toute l'app, miroirs compris.

// Retry générique avec backoff exponentiel + timeout global. À utiliser pour
// les APIs publiques sans redondance native (BAN, Opendatasoft).
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

// ===== Appel API prix carburants =====
const STATIONS_PAGE = 100;          // maximum autorisé par l'API Opendatasoft
const MAX_STATIONS = 400;           // au-delà, la liste n'est plus exploitable
const ODS_OFFSET_CEILING = 10000;   // contrainte API : offset + limit <= 10000

// Champs réellement consommés par l'UI. Sans ce `select`, l'API renvoie en plus
// `horaires`, `prix`, `rupture` et `services` (des blobs JSON sérialisés en
// texte) et tout le découpage administratif : 275 Ko par page de 100 stations,
// contre 76 Ko ici. Dérivé de FUEL_LABELS pour rester en phase automatiquement —
// la fiche détail affiche les autres carburants, pas seulement celui recherché.
const STATION_FIELDS = [
  'id', 'cp', 'ville', 'adresse', 'geom',
  ...Object.keys(FUEL_LABELS).flatMap(field => {
    const base = field.replace('_prix', '');
    return [`${base}_prix`, `${base}_maj`, `${base}_rupture_type`];
  })
].join(',');

// Retourne { stations, total, truncated }. `total` = nombre de stations dans le
// rayon côté API, `truncated` = on a dû s'arrêter à MAX_STATIONS.
async function fetchStations(lat, lon, radiusKm, fuelField) {
  // `fuel2:` = v2 du schéma (objet au lieu d'un tableau nu). Les entrées v1
  // seraient mal interprétées ; elles expireront seules grâce au TTL.
  const key = `fuel2:${lat.toFixed(3)}:${lon.toFixed(3)}:${radiusKm}:${fuelField}`;
  const cached = cacheGet(sessionStorage, key, TTL_FUEL);
  if (cached) return cached;
  const whereClause = `within_distance(geom, geom'POINT(${lon} ${lat})', ${radiusKm}km) AND ${fuelField} IS NOT NULL`;
  const base = `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records?` +
    `where=${encodeURIComponent(whereClause)}` +
    `&select=${encodeURIComponent(STATION_FIELDS)}` +
    // Tri serveur par prix croissant : si le rayon dépasse MAX_STATIONS, on
    // tronque les stations les PLUS CHÈRES, pas un échantillon au hasard — le
    // classement du moins cher reste donc exact. `id` départage les ex æquo,
    // sans quoi la pagination pourrait dupliquer ou sauter des lignes.
    `&order_by=${encodeURIComponent(`${fuelField},id`)}`;

  const fetchPage = async (offset) => {
    const url = `${base}&limit=${STATIONS_PAGE}&offset=${offset}`;
    const res = await fetchWithRetry(signal => fetch(url, { signal }));
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`API carburants ${res.status} :`, body);
      throw httpError(res, 'prix');
    }
    return res.json();
  };

  // `limit` est plafonné à 100 côté API. Sans pagination, une recherche à 50 km
  // autour de Paris (754 stations) n'en remontait que 100.
  const first = await fetchPage(0);
  const results = (first.results || []).slice();
  const total = first.total_count || results.length;
  const pageCount = Math.min(
    Math.ceil(Math.min(total, MAX_STATIONS) / STATIONS_PAGE),
    Math.floor(ODS_OFFSET_CEILING / STATIONS_PAGE)
  );
  if (pageCount > 1) {
    const rest = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, i) => fetchPage((i + 1) * STATIONS_PAGE))
    );
    rest.forEach(p => results.push(...(p.results || [])));
  }
  const stations = results.slice(0, MAX_STATIONS);
  const payload = { stations, total, truncated: total > stations.length };
  cacheSet(sessionStorage, key, payload);
  return payload;
}

// ===== Routage routier (Valhalla primaire + OSRM fallback) =====
// Opendatasoft ne filtre qu'en haversine, donc pour le mode "voiture" on
// surfetch puis on mesure la distance routière via une matrice 1 origine × N.
// Valhalla (FOSSGIS) en primaire : costing plus nuancé qu'OSRM, respecte mieux
// les restrictions de virages et les classes de routes, donc précision > OSRM
// sur le terrain urbain. OSRM reste en fallback si Valhalla flanche.
// L'API est servie par `valhalla1.openstreetmap.de` (100 lieux max par matrice,
// d'où les lots de ROUTING_BATCH_MAX). `valhalla.openstreetmap.de` n'héberge
// plus que l'interface web de démonstration : interrogé là, `/sources_to_targets`
// renvoyait une page HTML sans en-tête CORS, et chaque matrice échouait en
// silence — le mode voiture ne tenait plus que sur OSRM.
const VALHALLA_ENDPOINT = 'https://valhalla1.openstreetmap.de';
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

// Pas de requête Overpass au runtime : un ancien fallback interrogeait les
// instances publiques à chaque recherche où une enseigne manquait. Leurs
// politiques d'usage proscrivent ce trafic dès qu'il devient massif, et une
// station sans enseigne garde de toute façon un affichage complet (adresse,
// ville). La base mensuelle et les regex sur les libellés suffisent.

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
  // Fallback : initiale du 1er mot signifiant, sur la pastille neutre
  const word = name.trim().split(/\s+/).find(w => /[a-z]/i.test(w));
  if (!word) return null;
  return { mono: word[0].toUpperCase(), neutral: true };
}

// Pastille d'enseigne. Les couleurs de marque passent en style en ligne : ce
// sont celles des enseignes, pas du design system. Enseigne inconnue ou prix
// périmé (`neutral`) : pastille neutre, aux couleurs du thème.
function brandBadgeHtml(brandName, { neutral = false } = {}) {
  const badge = getBrandBadge(brandName);
  const mono = esc(badge ? badge.mono : '—');
  if (!badge || badge.neutral || neutral) {
    return `<span class="brand-badge brand-badge-neutral" aria-hidden="true">${mono}</span>`;
  }
  return `<span class="brand-badge" style="background:${badge.bg};color:${badge.fg}" aria-hidden="true">${mono}</span>`;
}

// Icônes de l'interface (jeu Lucide, comme la maquette), tracées en
// currentColor : elles prennent la couleur du texte qu'elles accompagnent.
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  trendDown: '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
  trendUp: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  trendFlat: '<path d="M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
};
function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
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

// Couleur du rang (onglet Historique) : la maquette ne distingue que la
// station la moins chère, en accent ; les autres rangs restent discrets.
function getColorForRank(rank) {
  return rank === 0 ? 'var(--o-accent)' : 'var(--o-faint)';
}

function formatPrice(price) {
  const [euros, cents = '000'] = price.toFixed(3).split('.');
  return `${euros}<span class="cents">,${cents}</span> €`;
}

// Un prix non redéclaré depuis plus de STALE_DAYS jours sort du classement :
// il reste visible, en fin de tableau, mais ne peut plus être désigné « le
// moins cher ». Sans cette règle, le bloc gagnant de Paris (5 km) affichait au
// 01/10/2026 un gazole à 2,200 € relevé 184 jours plus tôt, devant des prix du
// jour à 2,250 € — typiquement une station qui ne déclare plus. 7 jours plutôt
// que les 3 des alertes email : une station au prix inchangé peut légitimement
// ne rien déclarer pendant quelques jours.
const STALE_DAYS = 7;

function isStalePrice(s, fuelField) {
  const t = new Date(s[fuelField.replace('_prix', '_maj')]).getTime();
  return !Number.isFinite(t) || Date.now() - t > STALE_DAYS * 864e5;
}

// Ordre du classement : prix actualisés d'abord, chaque groupe trié par prix.
// Les stations périmées se retrouvent donc toujours en queue de liste.
// À prix égal (au millième, la précision des relevés — ex. un prix national
// commun à toute une enseigne), la plus proche passe devant : distance par la
// route quand elle est connue, sinon à vol d'oiseau.
function compareStations(a, b) {
  return (a._stale - b._stale)
    || (Math.round(a.price * 1000) - Math.round(b.price * 1000))
    || (stationKm(a) - stationKm(b));
}

function stationKm(s) {
  return s.driveKm ?? s.distance ?? Infinity;
}

// "il y a 3h", "il y a 2j", "il y a 5 min" — pour l'horodatage de mise à jour.
// Retourne { text, tier } pour permettre une coloration selon la fraîcheur :
//   fresh = < 48 h (chip neutre, opacité faible)
//   stale = 48 h–7 j (chip orange, attention douce)
//   veryStale = > 7 j (chip rouge, hors classement — voir STALE_DAYS)
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
  const tier = diffD > STALE_DAYS ? 'veryStale' : diffD > 2 ? 'stale' : 'fresh';
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
  const deltaCt = Math.round(deltaEur * 1000) / 10; // centimes, au dixième
  // Moins d'un demi-centime d'écart : on parle de stabilité.
  const sign = deltaCt <= -0.5 ? 'down' : deltaCt >= 0.5 ? 'up' : 'flat';
  const arrow = sign === 'down' ? '↘' : sign === 'up' ? '↗' : '→';
  return { sign, arrow, deltaCt };
}

// « −1,8 ct/L vs moyenne 7 jours », avec un vrai signe moins.
function formatTrend(trend) {
  if (trend.sign === 'flat') return 'stable sur 7 jours';
  const value = Math.abs(trend.deltaCt).toFixed(1).replace('.', ',');
  return `${trend.deltaCt > 0 ? '+' : '−'}${value} ct/L vs moyenne 7 jours`;
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
    // Migration du carburant : une recherche enregistrée avant le renommage
    // `sp95_e10_prix` → `e10_prix` ferait échouer la reprise en un clic.
    data.fuel = normalizeFuelField(data.fuel);
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

// Données d'affichage communes au bloc gagnant et aux lignes du tableau.
function stationView(s, fuelField) {
  const brandName = extractStationName(s);
  const title = brandName || s.adresse || 'Station sans nom';
  const cpVille = [s.cp, s.ville].filter(Boolean).join(' ');
  const subParts = [];
  if (brandName && s.adresse) subParts.push(s.adresse);
  if (cpVille) subParts.push(cpVille);
  return {
    brandName,
    title,
    subtitle: subParts.join(' · '),
    cpVille,
    freshness: formatRelativeTime(s[fuelField.replace('_prix', '_maj')]),
    distKm: s.driveKm != null ? s.driveKm : s.distance,
    byRoad: s.driveKm != null,
    dirUrl: directionsUrl(s.lat, s.lon, title)
  };
}

const km1 = (v) => `${v.toFixed(1).replace('.', ',')} km`;
const eur2 = (v) => `${v.toFixed(2).replace('.', ',')} €`;

// Bloc « Le moins cher » : l'objet de la page, traité à l'échelle qu'il mérite.
// Le prix est posé en clamp(64px, 13vw, 112px) comme dans la maquette — c'est
// l'information qu'on vient chercher, tout le reste la commente.
const TREND_ICONS = { down: 'trendDown', up: 'trendUp', flat: 'trendFlat' };
function buildWinnerBlock(s, fuelField) {
  const v = stationView(s, fuelField);
  const trend = s.id != null ? getStationTrend(String(s.id), fuelField, s.price) : null;
  const [euros, cents] = s.price.toFixed(3).split('.');

  const el = document.createElement('article');
  el.className = 'winner';
  el.innerHTML = `
    <div class="winner-main">
      <span class="winner-tag">${icon('check')}Le moins cher</span>
      <div class="winner-price">${euros},${cents}<span class="winner-unit">€ / L</span></div>
      ${trend ? `<div class="winner-trend trend-${trend.sign}">${icon(TREND_ICONS[trend.sign])}${esc(formatTrend(trend))}</div>` : ''}
    </div>
    <div class="winner-info">
      <div class="winner-title">${brandBadgeHtml(v.brandName)}<h3 class="winner-name">${esc(v.title)}</h3></div>
      <div class="winner-addr">${esc(v.subtitle)}</div>
      <div class="winner-facts">
        <span><span class="winner-num">${v.distKm != null ? esc(km1(v.distKm)) : '—'}</span> ${v.byRoad ? 'par la route' : 'à vol d’oiseau'}</span>
        ${s.driveMin != null ? `<span><span class="winner-num">${s.driveMin}</span> min</span>` : ''}
        ${v.freshness ? `<span class="winner-fresh freshness-${v.freshness.tier}">${icon('clock')}relevé ${esc(v.freshness.text)}</span>` : ''}
      </div>
      ${s._outlier ? `<div class="winner-warn">${icon('alert')}Prix qui s’écarte de ${Math.round(s._outlier.ratio * 100)} % de la médiane locale — à vérifier sur place.</div>` : ''}
      <div class="winner-actions">
        <a class="btn btn-primary" href="${esc(v.dirUrl)}" target="_blank" rel="noopener">${icon('navigation')}Itinéraire</a>
        <button type="button" class="btn btn-secondary" data-show-map>Voir sur la carte</button>
        <button type="button" class="btn btn-secondary" data-station-idx="0">Détails</button>
      </div>
    </div>
  `;
  return el;
}

// Une ligne du tableau : rang, station, distance, prix et surcoût sur un plein.
// Services, tendance et autres carburants sont dans la fiche détail, qui
// s'ouvre au clic sur la ligne. Sur téléphone, la même ligne se replie en
// deux étages (voir style.css) : la distance passe sous le nom, avec le temps
// de trajet et la ville (`station-sub-phone`), et le surcoût sous le prix.
// `refStation` (la moins chère actualisée) peut être null quand aucune station
// du rayon n'a de prix récent. Une ligne périmée n'a ni rang ni surcoût : la
// comparer au gagnant serait affirmer un écart qui n'existe peut-être plus.
function buildStationRow(s, i, fuelField, refStation) {
  const v = stationView(s, fuelField);
  const extra = refStation && !s._stale ? (s.price - refStation.price) * getTankSize() : 0;
  const dist = v.distKm != null ? km1(v.distKm) : '—';
  const phoneSub = [dist, s.driveMin != null ? `${s.driveMin} min` : null, v.cpVille].filter(Boolean).join(' · ');

  const tr = document.createElement('tr');
  tr.className = s._stale ? 'station-row is-stale' : 'station-row';
  tr.dataset.stationIdx = String(i);
  tr.setAttribute('tabindex', '0');
  tr.setAttribute('role', 'button');
  tr.setAttribute('aria-label', `Voir les détails de ${v.title}, ${s.price.toFixed(3)} euros par litre` +
    (s._stale && v.freshness ? `, prix relevé ${v.freshness.text}` : ''));
  tr.innerHTML = `
    <td class="col-rank">${s._stale ? '—' : String(i + 1).padStart(2, '0')}</td>
    <td class="col-station">
      <div class="station-id">
        ${brandBadgeHtml(v.brandName, { neutral: s._stale })}
        <span class="station-name">${esc(v.title)}${s._outlier ? `<span class="row-warn" title="Prix qui s’écarte fortement de la médiane locale — à vérifier sur place.">${icon('alert')}</span>` : ''}</span>
        ${s._stale
          ? `<span class="station-sub station-stale">Relevé ${v.freshness ? esc(v.freshness.text) : 'à une date inconnue'}</span>`
          : `<span class="station-sub station-sub-wide">${esc(v.subtitle)}</span><span class="station-sub station-sub-phone">${esc(phoneSub)}</span>`}
      </div>
    </td>
    <td class="col-dist">${esc(dist)}${s.driveMin != null ? `<span class="col-eta">${s.driveMin} min</span>` : ''}</td>
    <td class="col-price">${s.price.toFixed(3).replace('.', ',')}</td>
    <td class="col-extra">${extra >= 0.005 ? `+${esc(eur2(extra))}` : '—'}</td>
  `;
  return tr;
}

// Intercalaire entre le classement et les prix périmés, dans le tableau même :
// la frontière se lit sans quitter la liste des yeux.
function buildStaleSeparator(count) {
  const tr = document.createElement('tr');
  tr.className = 'stale-sep';
  tr.innerHTML = `<td colspan="5">${icon('info')}Hors classement · ${count} prix non actualisé${count > 1 ? 's' : ''} depuis plus de ${STALE_DAYS} jours</td>`;
  return tr;
}

function buildHistoryCard(s, i, total) {
  const color = getColorForRank(s._stale ? -1 : i, total);
  const brandName = extractStationName(s);
  const title = brandName || s.adresse || 'Station sans nom';
  const badgeHtml = brandBadgeHtml(brandName, { neutral: s._stale });
  const subParts = [];
  if (brandName && s.adresse) subParts.push(s.adresse);
  const cpVille = [s.cp, s.ville].filter(Boolean).join(' ');
  if (cpVille) subParts.push(cpVille);
  const subtitle = subParts.join(' · ');

  const el = document.createElement('div');
  el.className = 'history-card';
  el.style.setProperty('--rank-color', color);
  el.innerHTML = `
    <div class="rank" aria-hidden="true">${s._stale ? '—' : String(i + 1).padStart(2, '0')}</div>
    <div class="info">
      <div class="name">${badgeHtml}<span class="name-text">${esc(title)}</span></div>
      <div class="addr">${esc(subtitle)}</div>
    </div>
    <div class="hist-body"><div class="hist-empty"><span class="loader-sm" aria-hidden="true"></span>Chargement de l'historique…</div></div>
  `;
  return el;
}

// Bloc d'écart, en pleine largeur sur fond d'accent. Placé en bas des
// résultats, après le panneau de l'onglet : moins important que le gagnant et
// la liste. Seulement si l'écart dépasse 1 ct/L, sinon il n'y a rien à dire.
function buildSavingsBanner(stations) {
  if (!stations || stations.length < 2) return null;
  const delta = stations[stations.length - 1].price - stations[0].price;
  if (delta < 0.01) return null;
  const tankSize = getTankSize();
  const el = document.createElement('section');
  el.className = 'savings';
  el.innerHTML = `
    <div class="savings-kicker">Écart dans ton rayon</div>
    <div class="savings-line">${eur2(delta * tankSize)} d’écart sur un plein de ${tankSize} litres.</div>
  `;
  return el;
}

// Squelette de la maquette : la ligne de méta, puis le bloc gagnant (pastille,
// prix, nom, adresse, bouton). Il occupe la place du résultat final, qui
// s'affiche donc sans saut de mise en page.
function renderSkeletons() {
  $stationList.setAttribute('aria-busy', 'true');
  $results.classList.remove('hidden');
  $results.classList.add('is-loading');
  $resultsTitle.innerHTML = '<span class="sk sk-meta"></span>';
  $resultsCount.textContent = '';
  $resultsTop.innerHTML = `
    <div class="winner winner-skeleton" aria-hidden="true">
      <div class="winner-main"><div class="sk sk-tag"></div><div class="sk sk-price"></div></div>
      <div class="winner-info"><div class="sk sk-name"></div><div class="sk sk-addr"></div><div class="sk sk-btn"></div></div>
    </div>
  `;
  $resultsBottom.innerHTML = '';
  $stationList.innerHTML = '';
}

// Lieu affiché dans la ligne de méta : la commune seule, comme la maquette
// (« GAZOLE · AVIGNON · 5 KM »), y compris quand la recherche part d'une
// adresse précise (« 15 Place de l'Horloge 84000 Avignon » → « Avignon »).
function placeName(label) {
  const m = /\b\d{5}\s+(.+)$/.exec(label || '');
  return m ? m[1] : label;
}

// Nombre de lignes affichées avant le bouton « Afficher les N autres ». Au-delà,
// le tableau devient un mur : la maquette coupe volontairement.
const ROWS_VISIBLE = 12;
let rowsExpanded = false;

function renderStations() {
  if (!currentResults) return;
  const { fuelField, stations } = currentResults;
  const total = stations.length;

  $results.classList.remove('is-loading');
  $resultsTop.innerHTML = '';
  $resultsBottom.innerHTML = '';
  $stationList.innerHTML = '';
  $stationList.setAttribute('aria-busy', 'false');
  // Ligne de méta unique, comme la maquette : carburant, lieu, rayon, effectif.
  // Elle remplace le couple titre + compteur, qui disait deux fois la même
  // chose sur deux lignes.
  $resultsTitle.textContent = [
    FUEL_LABELS[fuelField],
    placeName(currentResults.label),
    `${currentResults.radiusKm || parseInt($radius.value, 10) || 5} km`,
    `${total} station${total > 1 ? 's' : ''}`
  ].join(' · ');

  if (total === 0) {
    const node = document.createElement('div');
    node.className = 'notice';
    const currentR = currentResults.radiusKm || parseInt($radius.value, 10) || 5;
    const nextR = Math.min(50, currentR * 2);
    if (nextR > currentR) {
      node.innerHTML = `${icon('info')}<p>Aucune station avec ce carburant dans un rayon de ${currentR} km.</p>
        <button type="button" class="btn btn-primary btn-sm">Élargir à ${nextR} km</button>`;
      node.querySelector('button').addEventListener('click', () => {
        $radius.value = String(nextR);
        doAddressSearch();
      }, { once: true });
    } else {
      node.innerHTML = `${icon('info')}<p>Aucune station avec ce carburant dans un rayon de ${currentR} km. Essaie un autre carburant ou une autre zone.</p>`;
    }
    $resultsTop.appendChild(node);
    $resultsCount.textContent = '';
    return;
  }

  // Les stations périmées sont triées en queue (compareStations) : le gagnant
  // est donc la première station, à condition qu'elle soit actualisée.
  const fresh = stations.filter(s => !s._stale);
  const staleCount = total - fresh.length;
  const refStation = fresh.length ? stations[0] : null;

  if (refStation) {
    $resultsTop.appendChild(buildWinnerBlock(refStation, fuelField));
  } else {
    const note = document.createElement('div');
    note.className = 'notice';
    note.innerHTML = `${icon('info')}<p>Aucune station de ce rayon n’a déclaré de prix ${esc(FUEL_LABELS[fuelField])} ces ` +
      `${STALE_DAYS} derniers jours. Voici les derniers prix connus, sans classement : vérifie-les sur place.</p>`;
    $resultsTop.appendChild(note);
  }

  // L'écart ne se calcule qu'entre prix actualisés : un vieux prix bas ou haut
  // gonflerait un écart qui n'existe plus à la pompe.
  const savings = buildSavingsBanner(fresh);
  if (savings) $resultsBottom.appendChild(savings);

  const rest = refStation ? stations.slice(1) : stations;
  const offset = refStation ? 1 : 0; // index de `rest[0]` dans `stations`
  if (rest.length) {
    const shown = rowsExpanded ? rest.length : Math.min(rest.length, ROWS_VISIBLE);
    const card = document.createElement('div');
    card.className = 'list-card';
    const table = document.createElement('table');
    table.className = 'station-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th class="col-rank">Nº</th>
          <th class="col-station">Station</th>
          <th class="col-dist">Distance</th>
          <th class="col-price">Prix</th>
          <th class="col-extra">Sur un plein</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    rest.slice(0, shown).forEach((s, i) => {
      // L'intercalaire ne sert que s'il sépare quelque chose : quand tout est
      // périmé, la note au-dessus du tableau le dit déjà.
      if (s._stale && refStation && (i === 0 || !rest[i - 1]._stale)) {
        tbody.appendChild(buildStaleSeparator(staleCount));
      }
      tbody.appendChild(buildStationRow(s, i + offset, fuelField, refStation));
    });
    card.appendChild(table);

    if (rest.length > shown) {
      const foot = document.createElement('div');
      foot.className = 'list-more';
      foot.innerHTML = `<button type="button" class="btn btn-secondary btn-sm">Afficher les ${rest.length - shown} autres stations</button>`;
      foot.querySelector('button').addEventListener('click', () => { rowsExpanded = true; renderStations(); });
      card.appendChild(foot);
    }
    $stationList.appendChild(card);
  }

  // Troncature : on ne prétend pas afficher un classement exhaustif quand le
  // rayon contient plus de stations qu'on n'en charge.
  if (currentResults.truncated) {
    $resultsCount.textContent = `${MAX_STATIONS} chargées sur ${currentResults.totalInRadius}`;
    $resultsCount.title =
      `Ce rayon contient ${currentResults.totalInRadius} stations ; Octane en charge ${MAX_STATIONS} au maximum, ` +
      `en partant des moins chères. Réduis le rayon pour un classement exhaustif.`;
  } else {
    $resultsCount.textContent = '';
    $resultsCount.removeAttribute('title');
  }

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
      price: parseFloat(s[fuelField]),
      _stale: isStalePrice(s, fuelField)
    };
  }).filter(s => s.lat != null && s.lon != null && !isNaN(s.price) && s.price > 0)
    .sort(compareStations);

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
  // Même ordre que le premier rendu : actualisées d'abord, puis par prix.
  currentResults.stations = kept.sort(compareStations);
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
  setCtaLoading(true);
  rowsExpanded = false; // toute nouvelle recherche repart sur un tableau replié
  // En mode voiture, on sur-fetch en vol d'oiseau pour ne pas manquer de
  // stations accessibles qui sont au-delà du cercle haversine.
  const fetchRadiusKm = distanceMode === 'drive'
    ? Math.min(50, Math.ceil(radiusKm * DRIVE_INFLATE + DRIVE_SAFETY_KM))
    : radiusKm;

  try {
    showStatus(`Recherche des stations dans un rayon de ${radiusKm} km autour de ${label}...`);
    renderSkeletons();
    // Base de marques shippée statiquement : chargée une fois par session, < 1 s
    // même sur la toute première visite grâce à la taille (~200 Ko gzip).
    const brandsPromise = loadOSMBrands();
    const { stations: rawStations, total: totalInRadius, truncated } =
      await fetchStations(lat, lon, fetchRadiusKm, fuelField);
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
      radiusKm,
      totalInRadius,
      truncated
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
    });
  } catch (err) {
    if (token !== currentSearchToken) return;
    // Rien à montrer : le squelette disparaît avec la section, la barre d'état
    // porte l'erreur et le bouton de rattrapage.
    $stationList.setAttribute('aria-busy', 'false');
    $stationList.innerHTML = '';
    $resultsTop.innerHTML = '';
    $resultsBottom.innerHTML = '';
    $results.classList.remove('is-loading');
    $results.classList.add('hidden');
    console.error(err);
    showStatusAction(
      friendlyError(err, 'prix'),
      'Réessayer',
      () => { hideStatus(); runSearch(lat, lon, label); }
    );
  } finally {
    // Une recherche plus récente a repris le bouton à son compte ; pendant un
    // géocodage en cours (searchBusy), il reste en « Recherche… ».
    if (token === currentSearchToken) setCtaLoading(searchBusy);
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
  setCtaLoading(busy);
}

// Bouton Chercher en « Recherche… » avec sa roue, quel que soit le point
// d'entrée de la recherche (bouton, suggestion, reprise, changement de mode).
// Le CSS bascule libellé et icône sur aria-busy.
function setCtaLoading(on) {
  $searchBtn.setAttribute('aria-busy', String(on));
}

async function doAddressSearch() {
  if (searchBusy) return;
  const address = $address.value.trim();
  // Le géocodeur refuse les requêtes de moins de 3 caractères (400) ; les
  // communes à nom très court (Eu, Ay, Y…) passent avec leur code postal.
  if (!address || address.length < 3) {
    showStatus('Entre au moins 3 caractères (pour une commune très courte, ajoute son code postal : « Eu 76260 »)', true);
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
      friendlyError(err, 'adresses'),
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
    const url = `${GEOCODER_URL}?q=${encodeURIComponent(q)}&limit=6&autocomplete=1`;
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
    return `<li role="option" data-idx="${i}" aria-selected="false">${esc(label)}<span class="sg-ctx">${esc(context)}</span></li>`;
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
  cacheSet(localStorage, geoCacheKey(label), { lat, lon, label });
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
      `<li role="option" class="sg-hist-item" data-idx="${i}" aria-selected="false">${esc(h.label)}</li>`
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

// Bouton de géolocalisation : trois états, comme la maquette. Une fois la
// position utilisée, la seconde ligne montre l'adresse retrouvée ; retaper
// une adresse le ramène au repos.
const $geoLabel = $geolocBtn.querySelector('.geo-label');
const $geoSub = $geolocBtn.querySelector('.geo-sub');
const GEO_TEXT = {
  idle: ['Utiliser ma position actuelle', 'Remplit l’adresse automatiquement'],
  busy: ['Localisation en cours…', 'Autorise l’accès à ta position'],
  done: ['Position actuelle utilisée', 'Coordonnées GPS']
};
function setGeoState(state, sub) {
  $geoLabel.textContent = GEO_TEXT[state][0];
  $geoSub.textContent = sub || GEO_TEXT[state][1];
  $geolocBtn.classList.toggle('is-done', state === 'done');
}
$address.addEventListener('input', () => {
  if ($geolocBtn.classList.contains('is-done')) setGeoState('idle');
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
  setGeoState('busy');
  showStatus('Récupération de ta position...');
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lon } = pos.coords;
      const address = await reverseGeocode(lat, lon);
      $address.value = address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      setGeoState('done', address);
      // Relancer « Chercher » sur cette adresse ne coûte pas de nouvel appel,
      // et retombe sur la position exacte plutôt que sur le numéro de rue.
      if (address) cacheSet(localStorage, geoCacheKey(address), { lat, lon, label: address });
      updateUrlParams();
      try { await runSearch(lat, lon, address || 'ta position actuelle'); }
      finally { setSearchBusy(false); }
    },
    (err) => {
      setGeoState('idle');
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
// Pour chaque station, on trace l'évolution du prix sur les 100 derniers jours
// via le dataset public `prix-des-carburants-j-1` (12 mois glissants). Cache
// mémoire + localStorage (TTL 24h) + dédup des requêtes en vol. Aucun fichier
// généré : tout est calculé à la volée côté client, et pré-chargé en arrière-plan
// dès qu'une recherche retourne des résultats.

const TTL_HISTORY = 24 * 60 * 60 * 1000;
const HIST_DAYS = 100;                // fenêtre réellement couverte, en JOURS
const HIST_PAGE = 100;                // maximum autorisé par l'API Opendatasoft
const HIST_MAX_PAGES = 3;             // 300 relevés : tient 100 j même à 3 relevés/jour
const HIST_KEEP = 150;                // plafond de points stockés (garde-fou localStorage)
const HIST_PREFETCH_CONCURRENCY = 4;

// Dataset `prix-des-carburants-j-1` (public.opendatasoft.com, 12 mois glissants).
// Schéma confirmé : champs plats `price_gazole`, `price_sp95`, `price_sp98`,
// `price_gplc`, `price_e10`, `price_e85` (préfixe `price_`, pas `prix_`).
// Timestamp ligne = `update`. 1 ligne par station par jour.
const HIST_FUELS = new Set([
  'gazole_prix', 'sp95_prix', 'e10_prix', 'sp98_prix', 'e85_prix', 'gplc_prix'
]);
const HIST_FUEL_COL = {
  gazole_prix: 'price_gazole',
  sp95_prix: 'price_sp95',
  e10_prix: 'price_e10',
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

  // `hist2:` = v2 du schéma : fenêtre bornée en jours + queue plate conservée.
  // Les entrées v1 sont ignorées pour forcer un recalcul ; elles expireront
  // seules grâce au TTL.
  const storageKey = `hist2:${key}`;
  const persisted = cacheGet(localStorage, storageKey, TTL_HISTORY);
  if (persisted) { historyMemCache[key] = persisted; return persisted; }

  historyInflight[key] = (async () => {
    try {
      const col = HIST_FUEL_COL[fuelField];
      // Fenêtre bornée dans le TEMPS, pas en nombre de lignes. Le dataset a en
      // principe 1 ligne par station par jour, mais il monte parfois à 4 : un
      // `limit=100` sec ne couvrait donc pas 100 jours, mais parfois 25.
      // On exige aussi un prix non-null pour ce carburant, sinon on récupère
      // des lignes inutiles pour les stations multi-carburants.
      const where = `id="${stationId}" AND ${col} IS NOT NULL AND update >= now(days=-${HIST_DAYS})`;
      const fetchPage = async (offset) => {
        const url = `https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/prix-des-carburants-j-1/records?` +
          `where=${encodeURIComponent(where)}` +
          `&order_by=${encodeURIComponent('update desc')}` +
          `&select=${encodeURIComponent(`update,${col}`)}` +
          `&limit=${HIST_PAGE}&offset=${offset}`;
        const res = await fetchWithRetry(signal => fetch(url, { signal }));
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`API j-1: ${res.status} — ${body.slice(0, 200)}`);
        }
        return res.json();
      };

      // `limit` est plafonné à 100 côté API : on pagine tant qu'il reste des
      // relevés dans la fenêtre. La 1re page donne `total_count`, donc on sait
      // exactement combien de pages tirer — et la plupart des stations tiennent
      // en une seule.
      const first = await fetchPage(0);
      const raw = (first.results || []).slice();
      const pages = Math.min(
        Math.ceil((first.total_count || raw.length) / HIST_PAGE),
        HIST_MAX_PAGES
      );
      if (pages > 1) {
        const rest = await Promise.all(
          Array.from({ length: pages - 1 }, (_, i) => fetchPage((i + 1) * HIST_PAGE))
        );
        rest.forEach(p => raw.push(...(p.results || [])));
      }
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
      // La dédup supprime les doublons consécutifs, donc la série s'arrête à la
      // dernière *variation* de prix — souvent des semaines en arrière, une
      // station pouvant garder le même prix 2 mois. La courbe semblait alors
      // s'interrompre dans le passé et l'axe des dates devenait mensonger. On
      // ré-ancre donc le dernier point sur le relevé le plus récent : le palier
      // final est tracé jusqu'à aujourd'hui, ce qui est la réalité.
      const latest = sorted[sorted.length - 1];
      const lastKept = dedup[dedup.length - 1];
      if (latest && lastKept && latest[0] !== lastKept[0]) dedup.push(latest);
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
  const eur3 = (v) => `${v.toFixed(3).replace('.', ',')} €`;

  return `
    <svg viewBox="0 0 ${W} ${H}" class="sparkline" role="img" aria-label="Évolution de prix sur ${points.length} relevés, du ${firstDate} au ${lastDate}">
      <polyline points="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3" fill="currentColor"/>
    </svg>
    <div class="hist-stats">
      <span>min <strong>${eur3(min)}</strong></span>
      <span>moy <strong>${eur3(avg)}</strong></span>
      <span>max <strong>${eur3(max)}</strong></span>
      <span class="hist-trend ${sign}">${arrow} ${delta >= 0 ? '+' : '−'}${eur3(Math.abs(delta))} · ${firstDate} → ${lastDate}</span>
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
    $historyList.innerHTML = `<div class="hist-note">${icon('info')}Aucune station dans les résultats.</div>`;
    return;
  }
  if (!HIST_FUELS.has(fuelField)) {
    $historyList.innerHTML = `<div class="hist-note">${icon('info')}Historique non disponible pour ce carburant.</div>`;
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
let bestLayer = null;        // la moins chère, hors regroupement : toujours visible
let userMarker = null;

function ensureMap() {
  if (map || typeof L === 'undefined') return map;
  map = L.map($stationMap, { scrollWheelZoom: true, zoomControl: true });
  // Fond Plan IGN (Géoplateforme) plutôt que les serveurs de tuiles d'OSM, dont
  // la politique d'usage interdit le trafic intensif sans accord préalable — un
  // passage médiatique suffirait à faire bloquer la carte. Service public,
  // gratuit et sans clé ; il ne couvre que la France (404 au-delà des
  // frontières, ce qui laisse le fond neutre de la carte). Désaturé en CSS pour
  // laisser la couleur aux seuls marqueurs.
  L.tileLayer('https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
    '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png' +
    '&TILEMATRIXSET=PM_0_19&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', {
    attribution: '&copy; <a href="https://www.ign.fr/">IGN</a> – Géoplateforme · ' +
      'enseignes &copy; <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(map);
  // Cluster si le plugin a chargé, sinon layerGroup simple. Les regroupements
  // sont dessinés par Octane (pastille sombre au nombre de stations) plutôt
  // que par la feuille du plugin, aux couleurs étrangères au design system.
  markersLayer = (typeof L.markerClusterGroup === 'function')
    ? L.markerClusterGroup({
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        maxClusterRadius: 50,
        iconCreateFunction: (cluster) => L.divIcon({
          className: 'map-cluster',
          html: `<span>${cluster.getChildCount()}</span>`,
          iconSize: [36, 36]
        })
      })
    : L.layerGroup();
  markersLayer.addTo(map);
  bestLayer = L.layerGroup().addTo(map);
  // Bouton « Détails » des bulles : Leaflet bloque la propagation des clics
  // hors de la bulle, d'où un écouteur posé à chaque ouverture.
  map.on('popupopen', (e) => {
    const btn = e.popup.getElement() && e.popup.getElement().querySelector('[data-station-idx]');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const s = currentResults && currentResults.stations[parseInt(btn.dataset.stationIdx, 10)];
      if (s) openStationSheet(s, currentResults.fuelField, btn);
    });
  });
  return map;
}

function renderMap(stations) {
  if (!currentResults) return;
  const m = ensureMap();
  if (!m) return;
  const { userLat, userLon } = currentResults;
  // La carte a pu changer de taille pendant qu'elle était masquée (autre
  // onglet, rotation du téléphone) : sans nouvelle mesure, le cadrage
  // ci-dessous se calculerait sur l'ancienne taille.
  m.invalidateSize();

  markersLayer.clearLayers();
  bestLayer.clearLayers();
  if (userMarker) { m.removeLayer(userMarker); userMarker = null; }

  // Point de départ : pastille d'encre cerclée, comme la maquette.
  userMarker = L.marker([userLat, userLon], {
    icon: L.divIcon({ className: 'map-me', html: '<span></span>', iconSize: [16, 16] }),
    title: 'Ta position',
    keyboard: false
  }).addTo(m).bindPopup('Ta position');

  const bounds = L.latLngBounds([[userLat, userLon]]);
  const fuelField = currentResults.fuelField;

  if (stations.length) {
    stations.forEach((s, i) => {
      // Épingles de la maquette : la moins chère en accent avec son prix
      // (« 01 · 2,199 € »), les autres à leur rang, les prix périmés grisés et
      // sans rang, comme leur ligne du tableau.
      const best = i === 0 && !s._stale;
      const v = stationView(s, fuelField);
      const price = s.price.toFixed(3).replace('.', ',');
      const label = best ? `01 · ${price} €` : s._stale ? '–' : String(i + 1).padStart(2, '0');
      const icon = L.divIcon({
        className: 'map-pin',
        html: `<div class="pin${best ? ' pin-best' : ''}${s._stale ? ' pin-stale' : ''}"><span class="pin-label">${label}</span></div>`,
        // Taille au contenu : l'élément est posé sur la coordonnée et la
        // translation CSS de .pin y amène la pointe de l'épingle. La bulle
        // s'ouvre au-dessus de l'étiquette (36 ou 28 px, plus la pointe).
        iconSize: null,
        popupAnchor: [0, best ? -44 : -36]
      });
      const marker = L.marker([s.lat, s.lon], {
        icon,
        title: `${v.title}, ${price} € le litre`,
        zIndexOffset: best ? 1000 : 0
      });
      const dist = v.distKm != null ? km1(v.distKm) + (v.byRoad ? ' par la route' : '') : '';
      marker.bindPopup(`
        <div class="pop">
          <div class="pop-head">${brandBadgeHtml(v.brandName, { neutral: s._stale })}<strong class="pop-name">${esc(v.title)}</strong></div>
          ${v.subtitle ? `<div class="pop-addr">${esc(v.subtitle)}</div>` : ''}
          <div class="pop-facts"><span class="pop-price">${price} €/L</span><span>${esc(dist)}${s.driveMin != null ? ` · ${s.driveMin} min` : ''}</span></div>
          ${s._stale ? `<div class="pop-stale">Hors classement · relevé ${esc(v.freshness ? v.freshness.text : 'à une date inconnue')}</div>` : ''}
          <button type="button" class="btn btn-secondary btn-sm" data-station-idx="${i}">Détails</button>
        </div>`, { minWidth: 220 });
      (best ? bestLayer : markersLayer).addLayer(marker);
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
// Choix d'un onglet par l'utilisateur : la page descend jusqu'au panneau
// affiché, comme elle descend jusqu'aux résultats après une recherche
// (défilement doux, 16 px de marge haute via scroll-margin-top). Sans ça, le
// panneau s'ouvre sous le bloc gagnant et l'écart, souvent hors de l'écran.
function showView(view) {
  setView(view);
  const panel = { list: $stationList, map: $stationMap, history: $historyList }[view];
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$viewList.addEventListener('click', () => showView('list'));
$viewMap.addEventListener('click', () => showView('map'));
$viewHistory.addEventListener('click', () => showView('history'));

// ===== Bottom sheet "détails station" =====
// Ouvert au clic sur une carte. Recyclable : un seul DOM, rempli dynamiquement.
const $stationSheet = document.getElementById('stationSheet');
const $sheetContent = $stationSheet ? $stationSheet.querySelector('.sheet-content') : null;
const $sheetPanel = $stationSheet ? $stationSheet.querySelector('.sheet-panel') : null;
let lastSheetTrigger = null; // pour rendre le focus à la card cliquée à la fermeture

const ALL_FUELS = [
  { field: 'gazole_prix', label: 'Gazole' },
  { field: 'sp95_prix', label: 'SP95' },
  { field: 'e10_prix', label: 'SP95-E10' },
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
  const badgeHtml = brandBadgeHtml(brandName);
  const fullAddr = [s.adresse, [s.cp, s.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  // Fiche volontairement courte : uniquement les données officielles utiles
  // pour décider d'y aller. Le prix recherché et son relevé, la distance, les
  // réserves éventuelles, les liens d'itinéraire, puis les autres carburants
  // réellement vendus. Services, tendance et surcoût n'y figurent plus (le
  // surcoût reste dans le tableau, la tendance dans le bloc gagnant).
  const fresh = formatRelativeTime(s[fuelField.replace('_prix', '_maj')]);
  const distKm = s.driveKm != null ? s.driveKm : s.distance;
  const keyHtml = `
    <div class="sheet-key">
      <div class="sheet-key-price">
        <span class="sheet-key-fuel">${esc(FUEL_LABELS[fuelField])}</span>
        <span class="sheet-key-value">${s.price.toFixed(3).replace('.', ',')}<span class="sheet-key-unit">€ / L</span></span>
        ${fresh ? `<span class="sheet-key-fresh freshness-${fresh.tier}">${icon('clock')}relevé ${esc(fresh.text)}</span>` : ''}
      </div>
      ${distKm != null ? `<div class="sheet-key-dist">
        <span class="sheet-key-num">${esc(km1(distKm))}</span>
        <span>${s.driveKm != null ? 'par la route' : 'à vol d’oiseau'}${s.driveMin != null ? ` · ${s.driveMin} min` : ''}</span>
      </div>` : ''}
    </div>`;

  const outlierHtml = s._outlier
    ? `<div class="sheet-warn">${icon('alert')}<p>Prix qui s’écarte de ${Math.round(s._outlier.ratio * 100)} % de la médiane locale (${esc(s._outlier.median.toFixed(3).replace('.', ','))} €). Possible saisie erronée — à vérifier sur place.</p></div>`
    : '';
  const staleHtml = s._stale
    ? `<div class="sheet-note">${icon('info')}<p>La station n’a pas redéclaré ce prix depuis plus de ${STALE_DAYS} jours : il est exclu du classement. À vérifier sur place.</p></div>`
    : '';

  // Autres carburants : seulement les prix fiables, c'est-à-dire déclarés
  // depuis moins de STALE_DAYS jours (le seuil du classement). Une rupture
  // temporaire est signalée (pas de plein possible aujourd'hui) ; un carburant
  // non distribué, en rupture définitive ou au prix trop ancien n'est pas listé.
  const others = ALL_FUELS.filter(f => f.field !== fuelField).map(f => {
    const rupture = s[f.field.replace('_prix', '_rupture_type')];
    if (rupture === 'temporaire') {
      return `<li><span class="sheet-fuel">${f.label}</span><span class="sheet-rupture">Rupture temporaire</span></li>`;
    }
    const v = s[f.field];
    const f2 = formatRelativeTime(s[f.field.replace('_prix', '_maj')]);
    if (rupture === 'definitive' || typeof v !== 'number' || v <= 0 || !f2 || f2.tier === 'veryStale') return '';
    return `<li><span class="sheet-fuel">${f.label}</span>` +
      `<span class="sheet-other-price">${v.toFixed(3).replace('.', ',')} €</span>` +
      `<span class="sheet-fresh freshness-${f2.tier}">${esc(f2.text)}</span></li>`;
  }).join('');

  return `
    <header class="sheet-header">
      <div class="sheet-title-row">${badgeHtml}<h2 id="sheetTitle">${esc(brandName)}</h2></div>
      ${fullAddr ? `<div class="sheet-addr">${esc(fullAddr)}</div>` : ''}
    </header>
    ${keyHtml}
    ${staleHtml}
    ${outlierHtml}
    <div class="sheet-actions">
      <a class="btn btn-primary" href="${googleMapsUrl(s.lat, s.lon)}" target="_blank" rel="noopener">${icon('navigation')}Google Maps</a>
      <a class="btn btn-secondary" href="${wazeUrl(s.lat, s.lon)}" target="_blank" rel="noopener">Waze</a>
      ${fullAddr ? `<button type="button" class="btn btn-secondary sheet-copy" data-copy="${esc(fullAddr)}">Copier l'adresse</button>` : ''}
    </div>
    ${others ? `<section class="sheet-section"><h3>Autres carburants</h3><ul class="sheet-others">${others}</ul></section>` : ''}
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
    // closest : le clic peut tomber sur l'icône (svg) du bouton de fermeture.
    if (e.target.closest('[data-close="1"]')) closeStationSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$stationSheet.classList.contains('hidden')) closeStationSheet();
  });
}

// Click handler global sur la liste : on remonte au .station, on retrouve
// l'objet station depuis currentResults.stations par index (data-station-idx
// posé au render). Ignore les clics sur les liens internes (Itinéraire).
// Deux points d'entrée vers la fiche : une ligne du tableau, ou le bouton
// « Détails » du bloc gagnant. Les deux portent data-station-idx.
function openCardFromEvent(e) {
  const trigger = e.target.closest('[data-station-idx]');
  if (!trigger) return;
  // On laisse passer les vrais liens (Itinéraire) sauf s'ils SONT le déclencheur.
  if (e.target.closest('a') && e.target.closest('a') !== trigger) return;
  const idx = parseInt(trigger.dataset.stationIdx, 10);
  if (isNaN(idx) || !currentResults) return;
  const s = currentResults.stations[idx];
  if (s) openStationSheet(s, currentResults.fuelField, trigger);
}
// Écoute sur toute la section : le bloc gagnant (au-dessus des onglets) comme
// le tableau. « Voir sur la carte » fait comme l'onglet Carte : il l'ouvre et
// descend jusqu'à elle.
$results.addEventListener('click', (e) => {
  if (e.target.closest('[data-show-map]')) {
    showView('map');
    return;
  }
  openCardFromEvent(e);
});
$results.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.station-row')) {
    e.preventDefault();
    openCardFromEvent(e);
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
  const fuel = normalizeFuelField(params.get('fuel'));
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
    <span class="icon-chip icon-chip-sm" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></span>
    <p class="resume-text">Reprendre ta dernière recherche : <strong>${esc(fuelLabel)}</strong> autour de <strong>${esc(last.q)}</strong> (${esc(last.radius)} km)</p>
    <div class="resume-actions">
      <button type="button" class="btn btn-primary btn-sm resume-go" aria-label="Reprendre la recherche">Reprendre</button>
      <button type="button" class="icon-btn icon-btn-sm resume-dismiss" aria-label="Ignorer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
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
