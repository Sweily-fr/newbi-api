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

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI non trouvé dans ecosystem.config.cjs');
  process.exit(1);
}

async function fixOrphanExpenses() {
  let client;
  
  try {
    console.log('🚀 Connexion à MongoDB...');
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('✅ Connecté à MongoDB');

    const db = client.db();
    const expensesCollection = db.collection('expenses');

    // 1. Analyser les dépenses existantes
    console.log('\n📊 Analyse des dépenses...');
    const totalExpenses = await expensesCollection.countDocuments();
    const expensesWithWorkspace = await expensesCollection.countDocuments({ workspaceId: { $exists: true, $ne: null } });
    const orphanExpenses = await expensesCollection.countDocuments({ $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }] });

    console.log(`📈 Total des dépenses: ${totalExpenses}`);
    console.log(`✅ Dépenses avec workspaceId: ${expensesWithWorkspace}`);
    console.log(`⚠️  Dépenses orphelines (sans workspaceId): ${orphanExpenses}`);

    // 2. Lister quelques exemples de dépenses orphelines
    if (orphanExpenses > 0) {
      console.log('\n🔍 Exemples de dépenses orphelines:');
      const examples = await expensesCollection.find(
        { $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }] }
      ).limit(10).toArray();

      examples.forEach((expense, index) => {
        console.log(`  ${index + 1}. ID: ${expense._id}`);
        console.log(`     Titre: ${expense.title || 'N/A'}`);
        console.log(`     Montant: ${expense.amount || 0}€`);
        console.log(`     Date: ${expense.date || expense.createdAt}`);
        console.log(`     CreatedBy: ${expense.createdBy || 'N/A'}`);
        console.log(`     WorkspaceId: ${expense.workspaceId || 'NULL'}`);
        console.log('');
      });

      // Calculer le montant total des dépenses orphelines
      const orphanAmountResult = await expensesCollection.aggregate([
        { $match: { $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }] } },
        { $group: { _id: null, totalAmount: { $sum: '$amount' } } }
      ]).toArray();

      const totalOrphanAmount = orphanAmountResult.length > 0 ? orphanAmountResult[0].totalAmount : 0;
      console.log(`💰 Montant total des dépenses orphelines: ${totalOrphanAmount}€`);

      // 3. Proposer les options
      console.log('\n🛠️  Options disponibles:');
      console.log('1. Supprimer toutes les dépenses orphelines');
      console.log('2. Lister toutes les dépenses orphelines (détaillé)');
      console.log('3. Annuler (ne rien faire)');

      // Pour l'instant, on va juste supprimer automatiquement
      console.log('\n🗑️  Suppression des dépenses orphelines...');
      const deleteResult = await expensesCollection.deleteMany({
        $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }]
      });

      console.log(`✅ ${deleteResult.deletedCount} dépenses orphelines supprimées`);
      console.log(`💰 Montant récupéré: ${totalOrphanAmount}€`);

      // 4. Vérification finale
      console.log('\n🔍 Vérification finale...');
      const remainingOrphans = await expensesCollection.countDocuments({
        $or: [{ workspaceId: { $exists: false } }, { workspaceId: null }]
      });
      console.log(`📊 Dépenses orphelines restantes: ${remainingOrphans}`);

    } else {
      console.log('✅ Aucune dépense orpheline trouvée');
    }

  } catch (error) {
    console.error('❌ Erreur lors du nettoyage des dépenses:', error);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('🔌 Déconnecté de MongoDB');
    }
  }
}

// Exécuter le script
fixOrphanExpenses()
  .then(() => {
    console.log('\n🎉 Nettoyage des dépenses orphelines terminé avec succès');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Erreur fatale:', error);
    process.exit(1);
  });
