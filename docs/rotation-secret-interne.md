# Rotation du secret interne (INTERNAL_API_SECRET)

Le site (NewbiV2, Vercel) et l'API (newbi-api, VPS PM2) s'appellent mutuellement
avec l'en-tête `x-internal-secret` : génération et archivage des PDF, annexes,
SuperPDP, notifications de leads.

- **Envoi** : toujours `INTERNAL_API_SECRET`.
- **Réception** : `INTERNAL_API_SECRET` **ou** `INTERNAL_API_SECRET_ALT`
  (facultative ; vide ou absente = ignorée), comparaison en temps constant.
  Vérification unique par dépôt : `src/middlewares/internal-secret.js` (API),
  `src/lib/security/require-internal-secret.js` (site).

Ce double secret en réception permet de changer la clé sans coupure.

## Procédure

Nouvelle clé : `openssl rand -hex 32`. Notée `NOUVELLE`, l'actuelle `ANCIENNE`.

| Étape | `INTERNAL_API_SECRET` | `INTERNAL_API_SECRET_ALT` |
| ----- | --------------------- | ------------------------- |
| 1     | ANCIENNE (inchangée)  | NOUVELLE                  |
| 2     | NOUVELLE              | ANCIENNE                  |
| 3     | NOUVELLE              | vide (ou retirée)         |

Chaque étape s'applique **des deux côtés, dans n'importe quel ordre**. Aucun
appel n'échoue tant que les deux côtés sont soit à l'étape précédente, soit à
l'étape en cours.

Seule règle : **ne commencer une étape qu'une fois la précédente en service des
deux côtés** (déploiement Vercel prêt et promu, rechargement PM2 terminé). Un
côté encore au départ refuserait la nouvelle clé envoyée par un côté déjà à
l'étape 2.

Le test `__tests__/security/internal-secret-rotation.test.js` rejoue ces
étapes entre un émetteur et un récepteur.

## Côté site (Vercel)

Un changement de variable ne s'applique qu'au **déploiement suivant** : il faut
redéployer après chaque étape.

```bash
# Étape 1
vercel env add INTERNAL_API_SECRET_ALT production        # saisir NOUVELLE

# Étape 2
vercel env update INTERNAL_API_SECRET production         # saisir NOUVELLE
vercel env update INTERNAL_API_SECRET_ALT production     # saisir ANCIENNE

# Étape 3
vercel env remove INTERNAL_API_SECRET_ALT production

# Après CHAQUE étape : redéployer la production
vercel redeploy <url-du-déploiement-de-production-actuel> --target production
```

Même chose avec `preview` pour le couple preview develop / API staging.

## Côté API (VPS, PM2)

L'app `newbi` (cluster ×4) relit `~/api.newbi.fr/.env.production` au
démarrage de chaque instance, et ce fichier passe avant l'environnement
mémorisé par PM2 (`src/config/env.js`). À chaque étape :

1. Modifier `.env.production`.
2. Recharger sans coupure, chaque nouvelle instance relit le fichier :

```bash
source ~/.nvm/nvm.sh && cd ~/api.newbi.fr
pm2 reload ecosystem.production.cjs && pm2 save
```

Pendant le `reload`, les 4 instances basculent une par une : certaines sont à
l'étape précédente, d'autres à l'étape en cours, cas couvert par la procédure.

Staging (`newbi-staging`) : valeurs dans le bloc `env` de
`~/staging/ecosystem.config.cjs`, puis
`pm2 restart ecosystem.config.cjs --only newbi-staging --update-env`.

## Vérifier

- Comparer des empreintes, jamais les valeurs :
  `printf %s "$INTERNAL_API_SECRET" | shasum -a 256 | cut -c1-10`.
- Aucun 401 dans les logs PM2 (`[FacturXArchive]`, `[CreditNoteArchive]`,
  `[document-annex]`) ni sur Vercel (`/api/*/data/*`, `/api/leads/notify`).
