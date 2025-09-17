#!/usr/bin/env node

/**
 * Script de sauvegarde complète de la base de données de production
 * 
 * Ce script :
 * 1. Crée une sauvegarde complète de la base de données MongoDB
 * 2. Exporte toutes les collections avec leurs données
 * 3. Génère un fichier de sauvegarde horodaté
 * 4. Valide l'intégrité de la sauvegarde
 * 
 * Usage: node scripts/backup-production-db.js [--output-dir=/path/to/backup]
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const execAsync = promisify(exec);

// Configuration ES modules
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
dotenv.config();
await loadEcosystemConfig();

// Paramètres du script
const OUTPUT_DIR = process.argv.find(arg => arg.startsWith('--output-dir='))?.split('=')[1] || './backups';
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + new Date().toISOString().replace(/[:.]/g, '-').split('T')[1].split('.')[0];

/**
 * Extrait les informations de connexion MongoDB depuis l'URI
 */
function parseMongoUri(uri) {
  const url = new URL(uri);
  return {
    host: url.hostname,
    port: url.port || '27017',
    database: url.pathname.slice(1),
    username: url.username,
    password: url.password,
    authSource: url.searchParams.get('authSource') || url.pathname.slice(1),
    // Ajouter support pour les paramètres SSL/TLS
    ssl: url.searchParams.get('ssl') === 'true',
    authMechanism: url.searchParams.get('authMechanism')
  };
}

/**
 * Crée le répertoire de sauvegarde
 */
async function createBackupDirectory() {
  const backupDir = path.resolve(OUTPUT_DIR, `backup_${TIMESTAMP}`);
  
  try {
    await fs.mkdir(backupDir, { recursive: true });
    console.log(`📁 Répertoire de sauvegarde créé: ${backupDir}`);
    return backupDir;
  } catch (error) {
    throw new Error(`Impossible de créer le répertoire de sauvegarde: ${error.message}`);
  }
}

/**
 * Effectue la sauvegarde avec mongodump
 */
async function performMongoDump(backupDir) {
  console.log('🔄 Démarrage de la sauvegarde MongoDB...');
  
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI non défini dans les variables d\'environnement');
  }
  
  console.log(`🔗 URI MongoDB détecté: ${mongoUri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
  
  // Construction de la commande mongodump avec URI complète
  let mongodumpCmd = `mongodump --uri="${mongoUri}" --out="${backupDir}" --gzip`;
  
  console.log('📦 Exécution de mongodump...');
  console.log(`Commande: mongodump --uri="***" --out="${backupDir}" --gzip`);
  
  try {
    const { stdout, stderr } = await execAsync(mongodumpCmd);
    
    if (stderr && !stderr.includes('done dumping')) {
      console.warn('⚠️  Avertissements mongodump:', stderr);
    }
    
    console.log('✅ Sauvegarde mongodump terminée');
    
    // Extraire le nom de la base pour retourner le bon chemin
    const mongoInfo = parseMongoUri(mongoUri);
    return path.join(backupDir, mongoInfo.database);
    
  } catch (error) {
    throw new Error(`Erreur lors de l'exécution de mongodump: ${error.message}`);
  }
}

/**
 * Crée un export JSON des collections critiques
 */
async function exportCriticalCollections(backupDir) {
  console.log('📋 Export des collections critiques en JSON...');
  
  const mongoUri = process.env.MONGODB_URI;
  const mongoInfo = parseMongoUri(mongoUri);
  
  // Collections critiques à exporter en JSON pour faciliter l'inspection
  const criticalCollections = [
    'Users', // Ancienne collection
    'user',  // Nouvelle collection
    'invoices',
    'quotes',
    'expenses',
    'clients'
  ];
  
  const jsonDir = path.join(backupDir, 'json_exports');
  await fs.mkdir(jsonDir, { recursive: true });
  
  for (const collection of criticalCollections) {
    try {
      let mongoexportCmd = `mongoexport`;
      
      if (mongoInfo.host !== 'localhost') {
        mongoexportCmd += ` --host "${mongoInfo.host}:${mongoInfo.port}"`;
      }
      
      if (mongoInfo.username && mongoInfo.password) {
        mongoexportCmd += ` --username "${mongoInfo.username}" --password "${mongoInfo.password}"`;
        mongoexportCmd += ` --authenticationDatabase "${mongoInfo.authSource}"`;
      }
      
      mongoexportCmd += ` --db "${mongoInfo.database}"`;
      mongoexportCmd += ` --collection "${collection}"`;
      mongoexportCmd += ` --out "${path.join(jsonDir, `${collection}.json`)}"`;
      mongoexportCmd += ` --pretty`;
      
      const { stdout, stderr } = await execAsync(mongoexportCmd);
      
      if (stderr && !stderr.includes('exported')) {
        console.warn(`⚠️  Avertissement pour ${collection}:`, stderr);
      } else {
        console.log(`✅ Collection ${collection} exportée`);
      }
      
    } catch (error) {
      console.warn(`⚠️  Impossible d'exporter ${collection}: ${error.message}`);
    }
  }
}

/**
 * Génère un rapport de sauvegarde
 */
