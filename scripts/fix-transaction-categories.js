#!/usr/bin/env node

/**
 * Script de migration pour corriger les catégories des transactions
 * Met à jour les transactions qui ont category ou expenseCategory à null
 * en utilisant les métadonnées Bridge (bridgeCategoryId ou bridgeCategoryMapped)
 *
 * Usage: node scripts/fix-transaction-categories.js [--apply]
 *   Sans --apply: mode preview (aucune modification)
 *   Avec --apply: applique les modifications
 */

import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

// Configuration
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}
const DB_NAME = 'newbi';

// Mapping des catégories Bridge vers nos catégories internes
const bridgeCategoryMapping = {
  // Alimentation & Restauration
  270: "MEALS",
  271: "MEALS",
  272: "MEALS",
  273: "MEALS",
  274: "MEALS",

  // Transport & Voyages
  280: "TRAVEL",
  281: "TRAVEL",
  282: "TRAVEL",
  283: "TRAVEL",
  284: "TRAVEL",
  285: "TRAVEL",
  286: "TRAVEL",
  287: "TRAVEL",
  288: "TRAVEL",

  // Hébergement
  290: "ACCOMMODATION",
  291: "ACCOMMODATION",

  // Achats & Shopping
  300: "OFFICE_SUPPLIES",
  301: "HARDWARE",
  302: "OFFICE_SUPPLIES",
  303: "OFFICE_SUPPLIES",

  // Services & Abonnements
  310: "SUBSCRIPTIONS",
  311: "SOFTWARE",
  312: "SUBSCRIPTIONS",
  313: "SUBSCRIPTIONS",
  314: "SUBSCRIPTIONS",

  // Santé & Bien-être
  320: "SERVICES",
  321: "SERVICES",
  322: "SERVICES",

  // Logement & Charges
  330: "RENT",
  331: "UTILITIES",
  332: "UTILITIES",
  333: "UTILITIES",
  334: "UTILITIES",
  335: "MAINTENANCE",

  // Banque & Assurances
  340: "SERVICES",
  341: "INSURANCE",
  342: "INSURANCE",
  343: "INSURANCE",
  344: "INSURANCE",

  // Impôts & Taxes
  350: "TAXES",
  351: "TAXES",
  352: "TAXES",
  353: "TAXES",
  354: "TAXES",

  // Loisirs & Sorties
  360: "OTHER",
  361: "OTHER",
  362: "OTHER",
  363: "OTHER",

  // Éducation & Formation
  370: "TRAINING",
  371: "TRAINING",
  372: "TRAINING",

  // Professionnels
  380: "SERVICES",
  381: "MARKETING",
  382: "SERVICES",
  383: "SALARIES",
  384: "SERVICES",

  // Catégories génériques Bridge
  1: "OTHER",
  2: "OTHER",
  3: "OTHER",
};

// Statistiques globales
const stats = {
  totalTransactions: 0,
  transactionsToFix: 0,
  fixed: 0,
  skipped: 0,
  errors: 0,
  byCategory: {}
};

/**
 * Mappe un ID de catégorie Bridge vers notre catégorie interne
 */
function mapBridgeCategory(bridgeCategoryId) {
  if (!bridgeCategoryId) return "OTHER";
  return bridgeCategoryMapping[bridgeCategoryId] || "OTHER";
}

/**
 * Analyse et corrige les transactions
 */
