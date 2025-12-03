import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger les variables d'environnement
dotenv.config({ path: join(__dirname, '..', '.env') });

async function dropOldIndexes() {
  try {
    console.log('🔄 Connexion à MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    const db = mongoose.connection.db;

    // Lister les index existants pour invoices
    console.log('\n📋 Index actuels de la collection invoices:');
    const invoiceIndexes = await db.collection('invoices').indexes();
    invoiceIndexes.forEach(index => {
      console.log(`  - ${index.name}`);
    });

    // Supprimer l'ancien index des invoices
    console.log('\n🗑️  Suppression de l\'ancien index invoices...');
    try {
      await db.collection('invoices').dropIndex('number_workspaceId_year_unique');
      console.log('✅ Index "number_workspaceId_year_unique" supprimé de invoices');
    } catch (err) {
      if (err.code === 27) {
        console.log('⚠️  Index "number_workspaceId_year_unique" n\'existe pas dans invoices');
      } else {
        console.log('❌ Erreur lors de la suppression:', err.message);
      }
    }

    // Lister les index existants pour quotes
    console.log('\n📋 Index actuels de la collection quotes:');
    const quoteIndexes = await db.collection('quotes').indexes();
    quoteIndexes.forEach(index => {
      console.log(`  - ${index.name}`);
    });

    // Supprimer l'ancien index des quotes
    console.log('\n🗑️  Suppression de l\'ancien index quotes...');
    try {
      await db.collection('quotes').dropIndex('number_workspaceId_year_unique');
      console.log('✅ Index "number_workspaceId_year_unique" supprimé de quotes');
    } catch (err) {
      if (err.code === 27) {
        console.log('⚠️  Index "number_workspaceId_year_unique" n\'existe pas dans quotes');
      } else {
        console.log('❌ Erreur lors de la suppression:', err.message);
      }
    }

    console.log('\n🎉 Terminé ! Redémarrez le serveur avec "npm run dev" pour créer les nouveaux index.');
    
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Erreur:', error.message);
    process.exit(1);
  }
}

dropOldIndexes();
