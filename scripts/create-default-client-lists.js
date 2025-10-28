import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

import ClientList from '../src/models/ClientList.js';
import Organization from '../src/models/Organization.js';
import { DEFAULT_CLIENT_LISTS } from '../src/utils/defaultClientLists.js';

async function createDefaultClientLists() {
  try {
    console.log('🚀 Démarrage de la création des listes par défaut...');
    
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    // Récupérer toutes les organisations
    const organizations = await Organization.find();
    console.log(`📊 ${organizations.length} organisations trouvées`);

    let createdCount = 0;
    let skippedCount = 0;

    for (const org of organizations) {
      try {
        // Vérifier si les listes par défaut existent déjà
        const existingLists = await ClientList.countDocuments({
          workspaceId: org._id,
          isDefault: true
        });

        if (existingLists > 0) {
          console.log(`⏭️  Listes par défaut déjà existantes pour ${org.name}`);
          skippedCount++;
          continue;
        }

        // Créer les listes par défaut
        const listsToCreate = DEFAULT_CLIENT_LISTS.map(list => ({
          ...list,
          workspaceId: org._id,
          createdBy: org.createdBy || org._id,
          clients: []
        }));

        await ClientList.insertMany(listsToCreate);
        console.log(`✅ ${listsToCreate.length} listes créées pour ${org.name}`);
        createdCount++;
      } catch (error) {
        console.error(`❌ Erreur pour ${org.name}:`, error.message);
      }
    }

    console.log('\n📈 Résumé:');
    console.log(`✅ ${createdCount} organisations avec listes créées`);
    console.log(`⏭️  ${skippedCount} organisations avec listes existantes`);
    console.log(`📊 Total: ${organizations.length} organisations`);

    await mongoose.disconnect();
    console.log('✅ Déconnecté de MongoDB');
  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  }
}

createDefaultClientLists();
