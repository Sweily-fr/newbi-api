import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Script de nettoyage des champs subscription de la collection user
 * À exécuter APRÈS validation de la migration trial vers organization
 */

// Configuration MongoDB
let MONGODB_URI;
let MONGODB_DB_NAME = 'newbi';

// Essayer de charger la configuration depuis ecosystem.config.cjs
try {
  const configPath = join(__dirname, '..', 'ecosystem.config.cjs');
  if (fs.existsSync(configPath)) {
    // Utilisation synchrone pour éviter les problèmes avec await au niveau module
    console.log('⚠️ Configuration ecosystem.config.cjs trouvée mais non chargée (utilisation des variables d\'environnement)');
  }
} catch (error) {
  console.log('⚠️ Impossible de charger ecosystem.config.cjs, utilisation des variables d\'environnement');
}

// Fallback vers les variables d'environnement
if (!MONGODB_URI) {
  MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/newbi';
}

console.log('🧹 Nettoyage des champs subscription de la collection user');
console.log('📋 Configuration:');
console.log(`   - MongoDB URI: ${MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
console.log(`   - Database: ${MONGODB_DB_NAME}`);

const isDryRun = process.argv.includes('--dry-run');
const forceCleanup = process.argv.includes('--force');

if (isDryRun) {
  console.log('🧪 MODE SIMULATION - Aucune modification ne sera effectuée');
} else if (!forceCleanup) {
  console.log('⚠️ ATTENTION: Ce script va supprimer définitivement les champs subscription des utilisateurs');
  console.log('💡 Utilisez --force pour confirmer ou --dry-run pour simuler');
  process.exit(1);
}

async function cleanupUserSubscriptionFields() {
  const client = new MongoClient(MONGODB_URI);
  
  try {
    console.log('\n📡 Connexion à MongoDB...');
    await client.connect();
    console.log('✅ Connexion MongoDB établie');
    
    const db = client.db(MONGODB_DB_NAME);
    const userCollection = db.collection('user');
    
    // Étape 1: Analyser les utilisateurs avec champs subscription
    console.log('\n🔍 Analyse des utilisateurs avec champs subscription...');
    
    const usersWithSubscription = await userCollection.find({
      subscription: { $exists: true }
    }).toArray();
    
    console.log(`📊 Utilisateurs avec champs subscription trouvés: ${usersWithSubscription.length}`);
    
    if (usersWithSubscription.length === 0) {
      console.log('✅ Aucun champ subscription à nettoyer');
      return;
    }
    
    // Étape 2: Créer une sauvegarde des données subscription
    if (!isDryRun) {
      console.log('\n💾 Création de la sauvegarde des champs subscription...');
      const backupDir = join(__dirname, '..', 'backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = join(backupDir, `user-subscription-backup-${timestamp}.json`);
      
      const subscriptionBackup = usersWithSubscription.map(user => ({
        userId: user._id.toString(),
        email: user.email,
        subscription: user.subscription
      }));
      
      fs.writeFileSync(backupFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        totalUsers: usersWithSubscription.length,
        subscriptionData: subscriptionBackup
      }, null, 2));
      
      console.log(`✅ Sauvegarde créée: ${backupFile}`);
    }
    
    // Étape 3: Analyser les types de champs subscription
    console.log('\n📋 Analyse des champs subscription:');
    
    const subscriptionAnalysis = {
      withTrialData: 0,
      withStripeData: 0,
      withLicenceData: 0,
      totalFields: 0
    };
    
    for (const user of usersWithSubscription) {
      const sub = user.subscription || {};
      
      if (sub.trialStartDate || sub.trialEndDate || sub.isTrialActive || sub.hasUsedTrial) {
        subscriptionAnalysis.withTrialData++;
      }
      
      if (sub.stripeCustomerId) {
        subscriptionAnalysis.withStripeData++;
      }
      
      if (sub.licence !== undefined || sub.trial !== undefined) {
        subscriptionAnalysis.withLicenceData++;
      }
      
      subscriptionAnalysis.totalFields++;
    }
    
    console.log(`   - Utilisateurs avec données trial: ${subscriptionAnalysis.withTrialData}`);
    console.log(`   - Utilisateurs avec données Stripe: ${subscriptionAnalysis.withStripeData}`);
    console.log(`   - Utilisateurs avec données licence: ${subscriptionAnalysis.withLicenceData}`);
    console.log(`   - Total à nettoyer: ${subscriptionAnalysis.totalFields}`);
    
    // Étape 4: Vérification de sécurité
    if (!isDryRun) {
      console.log('\n🔒 VÉRIFICATION DE SÉCURITÉ:');
      console.log('⚠️ Assurez-vous que:');
      console.log('   1. La migration trial vers organization est terminée et validée');
      console.log('   2. Les données Stripe ne sont plus utilisées ou ont été migrées');
      console.log('   3. Vous avez testé le système avec les nouvelles données d\'organisation');
      console.log('\n💡 Si vous n\'êtes pas sûr, utilisez --dry-run pour simuler');
    }
    
    // Étape 5: Nettoyage des champs
    console.log('\n🧹 Nettoyage des champs subscription...');
    
    let cleanedCount = 0;
    let errorCount = 0;
    
    for (const user of usersWithSubscription) {
      try {
        console.log(`\n👤 Nettoyage utilisateur: ${user.email} (${user._id})`);
        
        if (!isDryRun) {
          // Supprimer le champ subscription
          const updateResult = await userCollection.updateOne(
            { _id: user._id },
            { 
              $unset: { subscription: "" },
              $set: { updatedAt: new Date() }
            }
          );
          
          if (updateResult.modifiedCount > 0) {
            console.log(`✅ Champs subscription supprimés pour ${user.email}`);
            cleanedCount++;
          } else {
            console.log(`⚠️ Aucune modification pour ${user.email}`);
          }
        } else {
          console.log(`🧪 [SIMULATION] Champs subscription seraient supprimés pour ${user.email}`);
          cleanedCount++;
        }
        
      } catch (error) {
        console.error(`❌ Erreur lors du nettoyage de ${user.email}:`, error.message);
        errorCount++;
      }
    }
    
    // Étape 6: Résumé du nettoyage
    console.log('\n📊 RÉSUMÉ DU NETTOYAGE:');
    console.log(`✅ Utilisateurs nettoyés avec succès: ${cleanedCount}`);
    console.log(`❌ Erreurs rencontrées: ${errorCount}`);
    console.log(`📋 Total traité: ${usersWithSubscription.length}`);
    
    if (isDryRun) {
      console.log('\n🧪 SIMULATION TERMINÉE - Aucune modification effectuée');
      console.log('💡 Exécutez avec --force pour appliquer les changements');
    } else {
      console.log('\n✅ NETTOYAGE TERMINÉ');
      
      if (cleanedCount > 0) {
        console.log('\n📋 ACTIONS EFFECTUÉES:');
        console.log(`- ${cleanedCount} champs subscription supprimés`);
        console.log('- Sauvegarde créée dans /backups');
        console.log('- Champs updatedAt mis à jour');
        
        console.log('\n⚠️ PROCHAINES ÉTAPES:');
        console.log('1. Vérifiez que l\'application fonctionne correctement');
        console.log('2. Testez le système trial avec les données d\'organisation');
        console.log('3. Surveillez les logs pour détecter d\'éventuelles erreurs');
        console.log('4. En cas de problème, restaurez depuis la sauvegarde');
      }
    }
    
    // Étape 7: Vérification post-nettoyage
    if (!isDryRun && cleanedCount > 0) {
      console.log('\n🔍 Vérification post-nettoyage...');
      
      const remainingSubscriptions = await userCollection.countDocuments({
        subscription: { $exists: true }
      });
      
      console.log(`📊 Champs subscription restants: ${remainingSubscriptions}`);
      
      if (remainingSubscriptions === 0) {
        console.log('✅ Tous les champs subscription ont été supprimés avec succès');
      } else {
        console.log('⚠️ Certains champs subscription n\'ont pas été supprimés');
      }
    }
    
  } catch (error) {
    console.error('❌ Erreur lors du nettoyage:', error);
    process.exit(1);
  } finally {
    await client.close();
    console.log('\n📡 Connexion MongoDB fermée');
  }
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  cleanupUserSubscriptionFields()
    .then(() => {
      console.log('\n🎉 Script terminé avec succès');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Erreur fatale:', error);
      process.exit(1);
    });
}

export default cleanupUserSubscriptionFields;
