#!/usr/bin/env node

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function clearDatabase() {
  try {
    console.log('🔗 Connexion à MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('✅ Connecté à MongoDB');
    
    const db = mongoose.connection.db;
    
    // Obtenir la liste de toutes les collections
    const collections = await db.listCollections().toArray();
    
    if (collections.length === 0) {
      console.log('📭 Aucune collection trouvée dans la base de données');
      return;
    }

    console.log(`🗂️  ${collections.length} collection(s) trouvée(s):`);
    collections.forEach(collection => {
      console.log(`   - ${collection.name}`);
    });

    console.log('\n🗑️  Suppression de toutes les collections...');
    
    // Supprimer toutes les collections
    for (const collection of collections) {
      await db.collection(collection.name).drop();
      console.log(`   ✅ Collection "${collection.name}" supprimée`);
    }

    console.log('\n🎉 Base de données vidée avec succès !');
    
  } catch (error) {
    console.error('❌ Erreur lors du vidage de la base de données:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Connexion fermée');
    process.exit(0);
  }
}

// Demander confirmation avant de procéder
console.log('⚠️  ATTENTION: Cette opération va SUPPRIMER TOUTES LES DONNÉES de la base de données !');
console.log(`📍 Base de données: ${process.env.MONGODB_URI || 'mongodb://localhost:27017/invoice-app'}`);
console.log('\nPour continuer, tapez "OUI" et appuyez sur Entrée:');

process.stdin.setEncoding('utf8');
process.stdin.on('readable', () => {
  const chunk = process.stdin.read();
  if (chunk !== null) {
    const input = chunk.trim().toUpperCase();
    if (input === 'OUI') {
      clearDatabase();
    } else {
      console.log('❌ Opération annulée');
      process.exit(0);
    }
  }
});
