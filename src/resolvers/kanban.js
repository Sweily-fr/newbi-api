// resolvers/kanban.js
import { Board, Column, Task } from '../models/kanban.js';
import { AuthenticationError } from 'apollo-server-express';
import { withWorkspace } from '../middlewares/better-auth-jwt.js';
import { getPubSub } from '../config/redis.js';
import logger from '../utils/logger.js';

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
      
      const task = new Task({
        ...cleanedInput,
        userId: user.id,
        workspaceId: finalWorkspaceId,
        position: input.position || 0
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
    
    updateTask: withWorkspace(async (_, { input, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const { id, ...updates } = input;
      
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
      
      const task = await Task.findOneAndUpdate(
        { _id: id, workspaceId: finalWorkspaceId },
        { ...updates, updatedAt: new Date() },
        { new: true }
      );
      if (!task) throw new Error('Task not found');
      
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
    
    moveTask: withWorkspace(async (_, { id, columnId, position, workspaceId }, { workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        // Get the task to move
        const task = await Task.findOne({ _id: id, workspaceId: finalWorkspaceId });
        if (!task) throw new Error('Task not found');
        
        // If the column is changing, update the column reference
        if (task.columnId !== columnId) {
          task.columnId = columnId;
          task.status = columnId;
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
    }
  },
  
  Column: {
    tasks: async (parent) => {
      return await Task.find({ columnId: parent.id }).sort('position');
    }
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