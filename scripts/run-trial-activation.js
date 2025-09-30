#!/usr/bin/env node

/**
 * Script d'exécution pour l'activation des trials
 * Interface conviviale avec confirmations utilisateur
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

async function main() {
  console.log('🎯 ACTIVATION TRIAL POUR UTILISATEURS EXISTANTS');
  console.log('===============================================\n');
  
  console.log('Ce script va activer la période d\'essai de 14 jours pour les organisations');
  console.log('qui n\'ont pas d\'abonnement actif et n\'ont pas encore utilisé leur trial.\n');
  
  try {
    // Étape 1: Analyse en mode dry-run
    console.log('📊 ÉTAPE 1: Analyse des organisations (dry-run)');
    console.log('==============================================');
    
    const runAnalysis = await question('Voulez-vous analyser les organisations ? (o/N): ');
    if (runAnalysis.toLowerCase() !== 'o') {
      console.log('❌ Analyse annulée');
      rl.close();
      return;
    }
    
    console.log('\n🔍 Exécution de l\'analyse...\n');
    await runScript('enable-trial-for-existing-users.js'); // Mode dry-run par défaut
    
    // Étape 2: Confirmation pour l'exécution
    console.log('\n💡 ÉTAPE 2: Application des changements');
    console.log('======================================');
    
    const applyChanges = await question('\nVoulez-vous appliquer ces changements ? (o/N): ');
    if (applyChanges.toLowerCase() !== 'o') {
      console.log('❌ Application annulée');
      rl.close();
      return;
    }
    
    // Confirmation finale
    const finalConfirm = await question('⚠️  ATTENTION: Cette action va modifier la base de données.\nÊtes-vous sûr de vouloir continuer ? (tapez "CONFIRMER"): ');
    if (finalConfirm !== 'CONFIRMER') {
      console.log('❌ Opération annulée');
      rl.close();
      return;
    }
    
    // Étape 3: Exécution avec --confirm
    console.log('\n🚀 Exécution de l\'activation des trials...\n');
    await runScript('enable-trial-for-existing-users.js', ['--confirm']);
    
    console.log('\n✅ ACTIVATION TERMINÉE AVEC SUCCÈS!');
    console.log('==================================');
    console.log('Les organisations éligibles ont maintenant accès à leur période d\'essai de 14 jours.');
    
  } catch (error) {
    console.error('\n❌ Erreur lors de l\'exécution:', error.message);
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
