// models/kanban.js
import mongoose from 'mongoose';

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

// Schéma pour les commentaires
const commentSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true
  },
  userName: {
    type: String,
    required: true
  },
  userImage: String,
  content: {
    type: String,
    required: true,
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

// Schéma pour l'historique d'activité
const activitySchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true
  },
  userName: {
    type: String,
    required: true
  },
  userImage: String,
  type: {
    type: String,
    required: true,
    enum: ['created', 'updated', 'moved', 'assigned', 'unassigned', 'priority_changed', 'due_date_changed', 'status_changed', 'comment_added']
  },
  field: String, // Champ modifié (ex: 'priority', 'dueDate', 'columnId')
  oldValue: String, // Ancienne valeur
  newValue: String, // Nouvelle valeur
  description: String, // Description de l'activité
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

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
  // Référence vers l'organisation/workspace (Better Auth)
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
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
  // Référence vers l'organisation/workspace (Better Auth)
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
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
  // Membres assignés à la tâche
  assignedMembers: [{
    userId: {
      type: String,
      required: true
    },
    name: {
      type: String,
      required: true
    },
    email: {
      type: String,
      required: true
    },
    image: String
  }],
  // Commentaires
  comments: [commentSchema],
  // Historique d'activité
  activity: [activitySchema],
  // Référence vers l'organisation/workspace (Better Auth)
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
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

// Index pour améliorer les performances des requêtes fréquentes
// Index composés workspace + autres champs
boardSchema.index({ workspaceId: 1, createdAt: -1 });
columnSchema.index({ workspaceId: 1, boardId: 1, order: 1 });
taskSchema.index({ workspaceId: 1, boardId: 1, columnId: 1, position: 1 });
// Index legacy pour la migration
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

export {
  Board,
  Column,
  Task
};