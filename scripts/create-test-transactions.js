/**
 * Script pour créer des transactions de test sur Bridge Sandbox
 *
 * Usage: node scripts/create-test-transactions.js
 */

import dotenv from "dotenv";
import mongoose from "mongoose";
import axios from "axios";

// Charger les variables d'environnement
dotenv.config({ path: ".env.development" });

const BRIDGE_CLIENT_ID = process.env.BRIDGE_CLIENT_ID;
const BRIDGE_CLIENT_SECRET = process.env.BRIDGE_CLIENT_SECRET;
const BRIDGE_BASE_URL =
  process.env.BRIDGE_BASE_URL || "https://api.bridgeapi.io";
const MONGODB_URI = process.env.MONGODB_URI;

// Transactions de test à créer
const TEST_TRANSACTIONS = [
  {
    amount: 1500.0,
    currency_code: "EUR",
    description: "VIR SEPA CLIENT DUPONT FACTURE",
    date: new Date().toISOString().split("T")[0],
  },
  {
    amount: 2500.0,
    currency_code: "EUR",
    description: "VIR MARTIN SARL REGLEMENT",
    date: new Date().toISOString().split("T")[0],
  },
  {
    amount: 850.0,
    currency_code: "EUR",
    description: "VIREMENT ENTREPRISE ABC",
    date: new Date(Date.now() - 86400000).toISOString().split("T")[0], // Hier
  },
  {
    amount: -120.5,
    currency_code: "EUR",
    description: "CB AMAZON MARKETPLACE",
    date: new Date().toISOString().split("T")[0],
  },
  {
    amount: -45.0,
    currency_code: "EUR",
    description: "PRLV FREE MOBILE",
    date: new Date().toISOString().split("T")[0],
  },
];

async function getItemIds() {
  // Connexion à MongoDB pour récupérer les item_ids
  await mongoose.connect(MONGODB_URI);
  console.log("✅ Connecté à MongoDB");

  const AccountBanking = mongoose.model(
    "AccountBanking",
    new mongoose.Schema({}, { strict: false }),
    "accounts_bankings"
  );

  const accounts = await AccountBanking.find({}).lean();

  // Extraire les item_ids uniques
  const itemIds = [
    ...new Set(accounts.map((acc) => acc.raw?.item_id).filter(Boolean)),
  ];

  console.log(`📊 ${accounts.length} comptes trouvés`);
  console.log(`🔑 Item IDs uniques: ${itemIds.join(", ")}`);

  await mongoose.disconnect();

  return itemIds;
}

async function createTransactionsViaBridge(itemId, transactions) {
  console.log(`\n🏦 Création de transactions pour item_id: ${itemId}`);

  try {
    const response = await axios.post(
      `${BRIDGE_BASE_URL}/v3/sandbox/items/${itemId}/transactions`,
      { transactions },
      {
        headers: {
          "Bridge-Version": "2021-06-01",
          "Client-Id": BRIDGE_CLIENT_ID,
          "Client-Secret": BRIDGE_CLIENT_SECRET,
          "Content-Type": "application/json",
        },
      }
    );

    console.log(`✅ ${transactions.length} transactions créées avec succès`);
    console.log("📝 Réponse:", JSON.stringify(response.data, null, 2));
    return true;
  } catch (error) {
    console.error(
      "❌ Erreur création transactions:",
      error.response?.data || error.message
    );
    return false;
  }
}

async function createTransactionsDirectlyInDB(workspaceId) {
  // Alternative: créer directement en base de données
  console.log("\n📝 Création directe en base de données...");

  await mongoose.connect(MONGODB_URI);

  const transactionSchema = new mongoose.Schema({}, { strict: false });
  const Transaction = mongoose.model(
    "Transaction",
    transactionSchema,
    "transactions"
  );

  const AccountBanking = mongoose.model(
    "AccountBankingRead",
    new mongoose.Schema({}, { strict: false }),
    "accounts_bankings"
  );

  // Récupérer un compte pour avoir le workspaceId
  const account = await AccountBanking.findOne({}).lean();
  if (!account) {
    console.error("❌ Aucun compte bancaire trouvé");
    await mongoose.disconnect();
    return;
  }

  const wsId = workspaceId || account.workspaceId;
  console.log(`📍 WorkspaceId: ${wsId}`);

  // Créer les transactions
  for (const tx of TEST_TRANSACTIONS) {
    const transaction = {
      externalId: `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      provider: "bridge",
      type: tx.amount > 0 ? "credit" : "debit",
      status: "completed",
      amount: tx.amount,
      currency: tx.currency_code,
      description: tx.description,
      workspaceId: wsId,
      date: new Date(tx.date),
      processedAt: new Date(),
      reconciliationStatus: "unmatched",
      metadata: { source: "test-script" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await Transaction.create(transaction);
    console.log(
      `  ✅ Transaction créée: ${tx.description} (${tx.amount > 0 ? "+" : ""}${tx.amount}€)`
    );
  }

  console.log(
    `\n✅ ${TEST_TRANSACTIONS.length} transactions de test créées en base`
  );

  await mongoose.disconnect();
}

async function main() {
  console.log("🚀 Script de création de transactions de test\n");
  console.log("Configuration:");
  console.log(
    `  - Bridge Client ID: ${BRIDGE_CLIENT_ID ? "✅ Défini" : "❌ Manquant"}`
  );
  console.log(
    `  - Bridge Client Secret: ${BRIDGE_CLIENT_SECRET ? "✅ Défini" : "❌ Manquant"}`
  );
  console.log(`  - MongoDB URI: ${MONGODB_URI ? "✅ Défini" : "❌ Manquant"}`);

  if (!MONGODB_URI) {
    console.error("\n❌ MONGODB_URI non défini dans .env.development");
    process.exit(1);
  }

  // Méthode 1: Essayer via l'API Bridge Sandbox
  if (BRIDGE_CLIENT_ID && BRIDGE_CLIENT_SECRET) {
    try {
      const itemIds = await getItemIds();

      if (itemIds.length > 0) {
        // Créer les transactions pour le premier item
        const success = await createTransactionsViaBridge(
          itemIds[0],
          TEST_TRANSACTIONS
        );

        if (success) {
          console.log("\n✅ Transactions créées via Bridge API");
          console.log("💡 Lance une synchronisation pour les voir dans Newbi");
          process.exit(0);
        }
      }
    } catch (error) {
      console.log(
        "⚠️ Échec via Bridge API, utilisation de la méthode directe..."
      );
    }
  }

  // Méthode 2: Créer directement en base de données
  await createTransactionsDirectlyInDB();

  console.log(
    "\n🎉 Terminé ! Rafraîchis le dashboard pour voir les transactions."
  );
}

main().catch(console.error);
