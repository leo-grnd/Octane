# OCTANE

Comparateur de prix de carburant en France, en temps réel.

Site statique qui interroge directement les APIs publiques :
- **Prix** · `data.economie.gouv.fr` (flux instantané du Ministère de l'Économie)
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

Hébergé sur **GitHub Pages** depuis la branche `main`.

## Historique des prix (sparklines)

Chaque station peut afficher l'évolution hebdomadaire de son prix sur les 12 dernières semaines.
Les données sont pré-calculées dans `data/history/<fuel>.json` à partir de l'archive annuelle
officielle `donnees.roulez-eco.fr/opendata/annee/YYYY` (ZIP + XML, Ministère de l'Économie).

Le script Node requiert `unzip` dans le PATH (présent par défaut sur macOS, Linux, et les
runners GitHub Actions `ubuntu-latest`). Le script Python est 100 % stdlib (pas de binaire
externe requis, utile si `unzip` manque).

**Rafraîchir localement (Node, recommandé) :**
```bash
node scripts/build-history.mjs              # 12 dernières semaines, année en cours
node scripts/build-history.mjs --weeks=24   # plus long historique
```

**Alternative Python (stdlib uniquement, si Node n'est pas dispo) :**
```bash
python3 scripts/build_history.py
python3 scripts/build_history.py --weeks 24 --year 2025
```

**Automatisation :** le workflow `.github/workflows/build-history.yml` tourne chaque lundi
à 05:00 UTC et commit les JSONs rafraîchis sur `main`. Déclenchable manuellement via l'onglet
Actions → Refresh price history → Run workflow.

Si les JSONs sont absents (404), le client affiche simplement « Historique indisponible ».

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
| `app.js` | Géocodage + appels API + rendu + cache + historique |
| `sw.js` + `manifest.webmanifest` | Service worker et manifest PWA |
| `favicon.svg` · `og-image.svg` | Icône + preview sociale |
| `scripts/build-history.mjs` | Pré-calcul des sparklines par station (Node) |
| `scripts/build_history.py` | Équivalent stdlib Python |
| `scripts/build-brands.mjs` | Scrape OSM → `data/osm/brands.json` (Node) |
| `scripts/build_brands.py` | Équivalent stdlib Python |
| `data/history/*.json` | Agrégats hebdomadaires (générés, commit) |
| `data/osm/brands.json` | Base des marques OSM (généré, commit) |
| `.github/workflows/build-history.yml` | Cron hebdo GHA (historique) |
| `.github/workflows/build-brands.yml` | Cron mensuel GHA (marques) |
