// Page "Alerte quotidienne" — composition d'une alerte + aperçu en direct.
//
// Volontairement autonome : app.js accroche au chargement des éléments propres à
// l'écran de recherche (#searchBtn, #stationList…) et planterait ici. Sans
// bundler ni modules, quelques helpers sont donc redupliqués à l'identique —
// esc(), les libellés carburants, la préférence commune du géocodeur. Toute
// correction sur l'un doit être reportée sur l'autre.

// ===== Thème (même contrat que index.html : clé localStorage octane-theme) =====
(function initTheme() {
  const icon = document.getElementById('themeIcon');
  const apply = (t) => {
    if (t === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      icon.textContent = '☀';
    } else {
      document.documentElement.removeAttribute('data-theme');
      icon.textContent = '☾';
    }
  };
  let saved = null;
  try { saved = localStorage.getItem('octane-theme'); } catch {}
  apply(saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  document.getElementById('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('octane-theme', next); } catch {}
    apply(next);
  });
})();

// ===== Constantes partagées avec le job d'envoi =====
// Le filtre de fraîcheur est le cœur de la fiabilité de l'alerte : sans lui, le
// podium national est trusté par des stations qui ont cessé de déclarer depuis
// des mois et dont le prix affiché n'existe plus.
const ALERT_FRESH_DAYS = 3;
const DATASET = 'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/' +
  'prix-des-carburants-en-france-flux-instantane-v2/records';

const FUEL_LABELS = {
  e10_prix: 'SP95-E10',
  sp95_prix: 'SP95',
  sp98_prix: 'SP98',
  gazole_prix: 'Gazole',
  e85_prix: 'E85',
  gplc_prix: 'GPLc'
};
// Le dataset a renommé `sp95_e10_prix` en `e10_prix` : on migre les valeurs
// héritées venant de l'URL ou d'une recherche sauvegardée.
const LEGACY_FUEL_FIELDS = { sp95_e10_prix: 'e10_prix' };
const normalizeFuelField = (f) => (f ? LEGACY_FUEL_FIELDS[f] || f : f);

const DRAFT_KEY = 'octane-alert-draft';
const LAST_SEARCH_KEY = 'octane-last-search';

// Adresse de contact pour la demande d'inscription. Laissée vide par défaut :
// la renseigner publie l'adresse en clair dans une page publique, donc c'est un
// choix qui revient au mainteneur. Vide => seul le bouton "Copier" s'affiche.
const CONTACT_EMAIL = '';

// ===== Helpers =====
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

// Aligné sur l'outil : le système n'a qu'un accent, on distingue seulement la
// station la moins chère du reste plutôt qu'un dégradé vert → rouge.
const RANK_COLORS = ['var(--color-accent)', 'var(--color-neutral-500)', 'var(--color-neutral-500)'];

function formatRelativeTime(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (isNaN(then)) return null;
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000));
  const diffH = diffMin / 60;
  if (diffMin < 2) return 'à l\'instant';
  if (diffMin < 60) return `il y a ${diffMin} min`;
  if (diffH < 24) return `il y a ${Math.round(diffH)} h`;
  return `il y a ${Math.round(diffH / 24)} j`;
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

const $ = (id) => document.getElementById(id);
const $email = $('email'), $fuel = $('fuel'), $hour = $('hour');
const $address = $('address'), $radius = $('radius');
const $addressField = $('addressField'), $radiusField = $('radiusField');
const $suggestions = $('suggestions');
const $form = $('alertForm'), $previewBtn = $('previewBtn');
const $status = $('status');
const $preview = $('preview'), $previewMeta = $('previewMeta'), $podium = $('previewPodium');
const $output = $('output'), $configBlock = $('configBlock');
const $copyBtn = $('copyBtn'), $mailtoBtn = $('mailtoBtn');

function showStatus(msg, isError = false) {
  $status.classList.remove('hidden');
  $status.classList.toggle('error', isError);
  $status.innerHTML = isError ? esc(msg) : `<span class="loader"></span>${esc(msg)}`;
}
function hideStatus() { $status.classList.add('hidden'); }

