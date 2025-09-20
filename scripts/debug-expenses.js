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

async function debugExpenses() {
  let client;
  
  try {
    console.log('🚀 Connexion à MongoDB...');
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('✅ Connecté à MongoDB');

    const db = client.db();
    const expensesCollection = db.collection('expenses');

    // 1. Statistiques générales
    console.log('\n📊 STATISTIQUES GÉNÉRALES:');
    const totalExpenses = await expensesCollection.countDocuments();
    console.log(`Total des dépenses: ${totalExpenses}`);

    // 2. Répartition par workspaceId
    console.log('\n🏢 RÉPARTITION PAR WORKSPACE:');
    const workspaceStats = await expensesCollection.aggregate([
      {
        $group: {
          _id: '$workspaceId',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      },
      { $sort: { totalAmount: -1 } }
    ]).toArray();

    workspaceStats.forEach(stat => {
      console.log(`WorkspaceId: ${stat._id || 'NULL'} - Count: ${stat.count} - Total: ${stat.totalAmount}€`);
    });

    // 3. Toutes les dépenses avec leurs détails
    console.log('\n📋 TOUTES LES DÉPENSES:');
    const allExpenses = await expensesCollection.find({}).toArray();
    
    if (allExpenses.length === 0) {
      console.log('❌ Aucune dépense trouvée dans la base de données');
    } else {
      allExpenses.forEach((expense, index) => {
        console.log(`\n${index + 1}. Dépense ID: ${expense._id}`);
        console.log(`   Titre: ${expense.title || 'N/A'}`);
        console.log(`   Montant: ${expense.amount || 0}€`);
        console.log(`   WorkspaceId: ${expense.workspaceId || 'NULL'}`);
        console.log(`   CreatedBy: ${expense.createdBy || 'N/A'}`);
        console.log(`   Status: ${expense.status || 'N/A'}`);
        console.log(`   Date: ${expense.date || expense.createdAt || 'N/A'}`);
      });
    }

    // 4. Calcul du total exact
    console.log('\n💰 CALCUL TOTAL:');
    const totalAmountResult = await expensesCollection.aggregate([
      { $group: { _id: null, totalAmount: { $sum: '$amount' } } }
    ]).toArray();
    
    const totalAmount = totalAmountResult.length > 0 ? totalAmountResult[0].totalAmount : 0;
    console.log(`Montant total de TOUTES les dépenses: ${totalAmount}€`);

    // 5. Vérifier les dépenses par statut
    console.log('\n📈 RÉPARTITION PAR STATUT:');
    const statusStats = await expensesCollection.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      }
    ]).toArray();

    statusStats.forEach(stat => {
      console.log(`Status: ${stat._id || 'NULL'} - Count: ${stat.count} - Total: ${stat.totalAmount}€`);
    });

  } catch (error) {
    console.error('❌ Erreur lors du debug:', error);
  } finally {
    if (client) {
      await client.close();
      console.log('\n🔌 Déconnecté de MongoDB');
    }
  }
}

// Exécuter le script
debugExpenses()
  .then(() => {
    console.log('\n🎉 Debug terminé');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Erreur fatale:', error);
    process.exit(1);
  });
