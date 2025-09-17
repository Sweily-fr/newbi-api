import { MongoClient } from 'mongodb';

const INVALID_CUSTOMER_ID = 'cus_T4P4fP7b671qch';

// Configuration MongoDB avec authentification
const MONGODB_CONFIG = {
  host: '127.0.0.1',
  port: 27017,
  database: 'newbi-production',
  username: 'newbi', // À ajuster selon votre configuration
  password: 'newbi123', // À ajuster selon votre configuration
  authSource: 'admin' // Base d'authentification
};

// Construire l'URI MongoDB avec authentification
const MONGODB_URI = `mongodb://${MONGODB_CONFIG.username}:${MONGODB_CONFIG.password}@${MONGODB_CONFIG.host}:${MONGODB_CONFIG.port}/${MONGODB_CONFIG.database}?authSource=${MONGODB_CONFIG.authSource}`;

console.log('🧹 NETTOYAGE DU CUSTOMER STRIPE INVALIDE');
console.log('=========================================');
console.log(`Customer ID à nettoyer: ${INVALID_CUSTOMER_ID}`);
console.log(`📊 Base de données: ${MONGODB_CONFIG.database}`);
console.log(`📡 Serveur MongoDB: ${MONGODB_CONFIG.host}:${MONGODB_CONFIG.port}`);
console.log(`👤 Utilisateur: ${MONGODB_CONFIG.username}`);

async function connectToDatabase() {
  const client = new MongoClient(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  await client.connect();
  return { client, db: client.db(MONGODB_CONFIG.database) };
}

async function cleanupInvalidStripeCustomer() {
  let client;
  
  try {
    console.log('\n📡 Connexion à MongoDB avec authentification...');
    const connection = await connectToDatabase();
    client = connection.client;
    const db = connection.db;
    
    console.log(`✅ Connecté à la base de données: ${MONGODB_CONFIG.database}`);
    
    // Test de connexion simple sans listCollections
    const userCount = await db.collection('user').countDocuments();
    console.log(`📊 Total utilisateurs dans la base: ${userCount}`);
    
    // 1. Trouver l'utilisateur avec ce customer ID
    console.log('\n🔍 Recherche de l\'utilisateur...');
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
      
      return;
    }
    
    console.log(`✅ Utilisateur trouvé: ${user.email}`);
    console.log(`   - ID: ${user._id}`);
    console.log(`   - Stripe Customer ID: ${user.subscription?.stripeCustomerId}`);
    console.log(`   - Licence: ${user.subscription?.licence}`);
    console.log(`   - Trial: ${user.subscription?.trial}`);
    
    // 2. Nettoyer les références Stripe
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
      
      // 3. Vérifier le résultat
      console.log('\n🔍 Vérification du nettoyage...');
      const updatedUser = await db.collection('user').findOne({ _id: user._id });
      console.log(`   - Stripe Customer ID: ${updatedUser.subscription?.stripeCustomerId || 'SUPPRIMÉ'}`);
      console.log(`   - Licence: ${updatedUser.subscription?.licence}`);
      console.log(`   - Trial: ${updatedUser.subscription?.trial}`);
      
    } else {
      console.log('❌ Aucune modification effectuée');
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
    if (error.message.includes('Authentication failed')) {
      console.error('💡 Erreur d\'authentification MongoDB');
      console.error('💡 Vérifiez les identifiants dans le script');
      console.error('💡 Ou utilisez: mongo --eval "db.runCommand({connectionStatus: 1})"');
    } else if (error.message.includes('ECONNREFUSED')) {
      console.error('💡 MongoDB n\'est pas accessible');
      console.error('💡 Vérifiez que MongoDB est démarré');
    }
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('\n📡 Connexion fermée');
    }
  }
}

// Exécuter le nettoyage
cleanupInvalidStripeCustomer()
  .then(() => {
    console.log('\n✅ NETTOYAGE TERMINÉ AVEC SUCCÈS');
    console.log('L\'utilisateur peut maintenant relancer une souscription');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ ERREUR LORS DU NETTOYAGE:', error.message);
    process.exit(1);
  });
