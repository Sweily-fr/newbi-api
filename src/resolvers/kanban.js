// resolvers/kanban.js
const { Board, Column, Task } = require('../models/kanban');
const { AuthenticationError } = require('apollo-server-express');

const resolvers = {
  Query: {
    boards: async (_, __, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      return await Board.find({ userId: user.id }).sort({ createdAt: -1 });
    },
    
    board: async (_, { id }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      const board = await Board.findOne({ _id: id, userId: user.id });
      if (!board) throw new Error('Board not found');
      return board;
    },
    
    columns: async (_, { boardId }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      return await Column.find({ boardId, userId: user.id }).sort('order');
    },
    
    column: async (_, { id }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      return await Column.findOne({ _id: id, userId: user.id });
    },
    
    tasks: async (_, { boardId, columnId }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      const query = { boardId, userId: user.id };
      if (columnId) query.columnId = columnId;
      return await Task.find(query).sort('position');
    },
    
    task: async (_, { id }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      return await Task.findOne({ _id: id, userId: user.id });
    }
  },
  
  Mutation: {
    // Board mutations
    createBoard: async (_, { input }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      const board = new Board({
        ...input,
        userId: user.id
      });
      return await board.save();
    },
    
    updateBoard: async (_, { input }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      const board = await Board.findOneAndUpdate(
        { _id: input.id, userId: user.id },
        { ...input, updatedAt: new Date() },
        { new: true }
      );
      if (!board) throw new Error('Board not found');
      return board;
    },
    
    deleteBoard: async (_, { id }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      
      try {
        // Supprimer les tâches associées au tableau
        await Task.deleteMany({ boardId: id, userId: user.id });
        
        // Supprimer les colonnes associées au tableau
        await Column.deleteMany({ boardId: id, userId: user.id });
        
        // Supprimer le tableau
        const result = await Board.deleteOne({ _id: id, userId: user.id });
        
        return result.deletedCount > 0;
      } catch (error) {
        console.error('Error deleting board:', error);
        throw new Error('Failed to delete board');
      }
    },
    
    // Column mutations
    createColumn: async (_, { input }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      const column = new Column({
        ...input,
        userId: user.id
      });
      return await column.save();
    },
    
    updateColumn: async (_, { input }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      const { id, ...updates } = input;
      const column = await Column.findOneAndUpdate(
        { _id: id, userId: user.id },
        { ...updates, updatedAt: new Date() },
        { new: true }
      );
      if (!column) throw new Error('Column not found');
      return column;
    },
    
    deleteColumn: async (_, { id }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      
      try {
        // Supprimer les tâches associées à la colonne
        await Task.deleteMany({ columnId: id, userId: user.id });
        
        // Supprimer la colonne
        const result = await Column.deleteOne({ _id: id, userId: user.id });
        
        return result.deletedCount > 0;
      } catch (error) {
        console.error('Error deleting column:', error);
        throw new Error('Failed to delete column');
      }
    },
    
    reorderColumns: async (_, { columns }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      
      try {
        const updatePromises = columns.map((id, index) =>
          Column.updateOne(
            { _id: id, userId: user.id },
            { $set: { order: index, updatedAt: new Date() } }
          )
        );
        
        await Promise.all(updatePromises);
        return true;
      } catch (error) {
        console.error('Error reordering columns:', error);
        throw new Error('Failed to reorder columns');
      }
    },
    
    // Task mutations
    createTask: async (_, { input }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      const task = new Task({
        ...input,
        userId: user.id,
        position: input.position || 0
      });
      return await task.save();
    },
    
    updateTask: async (_, { input }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      const { id, ...updates } = input;
      const task = await Task.findOneAndUpdate(
        { _id: id, userId: user.id },
        { ...updates, updatedAt: new Date() },
        { new: true }
      );
      if (!task) throw new Error('Task not found');
      return task;
    },
    
    deleteTask: async (_, { id }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      const result = await Task.deleteOne({ _id: id, userId: user.id });
      return result.deletedCount > 0;
    },
    
    moveTask: async (_, { id, columnId, position }, { user }) => {
      if (!user) throw new AuthenticationError('Not authenticated');
      
      try {
        // Get the task to move
        const task = await Task.findOne({ _id: id, userId: user.id });
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
          userId: user.id
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
    }
  },
  
  Board: {
    columns: async (parent) => {
      return await Column.find({ boardId: parent.id }).sort('order');
    },
    tasks: async (parent) => {
      return await Task.find({ boardId: parent.id }).sort('position');
    }
  },
  
  Column: {
    tasks: async (parent) => {
      return await Task.find({ columnId: parent.id }).sort('position');
    }
  }
};

module.exports = resolvers;