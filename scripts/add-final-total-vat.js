/**
 * Script de migration pour ajouter le champ finalTotalVAT aux documents existants
 * Ce champ stocke la TVA finale après application de la remise globale
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger les variables d'environnement
dotenv.config({ path: path.join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI non défini dans les variables d\'environnement');
  process.exit(1);
}

// Fonction pour calculer finalTotalVAT
function calculateFinalTotalVAT(doc) {
  const totalHT = doc.totalHT || 0;
  const totalVAT = doc.totalVAT || 0;
  const finalTotalHT = doc.finalTotalHT || 0;

  // Si finalTotalHT <= 0 (remise >= 100%), la TVA finale est 0
  if (finalTotalHT <= 0 || totalHT <= 0) {
    return 0;
  }

  // Calculer la TVA proportionnelle au montant final HT
  const finalTotalVAT = totalVAT * (finalTotalHT / totalHT);
  
  return parseFloat(finalTotalVAT.toFixed(2));
}

async function migrateDocuments() {
  try {
    console.log('🔌 Connexion à MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB\n');

    const collections = ['invoices', 'quotes', 'creditnotes'];
    let totalUpdated = 0;

    for (const collectionName of collections) {
      console.log(`\n📋 Migration de la collection: ${collectionName}`);
      
      const collection = mongoose.connection.collection(collectionName);
      
      // Trouver tous les documents sans finalTotalVAT
      const documents = await collection.find({
        finalTotalVAT: { $exists: false }
      }).toArray();

      console.log(`   Trouvé ${documents.length} documents à mettre à jour`);

      if (documents.length === 0) {
        console.log('   ✅ Aucune mise à jour nécessaire');
        continue;
      }

      let updated = 0;
      for (const doc of documents) {
        const finalTotalVAT = calculateFinalTotalVAT(doc);
        
        await collection.updateOne(
          { _id: doc._id },
          { $set: { finalTotalVAT } }
        );
        
        updated++;
        
        if (updated % 10 === 0) {
          process.stdout.write(`\r   Progression: ${updated}/${documents.length}`);
        }
      }

      console.log(`\r   ✅ ${updated} documents mis à jour`);
      totalUpdated += updated;
    }

    console.log(`\n\n✅ Migration terminée avec succès!`);
    console.log(`📊 Total: ${totalUpdated} documents mis à jour`);

  } catch (error) {
    console.error('❌ Erreur lors de la migration:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n🔌 Connexion MongoDB fermée');
  }
}

// Exécuter la migration
migrateDocuments();
