import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const DEMO_EMAIL = "demo@newbi.fr";

console.log('🎯 SCRIPT D\'AJOUT DE DONNÉES DE DÉMONSTRATION NEWBI');
console.log('==================================================');
console.log('📧 Utilisateur cible:', DEMO_EMAIL);
console.log('📊 Collections: 13 factures, 10 devis, 5 avoirs');
console.log('');

// Interface readline pour les confirmations
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function confirmExecution() {
  console.log('⚠️  ATTENTION: Ce script va:');
  console.log('   • Supprimer toutes les factures existantes de l\'utilisateur démo');
  console.log('   • Supprimer tous les devis existants de l\'utilisateur démo');
  console.log('   • Supprimer tous les avoirs existants de l\'utilisateur démo');
  console.log('   • Créer de nouvelles données de démonstration');
  console.log('');
  
  const answer = await askQuestion('Êtes-vous sûr de vouloir continuer ? (oui/non): ');
  return answer === 'oui' || answer === 'o' || answer === 'yes' || answer === 'y';
}

async function showPreview() {
  console.log('📋 APERÇU DES DONNÉES QUI SERONT CRÉÉES:');
  console.log('');
  console.log('📄 FACTURES (13):');
  console.log('   • Services variés: Développement, Formation, Consultation, etc.');
  console.log('   • Statuts répartis: 50% COMPLETED, 30% PENDING, 15% DRAFT, 5% CANCELED');
  console.log('   • Montants: Entre 100€ et 15,000€ selon les services');
  console.log('   • Dates: Réparties sur les 90 derniers jours');
  console.log('');
  console.log('📋 DEVIS (10):');
  console.log('   • Projets variés: E-commerce, Mobile, CRM, IoT, etc.');
  console.log('   • Statuts répartis: 30% COMPLETED, 50% PENDING, 15% CANCELED, 5% DRAFT');
  console.log('   • Montants: Entre 1,500€ et 11,400€ selon les projets');
  console.log('   • Validité: 30 jours à partir de la date d\'émission');
  console.log('');
  console.log('💰 AVOIRS (5):');
  console.log('   • Types variés: Geste commercial, Correction, Remboursement, etc.');
  console.log('   • Montants: Entre 50€ et 500€ (montants négatifs)');
  console.log('   • Liés aux factures existantes de manière aléatoire');
  console.log('   • Méthodes de remboursement variées');
  console.log('');
}

function executeScript() {
  return new Promise((resolve, reject) => {
    console.log('🚀 Exécution du script principal...\n');
    
    const scriptPath = join(__dirname, 'add-demo-documents.js');
    const child = spawn('node', [scriptPath], {
      stdio: 'inherit',
      cwd: __dirname
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Le script s'est terminé avec le code ${code}`));
      }
    });
    
    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function main() {
  try {
    // Vérifier les arguments de ligne de commande
    const args = process.argv.slice(2);
    const forceMode = args.includes('--force') || args.includes('-f');
    const previewMode = args.includes('--preview') || args.includes('-p');
    
    if (previewMode) {
      await showPreview();
      rl.close();
      return;
    }
    
    // Afficher l'aperçu
    await showPreview();
    
    // Demander confirmation si pas en mode force
    if (!forceMode) {
      const confirmed = await confirmExecution();
      if (!confirmed) {
        console.log('❌ Opération annulée par l\'utilisateur');
        rl.close();
        return;
      }
    } else {
      console.log('🔥 Mode force activé - Exécution sans confirmation');
    }
    
    rl.close();
    
    // Exécuter le script principal
    await executeScript();
    
    console.log('\n🎉 SUCCÈS !');
    console.log('✅ Les données de démonstration ont été ajoutées avec succès');
    console.log('🔗 Connectez-vous avec demo@newbi.fr pour voir les résultats');
    console.log('');
    console.log('📊 Prochaines étapes:');
    console.log('   • Tester la création de nouvelles factures');
    console.log('   • Vérifier la numérotation séquentielle');
    console.log('   • Tester la conversion devis → facture');
    console.log('   • Tester la création d\'avoirs');
    
  } catch (error) {
    console.error('\n❌ ERREUR:', error.message);
    
    if (error.message.includes('ECONNREFUSED')) {
      console.error('💡 Solution: Vérifiez que MongoDB est démarré');
    } else if (error.message.includes('authentication failed')) {
      console.error('💡 Solution: Vérifiez les identifiants MongoDB');
    } else if (error.message.includes('demo@newbi.fr')) {
      console.error('💡 Solution: Créez d\'abord l\'utilisateur démo avec create-demo-account.js');
    }
    
    console.error('\n🔧 Dépannage:');
    console.error('   • Vérifiez que MongoDB est accessible');
    console.error('   • Vérifiez que l\'utilisateur demo@newbi.fr existe');
    console.error('   • Consultez les logs détaillés ci-dessus');
    
    process.exit(1);
  } finally {
    if (rl && !rl.closed) {
      rl.close();
    }
  }
}

// Gestion des signaux
process.on('SIGINT', () => {
  console.log('\n⚠️  Interruption détectée');
  if (rl && !rl.closed) {
    rl.close();
  }
  process.exit(0);
});

// Affichage de l'aide
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('UTILISATION:');
  console.log('  node run-add-demo-documents.js [options]');
  console.log('');
  console.log('OPTIONS:');
  console.log('  --force, -f     Exécuter sans demander de confirmation');
  console.log('  --preview, -p   Afficher seulement l\'aperçu des données');
  console.log('  --help, -h      Afficher cette aide');
  console.log('');
  console.log('EXEMPLES:');
  console.log('  node run-add-demo-documents.js');
  console.log('  node run-add-demo-documents.js --force');
  console.log('  node run-add-demo-documents.js --preview');
  process.exit(0);
}

// Exécution
main().catch(console.error);
