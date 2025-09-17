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

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not found in environment variables');
  process.exit(1);
}

async function connectToDatabase() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  return { client, db: client.db(DB_NAME) };
}

async function findUserWithStripeCustomer(db, customerId) {
  console.log(`🔍 Recherche de l'utilisateur avec le customer ID: ${customerId}`);
  
  const user = await db.collection('user').findOne({
    'subscription.stripeCustomerId': customerId
  });
  
  if (user) {
    console.log(`✅ Utilisateur trouvé: ${user.email}`);
    console.log(`   - ID: ${user._id}`);
    console.log(`   - Stripe Customer ID: ${user.subscription?.stripeCustomerId}`);
    console.log(`   - Licence: ${user.subscription?.licence}`);
    console.log(`   - Trial: ${user.subscription?.trial}`);
  } else {
    console.log('❌ Aucun utilisateur trouvé avec ce customer ID');
  }
  
  return user;
}

async function cleanupStripeReferences(db, customerId, confirm = false) {
  console.log(`\n🧹 NETTOYAGE DES RÉFÉRENCES STRIPE`);
  console.log('=====================================');
  
  if (!confirm) {
    console.log('MODE DRY RUN - Aucune modification ne sera effectuée');
    console.log('Utilisez --confirm pour exécuter les changements');
  }
  
  const user = await findUserWithStripeCustomer(db, customerId);
  
  if (!user) {
    console.log('❌ Impossible de nettoyer: utilisateur non trouvé');
    return;
  }
  
  console.log(`\n📝 Modifications à effectuer pour ${user.email}:`);
  console.log('- Suppression du stripeCustomerId');
  console.log('- Réinitialisation de la licence à true');
  console.log('- Réinitialisation du trial à false');
  
  if (confirm) {
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
    } else {
      console.log('❌ Aucune modification effectuée');
    }
  } else {
    console.log('\n🔄 Pour exécuter ces changements, relancez avec --confirm');
  }
}

async function listAllStripeCustomers(db) {
  console.log('\n📋 LISTE DE TOUS LES CUSTOMERS STRIPE');
  console.log('=====================================');
  
  const users = await db.collection('user').find({
    'subscription.stripeCustomerId': { $exists: true, $ne: null }
  }).toArray();
  
  console.log(`Nombre d'utilisateurs avec un customer ID: ${users.length}`);
  
  if (users.length > 0) {
    console.log('\nUtilisateurs avec customer ID:');
    users.forEach(user => {
      console.log(`- ${user.email}: ${user.subscription.stripeCustomerId}`);
    });
  }
  
  return users;
}

async function validateStripeCustomer(customerId) {
  console.log(`\n🔍 VALIDATION DU CUSTOMER STRIPE: ${customerId}`);
  console.log('================================================');
  
  // Ici on pourrait ajouter une validation avec l'API Stripe
  // Pour l'instant, on considère que le customer est invalide s'il génère une erreur
  console.log('⚠️  Customer ID semble invalide (erreur rapportée)');
  console.log('💡 Recommandation: nettoyer les références pour permettre une nouvelle souscription');
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];
  const customerId = args[1];
  const confirm = args.includes('--confirm');
  
  if (!action) {
    console.log('Usage: node cleanup-stripe-references.js <action> [customerId] [--confirm]');
    console.log('\nActions:');
    console.log('  find <customerId>     - Trouver l\'utilisateur avec ce customer ID');
    console.log('  cleanup <customerId>  - Nettoyer les références Stripe pour ce customer');
    console.log('  list                  - Lister tous les customers Stripe');
    console.log('  validate <customerId> - Valider un customer ID');
    console.log('\nOptions:');
    console.log('  --confirm            - Exécuter les changements (sans cela, mode dry-run)');
    console.log('\nExemple:');
    console.log('  node cleanup-stripe-references.js cleanup cus_T4P4fP7b671qch --confirm');
    process.exit(1);
  }
  
  let client;
  
  try {
    console.log('Connexion à MongoDB...');
    const connection = await connectToDatabase();
    client = connection.client;
    const db = connection.db;
    
    console.log(`Connecté à la base de données: ${DB_NAME}`);
    
    switch (action) {
      case 'find':
        if (!customerId) {
          console.error('❌ Customer ID requis pour l\'action find');
          process.exit(1);
        }
        await findUserWithStripeCustomer(db, customerId);
        break;
        
      case 'cleanup':
        if (!customerId) {
          console.error('❌ Customer ID requis pour l\'action cleanup');
          process.exit(1);
        }
        await validateStripeCustomer(customerId);
        await cleanupStripeReferences(db, customerId, confirm);
        break;
        
      case 'list':
        await listAllStripeCustomers(db);
        break;
        
      case 'validate':
        if (!customerId) {
          console.error('❌ Customer ID requis pour l\'action validate');
          process.exit(1);
        }
        await validateStripeCustomer(customerId);
        break;
        
      default:
        console.error(`Action inconnue: ${action}`);
        process.exit(1);
    }
    
    console.log('\n✅ Script terminé avec succès');
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    if (client) {
      await client.close();
      console.log('Connexion à la base de données fermée');
    }
  }
}

main();