// ===== Heures d'envoi =====
(function fillHours() {
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = `${String(h).padStart(2, '0')}:00`;
    if (h === 8) opt.selected = true;
    $hour.appendChild(opt);
  }
})();

// ===== Bascule France entière / rayon =====
function getScope() {
  const r = document.querySelector('input[name="scope"]:checked');
  return r ? r.value : 'france';
}
function syncScopeFields() {
  const isRadius = getScope() === 'radius';
  $addressField.classList.toggle('hidden', !isRadius);
  $radiusField.classList.toggle('hidden', !isRadius);
  $address.required = isRadius;
}
document.querySelectorAll('input[name="scope"]').forEach(r =>
  r.addEventListener('change', syncScopeFields));

// ===== Géocodage BAN =====
// Même correctif que app.js : BAN classe parfois une voie homonyme au-dessus de
// la commune cherchée, à un millième près (« Avignon » → Combourg, Ille-et-Vilaine).
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

// Coordonnées retenues pour la zone. Renseignées par l'autocomplétion (sans
// appel réseau supplémentaire) ou par un géocodage à la volée.
let pickedPlace = null;

async function geocode(address) {
  const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(address)}&limit=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Géocodage indisponible');
  const data = await res.json();
  const best = pickBestGeoFeature(data.features || []);
  if (!best) throw new Error('Adresse introuvable');
  const [lon, lat] = best.geometry.coordinates;
  return { lat, lon, label: best.properties.label };
}

