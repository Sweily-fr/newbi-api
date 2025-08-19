import mongoose from "mongoose";
import Transaction from "../models/Transaction.js";
import User from "../models/User.js";

/**
 * Script de debug pour analyser les transactions Bridge
 */

const debugTransactions = async () => {
  try {
    console.log("🔍 Analyse des transactions Bridge...");

    // Connecter à MongoDB
    if (!mongoose.connection.readyState) {
      await mongoose.connect(
        process.env.MONGODB_URI || "mongodb://localhost:27017/invoice-app"
      );
      console.log("✅ Connexion MongoDB établie");
    }

    // Compter toutes les transactions
    const totalTransactions = await Transaction.countDocuments();
    console.log(`📊 Total des transactions: ${totalTransactions}`);

    // Compter les transactions avec workspaceId
    const transactionsWithWorkspace = await Transaction.countDocuments({
      workspaceId: { $exists: true },
    });
    console.log(
      `✅ Transactions avec workspaceId: ${transactionsWithWorkspace}`
    );

    // Compter les transactions sans workspaceId
    const transactionsWithoutWorkspace = await Transaction.countDocuments({
      workspaceId: { $exists: false },
    });
    console.log(
      `❌ Transactions sans workspaceId: ${transactionsWithoutWorkspace}`
    );

    // Afficher quelques exemples de transactions
    const sampleTransactions = await Transaction.find().limit(3).lean();
    console.log("\n📋 Exemples de transactions:");
    sampleTransactions.forEach((transaction, index) => {
      console.log(`\n${index + 1}. Transaction ${transaction._id}:`);
      console.log(
        `   - bridgeTransactionId: ${transaction.bridgeTransactionId || "N/A"}`
      );
      console.log(`   - userId: ${transaction.userId || "N/A"}`);
      console.log(`   - workspaceId: ${transaction.workspaceId || "MANQUANT"}`);
      console.log(`   - amount: ${transaction.amount || "N/A"}`);
      console.log(`   - description: ${transaction.description || "N/A"}`);
      console.log(`   - date: ${transaction.date || "N/A"}`);
    });

    // Grouper par utilisateur
    const transactionsByUser = await Transaction.aggregate([
      {
        $group: {
          _id: "$userId",
          count: { $sum: 1 },
          hasWorkspace: {
            $sum: {
              $cond: [{ $ifNull: ["$workspaceId", false] }, 1, 0],
            },
          },
        },
      },
    ]);

    console.log("\n👥 Transactions par utilisateur:");
    for (const userGroup of transactionsByUser) {
      const user = await User.findById(userGroup._id);
      console.log(
        `   - ${user?.email || userGroup._id}: ${
          userGroup.count
        } transactions (${userGroup.hasWorkspace} avec workspace)`
      );
    }

    // Vérifier les workspaceId uniques
    const uniqueWorkspaces = await Transaction.distinct("workspaceId");
    console.log(`\n🏢 Workspaces uniques: ${uniqueWorkspaces.length}`);
    uniqueWorkspaces.forEach((workspaceId, index) => {
      console.log(`   ${index + 1}. ${workspaceId}`);
    });
  } catch (error) {
    console.error("❌ Erreur lors du debug:", error);
  } finally {
    if (mongoose.connection.readyState) {
      await mongoose.disconnect();
      console.log("🔌 Connexion MongoDB fermée");
    }
  }
};

// Exécuter le debug
debugTransactions();
