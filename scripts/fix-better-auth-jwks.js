#!/usr/bin/env node

import { MongoClient } from 'mongodb';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔧 Fix Better Auth JWKS Private Key Error');
console.log('=========================================');

// Charger les variables d'environnement depuis ecosystem.config.cjs
let envVars = {};
try {
  const require = createRequire(import.meta.url);
  const ecosystemPath = path.join(__dirname, '..', 'ecosystem.config.cjs');
  console.log('📁 Chargement de:', ecosystemPath);
  
  const ecosystemConfig = require(ecosystemPath);
  
  if (ecosystemConfig.apps && ecosystemConfig.apps[0] && ecosystemConfig.apps[0].env) {
    envVars = ecosystemConfig.apps[0].env;
    console.log('✅ Variables d\'environnement chargées depuis ecosystem.config.cjs');
    
    // Appliquer les variables à process.env
    Object.keys(envVars).forEach(key => {
      if (!process.env[key]) {
        process.env[key] = envVars[key];
      }
    });
  } else {
    console.log('⚠️  Structure ecosystem.config.cjs non reconnue, utilisation des variables système');
  }
} catch (error) {
  console.log('⚠️  Impossible de charger ecosystem.config.cjs:', error.message);
  console.log('📋 Utilisation des variables d\'environnement système');
}

// Configuration MongoDB
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/newbi-production';
const dbName = process.env.MONGODB_DB_NAME || 'newbi';

async function fixJWKSError() {
  let client;
  
  try {
    console.log('⏳ Connexion à MongoDB...');
    client = new MongoClient(uri);
    await client.connect();
    
    const db = client.db(dbName);
    console.log('✅ Connecté à la base de données:', dbName);
    
    // Vérifier les variables d'environnement
    console.log('\n📋 Vérification des variables d\'environnement:');
    const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
    if (!betterAuthSecret) {
      console.log('❌ BETTER_AUTH_SECRET non définie!');
      console.log('💡 Générer un secret: openssl rand -hex 32');
      console.log('📋 Variables disponibles:', Object.keys(envVars).filter(k => k.includes('SECRET') || k.includes('AUTH')));
      return;
    } else {
      console.log('✅ BETTER_AUTH_SECRET définie:', betterAuthSecret.substring(0, 8) + '...');
    }
    
    // Afficher l'URI utilisée (masquée)
    const maskedUri = uri.replace(/:([^:@]+)@/, ':***@');
    console.log('🔗 URI MongoDB:', maskedUri);
    
    // Chercher les collections liées à Better Auth
    console.log('\n🔍 Recherche des collections Better Auth...');
    const collections = await db.listCollections().toArray();
    const authCollections = collections.filter(col => 
      col.name.includes('jwks') || 
      col.name.includes('key') || 
      col.name.includes('session') ||
      col.name.includes('account') ||
      col.name.includes('user')
    );
    
    console.log('📚 Collections trouvées:', authCollections.map(c => c.name));
    
    // Vérifier la collection user pour les sessions
    const userCollection = db.collection('user');
    const userCount = await userCollection.countDocuments();
    console.log('👥 Utilisateurs dans la base:', userCount);
    
    // Chercher des clés JWKS corrompues
    console.log('\n🔍 Recherche de clés JWKS...');
    
    // Better Auth stocke généralement les clés dans une collection séparée ou dans les métadonnées
    const possibleJWKSCollections = ['jwks', 'keys', 'auth_keys', 'better_auth_keys'];
    let jwksFound = false;
    
    for (const collName of possibleJWKSCollections) {
      try {
        const collection = db.collection(collName);
        const count = await collection.countDocuments();
        if (count > 0) {
          console.log(`📄 Collection ${collName}: ${count} documents`);
          const docs = await collection.find({}).limit(5).toArray();
          console.log('   Exemple de documents:', docs.map(d => Object.keys(d)));
          jwksFound = true;
        }
      } catch (error) {
        // Collection n'existe pas, continuer
      }
    }
    
    // Vérifier dans les métadonnées utilisateur
    const usersWithKeys = await userCollection.find({
      $or: [
        { jwks: { $exists: true } },
        { keys: { $exists: true } },
        { privateKey: { $exists: true } },
        { publicKey: { $exists: true } }
      ]
    }).toArray();
    
    if (usersWithKeys.length > 0) {
      console.log(`🔑 ${usersWithKeys.length} utilisateurs avec des clés trouvés`);
      jwksFound = true;
    }
    
    if (!jwksFound) {
      console.log('ℹ️  Aucune clé JWKS trouvée dans les collections standards');
      console.log('💡 Les clés peuvent être générées automatiquement au prochain démarrage');
    }
    
    // Solutions proposées
    console.log('\n🛠️  Solutions disponibles:');
    console.log('1. Nettoyer toutes les clés JWKS (recommandé)');
    console.log('2. Désactiver temporairement le chiffrement des clés privées');
    console.log('3. Régénérer BETTER_AUTH_SECRET et nettoyer');
    
    const args = process.argv.slice(2);
    
    if (args.includes('--clean-jwks')) {
      console.log('\n🧹 Nettoyage des clés JWKS...');
      
      // Nettoyer les collections JWKS
      for (const collName of possibleJWKSCollections) {
        try {
          const result = await db.collection(collName).deleteMany({});
          if (result.deletedCount > 0) {
            console.log(`✅ ${result.deletedCount} documents supprimés de ${collName}`);
          }
        } catch (error) {
          // Collection n'existe pas
        }
      }
      
      // Nettoyer les clés des utilisateurs
      const updateResult = await userCollection.updateMany(
        {},
        {
          $unset: {
            jwks: "",
            keys: "",
            privateKey: "",
            publicKey: ""
          }
        }
      );
      
      if (updateResult.modifiedCount > 0) {
        console.log(`✅ Clés supprimées de ${updateResult.modifiedCount} utilisateurs`);
      }
      
      console.log('✅ Nettoyage terminé! Redémarrez l\'application.');
      
    } else if (args.includes('--disable-encryption')) {
      console.log('\n⚠️  Pour désactiver le chiffrement, ajoutez à votre configuration Better Auth:');
      console.log('   jwt: { disablePrivateKeyEncryption: true }');
      
    } else {
      console.log('\n💡 Utilisation:');
      console.log('   node fix-better-auth-jwks.js --clean-jwks     # Nettoyer les clés');
      console.log('   node fix-better-auth-jwks.js --disable-encryption # Instructions pour désactiver');
    }
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
  } finally {
    if (client) {
      await client.close();
    }
  }
}

fixJWKSError();