// ===== Autocomplétion =====
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function closeSuggestions() {
  $suggestions.classList.add('hidden');
  $suggestions.innerHTML = '';
  $address.setAttribute('aria-expanded', 'false');
}
let lastSuggestionQuery = '';
const suggest = debounce(async (q) => {
  if (q !== lastSuggestionQuery || q.length < 3) return;
  let features = [];
  try {
    const res = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=6&autocomplete=1`);
    if (res.ok) features = (await res.json()).features || [];
  } catch { /* réseau indisponible : on laisse la saisie libre */ }
  if (q !== lastSuggestionQuery || !features.length) { closeSuggestions(); return; }
  $suggestions.innerHTML = features.map((f, i) =>
    `<li role="option" data-idx="${i}" aria-selected="false">${esc(f.properties.label || '')}` +
    `<span class="sg-ctx">${esc(f.properties.context || '')}</span></li>`
  ).join('');
  $suggestions.classList.remove('hidden');
  $address.setAttribute('aria-expanded', 'true');
  $suggestions.querySelectorAll('li').forEach((li, i) => {
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const f = features[i];
      const [lon, lat] = f.geometry.coordinates;
      $address.value = f.properties.label;
      pickedPlace = { lat, lon, label: f.properties.label };
      closeSuggestions();
    });
  });
}, 220);

$address.addEventListener('input', () => {
  const q = $address.value.trim();
  lastSuggestionQuery = q;
  pickedPlace = null; // la saisie a changé : les coordonnées mémorisées ne valent plus
  if (q.length < 3) { closeSuggestions(); return; }
  suggest(q);
});
$address.addEventListener('blur', () => setTimeout(closeSuggestions, 150));
$address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSuggestions();
});

// ===== Requête "moins chère" — identique à celle du job d'envoi =====
function buildWhere({ fuel, scope, lat, lon, radius }) {
  const majField = fuel.replace('_prix', '_maj');
  const parts = [`${fuel} IS NOT NULL`, `${majField} > now(days=-${ALERT_FRESH_DAYS})`];
  if (scope === 'radius') {
    parts.unshift(`within_distance(geom, geom'POINT(${lon} ${lat})', ${radius}km)`);
  }
  return parts.join(' AND ');
}

async function fetchCheapest(cfg, limit = 3) {
  const majField = cfg.fuel.replace('_prix', '_maj');
  const select = `id,cp,ville,adresse,geom,${cfg.fuel},${majField}`;
  const url = `${DATASET}?where=${encodeURIComponent(buildWhere(cfg))}` +
    `&select=${encodeURIComponent(select)}` +
    // `id` départage les ex æquo : indispensable dès qu'on trie sur une colonne
    // non unique, sinon l'ordre n'est pas déterministe.
    `&order_by=${encodeURIComponent(`${cfg.fuel},id`)}` +
    `&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('API carburants:', body);
    throw new Error(`API carburants : ${res.status}`);
  }
  const data = await res.json();
  return { results: data.results || [], total: data.total_count || 0 };
}

// ===== Rendu de l'aperçu =====
function renderPreview(cfg, { results, total }) {
  const majField = cfg.fuel.replace('_prix', '_maj');
  const zone = cfg.scope === 'france' ? 'France entière' : `${cfg.radius} km autour de ${cfg.label}`;
  $previewMeta.textContent = `${FUEL_LABELS[cfg.fuel]} · ${zone} · ${total} station${total > 1 ? 's' : ''} éligible${total > 1 ? 's' : ''}`;
  $podium.innerHTML = '';

  if (!results.length) {
    $podium.innerHTML = `<li class="alert-empty">Aucune station n'a mis à jour ce carburant dans cette zone depuis ${ALERT_FRESH_DAYS} jours. Élargis le rayon ou choisis un autre carburant.</li>`;
    return;
  }

  results.forEach((s, i) => {
    const { lat, lon } = extractCoords(s);
    const price = Number(s[cfg.fuel]);
    const color = RANK_COLORS[i] || RANK_COLORS[RANK_COLORS.length - 1];
    const addr = [s.adresse, [s.cp, s.ville].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    const maj = formatRelativeTime(s[majField]);
    const dist = cfg.scope === 'radius' && lat != null
      ? `${haversine(cfg.lat, cfg.lon, lat, lon).toFixed(1).replace('.', ',')} km`
      : null;
    const maps = lat != null
      ? `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}&travelmode=driving`
      : null;

    const li = document.createElement('li');
    li.className = 'alert-row';
    li.style.setProperty('--rank-color', color);
    li.innerHTML = `
      <div class="alert-rank" aria-hidden="true">${String(i + 1).padStart(2, '0')}</div>
      <div>
        <div class="alert-name">${esc(s.ville || 'Station')}${dist ? ` <span class="alert-maj">à ${esc(dist)}</span>` : ''}</div>
        <div class="alert-addr">${esc(addr)}</div>
        ${maps ? `<div class="alert-links"><a href="${esc(maps)}" target="_blank" rel="noopener">Itinéraire ↗</a></div>` : ''}
      </div>
      <div class="alert-price">
        ${price.toFixed(3).replace('.', ',')}
        <span class="alert-unit">€ / L</span>
        ${maj ? `<span class="alert-maj">maj ${esc(maj)}</span>` : ''}
      </div>
    `;
    $podium.appendChild(li);
  });
}

// ===== Configuration =====
function buildConfig(cfg) {
  const out = {
    email: cfg.email,
    fuel: cfg.fuel,
    hour: cfg.hour,
    scope: cfg.scope
  };
  if (cfg.scope === 'radius') {
    out.lat = Number(cfg.lat.toFixed(5));
    out.lon = Number(cfg.lon.toFixed(5));
    out.radius = cfg.radius;
    out.label = cfg.label;
  }
  return out;
}

function renderOutput(cfg) {
  const json = JSON.stringify(buildConfig(cfg), null, 2);
  $configBlock.textContent = json;
  $output.classList.remove('hidden');
  if (CONTACT_EMAIL) {
    const subject = 'Octane — demande d\'alerte quotidienne';
    const body = `Bonjour,\n\nJe souhaite recevoir l'alerte quotidienne Octane avec cette configuration :\n\n${json}\n\nMerci !`;
    $mailtoBtn.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    $mailtoBtn.classList.remove('hidden');
  }
}

$copyBtn.addEventListener('click', async () => {
  const prev = $copyBtn.textContent;
  try {
    await navigator.clipboard.writeText($configBlock.textContent);
    $copyBtn.textContent = '✓ Copié';
  } catch {
    // Clipboard refusée (contexte non sécurisé, permission) : on sélectionne le
    // bloc pour que l'utilisateur puisse copier au clavier.
    const range = document.createRange();
    range.selectNodeContents($configBlock);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    $copyBtn.textContent = 'Sélectionné — Ctrl+C';
  }
  setTimeout(() => { $copyBtn.textContent = prev; }, 1800);
});

// ===== Brouillon local =====
function saveDraft(cfg) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(cfg)); } catch {}
}
function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; }
}

