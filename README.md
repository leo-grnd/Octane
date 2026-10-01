# OCTANE

Comparateur de prix de carburant en France, en temps réel.

Site statique qui interroge directement les APIs publiques :
- **Prix** · `data.economie.gouv.fr` (flux instantané du Ministère de l'Économie)
- **Historique prix** · `public.opendatasoft.com/prix-des-carburants-j-1` (12 mois glissants, runtime)
- **Géocodage** · `data.geopf.fr/geocodage` (Base Adresse Nationale, servie par la Géoplateforme IGN)
- **Enseignes** · Base pré-calculée (`public/data/osm/brands.json`, issue d'OSM)
- **Routage** · Valhalla (primaire, `valhalla1.openstreetmap.de`) + OSRM (fallback), pour le mode
  « en voiture ». Les deux tournent en parallèle et leurs distances sont fusionnées.
- **Fond de carte** · Plan IGN v2 (WMTS Géoplateforme, sans clé), désaturé en CSS. Les serveurs de
  tuiles d'OSM interdisent l'usage intensif sans accord, ce qu'un passage médiatique suffirait à
  déclencher.

Pas de backend, pas de base de données, pas de clé API côté navigateur. Seule exception : les
[alertes quotidiennes](#alertes-quotidiennes), envoyées par un cron GitHub Actions — un email
planifié ne peut pas partir d'une page statique.

> ℹ️ Les deux portails Opendatasoft (`data.economie.gouv.fr` + `public.opendatasoft.com`)
> refusaient autrefois les origins non-allowlistées (403 `x-deny-reason: host_not_allowed`),
> ce qui obligeait à router les appels via un proxy CORS public. Ils renvoient désormais
> `Access-Control-Allow-Origin: *` : **les requêtes partent en direct depuis le navigateur**,
> sans proxy ni clé. Le proxy a été retiré en septembre 2026 — `corsproxy.io` est passé en
> freemium (401 sans clé API) et faisait tomber l'app entière.

### Une note sur le géocodage

BAN classe parfois une **voie homonyme au-dessus de la commune** cherchée, à un millième de score
près : « Avignon » renvoyait la rue Avignon de Combourg (Ille-et-Vilaine) plutôt que la ville
d'Avignon. Le client demande donc 5 résultats et, à score quasi équivalent, privilégie le type
`municipality`. Sans risque pour les adresses précises : dès qu'une requête contient une voie ou
un numéro, BAN ne remonte aucune commune dans son top 5.

L'ancienne adresse `api-adresse.data.gouv.fr` est **fermée depuis le 31/01/2026** (en-têtes
`Sunset` et `Deprecation`) ; Octane interroge la Géoplateforme de l'IGN depuis octobre 2026.
C'est le même moteur : scores, types et format GeoJSON sont identiques, d'où une migration
limitée à l'URL.

## Récupération des stations

L'API Opendatasoft plafonne `limit` à **100 lignes par requête** : une recherche à 50 km autour
de Paris couvre 755 stations, dont seules 100 remontaient. Le client pagine donc sur `offset`
(la 1re page fournit `total_count`, les suivantes partent en parallèle), jusqu'à un plafond de
**400 stations** — au-delà, la liste n'est plus exploitable et le compteur l'indique.

Les résultats sont triés côté serveur par prix croissant (`order_by=<carburant>,id`), ce qui
rend la troncature inoffensive : ce sont les stations **les plus chères** qui sautent, jamais le
classement du moins cher. Le `id` départage les ex æquo, faute de quoi la pagination pourrait
dupliquer ou sauter des lignes.

Un `select` explicite limite la réponse aux champs réellement affichés : **76 Ko par page au lieu
de 275 Ko**, le reste étant des blobs JSON sérialisés (`horaires`, `prix`, `rupture`) et le
découpage administratif.

### Prix périmés

Le flux contient des stations qui ne déclarent plus : au 01/10/2026, « le moins cher » de Paris
(5 km) était un gazole à 2,200 € relevé **184 jours** plus tôt, devant des prix du jour à 2,250 €.
Un prix non redéclaré depuis plus de **7 jours** (`STALE_DAYS`) sort donc du classement : il ne
peut plus être désigné gagnant, ne compte ni dans l'écart affiché ni dans le surcoût, et passe en
fin de tableau sous un intercalaire « Hors classement », sans rang, avec sa date de relevé. Il
reste visible, la station pouvant simplement n'avoir pas changé ses prix. Les alertes email sont
plus strictes (3 jours) : elles désignent un seul gagnant, sans tableau pour nuancer.

## Développement local

```bash
npx wrangler dev
# puis http://localhost:8787
```

`wrangler dev` reproduit Cloudflare à l'identique : URL sans `.html`, page 404, en-têtes de
`_headers` (dont la CSP) et routes `/api/*` du Worker. Un simple `python3 -m http.server -d public`
sert encore les fichiers, mais les liens internes, écrits sans extension (`/alertes`), y renvoient
une 404.

## Déploiement

Hébergé sur **Cloudflare** (Workers + fichiers statiques, offre gratuite), à l'adresse
**https://octane-carburant.fr**. Le déploiement suit le dépôt via Workers Builds : chaque push sur
`main` part en production, chaque autre branche reçoit une URL d'aperçu.

**L'ancienne adresse `leo-grnd.github.io/Octane/` redirige vers le nouveau domaine.** GitHub Pages n'y
publie plus le site mais des pages de redirection (`.github/workflows/pages-redirect.yml`, contenu
généré par `scripts/build-pages-redirect.mjs`) : chaque ancien lien rouvre la même page et la même
recherche (`/Octane/index.html?q=Lyon&fuel=e10_prix` → `/?q=Lyon&fuel=e10_prix`), toute autre adresse
passe par `404.html`, et un `sw.js` de désinstallation remplace le service worker de l'ancien site
(caches vidés, onglets rechargés). Prérequis : *Settings → Pages → Source = GitHub Actions*.

| Fichier | Rôle |
|--|--|
| `wrangler.jsonc` | Worker, dossier publié (`public/`), domaine |
| `public/_headers` | En-têtes HTTP : CSP, HSTS, anti-iframe, permissions, CORS de la police |
| `worker/index.js` | Code exécuté pour `/api/*` uniquement |
| `public/sitemap.xml` · `robots.txt` | Indexation par les moteurs |

Quelques règles qui en découlent :

- **Seules les routes `/api/*` invoquent le Worker** (`run_worker_first`). Pages et fichiers sont
  servis directement, sans limite ni coût : un pic de trafic ne consomme pas le quota gratuit de
  100 000 invocations par jour.
- **Liens internes sans `.html`** : Cloudflare redirige `/alertes.html` vers `/alertes`. Les anciens
  liens partagés continuent donc de fonctionner, mais le code, les URL canoniques et le
  `sitemap.xml` utilisent la forme courte pour éviter une redirection à chaque clic.
- **Aucun script en ligne** dans les pages : la CSP de `_headers` les bloquerait. Le thème est posé
  par `theme-init.js` (chargé de façon bloquante dans le `<head>`), la bascule et le menu mobile
  par `site.js`, commun à toutes les pages.
- **Seul `public/` est publié.** Sources, scripts, configuration et état des alertes vivent hors de
  ce dossier : ils ne peuvent pas fuiter par oubli. Le site y est aussi rangé parce que
  `wrangler dev` surveille le dossier publié et écrit son propre état dans `.wrangler/` : servi depuis
  la racine, il se rechargeait sans fin.
- **Tout nouveau service tiers** appelé par le navigateur doit être ajouté à la CSP de `_headers`
  et décrit dans `mentions-legales.html`.

## Historique des prix (sparklines)

Chaque station affiche l'évolution de son prix sur les **100 derniers jours**, calculée
en temps réel à partir du dataset public `prix-des-carburants-j-1` (`public.opendatasoft.com`,
12 mois glissants, Ministère de l'Économie).

La fenêtre est bornée en **jours** (`update >= now(days=-100)`), pas en nombre de lignes : le
dataset a en principe une ligne par station et par jour, mais il monte parfois à quatre, si bien
qu'un simple `limit=100` ne couvrait pas 100 jours. Comme l'API plafonne `limit` à 100, le client
pagine sur `offset` (3 pages au maximum, la plupart des stations tenant en une seule).

Pas de fichier généré, pas de cron : dès qu'une recherche retourne des stations, le client
pré-charge l'historique de chacune en arrière-plan (4 requêtes en parallèle), dédupli­que les
relevés consécutifs identiques, et met en cache le résultat dans `localStorage` (TTL 24 h).

La dédup conserve le dernier relevé même s'il répète le prix précédent : sans ça, la courbe
s'arrêtait à la dernière *variation* de prix — parfois deux mois en arrière — et l'axe des dates
affichait une plage trompeuse.

Si le dataset ne retourne pas assez de points pour une station, le client affiche simplement
« Historique indisponible ».

## Alertes quotidiennes

Chaque matin à l'heure choisie, un email indique la station la moins chère d'une zone pour un
carburant donné — un rayon autour d'une adresse, ou la France entière.

`alertes.html` sert à **composer** une alerte : elle affiche un aperçu en direct du podium du
jour, puis produit la configuration JSON à transmettre. L'inscription n'est pas automatique,
faute de backend : la liste des abonnés vit dans un secret de dépôt.

### Fonctionnement

`.github/workflows/daily-alerts.yml` est programmé **toutes les heures** et exécute
`scripts/send-alerts.mjs` (Node 20, aucune dépendance npm — `fetch` est natif). Le script retient
les abonnés dont l'heure d'envoi est passée depuis moins de 6 heures (heure de **Paris**, calculée
via `Intl`, donc l'heure d'été est gérée sans logique maison) et qui n'ont rien reçu aujourd'hui,
regroupe les abonnés partageant la même zone pour ne faire qu'un appel API, puis envoie via l'API
HTTP de Brevo.

Le dépôt étant public, l'état persisté (`data/alerts/state.json`) ne contient que des **empreintes
SHA-256** : ni email ni coordonnées en clair.

Deux garde-fous méritent d'être connus :

- **Filtre de fraîcheur** (`<carburant>_maj > now(days=-3)`). Sans lui, le podium national est
  trusté par des stations qui ne déclarent plus : au 16/09/2026, le gazole le moins cher de France
  s'affichait à Biscarrosse à 2,09 € sur un relevé du **24 juin**. L'alerte aurait envoyé
  l'abonné à 400 km vers un prix qui n'existe plus.
- **Garde anti-saisie erronée** : un prix sous 60 % de la médiane de la zone est écarté (gérant
  qui tape 0,199 au lieu de 1,99), et seulement au-delà de 5 stations, en dessous desquelles la
  médiane n'est pas représentative.

Le cron « horaire » de GitHub n'est qu'indicatif : sur septembre 2026 il n'a tourné que 3 à
7 fois par jour, avec des trous allant jusqu'à 6 h 44. D'où la fenêtre de 6 heures : une alerte
réglée sur 8 h part au premier run entre 8 h et 14 h. La garde « au plus un envoi par abonné et
par jour » empêche qu'un run suivant ou rejoué envoie deux fois le même email. La fenêtre ne
franchit pas minuit.

### Configuration

Trois secrets dans *Settings → Secrets and variables → Actions* :

| Secret | Rôle |
|--|--|
| `BREVO_API_KEY` | clé API Brevo (*SMTP & API → API Keys*) |
| `BREVO_SENDER` | adresse expéditrice validée chez Brevo |
| `OCTANE_ALERTS` | tableau JSON des abonnements |

Deux *variables* optionnelles : `SITE_URL` (défaut `https://octane-carburant.fr/`) et
`BREVO_SENDER_NAME` (défaut `Octane`).

Format d'`OCTANE_ALERTS` :

```json
[
  { "email": "moi@exemple.fr", "fuel": "gazole_prix", "hour": 8, "scope": "france" },
  { "email": "moi@exemple.fr", "fuel": "e10_prix", "hour": 7, "scope": "radius",
    "lat": 43.93635, "lon": 4.84886, "radius": 15, "label": "Avignon" }
]
```

`fuel` ∈ `gazole_prix` · `e10_prix` · `sp95_prix` · `sp98_prix` · `e85_prix` · `gplc_prix`.
`hour` ∈ 0–23 (heure de Paris). `radius` ∈ 1–50 km. Une entrée invalide est signalée dans les logs
et ignorée, sans empêcher les autres abonnés de recevoir leur alerte — le run sort malgré tout en
échec pour que le problème soit visible.

### Tester

```bash
OCTANE_ALERTS='[{"email":"moi@exemple.fr","fuel":"gazole_prix","hour":8,"scope":"france"}]' \
  node scripts/send-alerts.mjs --dry-run --force-hour=8
```

`--dry-run` affiche les emails sans rien envoyer ni écrire d'état, `--force-hour=N` simule
l'heure de Paris, `--force` ignore la garde anti-doublon.

Côté GitHub : onglet *Actions* → *Daily fuel alerts* → *Run workflow*, avec `dry_run` coché pour
un test à blanc. ⚠️ Un workflow planifié ne s'exécute que s'il est présent sur la branche par
défaut : le cron ne démarrera qu'une fois poussé sur `main`.

## Base de marques OSM

Pour éviter d'appeler Overpass au runtime (latence + dépendance à des miroirs pas
toujours dispo), on scrape **une fois** toutes les stations `amenity=fuel` de France
avec leur tag `brand`/`operator`/`name`, et on ship le résultat dans
`public/data/osm/brands.json`. Le client le charge une seule fois par session et cherche
la marque la plus proche (≤ 150 m) en local.

`brands.json` est une base dérivée d'OpenStreetMap : elle est diffusée sous **ODbL 1.0**
(© contributeurs OpenStreetMap), comme l'indiquent la page mentions légales et l'attribution
de la carte.

Il n'y a **aucun appel Overpass depuis le navigateur**. Un ancien fallback interrogeait les
instances publiques à chaque recherche où une enseigne manquait ; il a été retiré avant la mise
en ligne publique, leurs politiques d'usage proscrivant ce trafic dès qu'il devient massif. Une
station absente de la base garde un affichage complet, simplement sans enseigne.

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

## Design system

L'interface suit le design system **Modernist** exporté de Claude Design : angles droits
(`--radius-*` à 0), filets francs plutôt que cartes ombrées, Archivo en trois graisses, un seul
accent rouge (`#ec3013`) sur une rampe de neutres chauds.

- **`design-system.css` est la copie conforme de l'export**, chargée avant `style.css` sur les
  trois pages. Elle porte les tokens (`--color-*`, `--font-*`, `--space-*`, `--shadow-*`) et les
  composants (`.nav`, `.btn`, `.input`, `.field`, `.seg`, `.table`, `.tag`…). On la retouche le
  moins possible, pour qu'une nouvelle version de l'export puisse l'écraser. Deux écarts
  seulement, à refaire après un nouvel export : l'`@import` Google Fonts de la ligne 2 est retiré
  (voir « Ressources tierces »), et le bloc « Thème sombre » est ajouté en fin de fichier.
- **`style.css` et les feuilles de page n'emploient que ces tokens.** Exceptions assumées, listées
  en tête de `style.css` : couleurs d'enseigne des badges, rouge/vert des tendances de prix,
  orange/rouge de la fraîcheur. L'accent étant lui-même rouge, une hausse à sa couleur ne se
  distinguerait plus de la marque.
- **Le clair est le thème par défaut**, conformément à la direction artistique. Le sombre est
  activé par `data-theme="dark"` sur `<html>` (préférence système, puis choix mémorisé sous
  `octane-theme` dans `localStorage`). Un script en ligne dans le `<head>` de chaque page l'applique
  avant le premier rendu, pour éviter un flash clair.
- **Le sombre inverse les rampes tonales au lieu de redéfinir les composants** :
  `--color-neutral-100` reste « le plus proche du fond » et `-900` « le plus contrasté ». Chaque
  règle écrite pour le clair fonctionne donc en sombre sans duplication. L'accent remonte d'un cran
  (`#ff563c`) pour garder un contraste de 5,8:1 sur le fond sombre.
- **L'email d'alerte reprend la palette en valeurs littérales** (`MAIL` dans
  `scripts/send-alerts.mjs`) : les clients mail ne résolvent ni les variables CSS ni `color-mix`.

### Ressources tierces servies par le site

Aucune ressource n'est chargée depuis un CDN : police et cartographie sont copiées dans le dépôt.
Pas d'adresse IP de visiteur transmise à Google (la jurisprudence européenne a jugé ce transfert
contraire au RGPD), pas de panne d'unpkg qui casserait la carte, et la condition d'une politique
de sécurité de contenu (CSP) stricte.

| Ressource | Emplacement | Version | Licence |
|--|--|--|--|
| Archivo (police variable 400-800, latin + latin étendu) | `public/fonts/` | Google Fonts v25 | SIL OFL 1.1 |
| Leaflet | `public/vendor/leaflet/` | 1.9.4 | BSD-2 |
| Leaflet.markercluster | `public/vendor/leaflet.markercluster/` | 1.5.3 | MIT |

Les fichiers Leaflet gardent leur attribut `integrity` (SRI), identique à celui de la version
officielle sur unpkg. Pour monter de version : retélécharger les fichiers `dist/` dans le dossier
correspondant, mettre à jour le hash SRI et le tableau ci-dessus, puis bumper le SW.

### Icônes et aperçu de partage

`public/favicon.svg` (carré accent, anneau clair) est la source unique des icônes ; `og-image.png`
reprend le hero de l'accueil. Les réseaux sociaux n'affichent pas d'aperçu SVG et iOS ignore une
`apple-touch-icon` SVG, d'où des PNG, générés par le navigateur déjà installé :

```bash
node scripts/render-brand.mjs
```

À relancer après toute retouche de `public/favicon.svg` ou de `scripts/brand/og-image.html`, puis
committer les PNG. Le même script produit `backdrop.webp`, le fond de carte du haut des pages : la
page `scripts/brand/backdrop.html` assemble les tuiles Plan IGN et encode elle-même l'image, que le
script récupère par le protocole DevTools (`node scripts/render-brand.mjs backdrop` pour ne
régénérer qu'elle). Le script vérifie les dimensions de chaque image produite. `og:image` et
`canonical` exigent des URL absolues, sur `https://octane-carburant.fr/` : à mettre à jour avec le
`sitemap.xml` si le domaine change un jour.

## Fichiers

**Publié — `public/`** (tout ce dossier, et lui seul, est servi par Cloudflare) :

| Fichier | Rôle |
|--|--|
| `index.html` · `app.js` · `style.css` | L'outil : géocodage, appels API, rendu, cache, historique |
| `alertes.html` · `.css` · `.js` | Composition d'une alerte quotidienne + aperçu du jour |
| `comment-ca-marche.html` · `.css` · `.js` | Page d'explication et ses animations |
| `mentions-legales.html` · `.css` | Mentions légales (LCEN), confidentialité (RGPD), licences, conditions d'utilisation |
| `404.html` | Page d'erreur au design system |
| `design-system.css` | Design system v3 (maquette Claude Design) : tokens clair et sombre, composants, en-tête, hero, pied de page |
| `theme-init.js` · `site.js` | Thème avant le premier rendu · bascule du thème et menu mobile, sur toutes les pages |
| `backdrop.webp` | Fond de carte du haut des pages (Plan IGN en gris) — généré |
| `sw.js` · `manifest.webmanifest` | Service worker et manifest PWA |
| `fonts/` · `vendor/` | Archivo · Leaflet et markercluster, avec leurs licences |
| `favicon.svg` | Icône, et source de toutes les icônes PNG |
| `apple-touch-icon.png` · `icons/` | Icônes iOS (180) et PWA (192, 512, aussi « maskable ») — générées |
| `og-image.png` | Aperçu de partage 1200 × 630 (réseaux sociaux, messageries) — généré |
| `data/osm/brands.json` | Base des marques OSM (générée chaque mois par la CI, diffusée sous ODbL) |
| `_headers` | En-têtes HTTP (CSP, HSTS…) — lu par Cloudflare, jamais servi lui-même |
| `sitemap.xml` · `robots.txt` | Indexation par les moteurs |

**Non publié** :

| Fichier | Rôle |
|--|--|
| `wrangler.jsonc` · `worker/` | Configuration Cloudflare · code des routes `/api/*` |
| `scripts/render-brand.mjs` · `scripts/brand/` | Rendu des images générées via Chrome/Edge headless (sans dépendance) |
| `scripts/build-brands.mjs` · `build_brands.py` | Scrape OSM → `public/data/osm/brands.json` (Node ou Python stdlib) |
| `scripts/send-alerts.mjs` | Envoi des alertes quotidiennes (Node, sans dépendance) |
| `data/alerts/state.json` | Prix de la veille + anti-doublon (empreintes, écrit par la CI) |
| `.github/workflows/build-brands.yml` | Cron mensuel GHA (marques) |
| `.github/workflows/daily-alerts.yml` | Cron horaire GHA (alertes) |
| `.github/workflows/pages-redirect.yml` · `scripts/build-pages-redirect.mjs` | Redirections de l'ancienne adresse GitHub Pages |

> **Mentions légales — à tenir à jour.** Toute nouvelle donnée collectée, nouveau stockage local ou
> nouveau service tiers appelé par le navigateur doit y être ajouté, et la date de mise à jour en tête
> de page modifiée. Un champ provisoire se balise `<mark class="todo">` : il s'affiche en rouge tant
> qu'il n'est pas rempli, pour ne pas partir en ligne par mégarde.

> `sw.js` met en cache le *shell* de l'app : **bumper `VERSION` à chaque release**, sinon les
> navigateurs déjà venus servent l'ancienne version. Tout nouveau fichier de shell doit aussi
> être ajouté au tableau `SHELL`.
