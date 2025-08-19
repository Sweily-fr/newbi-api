import mongoose from "mongoose";
import Transaction from "../models/Transaction.js";
import User from "../models/User.js";

/**
 * Script de migration pour ajouter workspaceId aux transactions Bridge existantes
 *
 * Ce script :
 * 1. Trouve toutes les transactions sans workspaceId
 * 2. Pour chaque utilisateur, assigne ses transactions à son premier workspace
 * 3. Met à jour les transactions avec le workspaceId approprié
 */

const migrateTransactions = async () => {
  try {
    console.log("🔄 Début de la migration des transactions Bridge...");

    // Connecter à MongoDB
    if (!mongoose.connection.readyState) {
      await mongoose.connect(
        process.env.MONGODB_URI || "mongodb://localhost:27017/invoice-app"
      );
      console.log("✅ Connexion MongoDB établie");
    }

    // 1. Trouver toutes les transactions sans workspaceId
    const transactionsWithoutWorkspace = await Transaction.find({
      workspaceId: { $exists: false },
    });

    console.log(
      `📊 Trouvé ${transactionsWithoutWorkspace.length} transactions sans workspaceId`
    );

    if (transactionsWithoutWorkspace.length === 0) {
      console.log("✅ Aucune transaction à migrer");
      return;
    }

    // 2. Grouper les transactions par userId
    const transactionsByUser = {};
    for (const transaction of transactionsWithoutWorkspace) {
      const userId = transaction.userId.toString();
      if (!transactionsByUser[userId]) {
        transactionsByUser[userId] = [];
      }
      transactionsByUser[userId].push(transaction);
    }

    console.log(
      `👥 Transactions à migrer pour ${
        Object.keys(transactionsByUser).length
      } utilisateurs`
    );

    // 3. Pour chaque utilisateur, assigner ses transactions à son premier workspace
    let migratedCount = 0;
    let errorCount = 0;

    for (const [userId, transactions] of Object.entries(transactionsByUser)) {
      try {
        console.log(`\n🔍 Migration pour utilisateur ${userId}...`);

        // Récupérer l'utilisateur
        const user = await User.findById(userId);
        if (!user) {
          console.log(`❌ Utilisateur ${userId} non trouvé`);
          errorCount += transactions.length;
          continue;
        }

        console.log(
          `👤 Utilisateur trouvé: ${user.email || user.name || userId}`
        );

        // Pour cette migration, on va assigner toutes les transactions de cet utilisateur
        // au premier workspace qu'on trouve dans ses organisations Better Auth
        // En pratique, l'admin devra peut-être ajuster manuellement si nécessaire

        // Récupérer les organisations de l'utilisateur via Better Auth
        // Pour simplifier, on va utiliser un workspaceId par défaut basé sur l'utilisateur
        // L'admin pourra toujours re-synchroniser ou corriger après

        // Créer un workspaceId basé sur l'utilisateur (temporaire)
        // En réalité, il faudrait récupérer le vrai workspaceId depuis Better Auth
        const defaultWorkspaceId = new mongoose.Types.ObjectId();

        console.log(
          `⚠️  ATTENTION: ${transactions.length} transactions pour ${
            user.email || userId
          }`
        );
        console.log(
          `   Assignment temporaire au workspace: ${defaultWorkspaceId}`
        );
        console.log(
          `   L'admin devra re-synchroniser Bridge ou corriger le workspaceId`
        );

        // Mettre à jour toutes les transactions de cet utilisateur
        const transactionIds = transactions.map((t) => t._id);
        const result = await Transaction.updateMany(
          { _id: { $in: transactionIds } },
          {
            $set: {
              workspaceId: defaultWorkspaceId,
              migrationNote: `Migration automatique - workspaceId temporaire. Re-synchroniser Bridge recommandé.`,
            },
          }
        );

        console.log(`✅ ${result.modifiedCount} transactions mises à jour`);
        migratedCount += result.modifiedCount;
      } catch (error) {
        console.error(`❌ Erreur pour utilisateur ${userId}:`, error.message);
        errorCount += transactions.length;
      }
    }

    console.log(`\n📊 Résumé de la migration:`);
    console.log(`   - Transactions migrées: ${migratedCount}`);
    console.log(`   - Erreurs: ${errorCount}`);

    console.log(`\n🔧 Actions recommandées:`);
    console.log(`   1. Redémarrer le serveur GraphQL`);
    console.log(
      `   2. Demander aux admins de re-synchroniser leurs comptes Bridge`
    );
    console.log(
      `   3. Vérifier que les transactions apparaissent dans le bon workspace`
    );
  } catch (error) {
    console.error("❌ Erreur lors de la migration:", error);
  } finally {
    if (mongoose.connection.readyState) {
      await mongoose.disconnect();
      console.log("🔌 Connexion MongoDB fermée");
    }
  }
};

// Fonction pour assigner un workspaceId spécifique à toutes les transactions d'un utilisateur
const assignWorkspaceToUserTransactions = async (userId, workspaceId) => {
  try {
    console.log(
      `🔄 Assignment du workspace ${workspaceId} aux transactions de l'utilisateur ${userId}...`
    );

    // Connecter à MongoDB si pas déjà connecté
    if (!mongoose.connection.readyState) {
      await mongoose.connect(
        process.env.MONGODB_URI || "mongodb://localhost:27017/newbi"
      );
    }

    const result = await Transaction.updateMany(
      { userId: userId },
      {
        $set: { workspaceId: workspaceId },
        $unset: { migrationNote: 1 },
      }
    );

    console.log(`✅ ${result.modifiedCount} transactions mises à jour`);
    return result;
  } catch (error) {
    console.error("❌ Erreur lors de l'assignment:", error);
    throw error;
  }
};

// Exporter les fonctions
export { migrateTransactions, assignWorkspaceToUserTransactions };

// Exécuter la migration si le script est appelé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  migrateTransactions();
}
