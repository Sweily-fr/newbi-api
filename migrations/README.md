# Migrations MongoDB

Ce dossier contient les scripts de migration pour la base de données MongoDB.

## Migration: Déduplication des webhooks Stripe

### Problème résolu

Les emails d'abonnement Stripe étaient envoyés en double car la déduplication basée sur `global._processedStripeEvents` ne fonctionnait pas en environnement serverless (Vercel). Chaque nouvelle instance serverless avait un `global` vide.

### Solution

Utilisation d'une collection MongoDB `stripeWebhookEvents` pour stocker les événements Stripe traités de manière persistante et atomique.

## Exécution de la migration

### Option 1: Via mongosh (recommandé)

```bash
# En local
mongosh mongodb://localhost:27017/invoice-app --file migrations/create-stripe-webhook-events-collection.js

# En production (remplacer <MONGODB_URI> par votre URI MongoDB Atlas)
mongosh "<MONGODB_URI>" --file migrations/create-stripe-webhook-events-collection.js
```

### Option 2: Via MongoDB Compass

1. Ouvrir MongoDB Compass
2. Se connecter à la base de données
3. Aller dans l'onglet "Mongosh"
4. Copier/coller le contenu de `create-stripe-webhook-events-collection.js`
5. Exécuter le script

### Option 3: Via MongoDB Atlas UI

1. Se connecter à MongoDB Atlas
2. Aller dans "Database" > "Browse Collections"
3. Cliquer sur "+" pour créer une nouvelle collection
4. Nom: `stripeWebhookEvents`
5. Créer les index manuellement:
   - Index unique: `{ eventId: 1 }` avec option `unique: true`
   - Index TTL: `{ createdAt: 1 }` avec option `expireAfterSeconds: 604800`

## Vérification

Après l'exécution de la migration, vérifier que la collection et les index ont été créés :

```bash
mongosh "<MONGODB_URI>"

# Dans mongosh :
use invoice-app
db.stripeWebhookEvents.getIndexes()
```

Vous devriez voir 3 index :
- `_id_` (par défaut)
- `eventId_unique` (déduplication)
- `createdAt_ttl` (auto-nettoyage après 7 jours)

## Test de la déduplication

### 1. Test manuel avec Stripe CLI

```bash
# Installer Stripe CLI si nécessaire
brew install stripe/stripe-cli/stripe

# Se connecter
stripe login

# Écouter les webhooks localement
stripe listen --forward-to http://localhost:3000/api/auth/callback/stripe

# Dans un autre terminal, déclencher un événement
stripe trigger invoice.paid

# Attendre la réponse 200
# Rejouer le même événement (retry)
stripe events resend evt_xxx  # Remplacer evt_xxx par l'ID de l'événement

# Vérifier les logs : le 2e événement doit être ignoré avec le message:
# ⏭️ [STRIPE] Événement evt_xxx déjà traité, skip
```

### 2. Vérifier dans MongoDB

```bash
mongosh "<MONGODB_URI>"

use invoice-app
db.stripeWebhookEvents.find().sort({ createdAt: -1 }).limit(10)
```

Vous devriez voir les événements traités avec :
- `eventId`: ID unique de l'événement Stripe
- `eventType`: Type d'événement (invoice.paid, etc.)
- `processedAt`: Date de traitement
- `createdAt`: Date de création (pour le TTL)

### 3. Vérifier après redéploiement

1. Redéployer l'application sur Vercel
2. Rejouer un webhook Stripe déjà traité
3. Vérifier que l'événement est bien ignoré (pas de nouvel email)

## Rollback

Si vous devez annuler la migration :

```bash
mongosh "<MONGODB_URI>"

use invoice-app
db.stripeWebhookEvents.drop()
```

⚠️ **Attention**: Cela supprimera l'historique de déduplication. Les webhooks Stripe rejoués après le rollback pourront générer des emails en double jusqu'à la prochaine migration.

## Monitoring

### Vérifier le nombre d'événements traités

```javascript
db.stripeWebhookEvents.countDocuments()
```

### Voir les événements les plus récents

```javascript
db.stripeWebhookEvents.find().sort({ createdAt: -1 }).limit(20).pretty()
```

### Voir les types d'événements traités

```javascript
db.stripeWebhookEvents.aggregate([
  { $group: { _id: "$eventType", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
])
```

### Vérifier le TTL (auto-nettoyage)

```javascript
// Événements de plus de 7 jours (qui devraient être supprimés automatiquement)
const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

db.stripeWebhookEvents.find({
  createdAt: { $lt: sevenDaysAgo }
}).count()

// Devrait retourner 0 si le TTL fonctionne correctement
```

## Détails techniques

### Atomicité

L'opération `updateOne` avec `upsert: true` et `$setOnInsert` garantit l'atomicité :
- Si l'événement n'existe pas : insertion et `upsertedCount = 1`
- Si l'événement existe déjà : aucune modification et `upsertedCount = 0`
- En cas de race condition : erreur duplicate key (code 11000) interceptée

### TTL (Time To Live)

Les événements sont automatiquement supprimés après 7 jours par MongoDB :
- Réduit l'utilisation de l'espace disque
- Pas besoin de job de nettoyage manuel
- Les événements anciens ne peuvent plus causer de doublons (mais c'est rare que Stripe rejoue des webhooks après plusieurs jours)

### Performance

- Index unique sur `eventId` : recherche O(1)
- Index TTL sur `createdAt` : nettoyage automatique en arrière-plan
- Taille moyenne par document : ~150 bytes
- 1M d'événements ≈ 150 MB (négligeable)
