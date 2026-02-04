/**
 * Migration: Création de la collection stripeWebhookEvents pour la déduplication atomique
 *
 * Cette migration crée une collection MongoDB pour stocker les événements Stripe traités
 * et éviter les doublons d'emails lors des webhooks.
 *
 * Exécution:
 * mongosh <MONGODB_URI> --file migrations/create-stripe-webhook-events-collection.js
 */

// Nom de la base de données (à adapter selon votre environnement)
const dbName = "invoice-app";
const db = db.getSiblingDB(dbName);

print("🔧 [MIGRATION] Création de la collection stripeWebhookEvents...");

// Créer la collection si elle n'existe pas
db.createCollection("stripeWebhookEvents");

print("✅ [MIGRATION] Collection stripeWebhookEvents créée");

// Créer l'index unique sur eventId
print("🔧 [MIGRATION] Création de l'index unique sur eventId...");
db.stripeWebhookEvents.createIndex(
  { eventId: 1 },
  {
    unique: true,
    name: "eventId_unique"
  }
);

print("✅ [MIGRATION] Index unique eventId_unique créé");

// Créer l'index TTL sur createdAt (expire après 7 jours)
print("🔧 [MIGRATION] Création de l'index TTL sur createdAt...");
db.stripeWebhookEvents.createIndex(
  { createdAt: 1 },
  {
    expireAfterSeconds: 604800, // 7 jours (7 * 24 * 60 * 60)
    name: "createdAt_ttl"
  }
);

print("✅ [MIGRATION] Index TTL createdAt_ttl créé (expire après 7 jours)");

// Afficher les index créés
print("\n📋 [MIGRATION] Index créés:");
db.stripeWebhookEvents.getIndexes().forEach((index) => {
  print(`  - ${index.name}: ${JSON.stringify(index.key)}`);
  if (index.expireAfterSeconds) {
    print(`    TTL: ${index.expireAfterSeconds} secondes`);
  }
  if (index.unique) {
    print(`    Unique: true`);
  }
});

print("\n✅ [MIGRATION] Migration terminée avec succès!");
print("\n📌 [INFO] Les événements Stripe seront automatiquement supprimés après 7 jours.");
