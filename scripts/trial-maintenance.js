#!/usr/bin/env node

/**
 * Script de maintenance complet pour le système de trials
 * Combine activation, validation et nettoyage
 */

import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function runScript(scriptName, args = []) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, scriptName);
    const child = spawn('node', [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: __dirname
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Script terminé avec le code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function showMenu() {
  console.log('\n🎯 MAINTENANCE DU SYSTÈME DE TRIALS');
  console.log('===================================');
  console.log('1. 🔍 Valider l\'état actuel des trials');
  console.log('2. 🚀 Activer les trials pour utilisateurs existants');
  console.log('3. 🧹 Nettoyer les trials expirés');
  console.log('4. 🔄 Maintenance complète (validation + nettoyage)');
  console.log('5. 📊 Rapport détaillé uniquement');
  console.log('0. ❌ Quitter');
  
  const choice = await question('\nChoisissez une option (0-5): ');
  return choice;
}

async function validateTrials() {
  console.log('\n📊 VALIDATION DES TRIALS');
  console.log('========================');
  
  try {
    await runScript('validate-trial-activation.js');
    console.log('\n✅ Validation terminée');
  } catch (error) {
    console.error('❌ Erreur lors de la validation:', error.message);
  }
}

async function activateTrials() {
  console.log('\n🚀 ACTIVATION DES TRIALS');
  console.log('========================');
  
  const confirm = await question('Voulez-vous activer les trials pour les utilisateurs existants ? (o/N): ');
  if (confirm.toLowerCase() !== 'o') {
    console.log('❌ Activation annulée');
    return;
  }
  
  try {
    // D'abord en dry-run
    console.log('\n🔍 Analyse préliminaire...');
    await runScript('enable-trial-for-existing-users.js');
    
    const proceed = await question('\nVoulez-vous appliquer ces changements ? (o/N): ');
    if (proceed.toLowerCase() !== 'o') {
      console.log('❌ Application annulée');
      return;
    }
    
    const finalConfirm = await question('⚠️  ATTENTION: Modification de la base de données.\nTapez "CONFIRMER" pour continuer: ');
    if (finalConfirm !== 'CONFIRMER') {
      console.log('❌ Opération annulée');
      return;
    }
    
    console.log('\n🚀 Activation en cours...');
    await runScript('enable-trial-for-existing-users.js', ['--confirm']);
    console.log('\n✅ Activation terminée');
    
  } catch (error) {
    console.error('❌ Erreur lors de l\'activation:', error.message);
  }
}

async function cleanupExpiredTrials() {
  console.log('\n🧹 NETTOYAGE DES TRIALS EXPIRÉS');
  console.log('===============================');
  
  try {
    // D'abord en dry-run
    console.log('\n🔍 Recherche des trials expirés...');
    await runScript('cleanup-expired-trials.js');
    
    const proceed = await question('\nVoulez-vous nettoyer ces trials expirés ? (o/N): ');
    if (proceed.toLowerCase() !== 'o') {
      console.log('❌ Nettoyage annulé');
      return;
    }
    
    console.log('\n🧹 Nettoyage en cours...');
    await runScript('cleanup-expired-trials.js', ['--confirm']);
    console.log('\n✅ Nettoyage terminé');
    
  } catch (error) {
    console.error('❌ Erreur lors du nettoyage:', error.message);
  }
}

async function fullMaintenance() {
  console.log('\n🔄 MAINTENANCE COMPLÈTE');
  console.log('=======================');
  
  const confirm = await question('Voulez-vous exécuter la maintenance complète ? (o/N): ');
  if (confirm.toLowerCase() !== 'o') {
    console.log('❌ Maintenance annulée');
    return;
  }
  
  try {
    console.log('\n📊 Étape 1/3: Validation initiale...');
    await runScript('validate-trial-activation.js');
    
    console.log('\n🧹 Étape 2/3: Nettoyage des trials expirés...');
    await runScript('cleanup-expired-trials.js', ['--confirm']);
    
    console.log('\n📊 Étape 3/3: Validation finale...');
    await runScript('validate-trial-activation.js');
    
    console.log('\n✅ Maintenance complète terminée avec succès!');
    
  } catch (error) {
    console.error('❌ Erreur lors de la maintenance:', error.message);
  }
}

async function generateReport() {
  console.log('\n📊 GÉNÉRATION DU RAPPORT');
  console.log('========================');
  
  try {
    await runScript('validate-trial-activation.js');
    console.log('\n✅ Rapport généré et sauvegardé');
  } catch (error) {
    console.error('❌ Erreur lors de la génération du rapport:', error.message);
  }
}

async function main() {
  console.log('🎯 SYSTÈME DE MAINTENANCE DES TRIALS NEWBI');
  console.log('==========================================');
  console.log('Ce script vous permet de gérer le système de trials de Newbi.\n');
  
  try {
    while (true) {
      const choice = await showMenu();
      
      switch (choice) {
        case '1':
          await validateTrials();
          break;
        case '2':
          await activateTrials();
          break;
        case '3':
          await cleanupExpiredTrials();
          break;
        case '4':
          await fullMaintenance();
          break;
        case '5':
          await generateReport();
          break;
        case '0':
          console.log('\n👋 Au revoir!');
          rl.close();
          return;
        default:
          console.log('❌ Option invalide, veuillez choisir entre 0 et 5');
      }
      
      const continueChoice = await question('\nAppuyez sur Entrée pour continuer ou tapez "q" pour quitter: ');
      if (continueChoice.toLowerCase() === 'q') {
        console.log('\n👋 Au revoir!');
        break;
      }
    }
    
  } catch (error) {
    console.error('\n❌ Erreur fatale:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

// Gestion des signaux
process.on('SIGINT', () => {
  console.log('\n⚠️  Interruption détectée');
  rl.close();
  process.exit(0);
});

// Vérifier si le script est exécuté directement
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
