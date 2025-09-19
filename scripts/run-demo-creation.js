#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createInterface } from 'readline';
import createDemoAccount from './create-demo-account.js';

// Configuration ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Script d'exécution simple pour créer le compte démo
 * Usage: node scripts/run-demo-creation.js
 */

console.log('🎯 CRÉATION DE COMPTE DÉMO NEWBI');
console.log('================================');
console.log('Ce script va créer un compte démo complet avec :');
console.log('• 1 utilisateur démo (demo@newbi.fr)');
console.log('• 3 clients factices');
console.log('• 3 factures (complétée, en attente, brouillon)');
console.log('• 2 devis (accepté, en attente)');
console.log('• 1 avoir');
console.log('• 3 dépenses');
console.log('');

// Fonction pour demander confirmation (compatible ES modules)
function askConfirmation() {
  return new Promise((resolve) => {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    readline.question('Voulez-vous continuer ? (y/N): ', (answer) => {
      readline.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function main() {
  try {
    // Vérifier les arguments de ligne de commande
    const args = process.argv.slice(2);
    const forceMode = args.includes('--force') || args.includes('-f');
    
    if (!forceMode) {
      console.log('⚠️  ATTENTION: Si un compte démo existe déjà, il sera supprimé et recréé.');
      console.log('');
      
      const confirmed = await askConfirmation();
      if (!confirmed) {
        console.log('❌ Opération annulée par l\'utilisateur');
        process.exit(0);
      }
    }

    console.log('');
    console.log('🚀 Lancement de la création du compte démo...');
    console.log('');

    // Exécuter le script de création
    await createDemoAccount();

    console.log('');
    console.log('🎉 SUCCÈS ! Le compte démo a été créé avec succès.');
    console.log('');
    console.log('📝 INFORMATIONS DE CONNEXION:');
    console.log('   Email: demo@newbi.fr');
    console.log('   Mot de passe: Test_123@');
    console.log('');
    console.log('🌐 Vous pouvez maintenant vous connecter à l\'application avec ces identifiants.');
    
  } catch (error) {
    console.error('');
    console.error('❌ ERREUR lors de la création du compte démo:');
    console.error(error.message);
    console.error('');
    console.error('💡 SOLUTIONS POSSIBLES:');
    console.error('   • Vérifiez que MongoDB est démarré');
    console.error('   • Vérifiez la configuration de MONGODB_URI');
    console.error('   • Vérifiez les permissions d\'écriture sur la base de données');
    console.error('');
    console.error('🔍 DÉTAILS TECHNIQUES:');
    console.error(error.stack);
    process.exit(1);
  }
}

// Gestion des signaux d'interruption
process.on('SIGINT', () => {
  console.log('');
  console.log('⚠️  Interruption détectée. Arrêt du script...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('');
  console.log('⚠️  Terminaison détectée. Arrêt du script...');
  process.exit(0);
});

// Exécution du script principal
main();
