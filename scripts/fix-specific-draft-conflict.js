import mongoose from 'mongoose';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/invoice-app';

async function fixSpecificDraftConflict() {
  try {
    // Connexion à MongoDB
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('invoices');

    // Rechercher le conflit spécifique
    const conflictQuery = {
      number: "DRAFT-000002",
      workspaceId: new mongoose.Types.ObjectId('68c6872c8d7d37aa7f55db33'),
      issueYear: 2025
    };

    console.log('🔍 Recherche du conflit spécifique...');
    console.log('Critères:', JSON.stringify(conflictQuery, null, 2));

    const conflictingDrafts = await collection.find(conflictQuery).toArray();
    
    console.log(`📋 Trouvé ${conflictingDrafts.length} document(s) en conflit:`);
    
    if (conflictingDrafts.length === 0) {
      console.log('ℹ️  Aucun document trouvé avec ces critères');
      
      // Rechercher des documents similaires
      console.log('\n🔍 Recherche de documents similaires...');
      
      const similarDrafts = await collection.find({
        number: { $regex: /^DRAFT-000002/ },
        workspaceId: new mongoose.Types.ObjectId('68c6872c8d7d37aa7f55db33')
      }).toArray();
      
      console.log(`📋 Trouvé ${similarDrafts.length} document(s) similaire(s):`);
      similarDrafts.forEach((doc, index) => {
        console.log(`  ${index + 1}. ID: ${doc._id}`);
        console.log(`     Numéro: ${doc.number}`);
        console.log(`     Statut: ${doc.status}`);
        console.log(`     Année: ${doc.issueYear}`);
        console.log(`     Créé le: ${doc.createdAt}`);
        console.log('');
      });
      
      return;
    }

    // Afficher les détails des documents en conflit
    conflictingDrafts.forEach((doc, index) => {
      console.log(`\n📄 Document ${index + 1}:`);
      console.log(`  ID: ${doc._id}`);
      console.log(`  Numéro: ${doc.number}`);
      console.log(`  Statut: ${doc.status}`);
      console.log(`  Année: ${doc.issueYear}`);
      console.log(`  Créé le: ${doc.createdAt}`);
      console.log(`  Modifié le: ${doc.updatedAt}`);
    });

    if (conflictingDrafts.length === 1) {
      const doc = conflictingDrafts[0];
      
      // Renommer le document existant
      const timestamp = Date.now();
      const newNumber = `DRAFT-000002-${timestamp}`;
      
      console.log(`\n🔄 Renommage du document existant:`);
      console.log(`  Ancien numéro: ${doc.number}`);
      console.log(`  Nouveau numéro: ${newNumber}`);
      
      const result = await collection.updateOne(
        { _id: doc._id },
        { 
          $set: { 
            number: newNumber,
            updatedAt: new Date()
          } 
        }
      );
      
      if (result.modifiedCount === 1) {
        console.log('✅ Document renommé avec succès');
        console.log('✅ Vous pouvez maintenant créer un nouveau brouillon DRAFT-000002');
      } else {
        console.log('❌ Échec du renommage');
      }
      
    } else if (conflictingDrafts.length > 1) {
      console.log(`\n🔄 Renommage de ${conflictingDrafts.length} documents en conflit:`);
      
      // Trier par date de création (garder le plus récent)
      conflictingDrafts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      
      // Renommer tous sauf le plus récent
      const [keepDoc, ...renameeDocs] = conflictingDrafts;
      
      console.log(`✅ Garder le plus récent: ${keepDoc._id} (créé le ${keepDoc.createdAt})`);
      
      for (let i = 0; i < renameeDocs.length; i++) {
        const doc = renameeDocs[i];
        const timestamp = Date.now() + i + 1; // Éviter les doublons
        const newNumber = `DRAFT-000002-${timestamp}`;
        
        console.log(`🔄 Renommage: ${doc._id} -> ${newNumber}`);
        
        await collection.updateOne(
          { _id: doc._id },
          { 
            $set: { 
              number: newNumber,
              updatedAt: new Date()
            } 
          }
        );
      }
      
      console.log(`✅ ${renameeDocs.length} document(s) renommé(s) avec succès`);
      console.log('✅ Vous pouvez maintenant créer un nouveau brouillon DRAFT-000002');
    }

    console.log('\n🎉 CORRECTION TERMINÉE AVEC SUCCÈS!');

  } catch (error) {
    console.error('❌ Erreur lors de la correction:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Déconnecté de MongoDB');
  }
}

// Exécuter le script
fixSpecificDraftConflict().catch(console.error);
