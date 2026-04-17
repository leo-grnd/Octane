# OCTANE

Comparateur de prix de carburant en France, en temps réel.

Site statique qui interroge directement les APIs publiques :
- **Prix** · `data.economie.gouv.fr` (flux instantané du Ministère de l'Économie)
- **Géocodage** · `api-adresse.data.gouv.fr` (Base Adresse Nationale)

Pas de backend, pas de base de données, pas de clé API.

## Développement local

```bash
# N'importe quel serveur statique fait l'affaire
python3 -m http.server 8080
# puis http://localhost:8080
```

## Déploiement Dokploy

1. Dans Dokploy → **Create Application** → type **Docker Compose** (ou **Dockerfile**).
2. Branche la source sur ce repo (branche par défaut).
3. Dokploy lit le `Dockerfile` (image `nginx:alpine`) et expose le port `80`.
4. Ajoute ton domaine dans l'onglet Domains, active HTTPS (Let's Encrypt).
5. Deploy.

### Variables d'environnement
Aucune n'est requise.

### Healthcheck
Intégré au `Dockerfile` (`wget --spider http://localhost/`).

## Fichiers

| Fichier | Rôle |
|--|--|
| `index.html` | Structure |
| `style.css` | Style (thème sombre, accent orange) |
| `app.js` | Géocodage + appel API carburants + rendu |
| `Dockerfile` | Image nginx:alpine |
| `nginx.conf` | Config nginx (gzip, cache, headers de sécu) |
| `docker-compose.yml` | Optionnel — déploiement local |
