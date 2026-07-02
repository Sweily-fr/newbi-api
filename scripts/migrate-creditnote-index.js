import mongoose from "mongoose";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger les variables d'environnement
dotenv.config({ path: join(__dirname, "..", ".env") });

/**
 * Migration : index unique des avoirs.
 *
 * L'ancien index "creditnote_number_workspaceId_year_unique" n'incluait pas le
 * prefix, alors que le compteur (DocumentCounter) est keyé par préfixe et que
 * le préfixe par défaut est mensuel (AV-AAAAMM). Résultat : deux avoirs "0001"
 * émis en janvier et février de la même année entraient en collision (E11000)
 * et la création du second échouait.
 *
 * Le nouvel index "creditnote_prefix_number_workspaceId_year_unique"
 * (prefix + number + workspaceId + issueYear) est aligné sur ceux des
 * factures, devis et bons de commande. Il est défini dans
 * src/models/CreditNote.js et créé ici explicitement (ou au redémarrage du
 * serveur via autoIndex).
 */
async function migrateCreditNoteIndex() {
  try {
    console.log("🔄 Connexion à MongoDB...");
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connecté à MongoDB");

    const collection = mongoose.connection.db.collection("creditnotes");

    console.log("\n📋 Index actuels de la collection creditnotes:");
    const indexes = await collection.indexes();
    indexes.forEach((index) => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });

    // ORDRE IMPORTANT : créer le NOUVEL index AVANT de supprimer l'ancien.
    // La nouvelle clé (prefix+number+workspaceId+issueYear) est un sur-ensemble
    // de l'ancienne : les deux peuvent coexister. Ainsi la collection n'est
    // JAMAIS sans contrainte d'unicité, même si le script s'interrompt entre
    // les deux étapes (prod vivante).

    // 1. Créer le nouvel index (avec prefix)
    console.log("\n🔨 Création du nouvel index...");
    await collection.createIndex(
      { prefix: 1, number: 1, workspaceId: 1, issueYear: 1 },
      {
        unique: true,
        partialFilterExpression: { number: { $exists: true } },
        name: "creditnote_prefix_number_workspaceId_year_unique",
      },
    );
    console.log(
      '✅ Index "creditnote_prefix_number_workspaceId_year_unique" créé',
    );

    // 2. Supprimer l'ancien index (sans prefix) — seulement une fois le nouvel
    // index en place.
    console.log("\n🗑️  Suppression de l'ancien index...");
    try {
      await collection.dropIndex("creditnote_number_workspaceId_year_unique");
      console.log(
        '✅ Index "creditnote_number_workspaceId_year_unique" supprimé',
      );
    } catch (err) {
      if (err.code === 27) {
        console.log(
          '⚠️  Index "creditnote_number_workspaceId_year_unique" n\'existe pas (déjà migré ?)',
        );
      } else {
        throw err;
      }
    }

    console.log("\n📋 Index après migration:");
    const finalIndexes = await collection.indexes();
    finalIndexes.forEach((index) => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });

    console.log("\n🎉 Migration terminée !");
  } catch (error) {
    console.error("❌ Erreur pendant la migration:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

migrateCreditNoteIndex();
