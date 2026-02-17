/**
 * Script de migration pour ajouter hasCompletedTutorial = true
 * aux utilisateurs existants (créés avant l'ajout du tutoriel)
 *
 * Sans cette migration, le tutoriel se relance à chaque connexion
 * car le champ n'existe pas → undefined ?? false → false → tutoriel affiché
 *
 * Usage: node scripts/migrate-hasCompletedTutorial.js
 */

const mongoose = require("mongoose");
require("dotenv").config();

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/newbi";

async function migrateHasCompletedTutorial() {
  try {
    console.log("🔄 Connexion à MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connecté à MongoDB\n");

    const db = mongoose.connection.db;
    const userCollection = db.collection("user");

    // Compter les utilisateurs sans hasCompletedTutorial
    const usersWithoutField = await userCollection.countDocuments({
      hasCompletedTutorial: { $exists: false },
    });

    console.log(
      `📊 Utilisateurs sans hasCompletedTutorial: ${usersWithoutField}`
    );

    if (usersWithoutField === 0) {
      console.log("✅ Tous les utilisateurs ont déjà le champ hasCompletedTutorial");
      return;
    }

    console.log(
      `\n⚠️  Cette opération va mettre hasCompletedTutorial = true pour ${usersWithoutField} utilisateurs`
    );
    console.log(
      "   Cela signifie qu'ils ne verront plus le tutoriel à leur prochaine connexion.\n"
    );

    console.log("🔄 Migration en cours...");

    const result = await userCollection.updateMany(
      { hasCompletedTutorial: { $exists: false } },
      { $set: { hasCompletedTutorial: true } }
    );

    console.log(`\n✅ Migration terminée !`);
    console.log(`   - Utilisateurs modifiés: ${result.modifiedCount}`);
    console.log(`   - Utilisateurs matchés: ${result.matchedCount}`);

    // Vérification
    const remainingUsers = await userCollection.countDocuments({
      hasCompletedTutorial: { $exists: false },
    });

    if (remainingUsers === 0) {
      console.log("\n✅ Vérification: Tous les utilisateurs ont maintenant le champ hasCompletedTutorial");
    } else {
      console.log(
        `\n⚠️  Attention: ${remainingUsers} utilisateurs n'ont toujours pas le champ`
      );
    }

    // Afficher un échantillon
    console.log("\n📋 Échantillon de 5 utilisateurs après migration:");
    const sampleUsers = await userCollection
      .find({}, { projection: { email: 1, hasCompletedTutorial: 1, tutorialCompletedAt: 1 } })
      .limit(5)
      .toArray();

    sampleUsers.forEach((user, index) => {
      console.log(
        `   ${index + 1}. ${user.email} - hasCompletedTutorial: ${user.hasCompletedTutorial} - tutorialCompletedAt: ${user.tutorialCompletedAt || "N/A"}`
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
migrateHasCompletedTutorial()
  .then(() => {
    console.log("\n✅ Script terminé avec succès");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Script terminé avec erreur:", error);
    process.exit(1);
  });
