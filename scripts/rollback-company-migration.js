#!/usr/bin/env node

import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import readline from 'readline';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const BACKUP_DIR = path.resolve(__dirname, '../backups');
const DRY_RUN = process.argv.includes('--dry-run');
const AUTO_CONFIRM = process.argv.includes('--auto-confirm');

console.log(' ROLLBACK MIGRATION COMPANY → ORGANIZATION');
console.log('============================================');
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (simulation)' : 'EXÉCUTION RÉELLE'}`);
console.log('');

// Interface pour les questions utilisateur
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

// Fonction pour charger les variables d'environnement depuis ecosystem.config.cjs
async function loadEcosystemConfig() {
  const ecosystemPath = path.resolve(__dirname, '../ecosystem.config.cjs');
  
  if (fs.existsSync(ecosystemPath)) {
    try {
      const ecosystemConfig = await import(`file://${ecosystemPath}`);
      const config = ecosystemConfig.default;
      
      if (config && config.apps && config.apps[0] && config.apps[0].env) {
        Object.assign(process.env, config.apps[0].env);
        
        if (config.apps[0].env_production) {
          Object.assign(process.env, config.apps[0].env_production);
        }
        
        return true;
      }
    } catch (error) {
      console.log(' Erreur lors du chargement d\'ecosystem.config.cjs:', error.message);
    }
  }
  
  return false;
}

// Fonction pour lister les sauvegardes disponibles
function listAvailableBackups() {
  if (!fs.existsSync(BACKUP_DIR)) {
    console.log(' Aucun dossier de sauvegarde trouvé');
    return [];
  }

  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(item => {
      const fullPath = path.join(BACKUP_DIR, item);
      return fs.statSync(fullPath).isDirectory() && 
             item.includes('company-migration-backup');
    })
    .map(backup => {
      const fullPath = path.join(BACKUP_DIR, backup);
      const stats = fs.statSync(fullPath);
      return {
        name: backup,
        path: fullPath,
        created: stats.birthtime,
        size: getDirSize(fullPath)
      };
    })
    .sort((a, b) => b.created - a.created); // Plus récent en premier

  return backups;
}

// Fonction pour calculer la taille d'un dossier
function getDirSize(dirPath) {
  let totalSize = 0;
  
  function calculateSize(currentPath) {
    const items = fs.readdirSync(currentPath);
    
    for (const item of items) {
      const itemPath = path.join(currentPath, item);
      const stats = fs.statSync(itemPath);
      
      if (stats.isDirectory()) {
        calculateSize(itemPath);
      } else {
        totalSize += stats.size;
      }
    }
  }
  
  try {
    calculateSize(dirPath);
    return totalSize;
  } catch (error) {
    return 0;
  }
}

// Fonction pour formater la taille en bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Fonction de restauration depuis une sauvegarde
async function restoreFromBackup(backupPath) {
  console.log(` Restauration depuis: ${backupPath}`);
  
  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI non définie');
    }

    // Extraire le nom de la base de données depuis l'URI
    const dbName = new URL(mongoUri).pathname.slice(1) || 'newbi';
    
    // Chemin vers les données de sauvegarde
    const dbBackupPath = path.join(backupPath, dbName);
    
    if (!fs.existsSync(dbBackupPath)) {
      throw new Error(`Sauvegarde de la base ${dbName} non trouvée dans ${backupPath}`);
    }

    console.log(' Suppression des collections actuelles...');
    
    if (!DRY_RUN) {
      // Se connecter à MongoDB pour supprimer les collections
      const client = new MongoClient(mongoUri);
      await client.connect();
      const db = client.db();
      
      // Supprimer les collections créées par la migration
      const collections = ['organization', 'member'];
      for (const collectionName of collections) {
        try {
          await db.collection(collectionName).drop();
          console.log(`   Collection ${collectionName} supprimée`);
        } catch (error) {
          if (error.message.includes('ns not found')) {
            console.log(`   Collection ${collectionName} n'existe pas`);
          } else {
            console.log(`   Erreur suppression ${collectionName}: ${error.message}`);
          }
        }
      }
      
      await client.close();
    }

    console.log(' Restauration des données...');
    
    if (!DRY_RUN) {
      // Utiliser mongorestore pour restaurer les données
      const command = `mongorestore --uri="${mongoUri}" --drop "${backupPath}"`;
      console.log(' Exécution de mongorestore...');
      
      const { stdout, stderr } = await execAsync(command);
      
      if (stderr && !stderr.includes('done')) {
        console.warn(' Avertissements mongorestore:', stderr);
      }
    }

    console.log(' Restauration terminée');
    return true;
    
  } catch (error) {
    console.error(' Erreur lors de la restauration:', error.message);
    return false;
  }
}

