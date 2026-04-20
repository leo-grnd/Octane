# OCTANE

Comparateur de prix de carburant en France, en temps réel.

Site statique qui interroge directement les APIs publiques :
- **Prix** · `data.economie.gouv.fr` (flux instantané du Ministère de l'Économie)
- **Historique prix** · `public.opendatasoft.com/prix-des-carburants-j-1` (12 mois glissants, runtime)
- **Géocodage** · `api-adresse.data.gouv.fr` (Base Adresse Nationale)
- **Enseignes** · Base pré-calculée (`data/osm/brands.json`, issue d'OSM)

Pas de backend, pas de base de données, pas de clé API.

## Développement local

```bash
# N'importe quel serveur statique fait l'affaire
python3 -m http.server 8080
# puis http://localhost:8080
```

Ou ouvrir directement `index.html` dans un navigateur.

## Déploiement

Hébergé en live sur **GitHub Pages** depuis la branche `main`.

## Historique des prix (sparklines)

Chaque station affiche l'évolution de son prix sur les **30 dernières mises à jour**, calculée
en temps réel à partir du dataset public `prix-des-carburants-j-1` (`public.opendatasoft.com`,
12 mois glissants, Ministère de l'Économie).

> ⚠️ Les deux portails Opendatasoft (`data.economie.gouv.fr` + `public.opendatasoft.com`)
> refusent les origins non-allowlistées avec un 403 `x-deny-reason: host_not_allowed`.
> `leo-grnd.github.io` n'étant pas dans leur allowlist, **toutes les requêtes données sont
> routées via `corsproxy.io`** (proxy public gratuit, sans auth). Voir `CORS_PROXY` dans
> `app.js` — remplace par ton propre Worker Cloudflare si tu veux éliminer la dépendance
> externe, ou ouvre un ticket chez Opendatasoft pour être whitelisté.

Pas de fichier généré, pas de cron : dès qu'une recherche retourne des stations, le client
pré-charge l'historique de chacune en arrière-plan (4 requêtes en parallèle), dédupli­que les
relevés consécutifs identiques, et met en cache le résultat dans `localStorage` (TTL 24 h).

Si le dataset ne retourne pas assez de points pour une station, le client affiche simplement
« Historique indisponible ».

## Base de marques OSM

Pour éviter d'appeler Overpass au runtime (latence + dépendance à des miroirs pas
toujours dispo), on scrape **une fois** toutes les stations `amenity=fuel` de France
avec leur tag `brand`/`operator`/`name`, et on ship le résultat dans
`data/osm/brands.json`. Le client le charge une seule fois par session et cherche
la marque la plus proche (≤ 150 m) en local.

**Rafraîchir localement (Node) :**
```bash
node scripts/build-brands.mjs
```

**Alternative Python (stdlib uniquement) :**
```bash
python3 scripts/build_brands.py
```

**Automatisation :** le workflow `.github/workflows/build-brands.yml` tourne le 1er
de chaque mois à 04:00 UTC (les marques OSM bougent lentement). Déclenchable manuellement
via l'onglet Actions → Refresh OSM brands → Run workflow.

## Fichiers

| Fichier | Rôle |
|--|--|
| `index.html` | Structure + SEO |
| `style.css` | Style (thème sombre/clair, responsive) |
| `app.js` | Géocodage + appels API + rendu + cache + historique runtime |
| `sw.js` + `manifest.webmanifest` | Service worker et manifest PWA |
| `favicon.svg` · `og-image.svg` | Icône + preview sociale |
| `scripts/build-brands.mjs` | Scrape OSM → `data/osm/brands.json` (Node) |
| `scripts/build_brands.py` | Équivalent stdlib Python |
| `data/osm/brands.json` | Base des marques OSM (généré, commit) |
| `.github/workflows/build-brands.yml` | Cron mensuel GHA (marques) |
