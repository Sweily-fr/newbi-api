#!/usr/bin/env node

/**
 * Script maître de migration de production
 * 
 * Exécute automatiquement tous les scripts de migration dans l'ordre :
 * 1. Diagnostic MongoDB
 * 2. Sauvegarde de production
 * 3. Migration des données (dry-run puis réelle)
 * 4. Validation post-migration
 * 
 * Usage: node scripts/run-migration.js [--dry-run] [--skip-backup] [--auto-confirm]
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const SCRIPTS_DIR = __dirname;
const BACKUP_DIR = './backups';

// Paramètres de ligne de commande
const isDryRun = process.argv.includes('--dry-run');
const skipBackup = process.argv.includes('--skip-backup');
const autoConfirm = process.argv.includes('--auto-confirm');

// Interface readline pour les confirmations
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

/**
 * Demande confirmation à l'utilisateur
 */
async function askConfirmation(question) {
  if (autoConfirm) {
    console.log(`${question} (auto-confirmé)`);
    return true;
  }
  
  return new Promise((resolve) => {
    rl.question(`${question} (y/N): `, (answer) => {
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * Exécute un script et affiche la sortie en temps réel
 */
async function runScript(scriptName, args = [], description = '') {
  console.log(`\n🔄 ${description || `Exécution de ${scriptName}`}`);
  console.log('=' .repeat(60));
  
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  
  return new Promise((resolve, reject) => {
    const child = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: path.dirname(SCRIPTS_DIR)
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ ${description || scriptName} terminé avec succès`);
        resolve();
      } else {
        console.error(`❌ ${description || scriptName} a échoué avec le code ${code}`);
        reject(new Error(`Script ${scriptName} failed with code ${code}`));
      }
    });
    
    child.on('error', (error) => {
      console.error(`❌ Erreur lors de l'exécution de ${scriptName}:`, error.message);
      reject(error);
    });
  });
}

/**
 * Affiche un résumé des étapes à exécuter
 */
function displayMigrationPlan() {
  console.log('\n🚀 PLAN DE MIGRATION DE PRODUCTION');
  console.log('==================================');
  console.log(`Mode: ${isDryRun ? 'DRY-RUN (simulation)' : 'PRODUCTION (réel)'}`);
  console.log(`Sauvegarde: ${skipBackup ? 'IGNORÉE' : 'INCLUSE'}`);
  console.log(`Confirmations: ${autoConfirm ? 'AUTOMATIQUES' : 'MANUELLES'}`);
  
  console.log('\nÉtapes prévues:');
  console.log('1. 🔍 Diagnostic MongoDB');
  if (!skipBackup) {
    console.log('2. 💾 Sauvegarde de production');
  }
  console.log(`${skipBackup ? '2' : '3'}. 🔄 Migration des données ${isDryRun ? '(dry-run)' : ''}`);
  console.log(`${skipBackup ? '3' : '4'}. ✅ Validation post-migration`);
  
  if (!isDryRun) {
    console.log('\n⚠️  ATTENTION: Cette migration va modifier la base de production !');
  }
}

/**
 * Fonction principale
 */
async function main() {
  try {
    displayMigrationPlan();
    
    // Confirmation initiale
    if (!isDryRun) {
      const confirmed = await askConfirmation('\n⚠️  Êtes-vous sûr de vouloir procéder à la migration de production ?');
      if (!confirmed) {
        console.log('❌ Migration annulée par l\'utilisateur');
        process.exit(0);
      }
    }
    
    console.log('\n🚀 DÉMARRAGE DE LA MIGRATION');
    console.log('============================');
    
    // Étape 1: Diagnostic MongoDB
    await runScript('diagnose-mongodb.js', [], 'ÉTAPE 1: Diagnostic MongoDB');
    
    // Étape 2: Sauvegarde (optionnelle)
    if (!skipBackup) {
      const backupConfirmed = await askConfirmation('\n💾 Procéder à la sauvegarde de production ?');
      if (backupConfirmed) {
        await runScript('backup-production-db.js', [`--output-dir=${BACKUP_DIR}`], 'ÉTAPE 2: Sauvegarde de production');
      } else {
        console.log('⚠️  Sauvegarde ignorée par l\'utilisateur');
      }
    }
    
    // Étape 3: Migration des données
    const migrationArgs = isDryRun ? ['--dry-run'] : [];
    const migrationDescription = `ÉTAPE ${skipBackup ? '2' : '3'}: Migration des données ${isDryRun ? '(simulation)' : ''}`;
    
    if (!isDryRun) {
      const migrationConfirmed = await askConfirmation('\n🔄 Procéder à la migration réelle des données ?');
      if (!migrationConfirmed) {
        console.log('❌ Migration annulée par l\'utilisateur');
        process.exit(0);
      }
    }
    
    await runScript('migrate-production-to-new-structure.js', migrationArgs, migrationDescription);
    
    // Étape 4: Validation post-migration
    if (!isDryRun) {
      const validationConfirmed = await askConfirmation('\n✅ Procéder à la validation post-migration ?');
      if (validationConfirmed) {
        const validationDescription = `ÉTAPE ${skipBackup ? '3' : '4'}: Validation post-migration`;
        await runScript('validate-migration-integrity.js', [], validationDescription);
      }
    }
    
    // Résumé final
    console.log('\n🎉 MIGRATION TERMINÉE AVEC SUCCÈS');
    console.log('=================================');
    
    if (isDryRun) {
      console.log('✅ Simulation terminée - aucune donnée n\'a été modifiée');
      console.log('💡 Pour exécuter la migration réelle, relancez sans --dry-run');
    } else {
      console.log('✅ Migration de production terminée');
      console.log('💾 Sauvegarde disponible dans:', BACKUP_DIR);
      console.log('📋 Consultez les logs pour plus de détails');
    }
    
  } catch (error) {
    console.error('\n❌ ERREUR FATALE LORS DE LA MIGRATION');
    console.error('=====================================');
    console.error('Erreur:', error.message);
    
    if (!isDryRun) {
      console.error('\n🔄 En cas de problème, utilisez le script de rollback:');
      console.error('node scripts/rollback-migration.js');
    }
    
    process.exit(1);
  } finally {
    rl.close();
  }
}

// Gestion des signaux d'interruption
process.on('SIGINT', () => {
  console.log('\n⚠️  Migration interrompue par l\'utilisateur');
  rl.close();
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('\n⚠️  Migration interrompue');
  rl.close();
  process.exit(1);
});

// Exécution
main();
