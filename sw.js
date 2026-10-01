// Octane service worker — network-first pour le shell (déploiements visibles
// sans unregister manuel), stale-while-revalidate pour les CDN, bypass total
// pour les APIs de données.
// Bump VERSION à chaque release pour invalider le cache.
const VERSION = 'octane-v45';
const SHELL = [
  './',
  './index.html',
  './fonts/archivo.css',
  './fonts/archivo-latin.woff2',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet.markercluster/MarkerCluster.css',
  './vendor/leaflet.markercluster/MarkerCluster.Default.css',
  './vendor/leaflet.markercluster/leaflet.markercluster.js',
  './design-system.css',
  './style.css',
  './app.js',
  './comment-ca-marche.html',
  './comment-ca-marche.css',
  './alertes.html',
  './alertes.css',
  './alertes.js',
  './favicon.svg',
  './apple-touch-icon.png',
  './icons/icon-192.png',
  './manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL).catch(() => null)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== VERSION).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ne jamais cacher les appels data / géocodage / tuiles / routage — on laisse passer.
  const bypass = [
    'data.economie.gouv.fr',
    'public.opendatasoft.com',
    'data.geopf.fr',
    'router.project-osrm.org',
    'routing.openstreetmap.de',
    'valhalla1.openstreetmap.de'
  ];
  if (bypass.some(h => url.hostname.includes(h))) return;

  // Données précalculées (marques OSM) : toujours frais côté réseau,
  // fallback cache si offline. Évite de servir un 404 figé après redeploy.
  if (url.origin === self.location.origin && url.pathname.includes('/data/osm/')) {
    e.respondWith(
      caches.open(VERSION).then(cache =>
        fetch(req).then(res => {
          if (res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        }).catch(() => cache.match(req))
      )
    );
    return;
  }

  // Même origine (shell) → network-first avec fallback cache pour l'offline.
  // Garantit qu'un push se propage au prochain reload, sans avoir à unregister
  // le SW manuellement côté client.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Autres ressources tierces : stale-while-revalidate. Polices et Leaflet sont
  // désormais servis par le site (fonts/, vendor/) et passent par la branche
  // même origine ci-dessus ; plus aucun CDN n'est appelé au chargement.
  e.respondWith(
    caches.open(VERSION).then(cache =>
      cache.match(req).then(cached => {
        const fetchPromise = fetch(req).then(res => {
          if (res.ok) cache.put(req, res.clone()).catch(() => {});
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    )
  );
});