async function generateBackupReport(backupDir) {
  console.log('📊 Génération du rapport de sauvegarde...');
  
  const reportPath = path.join(backupDir, 'backup_report.txt');
  const mongoUri = process.env.MONGODB_URI;
  const mongoInfo = parseMongoUri(mongoUri);
  
  let report = `RAPPORT DE SAUVEGARDE NEWBI
========================================
Date: ${new Date().toISOString()}
Base de données: ${mongoInfo.database}
Serveur: ${mongoInfo.host}:${mongoInfo.port}
Répertoire: ${backupDir}

CONTENU DE LA SAUVEGARDE:
`;

  try {
    // Lister les fichiers de sauvegarde
    const files = await fs.readdir(backupDir, { recursive: true });
    
    report += `\nFichiers créés:\n`;
    for (const file of files) {
      const filePath = path.join(backupDir, file);
      try {
        const stats = await fs.stat(filePath);
        if (stats.isFile()) {
          report += `- ${file} (${Math.round(stats.size / 1024)} KB)\n`;
        }
      } catch (error) {
        report += `- ${file} (erreur lecture)\n`;
      }
    }
    
    // Informations sur les collections JSON
    const jsonDir = path.join(backupDir, 'json_exports');
    try {
      const jsonFiles = await fs.readdir(jsonDir);
      report += `\nExports JSON:\n`;
      for (const jsonFile of jsonFiles) {
        const jsonPath = path.join(jsonDir, jsonFile);
        const content = await fs.readFile(jsonPath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim()).length;
        report += `- ${jsonFile}: ${lines} documents\n`;
      }
    } catch (error) {
      report += `\nErreur lecture exports JSON: ${error.message}\n`;
    }
    
  } catch (error) {
    report += `\nErreur génération rapport: ${error.message}\n`;
  }
  
  report += `\nSauvegarde terminée à: ${new Date().toISOString()}\n`;
  
  await fs.writeFile(reportPath, report, 'utf8');
  console.log(`📄 Rapport sauvegardé: ${reportPath}`);
  
  return report;
}

/**
 * Valide l'intégrité de la sauvegarde
 */
async function validateBackup(backupDir) {
  console.log('🔍 Validation de l\'intégrité de la sauvegarde...');
  
  const mongoUri = process.env.MONGODB_URI;
  const mongoInfo = parseMongoUri(mongoUri);
  const dumpDir = path.join(backupDir, mongoInfo.database);
  
  try {
    // Vérifier que le répertoire de dump existe
    const dumpStats = await fs.stat(dumpDir);
    if (!dumpStats.isDirectory()) {
      throw new Error('Répertoire de dump non trouvé');
    }
    
    // Lister les fichiers BSON
    const files = await fs.readdir(dumpDir);
    const bsonFiles = files.filter(f => f.endsWith('.bson.gz') || f.endsWith('.bson'));
    
    if (bsonFiles.length === 0) {
      throw new Error('Aucun fichier BSON trouvé dans la sauvegarde');
    }
    
    console.log(`✅ Validation réussie: ${bsonFiles.length} collections sauvegardées`);
    
    // Afficher les collections sauvegardées
    console.log('📋 Collections sauvegardées:');
    for (const file of bsonFiles) {
      const collectionName = file.replace('.bson.gz', '').replace('.bson', '');
      const filePath = path.join(dumpDir, file);
      const stats = await fs.stat(filePath);
      console.log(`  - ${collectionName} (${Math.round(stats.size / 1024)} KB)`);
    }
    
    return true;
    
  } catch (error) {
    console.error('❌ Validation échouée:', error.message);
    return false;
  }
}

/**
 * Fonction principale
 */
async function main() {
  const startTime = Date.now();
  
  try {
    console.log('🚀 DÉMARRAGE DE LA SAUVEGARDE DE PRODUCTION');
    console.log(`Timestamp: ${TIMESTAMP}`);
    console.log(`Répertoire de sortie: ${OUTPUT_DIR}`);
    console.log('=' .repeat(60));
    
    // Vérifier que mongodump est disponible
    try {
      await execAsync('mongodump --version');
    } catch (error) {
      throw new Error('mongodump n\'est pas installé ou accessible. Installez MongoDB Database Tools.');
    }
    
    // Étape 1: Créer le répertoire de sauvegarde
    const backupDir = await createBackupDirectory();
    
    // Étape 2: Effectuer la sauvegarde mongodump
    await performMongoDump(backupDir);
    
    // Étape 3: Exporter les collections critiques en JSON
    await exportCriticalCollections(backupDir);
    
    // Étape 4: Valider la sauvegarde
    const isValid = await validateBackup(backupDir);
    if (!isValid) {
      throw new Error('La validation de la sauvegarde a échoué');
    }
    
    // Étape 5: Générer le rapport
    const report = await generateBackupReport(backupDir);
    
    const duration = Math.round((Date.now() - startTime) / 1000);
    
    console.log('\n🎉 SAUVEGARDE TERMINÉE AVEC SUCCÈS');
    console.log(`⏱️  Durée: ${duration} secondes`);
    console.log(`📁 Emplacement: ${backupDir}`);
    console.log('\n📋 RÉSUMÉ:');
    console.log(report.split('CONTENU DE LA SAUVEGARDE:')[1] || 'Rapport non disponible');
    
    console.log('\n⚠️  IMPORTANT:');
    console.log('- Vérifiez que la sauvegarde est complète avant de procéder à la migration');
    console.log('- Conservez cette sauvegarde jusqu\'à validation complète de la migration');
    console.log('- Testez la restauration sur un environnement de test si possible');
    
  } catch (error) {
    console.error('❌ ERREUR FATALE:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main as backupProductionDb };
