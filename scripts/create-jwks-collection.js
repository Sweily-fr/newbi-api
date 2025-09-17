import { MongoClient } from 'mongodb';
import { generateKeyPair } from 'crypto';
import { promisify } from 'util';

const generateKeyPairAsync = promisify(generateKeyPair);

// URI MongoDB de production
const MONGODB_URI = 'mongodb://newbiAdmin:j6FKJHBb39Rdw^kM^2^Fp5ohPfjgy9@localhost:27017/newbi?authSource=admin';
const DB_NAME = 'newbi';

console.log('🔐 CRÉATION DE LA COLLECTION JWKS');
console.log('=================================');
console.log(`📊 Base de données: ${DB_NAME}`);

async function connectToDatabase() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  return { client, db: client.db(DB_NAME) };
}

/**
 * Génère une paire de clés Ed25519 au format JWK
 */
async function generateEd25519KeyPair() {
  try {
    const { publicKey, privateKey } = await generateKeyPairAsync('ed25519', {
      publicKeyEncoding: {
        type: 'spki',
        format: 'jwk'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'jwk'
      }
    });

    return {
      publicKey: JSON.stringify(publicKey),
      privateKey: JSON.stringify(privateKey)
    };
  } catch (error) {
    console.error('Erreur lors de la génération des clés:', error);
    throw error;
  }
}

/**
 * Crée la collection jwks et génère les clés pour tous les utilisateurs
 */
async function createJwksCollection() {
  let client;
  
  try {
    console.log('\n📡 Connexion à MongoDB...');
    const connection = await connectToDatabase();
    client = connection.client;
    const db = connection.db;
    
    console.log(`✅ Connecté à la base de données: ${DB_NAME}`);
    
    // 1. Vérifier si la collection jwks existe déjà
    const collections = await db.listCollections({ name: 'jwks' }).toArray();
    if (collections.length > 0) {
      console.log('⚠️  La collection jwks existe déjà');
      const existingCount = await db.collection('jwks').countDocuments();
      console.log(`📊 Nombre d'entrées existantes: ${existingCount}`);
      
      console.log('\n❓ Voulez-vous continuer ? (Cela ajoutera des clés pour les utilisateurs manquants)');
      console.log('Tapez "CONTINUER" pour continuer ou Ctrl+C pour annuler:');
      
      // Attendre la confirmation
      process.stdin.setEncoding('utf8');
      process.stdin.resume();
      
      const confirmation = await new Promise((resolve) => {
        process.stdin.on('data', (data) => {
          resolve(data.toString().trim());
        });
      });
      
      if (confirmation !== 'CONTINUER') {
        console.log('❌ Opération annulée');
        return;
      }
    } else {
      console.log('📝 Création de la collection jwks...');
    }
    
    // 2. Récupérer tous les utilisateurs
    console.log('\n🔍 Récupération des utilisateurs...');
    const users = await db.collection('user').find({}).toArray();
    console.log(`👥 ${users.length} utilisateurs trouvés`);
    
    if (users.length === 0) {
      console.log('❌ Aucun utilisateur trouvé dans la collection "user"');
      return;
    }
    
    // 3. Vérifier quels utilisateurs ont déjà des clés JWKS
    const existingJwks = await db.collection('jwks').find({}).toArray();
    const existingUserIds = new Set(existingJwks.map(jwk => jwk._id.toString()));
    
    const usersNeedingKeys = users.filter(user => !existingUserIds.has(user._id.toString()));
    console.log(`🔑 ${usersNeedingKeys.length} utilisateurs ont besoin de clés JWKS`);
    
    if (usersNeedingKeys.length === 0) {
      console.log('✅ Tous les utilisateurs ont déjà des clés JWKS');
      return;
    }
    
    // 4. Générer les clés pour chaque utilisateur
    console.log('\n🔐 Génération des clés Ed25519...');
    const jwksDocuments = [];
    
    for (let i = 0; i < usersNeedingKeys.length; i++) {
      const user = usersNeedingKeys[i];
      console.log(`   Génération pour ${user.email} (${i + 1}/${usersNeedingKeys.length})`);
      
      try {
        const { publicKey, privateKey } = await generateEd25519KeyPair();
        
        jwksDocuments.push({
          _id: user._id, // Utiliser l'ID utilisateur comme _id du document JWKS
          publicKey,
          privateKey,
          createdAt: new Date()
        });
      } catch (error) {
        console.error(`❌ Erreur pour l'utilisateur ${user.email}:`, error.message);
      }
    }
    
    // 5. Insérer les documents JWKS
    if (jwksDocuments.length > 0) {
      console.log(`\n💾 Insertion de ${jwksDocuments.length} documents JWKS...`);
      const result = await db.collection('jwks').insertMany(jwksDocuments);
      console.log(`✅ ${result.insertedCount} documents JWKS créés avec succès`);
      
      // 6. Vérification finale
      console.log('\n🔍 Vérification finale...');
      const totalJwks = await db.collection('jwks').countDocuments();
      const totalUsers = await db.collection('user').countDocuments();
      
      console.log(`📊 Statistiques finales:`);
      console.log(`   - Total utilisateurs: ${totalUsers}`);
      console.log(`   - Total clés JWKS: ${totalJwks}`);
      console.log(`   - Couverture: ${totalJwks === totalUsers ? '✅ Complète' : '⚠️  Partielle'}`);
      
      // Afficher un exemple de document créé
      const sampleJwks = await db.collection('jwks').findOne({});
      if (sampleJwks) {
        console.log('\n📋 Exemple de document JWKS créé:');
        console.log(JSON.stringify({
          _id: sampleJwks._id,
          publicKey: sampleJwks.publicKey.substring(0, 50) + '...',
          privateKey: sampleJwks.privateKey.substring(0, 50) + '...',
          createdAt: sampleJwks.createdAt
        }, null, 2));
      }
    } else {
      console.log('❌ Aucun document JWKS à créer');
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
    throw error;
  } finally {
    if (client) {
      await client.close();
      console.log('\n📡 Connexion fermée');
    }
    process.stdin.pause();
  }
}

// Exécuter la création
createJwksCollection()
  .then(() => {
    console.log('\n✅ CRÉATION DE LA COLLECTION JWKS TERMINÉE');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ ERREUR LORS DE LA CRÉATION:', error.message);
    process.exit(1);
  });
