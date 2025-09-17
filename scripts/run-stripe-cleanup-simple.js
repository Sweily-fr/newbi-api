import { MongoClient } from 'mongodb';

const INVALID_CUSTOMER_ID = 'cus_T4P4fP7b671qch';

// Utiliser directement les variables d'environnement du système
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'newbi-production';

console.log('🧹 NETTOYAGE DU CUSTOMER STRIPE INVALIDE');
console.log('=========================================');
console.log(`Customer ID à nettoyer: ${INVALID_CUSTOMER_ID}`);

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not found in environment variables');
  console.error('Variables disponibles:', Object.keys(process.env).filter(key => key.includes('MONGO') || key.includes('DB')));
  process.exit(1);
}

console.log(`📡 URI MongoDB: ${MONGODB_URI.substring(0, 20)}...`);
console.log(`📊 Base de données: ${DB_NAME}`);

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
