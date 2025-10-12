// resolvers/kanban.js
import { Board, Column, Task } from '../models/kanban.js';
import { AuthenticationError } from 'apollo-server-express';
import { withWorkspace } from '../middlewares/better-auth-jwt.js';
import { getPubSub } from '../config/redis.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';
import User from '../models/User.js';

// Événements de subscription
const BOARD_UPDATED = 'BOARD_UPDATED';
const TASK_UPDATED = 'TASK_UPDATED';
const COLUMN_UPDATED = 'COLUMN_UPDATED';

// Fonction utilitaire pour publier en toute sécurité
const safePublish = (channel, payload, context = '') => {
  try {
    const pubsub = getPubSub();
    pubsub.publish(channel, payload).catch(error => {
      logger.error(`❌ [Kanban] Erreur publication ${context}:`, error);
    });
    logger.debug(`📢 [Kanban] ${context} publié sur ${channel}`);
  } catch (error) {
    logger.error(`❌ [Kanban] Erreur getPubSub ${context}:`, error);
  }
};

const resolvers = {
  Query: {
    boards: withWorkspace(async (_, { workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      return await Board.find({ workspaceId: finalWorkspaceId }).sort({ createdAt: -1 });
    }),
    
    organizationMembers: withWorkspace(async (_, { workspaceId }, { workspaceId: contextWorkspaceId, db }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        const { ObjectId } = require('mongodb');
        
        // Convertir le workspaceId en ObjectId pour la recherche
        const orgId = typeof finalWorkspaceId === 'string' 
          ? new ObjectId(finalWorkspaceId) 
          : finalWorkspaceId;
        
        logger.info(`🔍 [Kanban] Recherche membres pour organisation: ${orgId}`);
        
        // 1. Récupérer l'organisation
        const organization = await db.collection('organization').findOne({ _id: orgId });
        
        if (!organization) {
          logger.warn(`⚠️ [Kanban] Organisation non trouvée: ${orgId}`);
          return [];
        }
        
        logger.info(`🏢 [Kanban] Organisation trouvée: ${organization.name}`);
        
        // 2. Récupérer TOUS les membres (y compris owner) via la collection member
        // Better Auth stocke TOUS les membres dans la collection member, même l'owner
        const members = await db.collection('member').find({
          organizationId: orgId
        }).toArray();
        
        logger.info(`📋 [Kanban] ${members.length} membres trouvés (incluant owner)`);
        
        if (members.length === 0) {
          logger.warn(`⚠️ [Kanban] Aucun membre trouvé pour l'organisation ${orgId}`);
          return [];
        }
        
        // 3. Récupérer les IDs utilisateurs
        const userIds = members.map(m => {
          const userId = m.userId;
          return typeof userId === 'string' ? new ObjectId(userId) : userId;
        });
        
        logger.info(`👥 [Kanban] Recherche de ${userIds.length} utilisateurs`);
        
        // 4. Récupérer les informations des utilisateurs
        const users = await db.collection('user').find({
          _id: { $in: userIds }
        }).toArray();
        
        logger.info(`✅ [Kanban] ${users.length} utilisateurs trouvés`);
        
        // 5. Créer le résultat en combinant membres et users
        const result = members.map(member => {
          const memberUserId = member.userId?.toString();
          const user = users.find(u => u._id.toString() === memberUserId);
          
          if (!user) {
            logger.warn(`⚠️ [Kanban] Utilisateur non trouvé pour member: ${memberUserId}`);
            return null;
          }
          
          return {
            id: memberUserId,
            name: user.name || user.email || 'Utilisateur inconnu',
            email: user.email || '',
            image: user.image || null,
            role: member.role || 'member'
          };
        }).filter(Boolean); // Retirer les null
        
        logger.info(`✅ [Kanban] Retour de ${result.length} membres`);
        logger.info(`📋 [Kanban] Détails:`, result.map(r => ({ email: r.email, role: r.role })));
        
        return result;
      } catch (error) {
        logger.error('❌ [Kanban] Erreur récupération membres:', error);
        logger.error('Stack:', error.stack);
        return [];
      }
    }),
    
    board: withWorkspace(async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const board = await Board.findOne({ _id: id, workspaceId: finalWorkspaceId });
      if (!board) throw new Error('Board not found');
      return board;
    }),
    
    columns: withWorkspace(async (_, { boardId, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      return await Column.find({ boardId, workspaceId: finalWorkspaceId }).sort('order');
    }),
    
    column: withWorkspace(async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      return await Column.findOne({ _id: id, workspaceId: finalWorkspaceId });
    }),
    
    tasks: withWorkspace(async (_, { boardId, columnId, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const query = { boardId, workspaceId: finalWorkspaceId };
      if (columnId) query.columnId = columnId;
      return await Task.find(query).sort('position');
    }),
    
    task: withWorkspace(async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      return await Task.findOne({ _id: id, workspaceId: finalWorkspaceId });
    })
  },
  
  Mutation: {
    // Board mutations
    createBoard: withWorkspace(async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      const board = new Board({
        ...input,
        userId: user.id,
        workspaceId: finalWorkspaceId
      });
      
      const savedBoard = await board.save();
      
      // Créer automatiquement les 4 colonnes par défaut
      const defaultColumns = [
        { title: 'À faire', color: '#ef4444', order: 0 },
        { title: 'En cours', color: '#f59e0b', order: 1 },
        { title: 'En attente', color: '#8b5cf6', order: 2 },
        { title: 'Terminées', color: '#10b981', order: 3 }
      ];
      
      try {
        for (let i = 0; i < defaultColumns.length; i++) {
          const columnData = defaultColumns[i];
          
          const column = new Column({
            title: columnData.title,
            color: columnData.color,
            order: columnData.order,
            boardId: savedBoard.id,
            userId: user.id,
            workspaceId: finalWorkspaceId
          });
          
          await column.save();
        }
      } catch (error) {
        // Ne pas faire échouer la création du tableau si les colonnes échouent
      }
      
      // Publier l'événement de création de board
      safePublish(`${BOARD_UPDATED}_${finalWorkspaceId}`, {
        type: 'CREATED',
        board: savedBoard,
        workspaceId: finalWorkspaceId
      }, 'Board créé');
      
      return savedBoard;
    }),
    
    updateBoard: withWorkspace(async (_, { input, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const board = await Board.findOneAndUpdate(
        { _id: input.id, workspaceId: finalWorkspaceId },
        { ...input, updatedAt: new Date() },
        { new: true }
      );
      if (!board) throw new Error('Board not found');
      
      // Publier l'événement de mise à jour de board
      safePublish(`${BOARD_UPDATED}_${finalWorkspaceId}`, {
        type: 'UPDATED',
        board: board,
        workspaceId: finalWorkspaceId
      }, 'Board mis à jour');
      
      return board;
    }),
    
    deleteBoard: withWorkspace(async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        // Supprimer les tâches associées au tableau
        await Task.deleteMany({ boardId: id, workspaceId: finalWorkspaceId });
        
        // Supprimer les colonnes associées au tableau
        await Column.deleteMany({ boardId: id, workspaceId: finalWorkspaceId });
        
        // Supprimer le tableau
        const result = await Board.deleteOne({ _id: id, workspaceId: finalWorkspaceId });
        
        if (result.deletedCount > 0) {
          // Publier l'événement de suppression de board
          safePublish(`${BOARD_UPDATED}_${finalWorkspaceId}`, {
            type: 'DELETED',
            boardId: id,
            workspaceId: finalWorkspaceId
          }, 'Board supprimé');
        }
        
        return result.deletedCount > 0;
      } catch (error) {
        console.error('Error deleting board:', error);
        throw new Error('Failed to delete board');
      }
    }),
    
    // Column mutations
    createColumn: withWorkspace(async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      const column = new Column({
        ...input,
        userId: user.id,
        workspaceId: finalWorkspaceId
      });
      
      const savedColumn = await column.save();
      
      // Publier l'événement de création de colonne
      safePublish(`${COLUMN_UPDATED}_${finalWorkspaceId}_${savedColumn.boardId}`, {
        type: 'CREATED',
        column: savedColumn,
        boardId: savedColumn.boardId,
        workspaceId: finalWorkspaceId
      }, 'Colonne créée');
      
      return savedColumn;
    }),
    
    updateColumn: withWorkspace(async (_, { input, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const { id, ...updates } = input;
      const column = await Column.findOneAndUpdate(
        { _id: id, workspaceId: finalWorkspaceId },
        { ...updates, updatedAt: new Date() },
        { new: true }
      );
      if (!column) throw new Error('Column not found');
      
      // Publier l'événement de mise à jour de colonne
      safePublish(`${COLUMN_UPDATED}_${finalWorkspaceId}_${column.boardId}`, {
        type: 'UPDATED',
        column: column,
        boardId: column.boardId,
        workspaceId: finalWorkspaceId
      }, 'Colonne mise à jour');
      
      return column;
    }),
    
    deleteColumn: withWorkspace(async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        // Récupérer la colonne avant suppression pour avoir le boardId
        const column = await Column.findOne({ _id: id, workspaceId: finalWorkspaceId });
        if (!column) throw new Error('Column not found');
        
        // Supprimer les tâches associées à la colonne
        await Task.deleteMany({ columnId: id, workspaceId: finalWorkspaceId });
        
        // Supprimer la colonne
        const result = await Column.deleteOne({ _id: id, workspaceId: finalWorkspaceId });
        
        if (result.deletedCount > 0) {
          // Publier l'événement de suppression de colonne
          safePublish(`${COLUMN_UPDATED}_${finalWorkspaceId}_${column.boardId}`, {
            type: 'DELETED',
            columnId: id,
            boardId: column.boardId,
            workspaceId: finalWorkspaceId
          }, 'Colonne supprimée');
        }
        
        return result.deletedCount > 0;
      } catch (error) {
        console.error('Error deleting column:', error);
        throw new Error('Failed to delete column');
      }
    }),
    
    reorderColumns: withWorkspace(async (_, { columns, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        // Récupérer une colonne pour avoir le boardId
        const firstColumn = await Column.findOne({ _id: columns[0], workspaceId: finalWorkspaceId });
        if (!firstColumn) throw new Error('Column not found');
        
        const updatePromises = columns.map((id, index) =>
          Column.updateOne(
            { _id: id, workspaceId: finalWorkspaceId },
            { $set: { order: index, updatedAt: new Date() } }
          )
        );
        
        await Promise.all(updatePromises);
        
        // Publier l'événement de réorganisation des colonnes
        safePublish(`${COLUMN_UPDATED}_${finalWorkspaceId}_${firstColumn.boardId}`, {
          type: 'REORDERED',
          columns: columns,
          boardId: firstColumn.boardId,
          workspaceId: finalWorkspaceId
        }, 'Colonnes réorganisées');
        
        return true;
      } catch (error) {
        console.error('Error reordering columns:', error);
        throw new Error('Failed to reorder columns');
      }
    }),
    
    // Task mutations
    createTask: withWorkspace(async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      // Nettoyer les IDs temporaires de la checklist
      const cleanedInput = { ...input };
      if (cleanedInput.checklist) {
        cleanedInput.checklist = cleanedInput.checklist.map(item => {
          const cleanedItem = { ...item };
          // Supprimer les IDs temporaires (qui commencent par 'temp-')
          if (cleanedItem.id && cleanedItem.id.startsWith('temp-')) {
            delete cleanedItem.id;
          }
          return cleanedItem;
        });
      }
      
      // Récupérer les données utilisateur pour l'image
      const db = mongoose.connection.db;
      const userData = await db.collection('user').findOne({ 
        _id: new mongoose.Types.ObjectId(user.id) 
      });
      const userImage = userData?.image || userData?.avatar || userData?.profile?.profilePicture || userData?.profile?.profilePictureUrl || null;
      
      const task = new Task({
        ...cleanedInput,
        userId: user.id,
        workspaceId: finalWorkspaceId,
        position: input.position || 0,
        // Ajouter une entrée d'activité pour la création
        activity: [{
          userId: user.id,
          userName: userData?.name || user.name || user.email,
          userImage: userImage,
          type: 'created',
          description: 'a créé la tâche',
          createdAt: new Date()
        }]
      });
      const savedTask = await task.save();
      
      // Publier l'événement de création de tâche
      safePublish(`${TASK_UPDATED}_${finalWorkspaceId}_${savedTask.boardId}`, {
        type: 'CREATED',
        task: savedTask,
        boardId: savedTask.boardId,
        workspaceId: finalWorkspaceId
      }, 'Tâche créée');
      
      return savedTask;
    }),
    
    updateTask: withWorkspace(async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const { id, ...updates } = input;
      
      logger.info('📝 [UpdateTask] dueDate reçue:', input.dueDate);
      logger.info('📝 [UpdateTask] dueDate type:', typeof input.dueDate);
      
      // Récupérer la tâche avant modification pour comparer
      const oldTask = await Task.findOne({ _id: id, workspaceId: finalWorkspaceId });
      if (!oldTask) throw new Error('Task not found');
      
      // Nettoyer les IDs temporaires de la checklist
      if (updates.checklist) {
        updates.checklist = updates.checklist.map(item => {
          const cleanedItem = { ...item };
          // Supprimer les IDs temporaires (qui commencent par 'temp-')
          if (cleanedItem.id && cleanedItem.id.startsWith('temp-')) {
            delete cleanedItem.id;
          }
          return cleanedItem;
        });
      }
      
      // Récupérer les données utilisateur pour l'activité
      const db = mongoose.connection.db;
      const userData = user ? await db.collection('user').findOne({ 
        _id: new mongoose.Types.ObjectId(user.id) 
      }) : null;
      const userImage = userData?.image || userData?.avatar || userData?.profile?.profilePicture || userData?.profile?.profilePictureUrl || null;
      
      // Tracker les changements et créer une entrée d'activité groupée
      const changes = [];
      
      // Titre modifié
      if (updates.title !== undefined) {
        const oldTitle = (oldTask.title || '').trim();
        const newTitle = (updates.title || '').trim();
        if (oldTitle !== newTitle) {
          changes.push('le titre');
        }
      }
      
      // Description modifiée
      if (updates.description !== undefined) {
        const oldDesc = (oldTask.description || '').trim();
        const newDesc = (updates.description || '').trim();
        if (oldDesc !== newDesc) {
          changes.push('la description');
        }
      }
      
      // Priorité modifiée
      if (updates.priority !== undefined && updates.priority !== oldTask.priority) {
        const priorityLabels = { low: 'Basse', medium: 'Moyenne', high: 'Haute' };
        changes.push(`la priorité (${priorityLabels[updates.priority] || updates.priority})`);
      }
      
      // Date d'échéance modifiée
      if (updates.dueDate !== undefined) {
        const oldDate = oldTask.dueDate ? new Date(oldTask.dueDate).toISOString() : null;
        const newDate = updates.dueDate ? new Date(updates.dueDate).toISOString() : null;
        if (oldDate !== newDate) {
          changes.push(updates.dueDate ? 'la date d\'échéance' : 'supprimé la date d\'échéance');
        }
      }
      
      // Colonne modifiée
      if (updates.columnId !== undefined && updates.columnId !== oldTask.columnId) {
        changes.push('la colonne');
      }
      
      // Tags modifiés
      if (updates.tags !== undefined) {
        const oldTags = oldTask.tags || [];
        const newTags = updates.tags || [];
        const getTagName = (tag) => typeof tag === 'string' ? tag : tag?.name || tag;
        const oldTagNames = oldTags.map(getTagName);
        const newTagNames = newTags.map(getTagName);
        const addedTags = newTagNames.filter(tag => !oldTagNames.includes(tag));
        const removedTags = oldTagNames.filter(tag => !newTagNames.includes(tag));
        
        if (addedTags.length > 0) {
          changes.push(`ajouté le${addedTags.length > 1 ? 's' : ''} tag${addedTags.length > 1 ? 's' : ''} ${addedTags.join(', ')}`);
        }
        if (removedTags.length > 0) {
          changes.push(`supprimé le${removedTags.length > 1 ? 's' : ''} tag${removedTags.length > 1 ? 's' : ''} ${removedTags.join(', ')}`);
        }
      }
      
      // Membres assignés modifiés
      if (updates.assignedMembers !== undefined) {
        // Normaliser les IDs en strings et trier
        const normalizeMembers = (members) => {
          return (members || [])
            .map(m => {
              // Si c'est un objet avec userId (format frontend)
              if (m && m.userId) return m.userId.toString();
              // Si c'est un objet avec _id (format MongoDB)
              if (m && m._id) return m._id.toString();
              // Si c'est déjà une string
              if (typeof m === 'string') return m;
              // Si c'est un ObjectId
              if (m && m.toString) return m.toString();
              return String(m);
            })
            .filter(Boolean) // Enlever les valeurs vides
            .sort();
        };
        
        const oldMembers = normalizeMembers(oldTask.assignedMembers);
        const newMembers = normalizeMembers(updates.assignedMembers);
        
        // Comparer les tableaux triés
        const hasChanged = oldMembers.length !== newMembers.length || 
                          oldMembers.some((m, i) => m !== newMembers[i]);
        
        if (hasChanged) {
          const addedMembers = newMembers.filter(m => !oldMembers.includes(m));
          const removedMembers = oldMembers.filter(m => !newMembers.includes(m));
          
          if (addedMembers.length > 0) {
            changes.push(`assigné ${addedMembers.length} membre${addedMembers.length > 1 ? 's' : ''}`);
            // Ajouter une activité spécifique pour l'assignation avec les IDs des membres
            updates.activity = [...(oldTask.activity || []), {
              userId: user?.id,
              userName: userData?.name || user?.name || user?.email,
              userImage: userImage,
              type: 'assigned',
              description: `assigné ${addedMembers.length} membre${addedMembers.length > 1 ? 's' : ''}`,
              newValue: addedMembers, // Stocker les IDs des membres ajoutés
              createdAt: new Date()
            }];
          }
          if (removedMembers.length > 0) {
            changes.push(`désassigné ${removedMembers.length} membre${removedMembers.length > 1 ? 's' : ''}`);
            // Ajouter une activité spécifique pour la désassignation
            updates.activity = [...(updates.activity || oldTask.activity || []), {
              userId: user?.id,
              userName: userData?.name || user?.name || user?.email,
              userImage: userImage,
              type: 'unassigned',
              description: `désassigné ${removedMembers.length} membre${removedMembers.length > 1 ? 's' : ''}`,
              oldValue: removedMembers, // Stocker les IDs des membres retirés
              createdAt: new Date()
            }];
          }
        }
      }
      
      // Checklist modifiée
      if (updates.checklist !== undefined) {
        const oldChecklist = oldTask.checklist || [];
        const newChecklist = updates.checklist || [];
        if (oldChecklist.length !== newChecklist.length) {
          changes.push('la checklist');
        } else {
          // Vérifier si des items ont changé
          const hasChanges = newChecklist.some((item, index) => {
            const oldItem = oldChecklist[index];
            return !oldItem || item.text !== oldItem.text || item.completed !== oldItem.completed;
          });
          if (hasChanges) {
            changes.push('la checklist');
          }
        }
      }
      
      // Créer une seule entrée d'activité groupée si des changements existent
      if (changes.length > 0) {
        const description = changes.length === 1 
          ? `a modifié ${changes[0]}`
          : `a modifié ${changes.slice(0, -1).join(', ')} et ${changes[changes.length - 1]}`;
        
        updates.activity = [...(oldTask.activity || []), {
          userId: user?.id,
          userName: userData?.name || user?.name || user?.email,
          userImage: userImage,
          type: 'updated',
          description: description,
          createdAt: new Date()
        }];
      }
      
      const task = await Task.findOneAndUpdate(
        { _id: id, workspaceId: finalWorkspaceId },
        { ...updates, updatedAt: new Date() },
        { new: true, runValidators: true }
      );
      if (!task) throw new Error('Task not found');
      
      logger.info('📝 [UpdateTask] Task après sauvegarde:', {
        dueDate: task.dueDate,
        dueDateType: typeof task.dueDate,
        dueDateISO: task.dueDate ? task.dueDate.toISOString() : null
      });
      
      // Publier l'événement de mise à jour de tâche
      safePublish(`${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`, {
        type: 'UPDATED',
        task: task,
        boardId: task.boardId,
        workspaceId: finalWorkspaceId
      }, 'Tâche mise à jour');
      
      return task;
    }),
    
    deleteTask: withWorkspace(async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      // Récupérer la tâche avant suppression pour avoir le boardId
      const task = await Task.findOne({ _id: id, workspaceId: finalWorkspaceId });
      if (!task) throw new Error('Task not found');
      
      const result = await Task.deleteOne({ _id: id, workspaceId: finalWorkspaceId });
      
      if (result.deletedCount > 0) {
        // Publier l'événement de suppression de tâche
        safePublish(`${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`, {
          type: 'DELETED',
          taskId: id,
          boardId: task.boardId,
          workspaceId: finalWorkspaceId
        }, 'Tâche supprimée');
      }
      
      return result.deletedCount > 0;
    }),
    
    moveTask: withWorkspace(async (_, { id, columnId, position, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        // Get the task to move
        const task = await Task.findOne({ _id: id, workspaceId: finalWorkspaceId });
        if (!task) throw new Error('Task not found');
        
        const oldColumnId = task.columnId;
        
        // If the column is changing, update the column reference and add activity
        if (task.columnId !== columnId) {
          task.columnId = columnId;
          task.status = columnId;
          
          // Ajouter une entrée d'activité pour le déplacement
          if (user) {
            // Récupérer les données utilisateur pour l'image
            const db = mongoose.connection.db;
            const userData = await db.collection('user').findOne({ 
              _id: new mongoose.Types.ObjectId(user.id) 
            });
            const userImage = userData?.image || userData?.avatar || userData?.profile?.profilePicture || userData?.profile?.profilePictureUrl || null;
            
            task.activity.push({
              userId: user.id,
              userName: userData?.name || user.name || user.email,
              userImage: userImage,
              type: 'moved',
              field: 'columnId',
              oldValue: oldColumnId,
              newValue: columnId,
              description: 'a déplacé la tâche',
              createdAt: new Date()
            });
          }
        }
        
        // Update the position of the moved task
        task.position = position;
        await task.save();
        
        // Get all tasks in the target column, sorted by position
        const tasks = await Task.find({
          boardId: task.boardId,
          columnId: columnId,
          _id: { $ne: task._id },
          workspaceId: finalWorkspaceId
        }).sort('position');
        
        // Update positions of other tasks in the column
        const updatePromises = [];
        let currentPosition = 0;
        
        for (let i = 0; i < tasks.length; i++) {
          if (currentPosition === position) currentPosition++;
          if (tasks[i]._id.toString() === id) continue;
          
          updatePromises.push(
            Task.updateOne(
              { _id: tasks[i]._id },
              { $set: { position: currentPosition, updatedAt: new Date() } }
            )
          );
          
          currentPosition++;
        }
        
        await Promise.all(updatePromises);
        
        // Publier l'événement de déplacement de tâche
        safePublish(`${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`, {
          type: 'MOVED',
          task: task,
          boardId: task.boardId,
          workspaceId: finalWorkspaceId
        }, 'Tâche déplacée');
        
        return task;
      } catch (error) {
        console.error('Error moving task:', error);
        throw new Error('Failed to move task');
      }
    }),

    // Ajouter un commentaire
    addComment: withWorkspace(async (_, { taskId, input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        logger.info('💬 [Kanban] Adding comment:', { taskId, workspaceId: finalWorkspaceId, userId: user?.id });
        
        if (!user) {
          throw new Error('User not authenticated');
        }
        
        const task = await Task.findOne({ _id: taskId, workspaceId: finalWorkspaceId });
        if (!task) {
          logger.error('❌ [Kanban] Task not found:', taskId);
          throw new Error('Task not found');
        }

        // Récupérer les données utilisateur depuis Better Auth (collection MongoDB directe)
        const db = mongoose.connection.db;
        const userData = await db.collection('user').findOne({ 
          _id: new mongoose.Types.ObjectId(user.id) 
        });
        
        // Better Auth peut stocker l'image dans différents champs
        const userImage = userData?.image || userData?.avatar || userData?.profile?.profilePicture || userData?.profile?.profilePictureUrl || null;
        
        logger.info('📸 [Kanban] Photo utilisateur récupérée:', { 
          userId: user.id,
          image: userData?.image || 'null',
          avatar: userData?.avatar || 'null',
          profilePicture: userData?.profile?.profilePicture || 'null',
          profilePictureUrl: userData?.profile?.profilePictureUrl || 'null',
          finalImage: userImage || 'null',
          name: userData?.name || 'null',
          email: userData?.email || 'null',
          allKeys: userData ? Object.keys(userData).join(', ') : 'userData is null'
        });
        
        const comment = {
          userId: user.id,
          userName: userData?.name || user.name || user.email,
          userImage: userImage,
          content: input.content,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        
        logger.info('💬 [Kanban] Commentaire créé:', {
          userId: comment.userId,
          userName: comment.userName,
          userImage: comment.userImage
        });

        task.comments.push(comment);
        
        // Ajouter une entrée dans l'activité
        task.activity.push({
          userId: user.id,
          userName: userData?.name || user.name || user.email,
          userImage: userImage,
          type: 'comment_added',
          description: 'a ajouté un commentaire',
          createdAt: new Date()
        });

        await task.save();

        // Publier l'événement
        safePublish(`${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`, {
          type: 'COMMENT_ADDED',
          task: task,
          taskId: task._id,
          boardId: task.boardId,
          workspaceId: finalWorkspaceId
        }, 'Commentaire ajouté');

        return task;
      } catch (error) {
        logger.error('Error adding comment:', error);
        throw new Error('Failed to add comment');
      }
    }),

    // Modifier un commentaire
    updateComment: withWorkspace(async (_, { taskId, commentId, content, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        const task = await Task.findOne({ _id: taskId, workspaceId: finalWorkspaceId });
        if (!task) throw new Error('Task not found');

        const comment = task.comments.id(commentId);
        if (!comment) throw new Error('Comment not found');
        
        // Vérifier que l'utilisateur est le créateur du commentaire
        if (comment.userId !== user.id) {
          throw new Error('Not authorized to edit this comment');
        }

        comment.content = content;
        comment.updatedAt = new Date();
        await task.save();

        // Publier l'événement
        safePublish(`${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`, {
          type: 'COMMENT_UPDATED',
          task: task,
          taskId: task._id,
          boardId: task.boardId,
          workspaceId: finalWorkspaceId
        }, 'Commentaire modifié');

        return task;
      } catch (error) {
        logger.error('Error updating comment:', error);
        throw new Error('Failed to update comment');
      }
    }),

    // Supprimer un commentaire
    deleteComment: withWorkspace(async (_, { taskId, commentId, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        const task = await Task.findOne({ _id: taskId, workspaceId: finalWorkspaceId });
        if (!task) throw new Error('Task not found');

        const comment = task.comments.id(commentId);
        if (!comment) throw new Error('Comment not found');
        
        // Vérifier que l'utilisateur est le créateur du commentaire
        if (comment.userId !== user.id) {
          throw new Error('Not authorized to delete this comment');
        }

        // Supprimer le commentaire du tableau
        task.comments.pull(commentId);
        await task.save();

        // Publier l'événement
        safePublish(`${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`, {
          type: 'COMMENT_DELETED',
          task: task,
          taskId: task._id,
          boardId: task.boardId,
          workspaceId: finalWorkspaceId
        }, 'Commentaire supprimé');

        return task;
      } catch (error) {
        logger.error('Error deleting comment:', error);
        throw new Error('Failed to delete comment');
      }
    })
    
  },
  
  Board: {
    columns: async (board, _, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      return await Column.find({ boardId: board.id, workspaceId: board.workspaceId }).sort({ order: 1 });
    },
    tasks: async (parent, _, { user }) => {
      if (!user) return [];
      return await Task.find({ boardId: parent.id, workspaceId: parent.workspaceId }).sort('position');
    },
    members: async (board) => {
      try {
        const db = mongoose.connection.db;
        
        // Convertir le workspaceId en ObjectId
        const orgId = typeof board.workspaceId === 'string' 
          ? new mongoose.Types.ObjectId(board.workspaceId) 
          : board.workspaceId;
        
        logger.info(`🔍 [Kanban Board.members] Recherche membres pour organisation: ${orgId}`);
        
        // 1. Récupérer l'organisation
        const organization = await db.collection('organization').findOne({ _id: orgId });
        
        if (!organization) {
          logger.warn(`⚠️ [Kanban Board.members] Organisation non trouvée: ${orgId}`);
          return [];
        }
        
        logger.info(`🏢 [Kanban Board.members] Organisation trouvée: ${organization.name}`);
        
        // 2. Récupérer TOUS les membres via la collection member (Better Auth)
        const members = await db.collection('member').find({
          organizationId: orgId
        }).toArray();
        
        logger.info(`📋 [Kanban Board.members] ${members.length} membres trouvés`);
        
        if (members.length === 0) {
          logger.warn(`⚠️ [Kanban Board.members] Aucun membre trouvé`);
          return [];
        }
        
        // 3. Récupérer les IDs utilisateurs
        const userIds = members.map(m => {
          const userId = m.userId;
          return typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;
        });
        
        logger.info(`👥 [Kanban Board.members] Recherche de ${userIds.length} utilisateurs`);
        
        // 4. Récupérer les informations des utilisateurs avec leurs photos
        const users = await db.collection('user').find({
          _id: { $in: userIds }
        }).toArray();
        
        logger.info(`✅ [Kanban Board.members] ${users.length} utilisateurs trouvés`);
        
        // 5. Créer le résultat en combinant membres et users
        const result = members.map(member => {
          const memberUserId = member.userId?.toString();
          const user = users.find(u => u._id.toString() === memberUserId);
          
          if (!user) {
            logger.warn(`⚠️ [Kanban Board.members] Utilisateur non trouvé: ${memberUserId}`);
            return null;
          }
          
          // Better Auth peut stocker l'image dans différents champs
          const userImage = user.image || user.avatar || user.profile?.profilePicture || user.profile?.profilePictureUrl || null;
          
          logger.info(`📸 [Kanban Board.members] Utilisateur: ${user.email}`, {
            image: user.image || 'null',
            avatar: user.avatar || 'null',
            profilePicture: user.profile?.profilePicture || 'null',
            profilePictureUrl: user.profile?.profilePictureUrl || 'null',
            finalImage: userImage || 'null'
          });
          
          return {
            id: memberUserId,
            userId: memberUserId,
            name: user.name || user.email || 'Utilisateur inconnu',
            email: user.email || '',
            image: userImage,
            role: member.role || 'member'
          };
        }).filter(Boolean); // Retirer les null
        
        logger.info(`✅ [Kanban Board.members] Retour de ${result.length} membres avec photos`);
        
        return result;
      } catch (error) {
        logger.error('❌ [Kanban Board.members] Erreur:', error);
        logger.error('Stack:', error.stack);
        return [];
      }
    }
  },
  
  Column: {
    tasks: async (parent) => {
      return await Task.find({ columnId: parent.id }).sort('position');
    }
  },

  Comment: {
    id: (parent) => parent._id || parent.id,
  },

  Activity: {
    id: (parent) => parent._id || parent.id,
  },

  Subscription: {
    boardUpdated: {
      subscribe: withWorkspace((_, { workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        try {
          const pubsub = getPubSub();
          // Utiliser un canal spécifique au workspace pour optimiser les performances
          return pubsub.asyncIterableIterator([`${BOARD_UPDATED}_${finalWorkspaceId}`]);
        } catch (error) {
          logger.error('❌ [Kanban] Erreur subscription boardUpdated:', error);
          throw new Error('Subscription failed');
        }
      }),
      resolve: (payload, { workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        // Filtrer les événements par workspace
        if (payload.workspaceId === finalWorkspaceId) {
          return payload;
        }
        return null;
      }
    },

    taskUpdated: {
      subscribe: withWorkspace((_, { boardId, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        try {
          const pubsub = getPubSub();
          // Utiliser un canal spécifique au workspace et board pour optimiser
          return pubsub.asyncIterableIterator([`${TASK_UPDATED}_${finalWorkspaceId}_${boardId}`]);
        } catch (error) {
          logger.error('❌ [Kanban] Erreur subscription taskUpdated:', error);
          throw new Error('Subscription failed');
        }
      }),
      resolve: (payload, { boardId, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        // Filtrer les événements par workspace et board
        if (payload.workspaceId === finalWorkspaceId && payload.boardId === boardId) {
          return payload;
        }
        return null;
      }
    },

    columnUpdated: {
      subscribe: withWorkspace((_, { boardId, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        try {
          const pubsub = getPubSub();
          // Utiliser un canal spécifique au workspace et board pour optimiser
          return pubsub.asyncIterableIterator([`${COLUMN_UPDATED}_${finalWorkspaceId}_${boardId}`]);
        } catch (error) {
          logger.error('❌ [Kanban] Erreur subscription columnUpdated:', error);
          throw new Error('Subscription failed');
        }
      }),
      resolve: (payload, { boardId, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        // Filtrer les événements par workspace et board
        if (payload.workspaceId === finalWorkspaceId && payload.boardId === boardId) {
          return payload;
        }
        return null;
      }
    }
  }
};

export default resolvers;