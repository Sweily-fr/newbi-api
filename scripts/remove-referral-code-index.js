#!/usr/bin/env node

/**
 * Script pour supprimer complètement l'index referralCode
 * 
 * Ce script supprime l'index referralCode_1 pour permettre la migration
 * L'index sera recréé après la migration si nécessaire
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';
import path from 'path';

// Configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Fonction pour charger les variables d'environnement depuis ecosystem.config.cjs
async function loadEcosystemConfig() {
  const ecosystemPath = path.resolve(__dirname, '../ecosystem.config.cjs');
  
  try {
    await fs.access(ecosystemPath);
    console.log('📄 Chargement des variables depuis ecosystem.config.cjs');
    
    // Importer dynamiquement le fichier ecosystem
    const ecosystemConfig = await import(`file://${ecosystemPath}`);
    const config = ecosystemConfig.default;
    
    if (config && config.apps && config.apps[0] && config.apps[0].env) {
      // Appliquer les variables d'environnement
      Object.assign(process.env, config.apps[0].env);
      
      // Si env_production existe, l'utiliser aussi
      if (config.apps[0].env_production) {
        Object.assign(process.env, config.apps[0].env_production);
      }
      
      console.log('✅ Variables d\'environnement chargées depuis ecosystem.config.cjs');
      return true;
    }
  } catch (error) {
    console.log('⚠️  Impossible de charger ecosystem.config.cjs:', error.message);
  }
  
  return false;
}

// Charger les variables d'environnement
dotenv.config({ path: join(__dirname, '../.env') });
await loadEcosystemConfig();

/**
 * Fonction principale
 */
async function main() {
  try {
    console.log('🗑️  SUPPRESSION DE L\'INDEX REFERRALCODE');
    console.log('=' .repeat(60));
    
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connexion MongoDB établie');
    
    const db = mongoose.connection.db;
    
    // Vérifier si la collection user existe
    const collections = await db.listCollections({ name: 'user' }).toArray();
    if (collections.length === 0) {
      console.log('✅ Collection "user" n\'existe pas, rien à supprimer');
      return;
    }
    
    console.log('🔍 Analyse des index de la collection "user"...');
    
    // Lister les index existants
    const indexes = await db.collection('user').indexes();
    console.log('📋 Index existants:');
    indexes.forEach(index => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
      if (index.unique) {
        console.log(`    → Index unique`);
      }
      if (index.sparse) {
        console.log(`    → Index sparse`);
      }
    });
    
    // Vérifier si l'index referralCode_1 existe
    const referralCodeIndex = indexes.find(idx => idx.name === 'referralCode_1');
    
    if (referralCodeIndex) {
      console.log('\n🗑️  Suppression de l\'index referralCode_1...');
      
      try {
        await db.collection('user').dropIndex('referralCode_1');
        console.log('✅ Index referralCode_1 supprimé avec succès');
      } catch (error) {
        console.error('❌ Erreur lors de la suppression:', error.message);
        throw error;
      }
      
    } else {
      console.log('\n✅ Index referralCode_1 non trouvé, rien à supprimer');
    }
    
    // Vérifier que l'index a bien été supprimé
    console.log('\n🔍 Vérification après suppression...');
    const newIndexes = await db.collection('user').indexes();
    const stillExists = newIndexes.find(idx => idx.name === 'referralCode_1');
    
    if (stillExists) {
      console.error('❌ L\'index referralCode_1 existe encore !');
      throw new Error('Échec de la suppression de l\'index');
    } else {
      console.log('✅ Index referralCode_1 bien supprimé');
    }
    
    console.log('\n📋 Index restants:');
    newIndexes.forEach(index => {
      console.log(`  - ${index.name}: ${JSON.stringify(index.key)}`);
    });
    
    // Tester l'insertion de documents avec referralCode null
    console.log('\n🧪 Test d\'insertion de documents avec referralCode null...');
    
    const testDoc1 = {
      _id: new mongoose.Types.ObjectId(),
      email: 'test1@example.com',
      referralCode: null
    };
    
    const testDoc2 = {
      _id: new mongoose.Types.ObjectId(),
      email: 'test2@example.com',
      referralCode: null
    };
    
    try {
      // Insérer le premier document test
      await db.collection('user').insertOne(testDoc1);
      console.log('✅ Premier document test inséré');
      
      // Insérer le deuxième document test
      await db.collection('user').insertOne(testDoc2);
      console.log('✅ Deuxième document test inséré');
      
      // Nettoyer les documents test
      await db.collection('user').deleteMany({ 
        _id: { $in: [testDoc1._id, testDoc2._id] } 
      });
      console.log('✅ Documents test supprimés');
      
      console.log('🎉 Test réussi: les valeurs null multiples sont maintenant autorisées');
      
    } catch (error) {
      console.error('❌ Test échoué:', error.message);
      
      // Nettoyer en cas d'erreur
      await db.collection('user').deleteMany({ 
        _id: { $in: [testDoc1._id, testDoc2._id] } 
      }).catch(() => {});
      
      throw error;
    }
    
    console.log('\n🎯 RÉSUMÉ:');
    console.log('✅ Index referralCode_1 supprimé complètement');
    console.log('✅ Les valeurs referralCode null multiples sont maintenant autorisées');
    console.log('✅ La migration peut maintenant être exécutée sans erreur');
    console.log('\n⚠️  NOTE: L\'index referralCode pourra être recréé après la migration si nécessaire');
    
  } catch (error) {
    console.error('❌ ERREUR FATALE:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('✅ Connexion MongoDB fermée');
  }
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main as removeReferralCodeIndex };
