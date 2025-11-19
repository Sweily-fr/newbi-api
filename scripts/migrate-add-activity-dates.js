import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Client from '../src/models/Client.js';

dotenv.config();

const migrateActivityDates = async () => {
  try {
    console.log('🔄 Connexion à MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    console.log('🔍 Recherche des clients avec des activités sans date...');
    
    const clients = await Client.find({
      'activity': { $exists: true, $ne: [] }
    });

    console.log(`📊 ${clients.length} clients trouvés avec des activités`);

    let updatedCount = 0;
    let activityCount = 0;

    for (const client of clients) {
      let hasChanges = false;

      for (const activity of client.activity) {
        if (!activity.createdAt) {
          // Utiliser la date de création du client comme fallback
          activity.createdAt = client.createdAt || new Date();
          hasChanges = true;
          activityCount++;
        }
      }

      if (hasChanges) {
        await client.save();
        updatedCount++;
        console.log(`✅ Client ${client.name} mis à jour (${client.activity.length} activités)`);
      }
    }

    console.log('\n📊 Résumé de la migration:');
    console.log(`   - Clients mis à jour: ${updatedCount}`);
    console.log(`   - Activités mises à jour: ${activityCount}`);
    console.log('✅ Migration terminée avec succès!');

  } catch (error) {
    console.error('❌ Erreur lors de la migration:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('👋 Déconnecté de MongoDB');
  }
};

migrateActivityDates();