// ===== Soumission =====
async function handleSubmit(e) {
  e.preventDefault();
  hideStatus();
  $preview.classList.add('hidden');
  $output.classList.add('hidden');

  const email = $email.value.trim();
  // Validation volontairement permissive : on écarte les fautes de frappe
  // évidentes sans prétendre valider une adresse, ce qu'aucune regex ne fait.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    showStatus('Cette adresse email ne semble pas valide.', true);
    $email.focus();
    return;
  }

  const scope = getScope();
  const cfg = {
    email,
    fuel: $fuel.value,
    hour: parseInt($hour.value, 10),
    scope
  };

  if (scope === 'radius') {
    const radius = parseInt($radius.value, 10);
    if (!Number.isFinite(radius) || radius < 1 || radius > 50) {
      showStatus('Le rayon doit être compris entre 1 et 50 km.', true);
      $radius.focus();
      return;
    }
    cfg.radius = radius;
    const typed = $address.value.trim();
    if (!typed) {
      showStatus('Indique une adresse ou une ville, ou bascule sur « France entière ».', true);
      $address.focus();
      return;
    }
    // L'autocomplétion a déjà les coordonnées : on ne regéocode que si la
    // saisie a changé depuis la sélection.
    if (pickedPlace && pickedPlace.label === typed) {
      Object.assign(cfg, { lat: pickedPlace.lat, lon: pickedPlace.lon, label: pickedPlace.label });
    } else {
      try {
        showStatus('Localisation de l\'adresse...');
        const place = await geocode(typed);
        Object.assign(cfg, { lat: place.lat, lon: place.lon, label: place.label });
        $address.value = place.label;
        pickedPlace = place;
      } catch (err) {
        showStatus(`Erreur : ${err.message}`, true);
        return;
      }
    }
  }

  $previewBtn.disabled = true;
  try {
    showStatus('Interrogation des prix en temps réel...');
    const data = await fetchCheapest(cfg);
    hideStatus();
    renderPreview(cfg, data);
    renderOutput(cfg);
    saveDraft(cfg);
    $preview.classList.remove('hidden');
    $preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    console.error(err);
    showStatus(`Impossible de récupérer les prix : ${err.message}`, true);
  } finally {
    $previewBtn.disabled = false;
  }
}
$form.addEventListener('submit', handleSubmit);

// ===== Préremplissage =====
// Priorité : brouillon d'alerte > paramètres d'URL > dernière recherche faite
// sur l'outil principal. L'idée est qu'arriver ici depuis une recherche
// fructueuse propose directement la même zone et le même carburant.
(function prefill() {
  const params = new URLSearchParams(location.search);
  const draft = loadDraft();
  let last = null;
  try { last = JSON.parse(localStorage.getItem(LAST_SEARCH_KEY)); } catch {}

  const setFuel = (f) => {
    const v = normalizeFuelField(f);
    if (v && [...$fuel.options].some(o => o.value === v)) $fuel.value = v;
  };
  const setRadius = (r) => {
    const v = parseInt(r, 10);
    if (Number.isFinite(v) && v >= 1 && v <= 50) $radius.value = String(v);
  };

  if (draft) {
    $email.value = draft.email || '';
    setFuel(draft.fuel);
    if (Number.isFinite(draft.hour)) $hour.value = String(draft.hour);
    if (draft.scope === 'radius') {
      document.getElementById('scopeRadius').checked = true;
      setRadius(draft.radius);
      if (draft.label) {
        $address.value = draft.label;
        if (draft.lat != null && draft.lon != null) {
          pickedPlace = { lat: draft.lat, lon: draft.lon, label: draft.label };
        }
      }
    }
  } else {
    setFuel(params.get('fuel') || (last && last.fuel));
    const q = params.get('q') || (last && last.q);
    const r = params.get('r') || (last && last.radius);
    if (q) {
      document.getElementById('scopeRadius').checked = true;
      $address.value = q;
      setRadius(r);
    }
  }
  syncScopeFields();
})();
