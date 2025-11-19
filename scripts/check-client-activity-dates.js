import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Client from '../src/models/Client.js';

dotenv.config();

const checkClientActivityDates = async () => {
  try {
    console.log('🔄 Connexion à MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connecté à MongoDB\n');

    // Récupérer un client avec des activités
    const clients = await Client.find({
      $or: [
        { 'activity': { $exists: true, $ne: [] } },
        { 'notes': { $exists: true, $ne: [] } }
      ]
    }).limit(3);

    console.log(`📊 ${clients.length} clients trouvés avec activités/notes\n`);

    for (const client of clients) {
      console.log(`\n📋 Client: ${client.name} (${client.id})`);
      console.log(`   Email: ${client.email}`);
      
      if (client.notes && client.notes.length > 0) {
        console.log(`\n   📝 Notes (${client.notes.length}):`);
        client.notes.forEach((note, index) => {
          console.log(`      ${index + 1}. ID: ${note.id}`);
          console.log(`         Content: ${note.content.substring(0, 50)}...`);
          console.log(`         userId: ${note.userId}`);
          console.log(`         userName: ${note.userName || 'N/A'}`);
          console.log(`         createdAt: ${note.createdAt || '❌ MANQUANT'}`);
          console.log(`         updatedAt: ${note.updatedAt || '❌ MANQUANT'}`);
        });
      }

      if (client.activity && client.activity.length > 0) {
        console.log(`\n   ⚡ Activités (${client.activity.length}):`);
        client.activity.forEach((activity, index) => {
          console.log(`      ${index + 1}. ID: ${activity.id}`);
          console.log(`         Type: ${activity.type}`);
          console.log(`         Description: ${activity.description || 'N/A'}`);
          console.log(`         userId: ${activity.userId}`);
          console.log(`         userName: ${activity.userName || 'N/A'}`);
          console.log(`         createdAt: ${activity.createdAt || '❌ MANQUANT'}`);
        });
      }
      
      console.log('\n' + '='.repeat(80));
    }

    console.log('\n✅ Vérification terminée!');

  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Déconnecté de MongoDB');
  }
};

checkClientActivityDates();
