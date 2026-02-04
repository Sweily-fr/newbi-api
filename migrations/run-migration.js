/**
 * Script Node.js pour exécuter la migration stripeWebhookEvents
 *
 * Usage:
 * node migrations/run-migration.js
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger les variables d'environnement
const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : process.env.NODE_ENV === "staging"
      ? ".env.staging"
      : ".env";

const envPath = path.resolve(path.dirname(__dirname), envFile);
dotenv.config({ path: envPath });

console.log(`🌍 Environnement: ${process.env.NODE_ENV || "development"}`);
console.log(`📄 Fichier .env chargé: ${envFile}`);

async function runMigration() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || "invoice-app";

  if (!uri) {
    console.error("❌ MONGODB_URI non défini dans les variables d'environnement");
    process.exit(1);
  }

  console.log(`\n🔌 Connexion à MongoDB...`);
  console.log(`📍 URI: ${uri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@")}`);
  console.log(`📂 Database: ${dbName}`);

  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log("✅ Connecté à MongoDB");

    const db = client.db(dbName);

    // Créer la collection si elle n'existe pas
    console.log("\n🔧 [MIGRATION] Création de la collection stripeWebhookEvents...");

    const collections = await db.listCollections({ name: "stripeWebhookEvents" }).toArray();

    if (collections.length === 0) {
      await db.createCollection("stripeWebhookEvents");
      console.log("✅ [MIGRATION] Collection stripeWebhookEvents créée");
    } else {
      console.log("ℹ️ [MIGRATION] Collection stripeWebhookEvents existe déjà");
    }

    // Créer l'index unique sur eventId
    console.log("\n🔧 [MIGRATION] Création de l'index unique sur eventId...");
    try {
      await db.collection("stripeWebhookEvents").createIndex(
        { eventId: 1 },
        {
          unique: true,
          name: "eventId_unique",
        }
      );
      console.log("✅ [MIGRATION] Index unique eventId_unique créé");
    } catch (error) {
      if (error.code === 85 || error.codeName === "IndexOptionsConflict") {
        console.log("ℹ️ [MIGRATION] Index eventId_unique existe déjà");
      } else {
        throw error;
      }
    }

    // Créer l'index TTL sur createdAt (expire après 7 jours)
    console.log("\n🔧 [MIGRATION] Création de l'index TTL sur createdAt...");
    try {
      await db.collection("stripeWebhookEvents").createIndex(
        { createdAt: 1 },
        {
          expireAfterSeconds: 604800, // 7 jours (7 * 24 * 60 * 60)
          name: "createdAt_ttl",
        }
      );
      console.log("✅ [MIGRATION] Index TTL createdAt_ttl créé (expire après 7 jours)");
    } catch (error) {
      if (error.code === 85 || error.codeName === "IndexOptionsConflict") {
        console.log("ℹ️ [MIGRATION] Index createdAt_ttl existe déjà");
      } else {
        throw error;
      }
    }

    // Afficher les index créés
    console.log("\n📋 [MIGRATION] Index créés:");
    const indexes = await db.collection("stripeWebhookEvents").indexes();
    indexes.forEach((index) => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
      if (index.expireAfterSeconds) {
        console.log(`    TTL: ${index.expireAfterSeconds} secondes (${index.expireAfterSeconds / 86400} jours)`);
      }
      if (index.unique) {
        console.log(`    Unique: true`);
      }
    });

    // Statistiques
    const count = await db.collection("stripeWebhookEvents").countDocuments();
    console.log(`\n📊 Nombre d'événements déjà traités: ${count}`);

    console.log("\n✅ [MIGRATION] Migration terminée avec succès!");
    console.log("\n📌 [INFO] Les événements Stripe seront automatiquement supprimés après 7 jours.");
    console.log("📌 [INFO] La déduplication atomique est maintenant active.");

  } catch (error) {
    console.error("\n❌ [MIGRATION] Erreur lors de la migration:", error);
    process.exit(1);
  } finally {
    await client.close();
    console.log("\n🔌 Déconnexion de MongoDB");
  }
}

// Exécuter la migration
runMigration().catch((error) => {
  console.error("❌ Erreur fatale:", error);
  process.exit(1);
});
