// Octane service worker — cache-first pour le shell, network-first pour les APIs.
// Bump VERSION à chaque release pour invalider le cache.
const VERSION = 'octane-v3';
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
    'api-adresse.data.gouv.fr',
    'overpass.kumi.systems',
    'overpass-api.de',
    'tile.openstreetmap.org'
  ];
  if (bypass.some(h => url.hostname.includes(h))) return;

  // Historique des prix : toujours frais (SWR) — ne pas servir depuis le cache SW
  if (url.origin === self.location.origin && url.pathname.includes('/data/history/')) {
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

  // Même origine → cache-first (shell), sinon stale-while-revalidate (fonts, leaflet)
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => cached))
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
