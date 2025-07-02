// models/kanban.js
const mongoose = require('mongoose');

// Schéma pour les items de la checklist
const checklistItemSchema = new mongoose.Schema({
  text: String,
  completed: { type: Boolean, default: false }
}, { _id: true });

// Schéma pour les tags
const tagSchema = new mongoose.Schema({
  name: String,
  className: String,
  bg: String,
  text: String,
  border: String
}, { _id: false });

// Schéma du tableau (Board)
const boardSchema = new mongoose.Schema({
  title: { 
    type: String, 
    required: [true, 'Le titre est requis'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  }
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Schéma de la colonne (Column)
const columnSchema = new mongoose.Schema({
  title: { 
    type: String, 
    required: [true, 'Le titre est requis'],
    trim: true
  },
  color: { 
    type: String, 
    required: [true, 'La couleur est requise'],
    trim: true
  },
  boardId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Board', 
    required: true 
  },
  order: { 
    type: Number, 
    required: [true, 'L\'ordre est requis'],
    min: 0
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  }
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Schéma de la tâche (Task)
const taskSchema = new mongoose.Schema({
  title: { 
    type: String, 
    required: [true, 'Le titre est requis'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  status: { 
    type: String, 
    required: [true, 'Le statut est requis']
  },
  priority: {
    type: String,
    enum: {
      values: ['low', 'medium', 'high'],
      message: 'La priorité doit être low, medium ou high'
    }
  },
  tags: [tagSchema],
  dueDate: Date,
  boardId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Board', 
    required: true 
  },
  columnId: { 
    type: String, 
    required: [true, 'L\'ID de la colonne est requis']
  },
  position: {
    type: Number,
    default: 0,
    min: 0
  },
  checklist: [checklistItemSchema],
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  }
}, { 
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Index pour améliorer les performances des requêtes fréquentes
boardSchema.index({ userId: 1, createdAt: -1 });
columnSchema.index({ boardId: 1, order: 1 });
taskSchema.index({ boardId: 1, columnId: 1, position: 1 });

// Middleware pour nettoyer les données liées lors de la suppression
boardSchema.pre('remove', async function(next) {
  const boardId = this._id;
  await Promise.all([
    Column.deleteMany({ boardId }),
    Task.deleteMany({ boardId })
  ]);
  next();
});

columnSchema.pre('remove', async function(next) {
  await Task.deleteMany({ columnId: this._id });
  next();
});

// Méthodes personnalisées
boardSchema.methods.getColumns = function() {
  return Column.find({ boardId: this._id }).sort('order');
};

boardSchema.methods.getTasks = function() {
  return Task.find({ boardId: this._id }).sort('position');
};

columnSchema.methods.getTasks = function() {
  return Task.find({ columnId: this._id }).sort('position');
};

// Création des modèles
const Board = mongoose.model('Board', boardSchema);
const Column = mongoose.model('Column', columnSchema);
const Task = mongoose.model('Task', taskSchema);

module.exports = {
  Board,
  Column,
  Task
};