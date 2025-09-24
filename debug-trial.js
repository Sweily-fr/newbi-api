import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import User from "./src/models/User.js";

async function debugTrial() {
  try {
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connecté à MongoDB");

    // Récupérer quelques utilisateurs avec leurs données trial
    const users = await User.find({})
      .select('email subscription')
      .limit(5);

    console.log("\n📊 Utilisateurs en base de données:");
    users.forEach((user, index) => {
      console.log(`\n${index + 1}. ${user.email}`);
      console.log("   Subscription:", JSON.stringify(user.subscription, null, 2));
      
      // Tester les méthodes trial
      if (user.subscription) {
        console.log("   isTrialValid():", user.isTrialValid());
        console.log("   hasPremiumAccess():", user.hasPremiumAccess());
        console.log("   getTrialDaysRemaining():", user.getTrialDaysRemaining());
      }
    });

    // Statistiques globales
    const totalUsers = await User.countDocuments();
    const usersWithTrial = await User.countDocuments({
      'subscription.isTrialActive': true
    });
    const usersWithTrialFields = await User.countDocuments({
      'subscription.trialStartDate': { $exists: true }
    });

    console.log("\n📈 Statistiques:");
    console.log(`   Total utilisateurs: ${totalUsers}`);
    console.log(`   Utilisateurs avec champs trial: ${usersWithTrialFields}`);
    console.log(`   Utilisateurs avec trial actif: ${usersWithTrial}`);

  } catch (error) {
    console.error("❌ Erreur:", error);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Déconnecté de MongoDB");
    process.exit(0);
  }
}

debugTrial();
