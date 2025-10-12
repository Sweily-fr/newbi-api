import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Script principal pour orchestrer la migration complète du système trial
 * user → organization
 */

console.log('🚀 MIGRATION COMPLÈTE DU SYSTÈME TRIAL USER → ORGANIZATION');
console.log('=' .repeat(70));

const isDryRun = process.argv.includes('--dry-run');
const skipValidation = process.argv.includes('--skip-validation');
const autoConfirm = process.argv.includes('--auto-confirm');

if (isDryRun) {
  console.log('🧪 MODE SIMULATION - Aucune modification ne sera effectuée');
}

// Fonction utilitaire pour exécuter un script
function runScript(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    console.log(`\n▶️ Exécution: node ${scriptPath} ${args.join(' ')}`);
    
    const child = spawn('node', [scriptPath, ...args], {
      cwd: __dirname,
      stdio: 'inherit'
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Script terminé avec succès: ${scriptPath}`);
        resolve();
      } else {
        console.error(`❌ Script échoué avec le code ${code}: ${scriptPath}`);
        reject(new Error(`Script failed with code ${code}`));
      }
    });
    
    child.on('error', (error) => {
      console.error(`❌ Erreur lors de l'exécution: ${error.message}`);
      reject(error);
    });
  });
}

// Fonction pour demander confirmation
function askConfirmation(message) {
  if (autoConfirm) {
    console.log(`${message} [AUTO-CONFIRMÉ]`);
    return Promise.resolve(true);
  }
  
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function runTrialMigration() {
  try {
    console.log('\n📋 PLAN DE MIGRATION:');
    console.log('1. Migration des données trial user → organization');
    console.log('2. Validation de la migration');
    console.log('3. Nettoyage des champs subscription (optionnel)');
    console.log('4. Mise à jour du modèle User.js (optionnel)');
    
    if (!autoConfirm) {
      const proceed = await askConfirmation('\n❓ Voulez-vous continuer avec la migration');
      if (!proceed) {
        console.log('🛑 Migration annulée par l\'utilisateur');
        process.exit(0);
      }
    }
    
    // Étape 1: Migration des données trial
    console.log('\n' + '='.repeat(50));
    console.log('📊 ÉTAPE 1: MIGRATION DES DONNÉES TRIAL');
    console.log('='.repeat(50));
    
    const migrationArgs = isDryRun ? ['--dry-run'] : [];
    await runScript('migrate-trial-to-organization.js', migrationArgs);
    
    if (isDryRun) {
      console.log('\n🧪 SIMULATION TERMINÉE - Migration des données');
      console.log('💡 Exécutez sans --dry-run pour appliquer les changements');
      return;
    }
    
    // Étape 2: Validation de la migration
    if (!skipValidation) {
      console.log('\n' + '='.repeat(50));
      console.log('🔍 ÉTAPE 2: VALIDATION DE LA MIGRATION');
      console.log('='.repeat(50));
      
      await runScript('validate-trial-migration.js');
      
      const validationOk = await askConfirmation('\n❓ La validation est-elle satisfaisante');
      if (!validationOk) {
        console.log('❌ Migration interrompue - Validation non satisfaisante');
        console.log('💡 Vérifiez le rapport de validation et corrigez les problèmes');
        process.exit(1);
      }
    }
    
    // Étape 3: Nettoyage des champs subscription (optionnel)
    console.log('\n' + '='.repeat(50));
    console.log('🧹 ÉTAPE 3: NETTOYAGE DES CHAMPS SUBSCRIPTION');
    console.log('='.repeat(50));
    
    const cleanupSubscription = await askConfirmation('\n❓ Voulez-vous nettoyer les champs subscription des utilisateurs');
    if (cleanupSubscription) {
      await runScript('cleanup-user-subscription-fields.js', ['--force']);
    } else {
      console.log('⏭️ Nettoyage des champs subscription ignoré');
    }
    
    // Étape 4: Mise à jour du modèle User.js (optionnel)
    console.log('\n' + '='.repeat(50));
    console.log('🔧 ÉTAPE 4: MISE À JOUR DU MODÈLE USER.JS');
    console.log('='.repeat(50));
    
    const updateModel = await askConfirmation('\n❓ Voulez-vous mettre à jour le modèle User.js pour supprimer les champs subscription');
    if (updateModel) {
      await runScript('update-user-model-remove-subscription.js');
    } else {
      console.log('⏭️ Mise à jour du modèle User.js ignorée');
    }
    
    // Résumé final
    console.log('\n' + '='.repeat(70));
    console.log('🎉 MIGRATION COMPLÈTE TERMINÉE AVEC SUCCÈS !');
    console.log('='.repeat(70));
    
    console.log('\n📊 RÉSUMÉ DES ACTIONS EFFECTUÉES:');
    console.log('✅ Migration des données trial user → organization');
    console.log('✅ Validation de la migration');
    if (cleanupSubscription) {
      console.log('✅ Nettoyage des champs subscription');
    }
    if (updateModel) {
      console.log('✅ Mise à jour du modèle User.js');
    }
    
    console.log('\n⚠️ PROCHAINES ÉTAPES IMPORTANTES:');
    console.log('1. 🔄 Redémarrez l\'application backend');
    console.log('2. 🔍 Vérifiez les logs au démarrage');
    console.log('3. 🧪 Testez le système trial avec les nouvelles données d\'organisation');
    console.log('4. 👥 Testez la création de nouveaux utilisateurs');
    console.log('5. 📊 Surveillez les métriques et les erreurs');
    
    console.log('\n💾 SAUVEGARDES CRÉÉES:');
    console.log('- Données trial originales dans /backups');
    if (cleanupSubscription) {
      console.log('- Champs subscription dans /backups');
    }
    if (updateModel) {
      console.log('- Modèle User.js original sauvegardé');
    }
    
    console.log('\n🆘 EN CAS DE PROBLÈME:');
    console.log('- Consultez les rapports de validation dans /reports');
    console.log('- Restaurez depuis les sauvegardes si nécessaire');
    console.log('- Vérifiez les logs d\'application pour les erreurs');
    
  } catch (error) {
    console.error('\n💥 ERREUR LORS DE LA MIGRATION:', error.message);
    console.error('\n🆘 ACTIONS DE RÉCUPÉRATION:');
    console.error('1. Vérifiez les logs ci-dessus pour identifier le problème');
    console.error('2. Corrigez le problème identifié');
    console.error('3. Relancez la migration depuis l\'étape qui a échoué');
    console.error('4. Si nécessaire, restaurez depuis les sauvegardes');
    process.exit(1);
  }
}

// Affichage de l'aide
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('\n📖 AIDE - MIGRATION TRIAL USER → ORGANIZATION');
  console.log('\nUsage: node run-trial-migration.js [options]');
  console.log('\nOptions:');
  console.log('  --dry-run         Simulation sans modifications');
  console.log('  --skip-validation Ignorer l\'étape de validation');
  console.log('  --auto-confirm    Confirmer automatiquement toutes les étapes');
  console.log('  --help, -h        Afficher cette aide');
  console.log('\nExemples:');
  console.log('  node run-trial-migration.js --dry-run');
  console.log('  node run-trial-migration.js --auto-confirm');
  console.log('  node run-trial-migration.js --skip-validation');
  process.exit(0);
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  runTrialMigration()
    .then(() => {
      console.log('\n🎊 MIGRATION TERMINÉE AVEC SUCCÈS !');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 MIGRATION ÉCHOUÉE:', error.message);
      process.exit(1);
    });
}

export default runTrialMigration;
