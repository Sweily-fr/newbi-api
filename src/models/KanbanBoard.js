const mongoose = require('mongoose');

/**
 * Schéma pour les commentaires sur une tâche
 */
const commentSchema = new mongoose.Schema({
  content: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: function(value) {
        return value && value.length <= 1000;
      },
      message: 'Le commentaire ne doit pas dépasser 1000 caractères'
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

/**
 * Schéma pour une tâche Kanban
 */
const taskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: function(value) {
        return value && value.length <= 100;
      },
      message: 'Le titre ne doit pas dépasser 100 caractères'
    }
  },
  description: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        return !value || value.length <= 2000;
      },
      message: 'La description ne doit pas dépasser 2000 caractères'
    }
  },
  status: {
    type: String,
    required: true,
    trim: true
  },
  order: {
    type: Number,
    default: 0
  },
  dueDate: {
    type: Date
  },
  labels: [{
    type: String,
    trim: true
  }],
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  comments: [commentSchema],
  attachments: [{
    name: String,
    url: String,
    type: String
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

/**
 * Schéma pour une colonne Kanban
 */
const columnSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: function(value) {
        return value && value.length <= 50;
      },
      message: 'Le titre ne doit pas dépasser 50 caractères'
    }
  },
  order: {
    type: Number,
    default: 0
  },
  tasks: [taskSchema]
});

/**
 * Schéma principal du tableau Kanban
 */
const kanbanBoardSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: function(value) {
        return value && value.length <= 100;
      },
      message: 'Le titre ne doit pas dépasser 100 caractères'
    }
  },
  description: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        return !value || value.length <= 500;
      },
      message: 'La description ne doit pas dépasser 500 caractères'
    }
  },
  columns: [columnSchema],
  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances des recherches
kanbanBoardSchema.index({ createdBy: 1 });
kanbanBoardSchema.index({ members: 1 });
kanbanBoardSchema.index({ 'columns.tasks.assignedTo': 1 });
kanbanBoardSchema.index({ 'columns.tasks.dueDate': 1 });

module.exports = mongoose.model('KanbanBoard', kanbanBoardSchema);