// Fonction de rollback manuel (sans sauvegarde)
async function manualRollback() {
  console.log(' Rollback manuel - Suppression des données migrées');
  
  let client;
  
  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI non définie dans les variables d\'environnement');
    }

    console.log(' Connexion à MongoDB...');
    client = new MongoClient(mongoUri);
    await client.connect();
    
    const db = client.db();
    console.log(' Connexion réussie');

    // Statistiques avant rollback
    const orgCount = await db.collection('organization').countDocuments();
    const memberCount = await db.collection('member').countDocuments();
    
    console.log(`\n État actuel:`);
    console.log(`   Organisations: ${orgCount}`);
    console.log(`   Memberships: ${memberCount}`);

    if (orgCount === 0 && memberCount === 0) {
      console.log(' Aucune donnée à supprimer');
      return true;
    }

    if (!AUTO_CONFIRM && !DRY_RUN) {
      const confirm = await askQuestion('\n Voulez-vous vraiment supprimer ces données ? (oui/non): ');
      if (confirm.toLowerCase() !== 'oui') {
        console.log(' Rollback annulé par l\'utilisateur');
        return false;
      }
    }

    console.log('\n Suppression des données...');

    let deletedOrgs = 0;
    let deletedMembers = 0;

    if (!DRY_RUN) {
      // Supprimer les memberships
      const memberResult = await db.collection('member').deleteMany({});
      deletedMembers = memberResult.deletedCount;
      console.log(`   ${deletedMembers} memberships supprimés`);

      // Supprimer les organisations
      const orgResult = await db.collection('organization').deleteMany({});
      deletedOrgs = orgResult.deletedCount;
      console.log(`   ${deletedOrgs} organisations supprimées`);
    } else {
      console.log(`   ${memberCount} memberships seraient supprimés`);
      console.log(`   ${orgCount} organisations seraient supprimées`);
    }

    console.log('\n RÉSUMÉ DU ROLLBACK');
    console.log('=====================');
    console.log(` Organisations supprimées: ${DRY_RUN ? orgCount + ' (simulation)' : deletedOrgs}`);
    console.log(` Memberships supprimés: ${DRY_RUN ? memberCount + ' (simulation)' : deletedMembers}`);

    if (DRY_RUN) {
      console.log('\n SIMULATION TERMINÉE - Aucune modification appliquée');
    } else {
      console.log('\n ROLLBACK TERMINÉ AVEC SUCCÈS');
      console.log('\n ACTIONS RECOMMANDÉES:');
      console.log('- Vérifier que l\'application fonctionne correctement');
      console.log('- Les données company dans la collection user sont préservées');
      console.log('- Vous pouvez relancer la migration si nécessaire');
    }

    return true;

  } catch (error) {
    console.error(' Erreur lors du rollback:', error.message);
    return false;
  } finally {
    if (client) {
      await client.close();
      console.log(' Connexion MongoDB fermée');
    }
  }
}

// Fonction principale de rollback
async function runRollback() {
  try {
    // Charger la configuration
    await loadEcosystemConfig();

    console.log(' Recherche des sauvegardes disponibles...');
    const backups = listAvailableBackups();

    if (backups.length === 0) {
      console.log(' Aucune sauvegarde trouvée');
      
      if (!AUTO_CONFIRM) {
        const proceed = await askQuestion('Voulez-vous effectuer un rollback manuel ? (oui/non): ');
        if (proceed.toLowerCase() !== 'oui') {
          console.log(' Rollback annulé');
          return;
        }
      }
      
      await manualRollback();
      return;
    }

    console.log('\n Sauvegardes disponibles:');
    backups.forEach((backup, index) => {
      console.log(`${index + 1}. ${backup.name}`);
      console.log(`   Créée: ${backup.created.toLocaleString()}`);
      console.log(`   Taille: ${formatBytes(backup.size)}`);
      console.log('');
    });

    let selectedBackup;

    if (AUTO_CONFIRM) {
      // Utiliser la sauvegarde la plus récente
      selectedBackup = backups[0];
      console.log(` Sauvegarde sélectionnée automatiquement: ${selectedBackup.name}`);
    } else {
      // Demander à l'utilisateur de choisir
      const choice = await askQuestion('Choisissez une sauvegarde (numéro) ou "manual" pour rollback manuel: ');
      
      if (choice.toLowerCase() === 'manual') {
        await manualRollback();
        return;
      }
      
      const index = parseInt(choice) - 1;
      if (index < 0 || index >= backups.length) {
        console.log(' Choix invalide');
        return;
      }
      
      selectedBackup = backups[index];
    }

    console.log(`\n Sauvegarde sélectionnée: ${selectedBackup.name}`);
    console.log(` Créée le: ${selectedBackup.created.toLocaleString()}`);

    if (!AUTO_CONFIRM && !DRY_RUN) {
      const confirm = await askQuestion('\n Confirmer la restauration ? Cette action est irréversible ! (oui/non): ');
      if (confirm.toLowerCase() !== 'oui') {
        console.log(' Rollback annulé par l\'utilisateur');
        return;
      }
    }

    const success = await restoreFromBackup(selectedBackup.path);
    
    if (success) {
      if (DRY_RUN) {
        console.log('\n SIMULATION TERMINÉE - Aucune modification appliquée');
      } else {
        console.log('\n ROLLBACK TERMINÉ AVEC SUCCÈS');
        console.log('\n ACTIONS RECOMMANDÉES:');
        console.log('- Redémarrer l\'application');
        console.log('- Vérifier que tout fonctionne correctement');
        console.log('- Analyser les causes du problème avant de relancer la migration');
      }
    }

  } catch (error) {
    console.error(' Erreur fatale:', error.message);
  } finally {
    rl.close();
  }
}

// Validation des arguments
if (process.argv.includes('--help')) {
  console.log(`
Usage: node rollback-company-migration.js [options]

Options:
  --dry-run       Simulation sans modification des données
  --auto-confirm  Utiliser automatiquement la sauvegarde la plus récente
  --help          Afficher cette aide

Description:
  Annule la migration company → organization en restaurant une sauvegarde
  ou en supprimant manuellement les données migrées.

Exemples:
  node rollback-company-migration.js --dry-run
  node rollback-company-migration.js
  node rollback-company-migration.js --auto-confirm
`);
  process.exit(0);
}

// Exécution
runRollback().catch(console.error);
