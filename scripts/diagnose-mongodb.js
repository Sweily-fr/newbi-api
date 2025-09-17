#!/usr/bin/env node

import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Fonction pour charger les variables d'environnement depuis ecosystem.config.cjs
async function loadEcosystemConfig() {
  const ecosystemPath = path.resolve(__dirname, '../ecosystem.config.cjs');
  
  if (fs.existsSync(ecosystemPath)) {
    console.log('📄 Fichier ecosystem.config.cjs trouvé');
    try {
      // Importer dynamiquement le fichier ecosystem
      const ecosystemConfig = await import(`file://${ecosystemPath}`);
      const config = ecosystemConfig.default;
      
      if (config && config.apps && config.apps[0] && config.apps[0].env) {
        console.log('🔧 Variables d\'environnement trouvées dans ecosystem.config.cjs');
        
        // Appliquer les variables d'environnement
        Object.assign(process.env, config.apps[0].env);
        
        // Si env_production existe, l'utiliser aussi
        if (config.apps[0].env_production) {
          console.log('🔧 Variables de production trouvées dans ecosystem.config.cjs');
          Object.assign(process.env, config.apps[0].env_production);
        }
        
        return true;
      }
    } catch (error) {
      console.log('⚠️  Erreur lors du chargement d\'ecosystem.config.cjs:', error.message);
    }
  } else {
    console.log('📄 Fichier ecosystem.config.cjs non trouvé');
  }
  
  return false;
}

// Charger les variables d'environnement
dotenv.config();

console.log('🔍 DIAGNOSTIC MONGODB');
console.log('====================');

async function diagnoseMongoDB() {
  try {
    // Charger ecosystem.config.cjs en premier
    await loadEcosystemConfig();
    
    // 1. Vérifier les variables d'environnement
    console.log('\n📋 Variables d\'environnement:');
    console.log('MONGODB_URI:', process.env.MONGODB_URI || 'NON DÉFINIE');
    console.log('NODE_ENV:', process.env.NODE_ENV || 'NON DÉFINIE');
    
    // Afficher d'autres variables MongoDB potentielles
    const mongoVars = Object.keys(process.env).filter(key => 
      key.toLowerCase().includes('mongo') || 
      key.toLowerCase().includes('db')
    );
    
    if (mongoVars.length > 0) {
      console.log('\n🔍 Autres variables liées à MongoDB:');
      mongoVars.forEach(key => {
        const value = process.env[key];
        if (value && value.includes('mongodb://')) {
          console.log(`${key}: ${value.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
        } else {
          console.log(`${key}: ${value}`);
        }
      });
    }
    
    // 2. Vérifier le statut MongoDB
    console.log('\n🔄 Statut MongoDB:');
    try {
      const { stdout: statusOutput } = await execAsync('systemctl is-active mongod');
      console.log('Service mongod:', statusOutput.trim());
    } catch (error) {
      console.log('Service mongod: INACTIF ou non installé');
      
      // Essayer avec mongodb
      try {
        const { stdout: statusOutput2 } = await execAsync('systemctl is-active mongodb');
        console.log('Service mongodb:', statusOutput2.trim());
      } catch (error2) {
        console.log('Service mongodb: INACTIF ou non installé');
      }
    }
    
    // 3. Tester la connexion MongoDB
    console.log('\n🔗 Test de connexion:');
    try {
      const { stdout: dbList } = await execAsync('mongosh --quiet --eval "show dbs"');
      console.log('Bases de données disponibles:');
      console.log(dbList);
    } catch (error) {
      console.log('❌ Impossible de se connecter à MongoDB sans authentification');
      console.log('Erreur:', error.message);
      
      // Essayer avec l'URI si elle existe
      if (process.env.MONGODB_URI) {
        try {
          const { stdout: dbListWithUri } = await execAsync(`mongosh "${process.env.MONGODB_URI}" --quiet --eval "show dbs"`);
          console.log('✅ Connexion réussie avec URI:');
          console.log(dbListWithUri);
        } catch (uriError) {
          console.log('❌ Connexion échouée même avec URI:');
          console.log('Erreur:', uriError.message);
        }
      }
    }
    
    // 4. Vérifier les collections dans la base
    console.log('\n📦 Collections dans la base:');
    const dbName = process.env.MONGODB_URI ? 
      new URL(process.env.MONGODB_URI).pathname.slice(1) : 
      'newbi';
    
    try {
      const command = process.env.MONGODB_URI ? 
        `mongosh "${process.env.MONGODB_URI}" --quiet --eval "use ${dbName}; show collections"` :
        `mongosh --quiet --eval "use ${dbName}; show collections"`;
        
      const { stdout: collections } = await execAsync(command);
      console.log(`Collections dans ${dbName}:`);
      console.log(collections);
    } catch (error) {
      console.log(`❌ Impossible de lister les collections de ${dbName}`);
      console.log('Erreur:', error.message);
    }
    
    // 5. Test mongodump
    console.log('\n🔧 Test mongodump:');
    try {
      const testCmd = process.env.MONGODB_URI ? 
        `mongodump --uri="${process.env.MONGODB_URI}" --help` :
        `mongodump --db ${dbName} --help`;
        
      const { stdout: dumpTest } = await execAsync(testCmd);
      console.log('✅ mongodump disponible et fonctionne');
    } catch (error) {
      console.log('❌ mongodump échoue:');
      console.log('Erreur:', error.message);
    }
    
  } catch (error) {
    console.error('❌ Erreur lors du diagnostic:', error.message);
  }
}

diagnoseMongoDB();