async function fixTransactionCategories(applyChanges = false) {
  console.log('🔄 Script de correction des catégories de transactions');
  console.log(`   Mode: ${applyChanges ? '✅ APPLICATION' : '👀 PREVIEW (--apply pour appliquer)'}`);
  console.log('');

  let client;

  try {
    // Connexion à MongoDB
    console.log('📡 Connexion à MongoDB...');
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('✅ Connecté à MongoDB');

    const db = client.db(DB_NAME);
    const transactionsCollection = db.collection('transactions');

    // Compter le total des transactions
    stats.totalTransactions = await transactionsCollection.countDocuments();
    console.log(`📊 Total transactions en base: ${stats.totalTransactions}`);

    // Trouver les transactions avec category ou expenseCategory null/manquant
    const transactionsToFix = await transactionsCollection.find({
      $or: [
        { category: null },
        { category: { $exists: false } },
        { expenseCategory: null },
        { expenseCategory: { $exists: false } }
      ]
    }).toArray();

    stats.transactionsToFix = transactionsToFix.length;
    console.log(`🔍 Transactions à corriger: ${stats.transactionsToFix}`);
    console.log('');

    if (transactionsToFix.length === 0) {
      console.log('✅ Aucune transaction à corriger !');
      return;
    }

    // Traiter chaque transaction
    for (const transaction of transactionsToFix) {
      try {
        // Déterminer la catégorie à utiliser
        let newCategory = null;

        // 1. Essayer d'utiliser la catégorie mappée déjà présente dans les métadonnées
        if (transaction.metadata?.bridgeCategoryMapped) {
          newCategory = transaction.metadata.bridgeCategoryMapped;
        }
        // 2. Sinon, mapper depuis l'ID de catégorie Bridge
        else if (transaction.metadata?.bridgeCategoryId) {
          newCategory = mapBridgeCategory(transaction.metadata.bridgeCategoryId);
        }
        // 3. Fallback vers OTHER
        else {
          newCategory = "OTHER";
        }

        // Vérifier si c'est une catégorie valide
        const validCategories = [
          "OFFICE_SUPPLIES", "TRAVEL", "MEALS", "ACCOMMODATION",
          "SOFTWARE", "HARDWARE", "SERVICES", "MARKETING",
          "TAXES", "RENT", "UTILITIES", "SALARIES",
          "INSURANCE", "MAINTENANCE", "TRAINING", "SUBSCRIPTIONS", "OTHER"
        ];

        if (!validCategories.includes(newCategory)) {
          newCategory = "OTHER";
        }

        // Statistiques par catégorie
        stats.byCategory[newCategory] = (stats.byCategory[newCategory] || 0) + 1;

        // Appliquer la correction si demandé
        if (applyChanges) {
          const updateResult = await transactionsCollection.updateOne(
            { _id: transaction._id },
            {
              $set: {
                category: newCategory,
                expenseCategory: newCategory
              }
            }
          );

          if (updateResult.modifiedCount > 0) {
            stats.fixed++;
          } else {
            stats.skipped++;
          }
        } else {
          stats.fixed++;
        }

        // Log de progression tous les 100 transactions
        if ((stats.fixed + stats.skipped) % 100 === 0) {
          console.log(`   Progression: ${stats.fixed + stats.skipped}/${stats.transactionsToFix}`);
        }

      } catch (error) {
        stats.errors++;
        console.error(`   ❌ Erreur sur transaction ${transaction._id}: ${error.message}`);
      }
    }

    // Afficher le résumé
    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('                    📊 RÉSUMÉ');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`   Total transactions: ${stats.totalTransactions}`);
    console.log(`   À corriger: ${stats.transactionsToFix}`);
    console.log(`   ${applyChanges ? 'Corrigées' : 'Prévues'}: ${stats.fixed}`);
    console.log(`   Ignorées: ${stats.skipped}`);
    console.log(`   Erreurs: ${stats.errors}`);
    console.log('');
    console.log('   Répartition par catégorie:');

    Object.entries(stats.byCategory)
      .sort((a, b) => b[1] - a[1])
      .forEach(([category, count]) => {
        console.log(`     ${category}: ${count}`);
      });

    console.log('═══════════════════════════════════════════════════════');

    if (!applyChanges) {
      console.log('');
      console.log('💡 Pour appliquer les modifications, relancez avec --apply :');
      console.log('   node scripts/fix-transaction-categories.js --apply');
    }

  } catch (error) {
    console.error('❌ Erreur fatale:', error);
    process.exit(1);
  } finally {
    if (client) {
      await client.close();
      console.log('');
      console.log('📡 Connexion MongoDB fermée');
    }
  }
}

// Exécution
const applyChanges = process.argv.includes('--apply');
fixTransactionCategories(applyChanges);
