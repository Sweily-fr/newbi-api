import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/invoice-app';

async function fixDraftDuplicates() {
  try {
    // Connexion à MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('invoices');

    console.log('🚀 Début de la correction des brouillons en double...\n');

    // ÉTAPE 1: Nettoyer les brouillons en double
    console.log('📋 ÉTAPE 1: Nettoyage des brouillons en double');
    console.log('=' .repeat(50));

    const pipeline = [
      {
        $match: {
          status: 'DRAFT',
          number: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: {
            number: '$number',
            workspaceId: '$workspaceId',
            issueYear: '$issueYear'
          },
          docs: { $push: '$$ROOT' },
          count: { $sum: 1 }
        }
      },
      {
        $match: {
          count: { $gt: 1 }
        }
      }
    ];

    const duplicates = await collection.aggregate(pipeline).toArray();
    
    if (duplicates.length === 0) {
      console.log('✅ Aucun brouillon en double trouvé');
    } else {
      console.log(`🔍 Trouvé ${duplicates.length} groupes de brouillons en double`);

      let totalRenamed = 0;

      for (const group of duplicates) {
        const docs = group.docs;
        console.log(`\n📝 Traitement du groupe: ${group._id.number} (${docs.length} documents)`);

        // Garder le plus récent, renommer les autres
        docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const [keepDoc, ...renameeDocs] = docs;

        console.log(`  ✅ Garder: ${keepDoc._id} (créé le ${keepDoc.createdAt})`);

        for (const doc of renameeDocs) {
          const timestamp = Date.now() + Math.floor(Math.random() * 1000);
          const newNumber = `DRAFT-${doc.number}-${timestamp}`;
          
          await collection.updateOne(
            { _id: doc._id },
            { $set: { number: newNumber } }
          );

          console.log(`  🔄 Renommé: ${doc._id} -> ${newNumber}`);
          totalRenamed++;
        }
      }

      console.log(`\n✅ Étape 1 terminée: ${totalRenamed} brouillons renommés`);
    }

    // ÉTAPE 2: Corriger les index
    console.log('\n📋 ÉTAPE 2: Correction des index');
    console.log('=' .repeat(50));

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
      console.log(`\n🗑️  Suppression de l'ancien index: ${oldIndexName}`);
      await collection.dropIndex(oldIndexName);
      console.log('✅ Ancien index supprimé avec succès');
    } else {
      console.log('\nℹ️  Aucun ancien index à supprimer');
    }

    // Vérifier si le nouvel index existe
    const newIndexName = 'number_workspaceId_year_unique';
    const hasNewIndex = indexes.some(index => index.name === newIndexName);

    if (!hasNewIndex) {
      console.log(`\n🔧 Création du nouvel index: ${newIndexName}`);
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
      console.log('\nℹ️  Le nouvel index existe déjà');
    }

    // Lister les index après modification
    const updatedIndexes = await collection.indexes();
    console.log('\n📋 Index après correction:');
    updatedIndexes.forEach(index => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });

    console.log('\n🎉 CORRECTION TERMINÉE AVEC SUCCÈS!');
    console.log('✅ Vous pouvez maintenant créer de nouveaux brouillons sans conflit');

  } catch (error) {
    console.error('❌ Erreur lors de la correction:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Déconnecté de MongoDB');
  }
}

// Exécuter le script
fixDraftDuplicates().catch(console.error);
