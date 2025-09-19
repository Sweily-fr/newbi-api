import { fileURLToPath } from 'url';
import { dirname } from 'path';
import readline from 'readline';
import fixDemoAccountPassword from './fix-demo-account-password.js';

// Configuration ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Interface readline pour les confirmations
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

/**
 * Demande une confirmation à l'utilisateur
 */
function askConfirmation(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes');
    });
  });
}

/**
 * Script principal avec interface utilisateur
 */
async function runDemoPasswordFix() {
  console.log('🔧 CORRECTION DU MOT DE PASSE DU COMPTE DÉMO');
  console.log('==============================================');
  console.log('');
  console.log('Ce script corrige les problèmes de connexion du compte démo');
  console.log('causés par l\'incompatibilité entre bcrypt et Better Auth.');
  console.log('');
  console.log('📋 Actions qui seront effectuées :');
  console.log('   • Vérification du format du hash du mot de passe');
  console.log('   • Suppression du hash bcrypt incompatible si détecté');
  console.log('   • Activation du flag de réinitialisation de mot de passe');
  console.log('   • Configuration pour Better Auth');
  console.log('');

  // Vérifier les arguments de ligne de commande
  const forceMode = process.argv.includes('--force');

  if (!forceMode) {
    const confirm = await askConfirmation('Voulez-vous continuer ? (y/N): ');
    if (!confirm) {
      console.log('❌ Opération annulée par l\'utilisateur');
      rl.close();
      process.exit(0);
    }
  }

  console.log('');
  console.log('🚀 Démarrage de la correction...');
  console.log('');

  try {
    await fixDemoAccountPassword();
    
    console.log('');
    console.log('✅ CORRECTION RÉUSSIE !');
    console.log('');
    console.log('📋 Prochaines étapes :');
    console.log('   1. Essayez de vous connecter avec demo@newbi.fr');
    console.log('   2. Si la connexion échoue, utilisez "Mot de passe oublié"');
    console.log('   3. Définissez un nouveau mot de passe via Better Auth');
    console.log('   4. Le nouveau hash sera compatible avec Better Auth');
    console.log('');

  } catch (error) {
    console.error('❌ ERREUR LORS DE LA CORRECTION');
    console.error('');
    console.error('Détails de l\'erreur :', error.message);
    console.error('');
    console.error('📋 Solutions possibles :');
    console.error('   • Vérifiez que MongoDB est démarré');
    console.error('   • Vérifiez les variables d\'environnement');
    console.error('   • Vérifiez que le compte démo existe');
    console.error('   • Exécutez d\'abord create-demo-account.js si nécessaire');
    console.error('');
    process.exit(1);
  } finally {
    rl.close();
  }
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  runDemoPasswordFix().catch((error) => {
    console.error('❌ Erreur fatale:', error);
    rl.close();
    process.exit(1);
  });
}
