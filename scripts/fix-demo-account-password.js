import { fileURLToPath } from 'url';
import { dirname } from 'path';
import mongoose from 'mongoose';

// Configuration ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import du modèle User
import User from '../src/models/User.js';

// Configuration MongoDB
let MONGODB_URI;
try {
  const config = await import('../ecosystem.config.cjs');
  MONGODB_URI = config.default.apps[0].env.MONGODB_URI;
} catch (error) {
  MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/newbi-production";
}

console.log('🚀 Script de correction du mot de passe du compte démo');
console.log('📋 Configuration MongoDB:', MONGODB_URI.replace(/\/\/.*@/, '//***:***@'));

/**
 * Corrige le mot de passe du compte démo pour la compatibilité Better Auth
 */
async function fixDemoAccountPassword() {
  try {
    // Connexion à MongoDB
    console.log('📋 Étape 1/3 - Connexion à MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connexion MongoDB réussie');

    // Rechercher l'utilisateur démo
    console.log('📋 Étape 2/3 - Recherche du compte démo...');
    const demoUser = await User.findOne({ email: 'demo@newbi.fr' });
    
    if (!demoUser) {
      console.log('❌ Compte démo non trouvé. Veuillez d\'abord exécuter create-demo-account.js');
      process.exit(1);
    }

    console.log('✅ Compte démo trouvé:', demoUser.email);
    console.log('📋 Hash actuel:', demoUser.password.substring(0, 20) + '...');

    // Analyser le type de hash
    const isBcryptHash = demoUser.password.startsWith('$2b$') || 
                        demoUser.password.startsWith('$2a$') || 
                        demoUser.password.startsWith('$2y$');

    if (isBcryptHash) {
      console.log('⚠️  Hash bcrypt détecté - incompatible avec Better Auth');
      
      // Forcer la réinitialisation du mot de passe
      console.log('📋 Étape 3/3 - Correction du mot de passe...');
      
      // Supprimer le hash bcrypt et forcer une réinitialisation
      await User.updateOne(
        { _id: demoUser._id },
        { 
          $unset: { password: 1 },
          $set: { 
            passwordResetRequired: true,
            // Définir un mot de passe temporaire que Better Auth peut gérer
            tempPassword: 'Test_123@'
          }
        }
      );

      console.log('✅ Mot de passe corrigé - réinitialisation forcée');
      console.log('\n🎉 CORRECTION TERMINÉE !');
      console.log('=====================================');
      console.log('📧 Email: demo@newbi.fr');
      console.log('🔑 Mot de passe: Test_123@ (à réinitialiser à la première connexion)');
      console.log('\n⚠️  IMPORTANT:');
      console.log('   • L\'utilisateur devra réinitialiser son mot de passe à la première connexion');
      console.log('   • Cela garantit la compatibilité avec Better Auth');
      console.log('   • Le nouveau hash sera généré par Better Auth');

    } else {
      console.log('✅ Le mot de passe semble déjà compatible avec Better Auth');
      console.log('📋 Format détecté:', demoUser.password.substring(0, 10) + '...');
    }

  } catch (error) {
    console.error('❌ Erreur lors de la correction:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('📋 Connexion MongoDB fermée');
  }
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  fixDemoAccountPassword();
}

export default fixDemoAccountPassword;
