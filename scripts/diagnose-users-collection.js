#!/usr/bin/env node

import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔍 DIAGNOSTIC DE LA COLLECTION USERS');
console.log('====================================');
console.log(`Fichier: ${__filename}`);
console.log(`Node version: ${process.version}`);
console.log('');

// Fonction pour charger les variables d'environnement depuis ecosystem.config.cjs
async function loadEcosystemConfig() {
  console.log('🔧 Chargement de la configuration...');
  const ecosystemPath = path.resolve(__dirname, '../ecosystem.config.cjs');
  
  if (fs.existsSync(ecosystemPath)) {
    try {
      const { createRequire } = await import('module');
      const require = createRequire(import.meta.url);
      const config = require(ecosystemPath);
      
      if (config && config.apps && config.apps[0] && config.apps[0].env) {
        Object.assign(process.env, config.apps[0].env);
        
        if (config.apps[0].env_production) {
          Object.assign(process.env, config.apps[0].env_production);
        }
        
        console.log('✅ Configuration chargée');
        return true;
      }
    } catch (error) {
      console.log('⚠️  Erreur lors du chargement d\'ecosystem.config.cjs:', error.message);
    }
  }
  
  return false;
}

// Fonction pour analyser la structure d'un objet
function analyzeStructure(obj, prefix = '') {
  const analysis = {};
  
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    
    if (value === null) {
      analysis[fullKey] = 'null';
    } else if (Array.isArray(value)) {
      analysis[fullKey] = `array[${value.length}]`;
      if (value.length > 0) {
        const firstItem = value[0];
        if (typeof firstItem === 'object' && firstItem !== null) {
          Object.assign(analysis, analyzeStructure(firstItem, `${fullKey}[0]`));
        }
      }
    } else if (typeof value === 'object') {
      analysis[fullKey] = 'object';
      Object.assign(analysis, analyzeStructure(value, fullKey));
    } else {
      analysis[fullKey] = typeof value;
    }
  }
  
  return analysis;
}

