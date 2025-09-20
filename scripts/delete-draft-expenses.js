import { MongoClient } from 'mongodb';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Charger la configuration depuis ecosystem.config.cjs
let MONGODB_URI;
try {
  const ecosystemConfig = require(path.join(__dirname, '..', 'ecosystem.config.cjs'));
  MONGODB_URI = ecosystemConfig.apps[0].env.MONGODB_URI;
} catch (error) {
  console.error('❌ Erreur lors du chargement de ecosystem.config.cjs:', error.message);
  process.exit(1);
}

async function deleteDraftExpenses() {
  let client;
  
  try {
    console.log('🚀 Connexion à MongoDB...');
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('✅ Connecté à MongoDB');

    const db = client.db();
    const expensesCollection = db.collection('expenses');

    // 1. Analyser les dépenses DRAFT
    console.log('\n📊 Analyse des dépenses DRAFT...');
    const draftExpenses = await expensesCollection.find({ status: 'DRAFT' }).toArray();
    
    if (draftExpenses.length === 0) {
      console.log('✅ Aucune dépense DRAFT trouvée');
      return;
    }

    console.log(`⚠️  Trouvé ${draftExpenses.length} dépenses DRAFT:`);
    
    let totalDraftAmount = 0;
    draftExpenses.forEach((expense, index) => {
      console.log(`\n${index + 1}. Dépense ID: ${expense._id}`);
      console.log(`   Titre: ${expense.title || 'N/A'}`);
      console.log(`   Montant: ${expense.amount || 0}€`);
      console.log(`   WorkspaceId: ${expense.workspaceId}`);
      console.log(`   Date: ${expense.date || expense.createdAt}`);
      totalDraftAmount += expense.amount || 0;
    });

    console.log(`\n💰 Montant total des dépenses DRAFT: ${totalDraftAmount}€`);

    // 2. Supprimer les dépenses DRAFT
    console.log('\n🗑️  Suppression des dépenses DRAFT...');
    const deleteResult = await expensesCollection.deleteMany({ status: 'DRAFT' });

    console.log(`✅ ${deleteResult.deletedCount} dépenses DRAFT supprimées`);
    console.log(`💰 Montant récupéré: ${totalDraftAmount}€`);

    // 3. Vérification finale
    console.log('\n🔍 Vérification finale...');
    const remainingDrafts = await expensesCollection.countDocuments({ status: 'DRAFT' });
    console.log(`📊 Dépenses DRAFT restantes: ${remainingDrafts}`);

  } catch (error) {
    console.error('❌ Erreur lors de la suppression des dépenses DRAFT:', error);
  } finally {
    if (client) {
      await client.close();
      console.log('\n🔌 Déconnecté de MongoDB');
    }
  }
}

// Exécuter le script
deleteDraftExpenses()
  .then(() => {
    console.log('\n🎉 Suppression des dépenses DRAFT terminée');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Erreur fatale:', error);
    process.exit(1);
  });
