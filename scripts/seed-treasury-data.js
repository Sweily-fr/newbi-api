/**
 * Script pour générer des données de test pour le graphique de trésorerie
 * Usage: node scripts/seed-treasury-data.js
 */

import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/newbi";

async function seedTreasuryData() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log("✅ Connecté à MongoDB");

    const db = client.db();

    // Utiliser le workspace ID fourni (essayer les deux formats)
    const workspaceIdString = "69028f4e5006f7d6d508b496";

    // Récupérer le workspace (essayer avec string et ObjectId)
    let workspace = await db
      .collection("organization")
      .findOne({ _id: workspaceIdString });
    if (!workspace) {
      workspace = await db
        .collection("organization")
        .findOne({ _id: new ObjectId(workspaceIdString) });
    }

    const workspaceId = workspace?._id || workspaceIdString;

    // Récupérer un utilisateur
    const user = await db.collection("user").findOne({});

    if (!workspace) {
      console.error(
        "❌ Workspace non trouvé avec l'ID: 69028f4e5006f7d6d508b496"
      );
      return;
    }

    if (!user) {
      console.error("❌ Aucun utilisateur trouvé pour ce workspace.");
      return;
    }

    console.log("📋 Workspace:", workspace.name || workspace._id);
    console.log("👤 Utilisateur:", user.name || user.email);

    const now = new Date();
    const expenses = [];

    // Générer des dépenses pour les 90 derniers jours
    console.log("💰 Génération des dépenses...");
    for (let i = 89; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);

      // 40% de chance d'avoir une dépense par jour
      if (Math.random() > 0.6) {
        const categories = [
          "OFFICE_SUPPLIES",
          "TRAVEL",
          "MEALS",
          "SERVICES",
          "MARKETING",
          "EQUIPMENT",
        ];

        const vendors = [
          "Amazon",
          "OVH",
          "Free",
          "Uber",
          "Restaurant Le Gourmet",
          "SNCF",
          "Google Ads",
          "Office Depot",
        ];

        const amount = Math.floor(Math.random() * 500) + 50; // Entre 50€ et 550€
        const category =
          categories[Math.floor(Math.random() * categories.length)];
        const vendor = vendors[Math.floor(Math.random() * vendors.length)];

        expenses.push({
          _id: new ObjectId(),
          workspaceId: workspaceId,
          userId: user._id,
          title: `Dépense ${vendor}`,
          description: `Achat chez ${vendor}`,
          amount: amount,
          currency: "EUR",
          category: category,
          vendor: vendor,
          date: date.toISOString().split("T")[0],
          paymentMethod: "CARD",
          status: "PAID",
          expenseType: "ORGANIZATION",
          isVatDeductible: true,
          vatRate: 20,
          vatAmount: amount * 0.2,
          files: [],
          tags: [],
          createdAt: date,
          updatedAt: date,
        });
      }
    }


    // Insérer les dépenses
    if (expenses.length > 0) {
      await db.collection("expenses").insertMany(expenses);
      console.log(`✅ ${expenses.length} dépenses insérées dans la collection 'expenses'`);
    }

    // Statistiques
    const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);

    console.log("\n📊 Statistiques:");
    console.log(`💸 Total dépenses: ${totalExpenses.toFixed(2)} €`);
    console.log(`📝 Nombre de dépenses: ${expenses.length}`);
    console.log(`\n✨ Données générées avec succès!`);
  } catch (error) {
    console.error("❌ Erreur:", error);
  } finally {
    await client.close();
    console.log("🔌 Déconnecté de MongoDB");
  }
}

// Exécuter le script
seedTreasuryData();
