// Octane service worker — network-first pour le shell (déploiements visibles
// sans unregister manuel), stale-while-revalidate pour les CDN, bypass total
// pour les APIs de données.
// Bump VERSION à chaque release pour invalider le cache.
const VERSION = 'octane-v20';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './favicon.svg',
  './og-image.svg',
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

  // Ne jamais cacher les appels data / géocodage / overpass — on laisse passer.
  const bypass = [
    'data.economie.gouv.fr',
    'public.opendatasoft.com',
    'corsproxy.io',
    'api-adresse.data.gouv.fr',
    'overpass.kumi.systems',
    'overpass-api.de',
    'tile.openstreetmap.org'
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

  // CDN externes (fonts, leaflet) : stale-while-revalidate
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
