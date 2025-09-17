import { MongoClient } from 'mongodb';

const INVALID_CUSTOMER_ID = 'cus_T4P4fP7b671qch';

// Différentes configurations MongoDB à essayer
const MONGODB_CONFIGS = [
  {
    name: 'Local sans auth',
    uri: 'mongodb://127.0.0.1:27017/newbi-production'
  },
  {
    name: 'Local avec base invoice-app',
    uri: 'mongodb://127.0.0.1:27017/invoice-app'
  },
  {
    name: 'Local avec base newbi',
    uri: 'mongodb://127.0.0.1:27017/newbi'
  },
  {
    name: 'Localhost sans auth',
    uri: 'mongodb://localhost:27017/newbi-production'
  }
];

console.log('🧹 NETTOYAGE DU CUSTOMER STRIPE INVALIDE');
console.log('=========================================');
console.log(`Customer ID à nettoyer: ${INVALID_CUSTOMER_ID}`);

async function tryConnection(config) {
  console.log(`\n📡 Test de connexion: ${config.name}`);
  console.log(`   URI: ${config.uri}`);
  
  let client;
  try {
    client = new MongoClient(config.uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });
    
    await client.connect();
    const db = client.db();
    
    // Test simple sans listCollections
    const userCount = await db.collection('user').countDocuments();
    console.log(`   ✅ Connexion réussie - ${userCount} utilisateurs trouvés`);
    
    return { client, db, config };
    
  } catch (error) {
    console.log(`   ❌ Échec: ${error.message}`);
    if (client) {
      try { await client.close(); } catch {}
    }
    return null;
  }
}

async function cleanupWithConnection(client, db, config) {
  try {
    console.log(`\n🔍 Recherche de l'utilisateur avec ${config.name}...`);
    
    const user = await db.collection('user').findOne({
      'subscription.stripeCustomerId': INVALID_CUSTOMER_ID
    });
    
    if (!user) {
      console.log('❌ Aucun utilisateur trouvé avec ce customer ID');
      
      // Chercher tous les utilisateurs avec un stripeCustomerId
      const usersWithStripe = await db.collection('user').find({
        'subscription.stripeCustomerId': { $exists: true, $ne: null }
      }).toArray();
      
      console.log(`\n📋 ${usersWithStripe.length} utilisateurs avec customer ID trouvés:`);
      usersWithStripe.forEach(u => {
        console.log(`   - ${u.email}: ${u.subscription.stripeCustomerId}`);
      });
      
      return false;
    }
    
    console.log(`✅ Utilisateur trouvé: ${user.email}`);
    console.log(`   - ID: ${user._id}`);
    console.log(`   - Stripe Customer ID: ${user.subscription?.stripeCustomerId}`);
    console.log(`   - Licence: ${user.subscription?.licence}`);
    console.log(`   - Trial: ${user.subscription?.trial}`);
    
    // Nettoyer les références Stripe
    console.log('\n🧹 Nettoyage des références Stripe...');
    const result = await db.collection('user').updateOne(
      { _id: user._id },
      {
        $unset: {
          'subscription.stripeCustomerId': ''
        },
        $set: {
          'subscription.licence': true,
          'subscription.trial': false
        }
      }
    );
    
    if (result.modifiedCount > 0) {
      console.log('✅ Références Stripe nettoyées avec succès');
      console.log('✅ L\'utilisateur peut maintenant créer une nouvelle souscription');
      
      // Vérifier le résultat
      console.log('\n🔍 Vérification du nettoyage...');
      const updatedUser = await db.collection('user').findOne({ _id: user._id });
      console.log(`   - Stripe Customer ID: ${updatedUser.subscription?.stripeCustomerId || 'SUPPRIMÉ'}`);
      console.log(`   - Licence: ${updatedUser.subscription?.licence}`);
      console.log(`   - Trial: ${updatedUser.subscription?.trial}`);
      
      return true;
    } else {
      console.log('❌ Aucune modification effectuée');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Erreur lors du nettoyage:', error.message);
    return false;
  }
}

async function main() {
  console.log('\n🔍 Test des différentes configurations MongoDB...');
  
  let successfulConnection = null;
  
  // Essayer chaque configuration
  for (const config of MONGODB_CONFIGS) {
    const connection = await tryConnection(config);
    if (connection) {
      successfulConnection = connection;
      break;
    }
  }
  
  if (!successfulConnection) {
    console.error('\n❌ Aucune connexion MongoDB réussie');
    console.error('💡 Suggestions:');
    console.error('   - Vérifiez que MongoDB est démarré');
    console.error('   - Utilisez le script stripe-cleanup-auth.js avec authentification');
    console.error('   - Vérifiez la configuration MongoDB dans ecosystem.config.cjs');
    process.exit(1);
  }
  
  console.log(`\n✅ Utilisation de: ${successfulConnection.config.name}`);
  
  // Effectuer le nettoyage
  const success = await cleanupWithConnection(
    successfulConnection.client,
    successfulConnection.db,
    successfulConnection.config
  );
  
  // Fermer la connexion
  await successfulConnection.client.close();
  console.log('\n📡 Connexion fermée');
  
  if (success) {
    console.log('\n✅ NETTOYAGE TERMINÉ AVEC SUCCÈS');
    console.log('L\'utilisateur peut maintenant relancer une souscription');
    process.exit(0);
  } else {
    console.log('\n❌ NETTOYAGE ÉCHOUÉ');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\n❌ ERREUR FATALE:', error.message);
  process.exit(1);
});
