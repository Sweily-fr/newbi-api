// resolvers/kanban.js
import { Board, Column, Task } from '../models/kanban.js';
import { AuthenticationError } from 'apollo-server-express';
import { withWorkspace } from '../middlewares/better-auth-bearer.js';

const resolvers = {
  Query: {
    boards: withWorkspace(async (_, { workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      return await Board.find({ workspaceId: finalWorkspaceId }).sort({ createdAt: -1 });
    }),
    
    board: withWorkspace(async (_, { id, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const board = await Board.findOne({ _id: id, workspaceId: finalWorkspaceId });
      if (!board) throw new Error('Board not found');
      return board;
    }),
    
    columns: withWorkspace(async (_, { boardId, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      return await Column.find({ boardId, workspaceId: finalWorkspaceId }).sort('order');
    }),
    
    column: withWorkspace(async (_, { id, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      return await Column.findOne({ _id: id, workspaceId: finalWorkspaceId });
    }),
    
    tasks: withWorkspace(async (_, { boardId, columnId, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const query = { boardId, workspaceId: finalWorkspaceId };
      if (columnId) query.columnId = columnId;
      return await Task.find(query).sort('position');
    }),
    
    task: withWorkspace(async (_, { id, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
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
      
      return savedBoard;
    }),
    
    updateBoard: withWorkspace(async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const board = await Board.findOneAndUpdate(
        { _id: input.id, workspaceId: finalWorkspaceId },
        { ...input, updatedAt: new Date() },
        { new: true }
      );
      if (!board) throw new Error('Board not found');
      return board;
    }),
    
    deleteBoard: withWorkspace(async (_, { id, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        // Supprimer les tâches associées au tableau
        await Task.deleteMany({ boardId: id, workspaceId: finalWorkspaceId });
        
        // Supprimer les colonnes associées au tableau
        await Column.deleteMany({ boardId: id, workspaceId: finalWorkspaceId });
        
        // Supprimer le tableau
        const result = await Board.deleteOne({ _id: id, workspaceId: finalWorkspaceId });
        
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
      
      return await column.save();
    }),
    
    updateColumn: withWorkspace(async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const { id, ...updates } = input;
      const column = await Column.findOneAndUpdate(
        { _id: id, workspaceId: finalWorkspaceId },
        { ...updates, updatedAt: new Date() },
        { new: true }
      );
      if (!column) throw new Error('Column not found');
      return column;
    }),
    
    deleteColumn: withWorkspace(async (_, { id, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        // Supprimer les tâches associées à la colonne
        await Task.deleteMany({ columnId: id, workspaceId: finalWorkspaceId });
        
        // Supprimer la colonne
        const result = await Column.deleteOne({ _id: id, workspaceId: finalWorkspaceId });
        
        return result.deletedCount > 0;
      } catch (error) {
        console.error('Error deleting column:', error);
        throw new Error('Failed to delete column');
      }
    }),
    
    reorderColumns: withWorkspace(async (_, { columns, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      
      try {
        const updatePromises = columns.map((id, index) =>
          Column.updateOne(
            { _id: id, workspaceId: finalWorkspaceId },
            { $set: { order: index, updatedAt: new Date() } }
          )
        );
        
        await Promise.all(updatePromises);
        return true;
      } catch (error) {
        console.error('Error reordering columns:', error);
        throw new Error('Failed to reorder columns');
      }
    }),
    
    // Task mutations
    createTask: withWorkspace(async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const task = new Task({
        ...input,
        userId: user.id,
        workspaceId: finalWorkspaceId,
        position: input.position || 0
      });
      return await task.save();
    }),
    
    updateTask: withWorkspace(async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const { id, ...updates } = input;
      const task = await Task.findOneAndUpdate(
        { _id: id, workspaceId: finalWorkspaceId },
        { ...updates, updatedAt: new Date() },
        { new: true }
      );
      if (!task) throw new Error('Task not found');
      return task;
    }),
    
    deleteTask: withWorkspace(async (_, { id, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      const finalWorkspaceId = workspaceId || contextWorkspaceId;
      const result = await Task.deleteOne({ _id: id, workspaceId: finalWorkspaceId });
      return result.deletedCount > 0;
    }),
    
    moveTask: withWorkspace(async (_, { id, columnId, position, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
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
  }
};

export default resolvers;