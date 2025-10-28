import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Task } from '../src/models/kanban.js';

dotenv.config();

async function migrateAssignedMembers() {
  try {
    console.log('🔄 Démarrage de la migration des assignedMembers...');
    
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    // Récupérer toutes les tâches
    const tasks = await Task.find({});
    console.log(`📋 ${tasks.length} tâches trouvées`);

    let updatedCount = 0;

    // Parcourir chaque tâche
    for (const task of tasks) {
      if (task.assignedMembers && task.assignedMembers.length > 0) {
        const firstMember = task.assignedMembers[0];
        
        // Vérifier si c'est un objet (ancienne structure) ou une string (nouvelle structure)
        if (typeof firstMember === 'object' && firstMember.userId) {
          // La structure contient des objets, il faut nettoyer en gardant seulement les IDs
          const cleanedMembers = task.assignedMembers.map(member => member.userId);

          await Task.updateOne(
            { _id: task._id },
            { assignedMembers: cleanedMembers }
          );

          updatedCount++;
          console.log(`✅ Tâche ${task._id} mise à jour: ${cleanedMembers.length} membres`);
        }
      }
    }

    console.log(`\n✅ Migration terminée ! ${updatedCount} tâches mises à jour`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Erreur lors de la migration:', error);
    process.exit(1);
  }
}

migrateAssignedMembers();
