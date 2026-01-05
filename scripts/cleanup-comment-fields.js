// Script pour supprimer les champs userName et userImage des commentaires et activités
// Ces champs seront récupérés dynamiquement via les resolvers GraphQL

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger les variables d'environnement
dotenv.config({ path: join(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI || process.env.DATABASE_URL;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI ou DATABASE_URL non défini dans .env');
  process.exit(1);
}

async function cleanupCommentFields() {
  try {
    console.log('🔌 Connexion à MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    const db = mongoose.connection.db;
    const tasksCollection = db.collection('tasks');

    // Compter les tâches avec des commentaires ou activités ayant userName/userImage
    const tasksWithFields = await tasksCollection.countDocuments({
      $or: [
        { 'comments.userName': { $exists: true } },
        { 'comments.userImage': { $exists: true } },
        { 'activity.userName': { $exists: true } },
        { 'activity.userImage': { $exists: true } }
      ]
    });

    console.log(`\n📊 Nombre de tâches à nettoyer: ${tasksWithFields}`);

    if (tasksWithFields === 0) {
      console.log('✅ Aucune tâche à nettoyer');
      await mongoose.connection.close();
      return;
    }

    // Supprimer les champs userName et userImage des commentaires NON externes
    console.log('\n🧹 Suppression des champs userName et userImage des commentaires non externes...');
    const result1 = await tasksCollection.updateMany(
      { 'comments': { $exists: true, $ne: [] } },
      {
        $set: {
          'comments.$[comment].userName': '$$REMOVE',
          'comments.$[comment].userImage': '$$REMOVE'
        }
      },
      {
        arrayFilters: [
          { 
            $or: [
              { 'comment.isExternal': { $exists: false } },
              { 'comment.isExternal': false }
            ]
          }
        ]
      }
    );

    console.log(`✅ Commentaires mis à jour: ${result1.modifiedCount} tâches`);

    // Supprimer les champs userName et userImage de toutes les activités
    console.log('\n🧹 Suppression des champs userName et userImage des activités...');
    const result2 = await tasksCollection.updateMany(
      { 'activity': { $exists: true, $ne: [] } },
      {
        $unset: {
          'activity.$[].userName': '',
          'activity.$[].userImage': ''
        }
      }
    );

    console.log(`✅ Activités mises à jour: ${result2.modifiedCount} tâches`);

    // Vérifier le résultat
    const remainingTasks = await tasksCollection.countDocuments({
      $or: [
        { 'comments.userName': { $exists: true }, 'comments.isExternal': { $ne: true } },
        { 'comments.userImage': { $exists: true }, 'comments.isExternal': { $ne: true } },
        { 'activity.userName': { $exists: true } },
        { 'activity.userImage': { $exists: true } }
      ]
    });

    console.log(`\n📊 Tâches restantes avec ces champs: ${remainingTasks}`);

    if (remainingTasks === 0) {
      console.log('✅ Nettoyage terminé avec succès !');
    } else {
      console.log('⚠️ Certaines tâches ont encore ces champs (probablement des commentaires externes)');
    }

    await mongoose.connection.close();
    console.log('\n🔌 Déconnecté de MongoDB');

  } catch (error) {
    console.error('❌ Erreur:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

cleanupCommentFields();
