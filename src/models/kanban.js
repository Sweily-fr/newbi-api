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

// Schéma pour les entrées de temps
const timeEntrySchema = new mongoose.Schema({
  startTime: {
    type: Date,
    required: true
  },
  endTime: Date,
  duration: {
    type: Number, // en secondes
    required: true,
    default: 0
  }
}, { _id: true });

// Schéma pour l'utilisateur qui a lancé le timer
const timerStartedBySchema = new mongoose.Schema({
  userId: String,
  userName: String,
  userImage: String
}, { _id: false });

// Schéma pour le suivi du temps
const timeTrackingSchema = new mongoose.Schema({
  totalSeconds: {
    type: Number,
    default: 0,
    min: 0
  },
  isRunning: {
    type: Boolean,
    default: false
  },
  currentStartTime: Date,
  // Utilisateur qui a lancé le timer actuel
  startedBy: {
    type: timerStartedBySchema,
    default: null
  },
  entries: [timeEntrySchema],
  hourlyRate: {
    type: Number,
    min: 0
  },
  roundingOption: {
    type: String,
    enum: ['none', 'up', 'down'],
    default: 'none'
  }
}, { _id: false });

// Schéma pour les images attachées
const taskImageSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true
  },
  url: {
    type: String,
    required: true
  },
  fileName: {
    type: String,
    required: true
  },
  fileSize: {
    type: Number,
    default: 0
  },
  contentType: {
    type: String,
    default: 'image/jpeg'
  },
  uploadedBy: {
    type: String,
    required: true
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

// Schéma pour les commentaires
const commentSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true
  },
  // userName et userImage sont récupérés dynamiquement via les resolvers GraphQL
  // Ne PAS les stocker en base de données
  content: {
    type: String,
    required: true,
    trim: true
  },
  // Images attachées au commentaire
  images: [taskImageSchema],
  isExternal: {
    type: Boolean,
    default: false
  },
  userEmail: String, // Pour les commentaires externes
  userName: String, // Uniquement pour les commentaires externes
  userImage: String, // Uniquement pour les commentaires externes
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
  // userName et userImage sont récupérés dynamiquement via les resolvers GraphQL
  // Ne PAS les stocker en base de données
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
      values: ['low', 'medium', 'high', ''],
      message: 'La priorité doit être low, medium, high ou vide'
    }
  },
  tags: [tagSchema],
  startDate: Date,
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
  // Membres assignés à la tâche (seulement les userId, les infos sont récupérées depuis la collection user)
  assignedMembers: [String],
  // Images attachées à la description de la tâche
  images: [taskImageSchema],
  // Commentaires
  comments: [commentSchema],
  // Historique d'activité
  activity: [activitySchema],
  // Suivi du temps et facturation
  timeTracking: timeTrackingSchema,
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