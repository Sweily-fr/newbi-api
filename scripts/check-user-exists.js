import mongoose from 'mongoose';
import User from '../src/models/User.js';

const MONGODB_URI = "mongodb+srv://newbiUser:rJTjJmJMuDee0VMOMqi9z0@cluster0.heqqnkz.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const DB_NAME = "newbi";

async function checkUser() {
  try {
    console.log('🔌 Connexion à MongoDB...');
    await mongoose.connect(MONGODB_URI, {
      dbName: DB_NAME,
    });
    console.log('✅ Connecté à MongoDB\n');

    const userId = '68dfcf100fecf5ae1eb5ed23';
    
    console.log(`🔍 Recherche de l'utilisateur: ${userId}\n`);
    
    // Essayer avec findById
    console.log('1️⃣ Recherche avec User.findById()...');
    const userById = await User.findById(userId);
    console.log('Résultat:', userById ? '✅ Trouvé' : '❌ Non trouvé');
    if (userById) {
      console.log('   Email:', userById.email);
      console.log('   Name:', userById.name);
      console.log('   Disabled:', userById.isDisabled);
    }
    
    // Essayer avec findOne et _id string
    console.log('\n2️⃣ Recherche avec findOne({ _id: string })...');
    const userByString = await User.findOne({ _id: userId });
    console.log('Résultat:', userByString ? '✅ Trouvé' : '❌ Non trouvé');
    
    // Essayer avec findOne et _id ObjectId
    console.log('\n3️⃣ Recherche avec findOne({ _id: ObjectId })...');
    const userByObjectId = await User.findOne({ _id: new mongoose.Types.ObjectId(userId) });
    console.log('Résultat:', userByObjectId ? '✅ Trouvé' : '❌ Non trouvé');
    
    // Lister toutes les collections
    console.log('\n📋 Collections disponibles:');
    const collections = await mongoose.connection.db.listCollections().toArray();
    collections.forEach(col => {
      console.log(`   - ${col.name}`);
    });
    
    // Chercher dans la collection 'user' (Better Auth)
    console.log('\n4️⃣ Recherche dans la collection "user" (Better Auth)...');
    const betterAuthUser = await mongoose.connection.db.collection('user').findOne({ 
      _id: new mongoose.Types.ObjectId(userId) 
    });
    console.log('Résultat:', betterAuthUser ? '✅ Trouvé' : '❌ Non trouvé');
    if (betterAuthUser) {
      console.log('   Email:', betterAuthUser.email);
      console.log('   Name:', betterAuthUser.name);
      console.log('   EmailVerified:', betterAuthUser.emailVerified);
    }
    
    // Chercher dans la collection 'users' (ancienne)
    console.log('\n5️⃣ Recherche dans la collection "users" (ancienne)...');
    const oldUser = await mongoose.connection.db.collection('users').findOne({ 
      _id: new mongoose.Types.ObjectId(userId) 
    });
    console.log('Résultat:', oldUser ? '✅ Trouvé' : '❌ Non trouvé');
    if (oldUser) {
      console.log('   Email:', oldUser.email);
      console.log('   Name:', oldUser.name);
    }
    
    console.log('\n✅ Diagnostic terminé');
    
  } catch (error) {
    console.error('❌ Erreur:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Déconnecté de MongoDB');
  }
}

checkUser();