// Fonction principale de diagnostic
async function runDiagnostic() {
  console.log('🚀 DÉBUT DU DIAGNOSTIC');
  let client;
  
  try {
    await loadEcosystemConfig();
    
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI non définie');
    }

    console.log('📋 Connexion à MongoDB...');
    client = new MongoClient(mongoUri);
    await client.connect();
    
    const db = client.db();
    
    // Test de connexion simple
    try {
      await db.collection('user').countDocuments({}, { limit: 1 });
      console.log('✅ Connexion réussie');
    } catch (testError) {
      const collections = await db.listCollections({}, { nameOnly: true }).toArray();
      console.log(`✅ Connexion réussie - ${collections.length} collections`);
    }

    console.log('\n📋 Analyse des collections...');
    
    // Lister toutes les collections
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    console.log('Collections disponibles:', collectionNames);
    
    const hasUsersCollection = collectionNames.includes('users');
    const hasUserCollection = collectionNames.includes('user');
    
    console.log(`\n📊 État des collections:`);
    console.log(`   Collection 'users': ${hasUsersCollection ? '✅ EXISTE' : '❌ MANQUANTE'}`);
    console.log(`   Collection 'user': ${hasUserCollection ? '✅ EXISTE' : '❌ MANQUANTE'}`);

    if (!hasUsersCollection) {
      console.log('\n❌ Collection "users" non trouvée');
      console.log('Collections disponibles:');
      collectionNames.forEach(name => console.log(`   - ${name}`));
      return;
    }

    console.log('\n📋 Analyse de la collection users...');
    
    // Compter les documents
    const usersCount = await db.collection('users').countDocuments();
    console.log(`📊 Nombre total de documents: ${usersCount}`);

    if (usersCount === 0) {
      console.log('❌ Aucun document dans la collection users');
      return;
    }

    // Récupérer quelques exemples
    const sampleUsers = await db.collection('users').find({}).limit(5).toArray();
    
    console.log('\n📋 ANALYSE DÉTAILLÉE DES DOCUMENTS:');
    console.log('==================================');
    
    sampleUsers.forEach((user, index) => {
      console.log(`\n👤 Document ${index + 1}:`);
      console.log(`   ID: ${user._id}`);
      console.log(`   Champs disponibles: ${Object.keys(user).join(', ')}`);
      
      // Analyser chaque champ
      Object.entries(user).forEach(([key, value]) => {
        if (key === '_id') return;
        
        if (value === null || value === undefined) {
          console.log(`   ${key}: ${value}`);
        } else if (typeof value === 'string') {
          console.log(`   ${key}: "${value.length > 50 ? value.substring(0, 50) + '...' : value}"`);
        } else if (typeof value === 'object') {
          console.log(`   ${key}: ${Array.isArray(value) ? `array[${value.length}]` : 'object'}`);
          if (typeof value === 'object' && !Array.isArray(value)) {
            Object.keys(value).forEach(subKey => {
              console.log(`     └─ ${subKey}: ${typeof value[subKey]}`);
            });
          }
        } else {
          console.log(`   ${key}: ${value} (${typeof value})`);
        }
      });
    });

    // Analyser la structure globale
    console.log('\n📋 ANALYSE DE LA STRUCTURE GLOBALE:');
    console.log('==================================');
    
    const allFields = new Set();
    const fieldTypes = {};
    
    sampleUsers.forEach(user => {
      const structure = analyzeStructure(user);
      Object.entries(structure).forEach(([field, type]) => {
        allFields.add(field);
        if (!fieldTypes[field]) {
          fieldTypes[field] = new Set();
        }
        fieldTypes[field].add(type);
      });
    });

    console.log('Tous les champs trouvés:');
    Array.from(allFields).sort().forEach(field => {
      const types = Array.from(fieldTypes[field]).join(', ');
      console.log(`   ${field}: ${types}`);
    });

    // Statistiques sur les champs company-related
    console.log('\n📋 RECHERCHE DE DONNÉES COMPANY:');
    console.log('===============================');
    
    const companyRelatedFields = Array.from(allFields).filter(field => 
      field.toLowerCase().includes('company') || 
      field.toLowerCase().includes('siret') ||
      field.toLowerCase().includes('vat') ||
      field.toLowerCase().includes('business') ||
      field.toLowerCase().includes('enterprise') ||
      field.toLowerCase().includes('firm')
    );
    
    if (companyRelatedFields.length > 0) {
      console.log('Champs liés aux entreprises trouvés:');
      companyRelatedFields.forEach(field => {
        console.log(`   ✅ ${field}`);
      });
    } else {
      console.log('❌ Aucun champ lié aux entreprises trouvé');
    }

    // Vérifier s'il y a des champs avec des valeurs non-null
    console.log('\n📋 ANALYSE DES VALEURS NON-VIDES:');
    console.log('================================');
    
    for (const user of sampleUsers) {
      console.log(`\n👤 Document ${user._id}:`);
      Object.entries(user).forEach(([key, value]) => {
        if (key !== '_id' && value !== null && value !== undefined && value !== '') {
          if (typeof value === 'object') {
            console.log(`   ${key}: [objet avec ${Object.keys(value).length} propriétés]`);
          } else {
            console.log(`   ${key}: ${typeof value === 'string' && value.length > 100 ? value.substring(0, 100) + '...' : value}`);
          }
        }
      });
    }

  } catch (error) {
    console.error('💥 Erreur:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    if (client) {
      await client.close();
      console.log('\n✅ Connexion fermée');
    }
  }
}

// Validation des arguments
if (process.argv.includes('--help')) {
  console.log(`
Usage: node diagnose-users-collection.js

Description:
  Analyse la structure et le contenu de la collection 'users' pour comprendre
  quelles données sont disponibles pour la migration.

Exemples:
  node diagnose-users-collection.js
`);
  process.exit(0);
}

// Exécution
runDiagnostic().catch(console.error);
