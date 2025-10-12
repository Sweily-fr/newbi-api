import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/invoice-app';

async function fixInvoiceIndex() {
  try {
    // Connexion à MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('invoices');

    // Lister tous les index existants
    const indexes = await collection.indexes();
    console.log('📋 Index existants:');
    indexes.forEach(index => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });

    // Vérifier si l'ancien index existe
    const oldIndexName = 'number_createdBy_year_unique';
    const hasOldIndex = indexes.some(index => index.name === oldIndexName);

    if (hasOldIndex) {
      console.log(`🗑️  Suppression de l'ancien index: ${oldIndexName}`);
      await collection.dropIndex(oldIndexName);
      console.log('✅ Ancien index supprimé avec succès');
    } else {
      console.log('ℹ️  Aucun ancien index à supprimer');
    }

    // Vérifier si le nouvel index existe
    const newIndexName = 'number_workspaceId_year_unique';
    const hasNewIndex = indexes.some(index => index.name === newIndexName);

    if (!hasNewIndex) {
      console.log(`🔧 Création du nouvel index: ${newIndexName}`);
      await collection.createIndex(
        {
          number: 1,
          workspaceId: 1,
          issueYear: 1
        },
        {
          unique: true,
          partialFilterExpression: { number: { $exists: true } },
          name: newIndexName,
        }
      );
      console.log('✅ Nouvel index créé avec succès');
    } else {
      console.log('ℹ️  Le nouvel index existe déjà');
    }

    // Lister les index après modification
    const updatedIndexes = await collection.indexes();
    console.log('📋 Index après modification:');
    updatedIndexes.forEach(index => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });

    console.log('🎉 Migration des index terminée avec succès');

  } catch (error) {
    console.error('❌ Erreur lors de la migration des index:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Déconnecté de MongoDB');
  }
}

// Exécuter le script
fixInvoiceIndex();
