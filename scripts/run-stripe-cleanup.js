import { MongoClient } from 'mongodb';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger les variables d'environnement depuis ecosystem.config.cjs
const ecosystemPath = path.join(__dirname, '..', 'ecosystem.config.cjs');

try {
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const ecosystemConfig = require(ecosystemPath);
  const appConfig = ecosystemConfig.apps[0];
  
  if (appConfig && appConfig.env) {
    Object.assign(process.env, appConfig.env);
    console.log('✅ Variables d\'environnement chargées depuis ecosystem.config.cjs');
  }
} catch (error) {
  console.error('❌ Erreur lors du chargement d\'ecosystem.config.cjs:', error.message);
  process.exit(1);
}

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || (process.env.MONGODB_URI ? process.env.MONGODB_URI.split('/').pop() : 'invoice-app');

const INVALID_CUSTOMER_ID = 'cus_T4P4fP7b671qch';

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not found in environment variables');
  console.error('Variables disponibles:', Object.keys(process.env).filter(key => key.includes('MONGO')));
  process.exit(1);
}

async function connectToDatabase() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  return { client, db: client.db(DB_NAME) };
}

async function cleanupInvalidStripeCustomer() {
  console.log('🧹 NETTOYAGE DU CUSTOMER STRIPE INVALIDE');
  console.log('=========================================');
  console.log(`Customer ID à nettoyer: ${INVALID_CUSTOMER_ID}`);
  
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
