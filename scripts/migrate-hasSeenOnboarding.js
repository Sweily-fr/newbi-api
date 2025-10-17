/**
 * Script de migration pour ajouter hasSeenOnboarding = true
 * aux utilisateurs existants
 * 
 * Usage: node scripts/migrate-hasSeenOnboarding.js
 */

const mongoose = require("mongoose");
require("dotenv").config();

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/newbi";

async function migrateHasSeenOnboarding() {
  try {
    console.log("🔄 Connexion à MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connecté à MongoDB\n");

    const db = mongoose.connection.db;
    const userCollection = db.collection("user");

    // Compter les utilisateurs sans hasSeenOnboarding
    const usersWithoutField = await userCollection.countDocuments({
      hasSeenOnboarding: { $exists: false },
    });

    console.log(
      `📊 Utilisateurs sans hasSeenOnboarding: ${usersWithoutField}`
    );

    if (usersWithoutField === 0) {
      console.log("✅ Tous les utilisateurs ont déjà le champ hasSeenOnboarding");
      return;
    }

    // Demander confirmation
    console.log(
      `\n⚠️  Cette opération va mettre hasSeenOnboarding = true pour ${usersWithoutField} utilisateurs`
    );
    console.log(
      "   Cela signifie qu'ils ne verront pas l'onboarding à leur prochaine connexion.\n"
    );

    // En production, vous pouvez ajouter une confirmation interactive
    // Pour l'instant, on exécute directement

    console.log("🔄 Migration en cours...");

    const result = await userCollection.updateMany(
      { hasSeenOnboarding: { $exists: false } },
      { $set: { hasSeenOnboarding: true } }
    );

    console.log(`\n✅ Migration terminée !`);
    console.log(`   - Utilisateurs modifiés: ${result.modifiedCount}`);
    console.log(`   - Utilisateurs matchés: ${result.matchedCount}`);

    // Vérification
    const remainingUsers = await userCollection.countDocuments({
      hasSeenOnboarding: { $exists: false },
    });

    if (remainingUsers === 0) {
      console.log("\n✅ Vérification: Tous les utilisateurs ont maintenant le champ hasSeenOnboarding");
    } else {
      console.log(
        `\n⚠️  Attention: ${remainingUsers} utilisateurs n'ont toujours pas le champ`
      );
    }

    // Afficher un échantillon
    console.log("\n📋 Échantillon de 5 utilisateurs après migration:");
    const sampleUsers = await userCollection
      .find({}, { projection: { email: 1, hasSeenOnboarding: 1, role: 1 } })
      .limit(5)
      .toArray();

    sampleUsers.forEach((user, index) => {
      console.log(
        `   ${index + 1}. ${user.email} - hasSeenOnboarding: ${user.hasSeenOnboarding} - role: ${user.role || "N/A"}`
      );
    });
  } catch (error) {
    console.error("❌ Erreur lors de la migration:", error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Déconnecté de MongoDB");
  }
}

// Exécution
migrateHasSeenOnboarding()
  .then(() => {
    console.log("\n✅ Script terminé avec succès");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script terminé avec erreur:", error);
    process.exit(1);
  });
