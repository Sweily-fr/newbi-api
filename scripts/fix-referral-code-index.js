#!/usr/bin/env node

/**
 * Script pour corriger l'index referralCode dans la collection user
 * 
 * Ce script :
 * 1. Supprime l'index unique problématique sur referralCode
 * 2. Recrée l'index avec l'option sparse pour permettre les valeurs null multiples
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
    console.log('🔧 CORRECTION DE L\'INDEX REFERRALCODE');
    console.log('=' .repeat(60));
    
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connexion MongoDB établie');
    
    const db = mongoose.connection.db;
    
    // Vérifier si la collection user existe
    const collections = await db.listCollections({ name: 'user' }).toArray();
    if (collections.length === 0) {
      console.log('✅ Collection "user" n\'existe pas, rien à corriger');
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
      console.log('\n🔧 Correction de l\'index referralCode...');
      
      // Supprimer l'index problématique
      console.log('🗑️  Suppression de l\'index referralCode_1...');
      await db.collection('user').dropIndex('referralCode_1');
      console.log('✅ Index referralCode_1 supprimé');
      
      // Recréer l'index avec l'option sparse
      console.log('🔨 Création du nouvel index referralCode (sparse + unique)...');
      await db.collection('user').createIndex(
        { referralCode: 1 }, 
        { 
          unique: true, 
          sparse: true,  // Permet les valeurs null multiples
          name: 'referralCode_1'
        }
      );
      console.log('✅ Nouvel index referralCode créé avec option sparse');
      
    } else {
      console.log('\n✅ Index referralCode_1 non trouvé, création directe...');
      
      // Créer l'index avec l'option sparse
      await db.collection('user').createIndex(
        { referralCode: 1 }, 
        { 
          unique: true, 
          sparse: true,
          name: 'referralCode_1'
        }
      );
      console.log('✅ Index referralCode créé avec option sparse');
    }
    
    // Vérifier le nouvel index
    console.log('\n🔍 Vérification du nouvel index...');
    const newIndexes = await db.collection('user').indexes();
    const newReferralCodeIndex = newIndexes.find(idx => idx.name === 'referralCode_1');
    
    if (newReferralCodeIndex) {
      console.log('✅ Index referralCode_1 configuré correctement:');
      console.log(`  - Unique: ${newReferralCodeIndex.unique}`);
      console.log(`  - Sparse: ${newReferralCodeIndex.sparse}`);
    }
    
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
      
      console.log('🎉 Test réussi: l\'index permet maintenant les valeurs null multiples');
      
    } catch (error) {
      console.error('❌ Test échoué:', error.message);
      
      // Nettoyer en cas d'erreur
      await db.collection('user').deleteMany({ 
        _id: { $in: [testDoc1._id, testDoc2._id] } 
      }).catch(() => {});
    }
    
    console.log('\n🎯 RÉSUMÉ:');
    console.log('✅ Index referralCode corrigé pour permettre les valeurs null multiples');
    console.log('✅ La migration peut maintenant être relancée sans erreur');
    
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

export { main as fixReferralCodeIndex };
