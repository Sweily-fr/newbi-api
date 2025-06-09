const KanbanBoard = require('../models/KanbanBoard');
const User = require('../models/User');
const { isAuthenticated } = require('../middlewares/auth');
const { 
  createNotFoundError, 
  createValidationError,
  AppError,
  ERROR_CODES
} = require('../utils/errors');

const kanbanResolvers = {
  Query: {
    kanbanBoard: isAuthenticated(async (_, { id }, { user }) => {
      const board = await KanbanBoard.findOne({ 
        _id: id, 
        $or: [
          { createdBy: user.id },
          { members: user.id }
        ]
      }).populate('createdBy members');
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Peupler les utilisateurs assignés aux tâches
      for (const column of board.columns) {
        for (const task of column.tasks) {
          if (task.assignedTo) {
            const assignedUser = await User.findById(task.assignedTo);
            task.assignedTo = assignedUser;
          }
          
          // Peupler les créateurs de commentaires
          for (const comment of task.comments) {
            const commentUser = await User.findById(comment.createdBy);
            comment.createdBy = commentUser;
          }
        }
      }
      
      return board;
    }),

    kanbanBoards: isAuthenticated(async (_, { page = 1, limit = 10 }, { user }) => {
      const query = {
        $or: [
          { createdBy: user.id },
          { members: user.id }
        ]
      };

      const skip = (page - 1) * limit;
      const totalCount = await KanbanBoard.countDocuments(query);
      
      const boards = await KanbanBoard.find(query)
        .populate('createdBy members')
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit);

      return {
        boards,
        totalCount,
        hasNextPage: totalCount > skip + limit
      };
    }),

    kanbanTask: isAuthenticated(async (_, { boardId, taskId }, { user }) => {
      const board = await KanbanBoard.findOne({ 
        _id: boardId, 
        $or: [
          { createdBy: user.id },
          { members: user.id }
        ]
      }).populate('createdBy members');
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Rechercher la tâche dans toutes les colonnes
      let foundTask = null;
      
      for (const column of board.columns) {
        const task = column.tasks.find(t => t._id.toString() === taskId);
        if (task) {
          foundTask = task;
          break;
        }
      }
      
      if (!foundTask) throw createNotFoundError('Tâche');
      
      // Peupler l'utilisateur assigné
      if (foundTask.assignedTo) {
        const assignedUser = await User.findById(foundTask.assignedTo);
        foundTask.assignedTo = assignedUser;
      }
      
      // Peupler les créateurs de commentaires
      for (const comment of foundTask.comments) {
        const commentUser = await User.findById(comment.createdBy);
        comment.createdBy = commentUser;
      }
      
      return foundTask;
    })
  },

  Mutation: {
    createKanbanBoard: isAuthenticated(async (_, { input }, { user }) => {
      try {
        // Vérifier que les membres existent
        if (input.members && input.members.length > 0) {
          const memberCount = await User.countDocuments({
            _id: { $in: input.members }
          });
          
          if (memberCount !== input.members.length) {
            throw createValidationError(
              'Certains membres spécifiés n\'existent pas',
              { members: 'Membres invalides' }
            );
          }
        }
        
        // Créer des colonnes par défaut
        const defaultColumns = [
          { title: 'À faire', order: 0, tasks: [] },
          { title: 'En cours', order: 1, tasks: [] },
          { title: 'En attente', order: 2, tasks: [] },
          { title: 'Terminée', order: 3, tasks: [] },
          { title: 'Corbeille', order: 4, tasks: [] }
        ];
        
        // Créer le tableau Kanban
        const board = new KanbanBoard({
          ...input,
          columns: defaultColumns,
          createdBy: user.id
        });
        
        await board.save();
        return await board.populate('createdBy members');
      } catch (error) {
        // Intercepter les erreurs de validation Mongoose
        if (error.name === 'ValidationError') {
          const validationErrors = Object.keys(error.errors).reduce((acc, key) => {
            acc[key] = error.errors[key].message;
            return acc;
          }, {});
          
          throw createValidationError(
            'Le tableau Kanban contient des erreurs de validation',
            validationErrors
          );
        }
        
        // Si c'est une autre erreur, la propager
        throw error;
      }
    }),

    updateKanbanBoard: isAuthenticated(async (_, { id, input }, { user }) => {
      const board = await KanbanBoard.findOne({ _id: id, createdBy: user.id });
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Vérifier que les membres existent
      if (input.members && input.members.length > 0) {
        const memberCount = await User.countDocuments({
          _id: { $in: input.members }
        });
        
        if (memberCount !== input.members.length) {
          throw createValidationError(
            'Certains membres spécifiés n\'existent pas',
            { members: 'Membres invalides' }
          );
        }
      }
      
      // Mettre à jour le tableau
      Object.keys(input).forEach(key => {
        board[key] = input[key];
      });
      
      await board.save();
      return await board.populate('createdBy members');
    }),

    deleteKanbanBoard: isAuthenticated(async (_, { id }, { user }) => {
      const result = await KanbanBoard.deleteOne({ _id: id, createdBy: user.id });
      
      if (result.deletedCount === 0) {
        throw createNotFoundError('Tableau Kanban');
      }
      
      return true;
    }),

    addKanbanColumn: isAuthenticated(async (_, { boardId, input }, { user }) => {
      const board = await KanbanBoard.findOne({ _id: boardId, createdBy: user.id });
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Déterminer l'ordre si non spécifié
      if (input.order === undefined) {
        const maxOrder = board.columns.reduce((max, col) => Math.max(max, col.order), -1);
        input.order = maxOrder + 1;
      }
      
      // Ajouter la colonne
      board.columns.push({
        title: input.title,
        order: input.order,
        tasks: input.tasks || []
      });
      
      await board.save();
      return await board.populate('createdBy members');
    }),

    updateKanbanColumn: isAuthenticated(async (_, { boardId, columnId, input }, { user }) => {
      const board = await KanbanBoard.findOne({ 
        _id: boardId, 
        $or: [
          { createdBy: user.id },
          { members: user.id }
        ]
      });
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Trouver la colonne à mettre à jour
      const columnIndex = board.columns.findIndex(col => col._id.toString() === columnId);
      
      if (columnIndex === -1) throw createNotFoundError('Colonne');
      
      // Mettre à jour la colonne
      Object.keys(input).forEach(key => {
        board.columns[columnIndex][key] = input[key];
      });
      
      try {
        await board.save();
        return await board.populate('createdBy members');
      } catch (error) {
        console.error('Erreur lors de la mise à jour de la colonne:', error);
        throw error;
      }
    }),

    deleteKanbanColumn: isAuthenticated(async (_, { boardId, columnId }, { user }) => {
      const board = await KanbanBoard.findOne({ _id: boardId, createdBy: user.id });
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Filtrer la colonne à supprimer
      const initialLength = board.columns.length;
      board.columns = board.columns.filter(col => col._id.toString() !== columnId);
      
      if (board.columns.length === initialLength) {
        throw createNotFoundError('Colonne');
      }
      
      await board.save();
      return await board.populate('createdBy members');
    }),

    reorderKanbanColumns: isAuthenticated(async (_, { boardId, columnIds }, { user }) => {
      const board = await KanbanBoard.findOne({ _id: boardId, createdBy: user.id });
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Vérifier que tous les IDs de colonnes sont valides
      const columnMap = new Map();
      board.columns.forEach(col => {
        columnMap.set(col._id.toString(), col);
      });
      
      for (const colId of columnIds) {
        if (!columnMap.has(colId)) {
          throw createNotFoundError(`Colonne avec ID ${colId}`);
        }
      }
      
      // Réorganiser les colonnes
      const newColumns = columnIds.map((colId, index) => {
        const column = columnMap.get(colId);
        column.order = index;
        return column;
      });
      
      // Ajouter les colonnes qui n'étaient pas dans la liste (si applicable)
      board.columns.forEach(col => {
        if (!columnIds.includes(col._id.toString())) {
          newColumns.push(col);
        }
      });
      
      board.columns = newColumns;
      await board.save();
      return await board.populate('createdBy members');
    }),

    addKanbanTask: isAuthenticated(async (_, { boardId, columnId, input }, { user }) => {
      const board = await KanbanBoard.findOne({ 
        _id: boardId, 
        $or: [
          { createdBy: user.id },
          { members: user.id }
        ]
      });
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Trouver la colonne
      const columnIndex = board.columns.findIndex(col => col._id.toString() === columnId);
      
      if (columnIndex === -1) throw createNotFoundError('Colonne');
      
      // Déterminer l'ordre si non spécifié
      if (input.order === undefined) {
        const maxOrder = board.columns[columnIndex].tasks.reduce(
          (max, task) => Math.max(max, task.order), -1
        );
        input.order = maxOrder + 1;
      }
      
      // Créer la tâche
      const newTask = {
        ...input,
        status: board.columns[columnIndex].title,
        createdBy: user.id,
        comments: []
      };
      
      // Ajouter la tâche à la colonne
      board.columns[columnIndex].tasks.push(newTask);
      
      await board.save();
      return await board.populate('createdBy members');
    }),

    updateKanbanTask: isAuthenticated(async (_, { boardId, taskId, input }, { user }) => {
      const board = await KanbanBoard.findOne({ 
        _id: boardId, 
        $or: [
          { createdBy: user.id },
          { members: user.id }
        ]
      });
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Rechercher la tâche dans toutes les colonnes
      let foundTask = false;
      
      for (const column of board.columns) {
        const taskIndex = column.tasks.findIndex(t => t._id.toString() === taskId);
        
        if (taskIndex !== -1) {
          // Mettre à jour la tâche
          Object.keys(input).forEach(key => {
            column.tasks[taskIndex][key] = input[key];
          });
          
          foundTask = true;
          break;
        }
      }
      
      if (!foundTask) throw createNotFoundError('Tâche');
      
      await board.save();
      return await board.populate('createdBy members');
    }),

    deleteKanbanTask: isAuthenticated(async (_, { boardId, taskId }, { user }) => {
      const board = await KanbanBoard.findOne({ 
        _id: boardId, 
        $or: [
          { createdBy: user.id },
          { members: user.id }
        ]
      });
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Rechercher la tâche dans toutes les colonnes
      let foundTask = false;
      
      for (const column of board.columns) {
        const initialLength = column.tasks.length;
        column.tasks = column.tasks.filter(t => t._id.toString() !== taskId);
        
        if (column.tasks.length < initialLength) {
          foundTask = true;
          break;
        }
      }
      
      if (!foundTask) throw createNotFoundError('Tâche');
      
      await board.save();
      return await board.populate('createdBy members');
    }),

    moveKanbanTask: isAuthenticated(async (_, { boardId, taskId, sourceColumnId, targetColumnId, order }, { user }) => {
      const board = await KanbanBoard.findOne({ 
        _id: boardId, 
        $or: [
          { createdBy: user.id },
          { members: user.id }
        ]
      });
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Trouver les colonnes source et cible
      const sourceColumn = board.columns.find(col => col._id.toString() === sourceColumnId);
      const targetColumn = board.columns.find(col => col._id.toString() === targetColumnId);
      
      if (!sourceColumn) throw createNotFoundError('Colonne source');
      if (!targetColumn) throw createNotFoundError('Colonne cible');
      
      // Trouver la tâche à déplacer
      const taskIndex = sourceColumn.tasks.findIndex(t => t._id.toString() === taskId);
      
      if (taskIndex === -1) throw createNotFoundError('Tâche');
      
      // Extraire la tâche
      const task = sourceColumn.tasks[taskIndex];
      
      // Mettre à jour le statut de la tâche pour correspondre à la colonne cible
      task.status = targetColumn.title;
      task.order = order;
      
      // Supprimer la tâche de la colonne source
      sourceColumn.tasks.splice(taskIndex, 1);
      
      // Ajouter la tâche à la colonne cible
      targetColumn.tasks.push(task);
      
      // Réorganiser les tâches dans la colonne cible
      targetColumn.tasks.sort((a, b) => a.order - b.order);
      
      // Mettre à jour les ordres des tâches dans la colonne cible
      targetColumn.tasks.forEach(t => {
        if (t._id.toString() !== taskId) {
          if (t.order >= order) {
            t.order = t.order + 1;
          }
        }
      });
      
      await board.save();
      return await board.populate('createdBy members');
    }),

    addKanbanTaskComment: isAuthenticated(async (_, { boardId, taskId, input }, { user }) => {
      const board = await KanbanBoard.findOne({ 
        _id: boardId, 
        $or: [
          { createdBy: user.id },
          { members: user.id }
        ]
      });
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Rechercher la tâche dans toutes les colonnes
      let foundTask = null;
      
      for (const column of board.columns) {
        const task = column.tasks.find(t => t._id.toString() === taskId);
        
        if (task) {
          // Ajouter le commentaire
          const newComment = {
            content: input.content,
            createdBy: user.id,
            createdAt: new Date()
          };
          
          task.comments.push(newComment);
          foundTask = task;
          break;
        }
      }
      
      if (!foundTask) throw createNotFoundError('Tâche');
      
      await board.save();
      
      // Peupler les données utilisateur pour le retour
      if (foundTask.assignedTo) {
        foundTask.assignedTo = await User.findById(foundTask.assignedTo);
      }
      
      for (const comment of foundTask.comments) {
        comment.createdBy = await User.findById(comment.createdBy);
      }
      
      return foundTask;
    }),

    deleteKanbanTaskComment: isAuthenticated(async (_, { boardId, taskId, commentId }, { user }) => {
      const board = await KanbanBoard.findOne({ 
        _id: boardId, 
        $or: [
          { createdBy: user.id },
          { members: user.id }
        ]
      });
      
      if (!board) throw createNotFoundError('Tableau Kanban');
      
      // Rechercher la tâche dans toutes les colonnes
      let foundTask = null;
      
      for (const column of board.columns) {
        const task = column.tasks.find(t => t._id.toString() === taskId);
        
        if (task) {
          // Vérifier si l'utilisateur est le créateur du commentaire ou du tableau
          const comment = task.comments.find(c => c._id.toString() === commentId);
          
          if (!comment) throw createNotFoundError('Commentaire');
          
          // Seul le créateur du commentaire ou le propriétaire du tableau peut supprimer
          if (comment.createdBy.toString() !== user.id && board.createdBy.toString() !== user.id) {
            throw new AppError(
              'Vous n\'êtes pas autorisé à supprimer ce commentaire',
              403,
              ERROR_CODES.FORBIDDEN
            );
          }
          
          // Supprimer le commentaire
          task.comments = task.comments.filter(c => c._id.toString() !== commentId);
          foundTask = task;
          break;
        }
      }
      
      if (!foundTask) throw createNotFoundError('Tâche');
      
      await board.save();
      
      // Peupler les données utilisateur pour le retour
      if (foundTask.assignedTo) {
        foundTask.assignedTo = await User.findById(foundTask.assignedTo);
      }
      
      for (const comment of foundTask.comments) {
        comment.createdBy = await User.findById(comment.createdBy);
      }
      
      return foundTask;
    })
  }
};

module.exports = kanbanResolvers;
