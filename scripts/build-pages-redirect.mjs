#!/usr/bin/env node
// Génère le contenu publié sur l'ANCIENNE adresse, leo-grnd.github.io/Octane/,
// depuis que le site est servi par Cloudflare sur octane-carburant.fr.
//
// Chaque page de l'ancien site devient une redirection qui conserve le chemin,
// la recherche (?q=&fuel=&r=) et l'ancre : un lien partagé avant la bascule
// rouvre la même recherche sur le nouveau domaine. 404.html couvre toute autre
// adresse. sw.js remplace le service worker de l'ancien site : il vide ses
// caches et se désinstalle, faute de quoi un visiteur hors ligne resterait
// bloqué sur une copie périmée.
//
// Usage : node scripts/build-pages-redirect.mjs [dossier]   (défaut : _site)
// Publié par .github/workflows/pages-redirect.yml. Zéro dépendance npm.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET = 'https://octane-carburant.fr';
const BASE = '/Octane';
const OUT = resolve(process.argv[2] || '_site');

// Page de l'ancien site → adresse équivalente, pour le repli sans JavaScript.
const PAGES = {
  'index.html': '/',
  'alertes.html': '/alertes',
  'comment-ca-marche.html': '/comment-ca-marche',
  'mentions-legales.html': '/mentions-legales',
  '404.html': '/'
};

// Calcule la nouvelle adresse depuis l'URL réellement demandée :
//   /Octane/                         → /
//   /Octane/index.html?q=Lyon        → /?q=Lyon
//   /Octane/alertes.html#x           → /alertes#x
//   /Octane/une/page/inconnue        → /une/page/inconnue (404 du nouveau site)
// Exporté pour les tests ; inséré tel quel dans chaque page.
export function targetFor(pathname, search, hash) {
  let p = pathname.indexOf(BASE) === 0 ? pathname.slice(BASE.length) : pathname;
  p = p.replace(/\.html$/, '').replace(/(^|\/)index$/, '$1');
  if (!p) p = '/';
  return TARGET + p + search + hash;
}

const page = (fallback) => `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Octane a déménagé — octane-carburant.fr</title>
  <meta name="robots" content="noindex" />
  <link rel="canonical" href="${TARGET}${fallback}" />
  <script>
    var BASE = '${BASE}', TARGET = '${TARGET}';
    ${targetFor.toString()}
    location.replace(targetFor(location.pathname, location.search, location.hash));
  </script>
  <meta http-equiv="refresh" content="0; url=${TARGET}${fallback}" />
</head>
<body style="font-family: system-ui, sans-serif; padding: 2rem">
  <p>Octane est désormais sur <a href="${TARGET}${fallback}">octane-carburant.fr</a>.</p>
</body>
</html>
`;

// Le navigateur vérifie la mise à jour du service worker à chaque visite : ce
// fichier prend la place de l'ancien, vide les caches de l'ancien site, se
// désinstalle et recharge les onglets ouverts, qui tombent sur les redirections.
const KILL_SWITCH_SW = `// Service worker de désinstallation de l'ancien site (voir scripts/build-pages-redirect.mjs).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.navigate(c.url));
  })());
});
`;

// N'écrit que lorsque le script est exécuté directement (pas lors d'un import
// par un test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(OUT, { recursive: true });
  for (const [file, fallback] of Object.entries(PAGES)) {
    writeFileSync(join(OUT, file), page(fallback));
  }
  writeFileSync(join(OUT, 'sw.js'), KILL_SWITCH_SW);
  // Pas de traitement Jekyll : les fichiers sont publiés tels quels.
  writeFileSync(join(OUT, '.nojekyll'), '');
  console.log(`✓ ${Object.keys(PAGES).length} pages de redirection + sw.js dans ${OUT}`);
}
