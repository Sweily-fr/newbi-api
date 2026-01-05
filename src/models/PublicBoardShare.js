// models/PublicBoardShare.js
import mongoose from 'mongoose';
import crypto from 'crypto';

// Schéma pour les visiteurs externes (utilisateurs non connectés)
const externalVisitorSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  firstName: {
    type: String,
    trim: true
  },
  lastName: {
    type: String,
    trim: true
  },
  name: {
    type: String,
    trim: true
  },
  image: {
    type: String,
    trim: true
  },
  firstVisitAt: {
    type: Date,
    default: Date.now
  },
  lastVisitAt: {
    type: Date,
    default: Date.now
  },
  visitCount: {
    type: Number,
    default: 1
  }
}, { _id: true });

// Schéma principal pour le partage public d'un tableau Kanban
const publicBoardShareSchema = new mongoose.Schema({
  // Token unique pour l'accès public (généré automatiquement)
  token: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Référence vers le tableau Kanban
  boardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Board',
    required: true,
    index: true
  },
  
  // Référence vers l'organisation/workspace
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  
  // Utilisateur qui a créé le lien de partage
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Nom personnalisé pour le lien (optionnel)
  name: {
    type: String,
    trim: true
  },
  
  // Permissions accordées aux visiteurs externes
  permissions: {
    // Peut voir les tâches
    canViewTasks: {
      type: Boolean,
      default: true
    },
    // Peut ajouter des commentaires
    canComment: {
      type: Boolean,
      default: true
    },
    // Peut voir les commentaires des autres
    canViewComments: {
      type: Boolean,
      default: true
    },
    // Peut voir les membres assignés
    canViewAssignees: {
      type: Boolean,
      default: true
    },
    // Peut voir les dates d'échéance
    canViewDueDates: {
      type: Boolean,
      default: true
    },
    // Peut voir les pièces jointes
    canViewAttachments: {
      type: Boolean,
      default: true
    }
  },
  
  // Statut du lien
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Date d'expiration (optionnel)
  expiresAt: {
    type: Date,
    default: null
  },
  
  // Protection par mot de passe (optionnel)
  password: {
    type: String,
    default: null
  },
  
  // Liste des visiteurs externes qui ont accédé au tableau
  visitors: [externalVisitorSchema],
  
  // Liste des emails bannis (accès révoqué)
  bannedEmails: [{
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    bannedAt: {
      type: Date,
      default: Date.now
    },
    reason: {
      type: String,
      trim: true
    }
  }],
  
  // Demandes d'accès en attente
  accessRequests: [{
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    name: {
      type: String,
      trim: true
    },
    message: {
      type: String,
      trim: true
    },
    requestedAt: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending'
    }
  }],
  
  // Statistiques d'accès
  stats: {
    totalViews: {
      type: Number,
      default: 0
    },
    uniqueVisitors: {
      type: Number,
      default: 0
    },
    totalComments: {
      type: Number,
      default: 0
    }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Index composés pour les recherches fréquentes
publicBoardShareSchema.index({ boardId: 1, isActive: 1 });
publicBoardShareSchema.index({ workspaceId: 1, isActive: 1 });
publicBoardShareSchema.index({ token: 1, isActive: 1 });

// Méthode statique pour générer un token unique
publicBoardShareSchema.statics.generateToken = function() {
  return crypto.randomBytes(32).toString('hex');
};

// Méthode pour vérifier si le lien est valide (actif et non expiré)
publicBoardShareSchema.methods.isValid = function() {
  if (!this.isActive) return false;
  if (this.expiresAt && new Date() > this.expiresAt) return false;
  return true;
};

// Méthode pour enregistrer une visite
publicBoardShareSchema.methods.recordVisit = async function(email) {
  const existingVisitor = this.visitors.find(v => v.email === email.toLowerCase());
  
  if (existingVisitor) {
    existingVisitor.lastVisitAt = new Date();
    existingVisitor.visitCount += 1;
  } else {
    this.visitors.push({
      email: email.toLowerCase(),
      firstVisitAt: new Date(),
      lastVisitAt: new Date(),
      visitCount: 1
    });
    this.stats.uniqueVisitors += 1;
  }
  
  this.stats.totalViews += 1;
  await this.save();
  
  return existingVisitor || this.visitors[this.visitors.length - 1];
};

// Méthode pour incrémenter le compteur de commentaires
publicBoardShareSchema.methods.incrementCommentCount = async function() {
  this.stats.totalComments += 1;
  await this.save();
};

// Middleware pour supprimer les liens expirés automatiquement (soft delete)
publicBoardShareSchema.pre('find', function() {
  // Ne pas filtrer automatiquement - laisser le resolver gérer
});

// Création du modèle
const PublicBoardShare = mongoose.model('PublicBoardShare', publicBoardShareSchema);

export default PublicBoardShare;
