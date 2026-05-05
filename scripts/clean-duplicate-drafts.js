import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}

async function cleanDuplicateDrafts() {
  try {
    // Connexion à MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('invoices');

    // Trouver tous les brouillons avec des numéros en double
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
      return;
    }

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

    console.log(`\n🎉 Migration terminée: ${totalRenamed} brouillons renommés`);

  } catch (error) {
    console.error('❌ Erreur lors du nettoyage des doublons:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Déconnecté de MongoDB');
  }
}

// Exécuter le script
cleanDuplicateDrafts();
