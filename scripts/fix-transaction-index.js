import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

async function fixTransactionIndex() {
  try {
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    // Accéder à la collection transactions
    const db = mongoose.connection.db;
    const collection = db.collection('transactions');

    // Lister tous les index existants
    console.log('\n📋 Index existants sur transactions:');
    const indexes = await collection.indexes();
    indexes.forEach(index => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });

    // Supprimer l'ancien index bridgeTransactionId_1 s'il existe
    try {
      await collection.dropIndex('bridgeTransactionId_1');
      console.log('\n✅ Index bridgeTransactionId_1 supprimé avec succès');
    } catch (error) {
      if (error.code === 27) {
        console.log('\n⚠️  Index bridgeTransactionId_1 n\'existe pas');
      } else {
        console.error('\n❌ Erreur suppression index bridgeTransactionId_1:', error.message);
      }
    }

    // Supprimer aussi d'autres anciens index potentiels
    const oldIndexes = ['bridgeTransactionId_1', 'bridgeAccountId_1'];
    for (const indexName of oldIndexes) {
      try {
        await collection.dropIndex(indexName);
        console.log(`✅ Index ${indexName} supprimé`);
      } catch (error) {
        if (error.code !== 27) {
          console.log(`⚠️  Index ${indexName} n'existe pas ou erreur:`, error.message);
        }
      }
    }

    // Vérifier les index après nettoyage
    console.log('\n📋 Index après nettoyage:');
    const newIndexes = await collection.indexes();
    newIndexes.forEach(index => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });

    // Compter les transactions existantes
    const transactionCount = await collection.countDocuments();
    console.log(`\n📊 Nombre de transactions dans la collection: ${transactionCount}`);

    console.log('\n✅ Nettoyage des index terminé');

  } catch (error) {
    console.error('❌ Erreur:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Déconnecté de MongoDB');
    process.exit(0);
  }
}

// Exécuter le script
fixTransactionIndex();
