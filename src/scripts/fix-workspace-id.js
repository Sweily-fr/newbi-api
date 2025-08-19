import mongoose from "mongoose";
import Transaction from "../models/Transaction.js";

/**
 * Script pour corriger le workspaceId des transactions Bridge
 * 
 * Problème : Les transactions ont un workspaceId aléatoire au lieu du vrai workspaceId de l'admin
 * Solution : Mettre à jour toutes les transactions avec le bon workspaceId
 */

const fixWorkspaceId = async () => {
  try {
    console.log("🔧 Correction du workspaceId des transactions...");

    // Connecter à MongoDB
    if (!mongoose.connection.readyState) {
      await mongoose.connect(
        process.env.MONGODB_URI || "mongodb://localhost:27017/invoice-app"
      );
      console.log("✅ Connexion MongoDB établie");
    }

    // Le workspaceId correct d'après les logs de l'admin
    const correctWorkspaceId = "68932751626f06764f62ca2e";
    const userId = "685ff0250e083b9a2987a0b9"; // sofiane.mtimet6@gmail.com

    console.log(`🎯 Correction pour utilisateur: ${userId}`);
    console.log(`🎯 Nouveau workspaceId: ${correctWorkspaceId}`);

    // Compter les transactions à corriger
    const transactionsToFix = await Transaction.countDocuments({
      userId: userId
    });

    console.log(`📊 Transactions à corriger: ${transactionsToFix}`);

    if (transactionsToFix === 0) {
      console.log("✅ Aucune transaction à corriger");
      return;
    }

    // Afficher l'ancien workspaceId pour confirmation
    const sampleTransaction = await Transaction.findOne({ userId: userId });
    console.log(`📋 Ancien workspaceId: ${sampleTransaction?.workspaceId}`);

    // Effectuer la correction
    const result = await Transaction.updateMany(
      { userId: userId },
      { 
        $set: { workspaceId: correctWorkspaceId },
        $unset: { migrationNote: 1 }
      }
    );

    console.log(`✅ ${result.modifiedCount} transactions corrigées`);

    // Vérifier le résultat
    const verifyCount = await Transaction.countDocuments({
      userId: userId,
      workspaceId: correctWorkspaceId
    });

    console.log(`✅ Vérification: ${verifyCount} transactions avec le bon workspaceId`);

    // Afficher un exemple de transaction corrigée
    const correctedTransaction = await Transaction.findOne({ 
      userId: userId,
      workspaceId: correctWorkspaceId 
    });

    console.log(`📋 Exemple de transaction corrigée:`, {
      id: correctedTransaction._id,
      bridgeTransactionId: correctedTransaction.bridgeTransactionId,
      workspaceId: correctedTransaction.workspaceId,
      amount: correctedTransaction.amount,
      description: correctedTransaction.description
    });

    console.log(`\n🎉 Correction terminée ! Les transactions devraient maintenant apparaître sur le dashboard.`);

  } catch (error) {
    console.error("❌ Erreur lors de la correction:", error);
  } finally {
    if (mongoose.connection.readyState) {
      await mongoose.disconnect();
      console.log("🔌 Connexion MongoDB fermée");
    }
  }
};

// Exécuter la correction
fixWorkspaceId();
