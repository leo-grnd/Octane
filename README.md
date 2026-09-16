# OCTANE

Comparateur de prix de carburant en France, en temps réel.

Site statique qui interroge directement les APIs publiques :
- **Prix** · `data.economie.gouv.fr` (flux instantané du Ministère de l'Économie)
- **Historique prix** · `public.opendatasoft.com/prix-des-carburants-j-1` (12 mois glissants, runtime)
- **Géocodage** · `api-adresse.data.gouv.fr` (Base Adresse Nationale)
- **Enseignes** · Base pré-calculée (`data/osm/brands.json`, issue d'OSM)
- **Routage** · Valhalla (primaire) + OSRM (fallback), pour le mode « en voiture »

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

`.github/workflows/daily-alerts.yml` tourne **toutes les heures** et exécute
`scripts/send-alerts.mjs` (Node 20, aucune dépendance npm — `fetch` est natif). Le script ne
retient que les abonnés dont l'heure d'envoi correspond à l'heure de **Paris** courante (calculée
via `Intl`, donc l'heure d'été est gérée sans logique maison), regroupe les abonnés partageant la
même zone pour ne faire qu'un appel API, puis envoie via l'API HTTP de Brevo.

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

Le cron peut glisser de plusieurs dizaines de minutes côté GitHub : le script rattrape jusqu'à
3 heures manquées, avec une garde « au plus un envoi par abonné et par jour » pour qu'un run
rejoué n'envoie jamais deux fois le même email.

### Configuration

Trois secrets dans *Settings → Secrets and variables → Actions* :

| Secret | Rôle |
|--|--|
| `BREVO_API_KEY` | clé API Brevo (*SMTP & API → API Keys*) |
| `BREVO_SENDER` | adresse expéditrice validée chez Brevo |
| `OCTANE_ALERTS` | tableau JSON des abonnements |

Deux *variables* optionnelles : `SITE_URL` (défaut `https://leo-grnd.github.io/Octane/`) et
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
| `comment-ca-marche.html` · `.css` | Page d'explication |
| `alertes.html` · `.css` · `.js` | Composition d'une alerte quotidienne + aperçu du jour |
| `sw.js` + `manifest.webmanifest` | Service worker et manifest PWA |
| `favicon.svg` · `og-image.svg` | Icône + preview sociale |
| `scripts/build-brands.mjs` | Scrape OSM → `data/osm/brands.json` (Node) |
| `scripts/build_brands.py` | Équivalent stdlib Python |
| `scripts/send-alerts.mjs` | Envoi des alertes quotidiennes (Node, sans dépendance) |
| `data/osm/brands.json` | Base des marques OSM (généré, commit) |
| `data/alerts/state.json` | Prix de la veille + anti-doublon (empreintes, écrit par la CI) |
| `.github/workflows/build-brands.yml` | Cron mensuel GHA (marques) |
| `.github/workflows/daily-alerts.yml` | Cron horaire GHA (alertes) |

> `sw.js` met en cache le *shell* de l'app : **bumper `VERSION` à chaque release**, sinon les
> navigateurs déjà venus servent l'ancienne version. Tout nouveau fichier de shell doit aussi
> être ajouté au tableau `SHELL`.
