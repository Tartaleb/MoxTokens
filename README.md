# MoxTokens

App web statique qui liste tous les **tokens** (nom + illustration) générés par les decks **Moxfield** publics d'un utilisateur.

Live : https://tartaleb.github.io/MoxTokens/

## Utilisation

1. Saisir un username Moxfield.
2. Cocher les decks dont tu veux extraire les tokens.
3. Cliquer **Extraire les tokens** — grille d'images + noms.

Seuls les decks marqués **publics** sur Moxfield sont visibles (limitation de l'API publique).

## Architecture

- **Frontend statique** : `index.html` + `style.css` + `app.js`, hébergé sur GitHub Pages.
- **Cloudflare Worker** (`cloudflare-worker/worker.js`) : proxy CORS qui parle à `api2.moxfield.com`. Nécessaire parce que Moxfield bloque les requêtes navigateur cross-origin.
- **Scryfall** : appelé directement depuis le navigateur (CORS ouvert) en fallback quand l'image d'un token n'est pas embarquée dans la réponse Moxfield.

## Déploiement

### Frontend
`git push origin main` — GitHub Pages reconstruit en ~1 min.

### Worker
```
cd cloudflare-worker
npx wrangler deploy
```
(`npx wrangler login` si l'auth a expiré.)

Pour ajouter un nouveau domaine au proxy, MAJ la whitelist `ALLOWED` dans `worker.js` puis redéployer.
