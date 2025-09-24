import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import User from "./src/models/User.js";

async function migrateSingleUser(email) {
  try {
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connecté à MongoDB");

    // Trouver l'utilisateur
    const user = await User.findOne({ email });
    if (!user) {
      console.log(`❌ Utilisateur ${email} non trouvé`);
      return;
    }

    console.log(`📊 Utilisateur trouvé: ${user.email}`);
    console.log("   Subscription avant:", JSON.stringify(user.subscription, null, 2));

    // Vérifier s'il a déjà les champs trial
    if (user.subscription.trialStartDate) {
      console.log("✅ Utilisateur déjà migré");
      return;
    }

    // Démarrer la période d'essai manuellement
    const now = new Date();
    const trialEndDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 jours

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          'subscription.trialStartDate': now,
          'subscription.trialEndDate': trialEndDate,
          'subscription.isTrialActive': true,
          'subscription.hasUsedTrial': true
        }
      }
    );
    
    console.log("✅ Période d'essai démarrée pour", user.email);

    // Recharger et afficher le résultat
    const updatedUser = await User.findById(user._id);
    console.log("   Subscription après:", JSON.stringify(updatedUser.subscription, null, 2));
    
    // Tester les méthodes
    console.log("   isTrialValid():", updatedUser.isTrialValid());
    console.log("   hasPremiumAccess():", updatedUser.hasPremiumAccess());
    console.log("   getTrialDaysRemaining():", updatedUser.getTrialDaysRemaining());

  } catch (error) {
    console.error("❌ Erreur:", error);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Déconnecté de MongoDB");
    process.exit(0);
  }
}

// Utiliser l'email fourni en argument ou celui par défaut
const email = process.argv[2] || "demo@newbi.fr";
migrateSingleUser(email);
