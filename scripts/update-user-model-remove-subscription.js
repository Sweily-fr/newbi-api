import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Script pour mettre à jour le modèle User.js et supprimer les champs subscription
 * À exécuter APRÈS le nettoyage des données subscription
 */

console.log('🔧 Mise à jour du modèle User.js - Suppression des champs subscription');

const isDryRun = process.argv.includes('--dry-run');
if (isDryRun) {
  console.log('🧪 MODE SIMULATION - Aucune modification ne sera effectuée');
}

async function updateUserModel() {
  try {
    const userModelPath = join(__dirname, '..', 'src', 'models', 'User.js');
    
    console.log(`📁 Chemin du modèle User.js: ${userModelPath}`);
    
    if (!fs.existsSync(userModelPath)) {
      throw new Error(`Fichier User.js non trouvé: ${userModelPath}`);
    }
    
    // Lire le contenu actuel
    const currentContent = fs.readFileSync(userModelPath, 'utf8');
    console.log('✅ Fichier User.js lu avec succès');
    
    // Créer une sauvegarde
    if (!isDryRun) {
      const backupPath = `${userModelPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.writeFileSync(backupPath, currentContent);
      console.log(`💾 Sauvegarde créée: ${backupPath}`);
    }
    
    // Définir les modifications à apporter
    const modifications = [
      {
        name: 'Suppression du champ subscription',
        search: /subscription: \{[\s\S]*?\},\s*emailVerificationExpires/,
        replace: 'emailVerificationExpires'
      },
      {
        name: 'Suppression du middleware pre("save") trial',
        search: /\/\*\*\s*\* Middleware pour démarrer automatiquement la période d'essai[\s\S]*?\}\);/,
        replace: ''
      },
      {
        name: 'Suppression de la méthode startTrial',
        search: /\/\*\*\s*\* Méthode pour démarrer la période d'essai[\s\S]*?\};/,
        replace: ''
      },
      {
        name: 'Suppression de la méthode isTrialValid',
        search: /\/\*\*\s*\* Méthode pour vérifier si la période d'essai[\s\S]*?\};/,
        replace: ''
      },
      {
        name: 'Suppression de la méthode endTrial',
        search: /\/\*\*\s*\* Méthode pour terminer la période d'essai[\s\S]*?\};/,
        replace: ''
      },
      {
        name: 'Suppression de la méthode getTrialDaysRemaining',
        search: /\/\*\*\s*\* Méthode pour obtenir les jours restants[\s\S]*?\};/,
        replace: ''
      },
      {
        name: 'Suppression de la méthode hasPremiumAccess',
        search: /\/\*\*\s*\* Méthode pour vérifier si l'utilisateur a accès aux fonctionnalités premium[\s\S]*?\};/,
        replace: ''
      }
    ];
    
    let updatedContent = currentContent;
    let modificationsApplied = 0;
    
    console.log('\n🔄 Application des modifications...');
    
    for (const modification of modifications) {
      console.log(`\n📝 ${modification.name}:`);
      
      if (modification.search.test(updatedContent)) {
        if (!isDryRun) {
          updatedContent = updatedContent.replace(modification.search, modification.replace);
          console.log('✅ Modification appliquée');
          modificationsApplied++;
        } else {
          console.log('🧪 [SIMULATION] Modification serait appliquée');
          modificationsApplied++;
        }
      } else {
        console.log('⚠️ Pattern non trouvé - modification ignorée');
      }
    }
    
    // Nettoyer les lignes vides multiples
    if (!isDryRun) {
      updatedContent = updatedContent.replace(/\n\s*\n\s*\n/g, '\n\n');
    }
    
    // Écrire le fichier mis à jour
    if (!isDryRun && modificationsApplied > 0) {
      fs.writeFileSync(userModelPath, updatedContent);
      console.log('\n✅ Fichier User.js mis à jour avec succès');
    }
    
    // Résumé
    console.log('\n📊 RÉSUMÉ DES MODIFICATIONS:');
    console.log(`✅ Modifications appliquées: ${modificationsApplied}/${modifications.length}`);
    
    if (isDryRun) {
      console.log('\n🧪 SIMULATION TERMINÉE - Aucune modification effectuée');
      console.log('💡 Exécutez sans --dry-run pour appliquer les changements');
    } else if (modificationsApplied > 0) {
      console.log('\n📋 MODIFICATIONS EFFECTUÉES:');
      console.log('- Champ subscription supprimé du schéma');
      console.log('- Middleware pre("save") trial supprimé');
      console.log('- Méthodes trial supprimées (startTrial, isTrialValid, etc.)');
      console.log('- Sauvegarde créée');
      
      console.log('\n⚠️ PROCHAINES ÉTAPES:');
      console.log('1. Redémarrez l\'application backend');
      console.log('2. Vérifiez qu\'il n\'y a pas d\'erreurs au démarrage');
      console.log('3. Testez la création de nouveaux utilisateurs');
      console.log('4. Vérifiez que le système trial fonctionne avec les organisations');
    }
    
  } catch (error) {
    console.error('❌ Erreur lors de la mise à jour du modèle:', error);
    process.exit(1);
  }
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  updateUserModel()
    .then(() => {
      console.log('\n🎉 Script terminé avec succès');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Erreur fatale:', error);
      process.exit(1);
    });
}

export default updateUserModel;
