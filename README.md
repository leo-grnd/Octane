# OCTANE

Comparateur de prix de carburant en France, en temps réel.

Site statique qui interroge directement les APIs publiques :
- **Prix** · `data.economie.gouv.fr` (flux instantané du Ministère de l'Économie)
- **Géocodage** · `api-adresse.data.gouv.fr` (Base Adresse Nationale)
- **Enseignes** · Overpass OSM (`amenity=fuel` + tag `brand`)

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
| `data/history/*.json` | Agrégats hebdomadaires (générés, commit) |
| `.github/workflows/build-history.yml` | Cron hebdo GHA |
