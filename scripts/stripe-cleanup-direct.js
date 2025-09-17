import { MongoClient } from 'mongodb';

const INVALID_CUSTOMER_ID = 'cus_T4P4fP7b671qch';

// URI MongoDB de production (basée sur la configuration standard)
const MONGODB_URI = 'mongodb://newbiAdmin:j6FKJHBb39Rdw^kM^2^Fp5ohPfjgy9@localhost:27017/newbi?authSource=admin';
const DB_NAME = 'newbi';

console.log('🧹 NETTOYAGE DU CUSTOMER STRIPE INVALIDE');
console.log('=========================================');
console.log(`Customer ID à nettoyer: ${INVALID_CUSTOMER_ID}`);
console.log(`📊 Base de données: ${DB_NAME}`);
console.log(`📡 URI MongoDB: ${MONGODB_URI}`);

async function connectToDatabase() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  return { client, db: client.db(DB_NAME) };
}

async function cleanupInvalidStripeCustomer() {
  let client;
  
  try {
    console.log('\n📡 Connexion à MongoDB...');
    const connection = await connectToDatabase();
    client = connection.client;
    const db = connection.db;
    
    console.log(`✅ Connecté à la base de données: ${DB_NAME}`);
    
    // Lister les collections disponibles pour diagnostic
    const collections = await db.listCollections().toArray();
    console.log(`📋 Collections disponibles: ${collections.map(c => c.name).join(', ')}`);
    
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
      
      // Compter le total d'utilisateurs
      const totalUsers = await db.collection('user').countDocuments();
      console.log(`\n📊 Total utilisateurs dans la base: ${totalUsers}`);
      
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
    if (error.message.includes('ECONNREFUSED')) {
      console.error('💡 Suggestion: Vérifiez que MongoDB est démarré et accessible');
      console.error('💡 Ou modifiez l\'URI MongoDB dans le script');
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
