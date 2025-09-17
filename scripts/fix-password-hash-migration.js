import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcrypt';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration MongoDB (basée sur le script stripe-cleanup-direct.js qui fonctionne)
const MONGODB_URI = 'mongodb://newbiAdmin:j6FKJHBb39Rdw^kM^2^Fp5ohPfjgy9@localhost:27017/newbi?authSource=admin';
const DB_NAME = 'newbi';

console.log('🔗 Connexion à MongoDB:', MONGODB_URI.replace(/:[^:]*@/, ':***@'));
console.log('🗄️ Base de données:', DB_NAME);

const isDryRun = !process.argv.includes('--confirm');
const mode = isDryRun ? '🔍 MODE DRY-RUN' : '⚡ MODE EXÉCUTION';
console.log(`\n${mode} - ${isDryRun ? 'Aucune modification ne sera effectuée' : 'Les modifications seront appliquées'}\n`);

async function analyzePasswordHashes() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db(DB_NAME);
    const usersCollection = db.collection('user');
    
    // Analyser tous les utilisateurs avec des mots de passe
    const users = await usersCollection.find({
      password: { $exists: true, $ne: null }
    }).toArray();
    
    console.log(`\n📊 Analyse de ${users.length} utilisateurs avec mots de passe:`);
    
    const stats = {
      bcryptHashes: 0,
      betterAuthHashes: 0,
      unknownHashes: 0,
      noPassword: 0,
      usersToReset: []
    };
    
    for (const user of users) {
      if (!user.password) {
        stats.noPassword++;
        continue;
      }
      
      const password = user.password;
      
      // Identifier le type de hash
      if (password.startsWith('$2b$') || password.startsWith('$2a$') || password.startsWith('$2y$')) {
        stats.bcryptHashes++;
        stats.usersToReset.push({
          id: user._id,
          email: user.email,
          hashType: 'bcrypt',
          hashPrefix: password.substring(0, 10) + '...'
        });
      } else if (password.length === 60 && password.startsWith('$')) {
        stats.betterAuthHashes++;
      } else {
        stats.unknownHashes++;
        console.log(`⚠️ Hash inconnu pour ${user.email}: ${password.substring(0, 20)}...`);
      }
    }
    
    console.log('\n📈 Statistiques des mots de passe:');
    console.log(`   • Hashes bcrypt (à réinitialiser): ${stats.bcryptHashes}`);
    console.log(`   • Hashes better-auth (OK): ${stats.betterAuthHashes}`);
    console.log(`   • Hashes inconnus: ${stats.unknownHashes}`);
    console.log(`   • Utilisateurs sans mot de passe: ${stats.noPassword}`);
    
    if (stats.usersToReset.length > 0) {
      console.log('\n👥 Utilisateurs avec hashes bcrypt à réinitialiser:');
      stats.usersToReset.forEach(user => {
        console.log(`   • ${user.email} (${user.hashType}: ${user.hashPrefix})`);
      });
      
      if (!isDryRun) {
        console.log('\n🔄 Réinitialisation des mots de passe bcrypt...');
        
        for (const user of stats.usersToReset) {
          // Marquer le mot de passe comme nécessitant une réinitialisation
          await usersCollection.updateOne(
            { _id: user.id },
            {
              $set: {
                passwordResetRequired: true,
                passwordResetReason: 'Migration from bcrypt to better-auth',
                passwordResetAt: new Date()
              },
              $unset: {
                password: 1 // Supprimer l'ancien hash bcrypt
              }
            }
          );
          console.log(`   ✅ ${user.email} - mot de passe réinitialisé`);
        }
        
        // Nettoyer les sessions existantes pour forcer une nouvelle authentification
        console.log('\n🧹 Nettoyage des sessions existantes...');
        const sessionsCollection = db.collection('sessions');
        const sessionResult = await sessionsCollection.deleteMany({});
        console.log(`   ✅ ${sessionResult.deletedCount} sessions supprimées`);
        
        // Nettoyer les tokens better-auth si ils existent
        const tokensCollection = db.collection('verification_tokens');
        const tokenResult = await tokensCollection.deleteMany({});
        console.log(`   ✅ ${tokenResult.deletedCount} tokens de vérification supprimés`);
        
        console.log('\n✅ Migration des mots de passe terminée!');
        console.log('📧 Les utilisateurs devront réinitialiser leur mot de passe à la prochaine connexion');
      } else {
        console.log('\n🔍 Mode dry-run: Aucune modification effectuée');
        console.log('💡 Utilisez --confirm pour appliquer les changements');
      }
    } else {
      console.log('\n✅ Aucun hash bcrypt trouvé - tous les mots de passe sont compatibles');
    }
    
    return stats;
    
  } catch (error) {
    console.error('❌ Erreur lors de l\'analyse:', error);
    throw error;
  } finally {
    await client.close();
    console.log('🔌 Connexion MongoDB fermée');
  }
}

async function validateAuthenticationFlow() {
  console.log('\n🔍 Validation du flux d\'authentification...');
  
  const client = new MongoClient(MONGODB_URI);
  
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    
    // Vérifier les collections nécessaires pour better-auth
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    console.log('\n📋 Collections disponibles:');
    collectionNames.forEach(name => {
      console.log(`   • ${name}`);
    });
    
    // Vérifier les collections better-auth
    const betterAuthCollections = [
      'user',
      'session',
      'account',
      'verification_tokens'
    ];
    
    console.log('\n🔐 Vérification des collections better-auth:');
    betterAuthCollections.forEach(collectionName => {
      const exists = collectionNames.includes(collectionName);
      console.log(`   ${exists ? '✅' : '❌'} ${collectionName}`);
    });
    
    // Vérifier les index sur la collection user
    const userCollection = db.collection('user');
    const indexes = await userCollection.indexes();
    
    console.log('\n📊 Index sur la collection user:');
    indexes.forEach(index => {
      console.log(`   • ${JSON.stringify(index.key)} (${index.name})`);
    });
    
    // Compter les utilisateurs avec différents états
    const totalUsers = await userCollection.countDocuments();
    const usersWithPassword = await userCollection.countDocuments({ password: { $exists: true } });
    const usersNeedingReset = await userCollection.countDocuments({ passwordResetRequired: true });
    
    console.log('\n👥 État des utilisateurs:');
    console.log(`   • Total: ${totalUsers}`);
    console.log(`   • Avec mot de passe: ${usersWithPassword}`);
    console.log(`   • Nécessitant réinitialisation: ${usersNeedingReset}`);
    
  } catch (error) {
    console.error('❌ Erreur lors de la validation:', error);
  } finally {
    await client.close();
  }
}

async function main() {
  console.log('🔧 Script de migration des mots de passe bcrypt vers better-auth');
  console.log('=' .repeat(60));
  
  try {
    // Analyser et migrer les mots de passe
    const stats = await analyzePasswordHashes();
    
    // Valider le flux d'authentification
    await validateAuthenticationFlow();
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ Script terminé avec succès');
    
    if (isDryRun && stats.usersToReset.length > 0) {
      console.log('\n💡 Pour appliquer les changements, relancez avec: --confirm');
    }
    
  } catch (error) {
    console.error('\n❌ Erreur fatale:', error);
    process.exit(1);
  }
}

// Exécuter le script
main();
