// models/UserInvited.js
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

/**
 * Schéma pour les utilisateurs invités (visiteurs externes des tableaux Kanban)
 * Ces utilisateurs ont un ID persistant et peuvent avoir un mot de passe optionnel
 */

// Schéma pour l'accès à un board spécifique
const boardAccessSchema = new mongoose.Schema({
  boardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Board',
    required: true
  },
  shareId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PublicBoardShare',
    required: true
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  // Date de première visite sur ce board
  grantedAt: {
    type: Date,
    default: Date.now
  },
  // Date de dernière visite sur ce board
  lastVisitAt: {
    type: Date,
    default: Date.now
  },
  // Nombre de visites sur ce board
  visitCount: {
    type: Number,
    default: 1
  },
  // Statut d'accès (actif, banni, en attente)
  status: {
    type: String,
    enum: ['active', 'banned', 'pending'],
    default: 'active'
  },
  // Raison du bannissement (si applicable)
  banReason: {
    type: String,
    trim: true
  },
  // Date du bannissement (si applicable)
  bannedAt: {
    type: Date
  }
}, { _id: true });

// Schéma principal pour les utilisateurs invités
const userInvitedSchema = new mongoose.Schema({
  // Email unique (identifiant principal)
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    index: true
  },
  
  // Mot de passe hashé (optionnel)
  password: {
    type: String,
    default: null
  },
  
  // Indique si le compte nécessite un mot de passe pour se connecter
  requiresPassword: {
    type: Boolean,
    default: false
  },
  
  // Informations de profil
  firstName: {
    type: String,
    trim: true
  },
  lastName: {
    type: String,
    trim: true
  },
  // Nom complet (calculé à partir de firstName + lastName)
  name: {
    type: String,
    trim: true
  },
  // URL de l'image de profil (stockée sur Cloudflare R2)
  image: {
    type: String,
    trim: true
  },
  // Clé Cloudflare de l'image (pour suppression)
  imageKey: {
    type: String,
    trim: true
  },
  
  // Référence vers un compte Newbi existant (si l'email correspond)
  linkedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  // Liste des boards auxquels ce visiteur a accès
  boardsAccess: [boardAccessSchema],
  
  // Statistiques globales
  stats: {
    totalVisits: {
      type: Number,
      default: 0
    },
    totalComments: {
      type: Number,
      default: 0
    },
    totalBoardsAccessed: {
      type: Number,
      default: 0
    }
  },
  
  // Token de session (pour maintenir la connexion)
  sessionToken: {
    type: String,
    default: null
  },
  sessionExpiresAt: {
    type: Date,
    default: null
  },
  
  // Métadonnées
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  lastLoginAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: false // On gère manuellement createdAt et updatedAt
});

// Index composé pour rechercher rapidement les accès à un board
userInvitedSchema.index({ 'boardsAccess.boardId': 1 });
userInvitedSchema.index({ 'boardsAccess.shareId': 1 });
userInvitedSchema.index({ linkedUserId: 1 });

// Middleware pre-save pour hasher le mot de passe et mettre à jour les timestamps
userInvitedSchema.pre('save', async function(next) {
  // Mettre à jour updatedAt
  this.updatedAt = new Date();
  
  // Hasher le mot de passe si modifié et non null
  if (this.isModified('password') && this.password) {
    try {
      const salt = await bcrypt.genSalt(10);
      this.password = await bcrypt.hash(this.password, salt);
    } catch (error) {
      return next(error);
    }
  }
  
  // Calculer le nom complet
  if (this.isModified('firstName') || this.isModified('lastName')) {
    const parts = [this.firstName, this.lastName].filter(Boolean);
    this.name = parts.length > 0 ? parts.join(' ') : this.email.split('@')[0];
  }
  
  // Mettre à jour les statistiques
  if (this.isModified('boardsAccess')) {
    this.stats.totalBoardsAccessed = this.boardsAccess.filter(b => b.status === 'active').length;
  }
  
  next();
});

// Méthode pour vérifier le mot de passe
userInvitedSchema.methods.comparePassword = async function(candidatePassword) {
  // Si pas de mot de passe requis, retourner true
  if (!this.requiresPassword || !this.password) {
    return true;
  }
  
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    return false;
  }
};

// Méthode pour définir un mot de passe
userInvitedSchema.methods.setPassword = async function(newPassword) {
  this.password = newPassword;
  this.requiresPassword = true;
  await this.save();
};

// Méthode pour supprimer le mot de passe
userInvitedSchema.methods.removePassword = async function() {
  this.password = null;
  this.requiresPassword = false;
  await this.save();
};

// Méthode pour ajouter l'accès à un board
userInvitedSchema.methods.addBoardAccess = async function(boardId, shareId, workspaceId) {
  const existingAccess = this.boardsAccess.find(
    b => b.boardId.toString() === boardId.toString()
  );
  
  if (existingAccess) {
    // Mettre à jour l'accès existant
    existingAccess.lastVisitAt = new Date();
    existingAccess.visitCount += 1;
    existingAccess.status = 'active';
    existingAccess.banReason = null;
    existingAccess.bannedAt = null;
  } else {
    // Ajouter un nouvel accès
    this.boardsAccess.push({
      boardId,
      shareId,
      workspaceId,
      grantedAt: new Date(),
      lastVisitAt: new Date(),
      visitCount: 1,
      status: 'active'
    });
  }
  
  this.stats.totalVisits += 1;
  await this.save();
  
  return existingAccess || this.boardsAccess[this.boardsAccess.length - 1];
};

// Méthode pour bannir d'un board
userInvitedSchema.methods.banFromBoard = async function(boardId, reason = null) {
  const access = this.boardsAccess.find(
    b => b.boardId.toString() === boardId.toString()
  );
  
  if (access) {
    access.status = 'banned';
    access.banReason = reason;
    access.bannedAt = new Date();
    await this.save();
    return true;
  }
  
  return false;
};

// Méthode pour débannir d'un board
userInvitedSchema.methods.unbanFromBoard = async function(boardId) {
  const access = this.boardsAccess.find(
    b => b.boardId.toString() === boardId.toString()
  );
  
  if (access && access.status === 'banned') {
    access.status = 'active';
    access.banReason = null;
    access.bannedAt = null;
    await this.save();
    return true;
  }
  
  return false;
};

// Méthode pour vérifier si l'utilisateur a accès à un board
userInvitedSchema.methods.hasAccessToBoard = function(boardId) {
  const access = this.boardsAccess.find(
    b => b.boardId.toString() === boardId.toString()
  );
  
  return access && access.status === 'active';
};

// Méthode pour vérifier si l'utilisateur est banni d'un board
userInvitedSchema.methods.isBannedFromBoard = function(boardId) {
  const access = this.boardsAccess.find(
    b => b.boardId.toString() === boardId.toString()
  );
  
  return access && access.status === 'banned';
};

// Méthode pour lier à un compte Newbi
userInvitedSchema.methods.linkToNewbiUser = async function(newbiUser) {
  this.linkedUserId = newbiUser._id;
  
  // Copier les informations du compte Newbi si elles sont manquantes
  if (!this.firstName && (newbiUser.name || newbiUser.profile?.firstName)) {
    this.firstName = newbiUser.profile?.firstName || newbiUser.name;
  }
  if (!this.lastName && newbiUser.profile?.lastName) {
    this.lastName = newbiUser.profile?.lastName || newbiUser.lastName;
  }
  if (!this.image && (newbiUser.image || newbiUser.avatar)) {
    this.image = newbiUser.image || newbiUser.avatar;
  }
  
  await this.save();
};

// Méthode statique pour trouver ou créer un utilisateur invité
userInvitedSchema.statics.findOrCreate = async function(email, options = {}) {
  const normalizedEmail = email.toLowerCase().trim();
  
  let userInvited = await this.findOne({ email: normalizedEmail });
  
  if (!userInvited) {
    userInvited = new this({
      email: normalizedEmail,
      firstName: options.firstName,
      lastName: options.lastName,
      name: options.name || normalizedEmail.split('@')[0],
      image: options.image,
      requiresPassword: false
    });
    await userInvited.save();
  }
  
  return userInvited;
};

// Méthode statique pour trouver par email avec les infos du compte Newbi lié
userInvitedSchema.statics.findByEmailWithLinkedUser = async function(email) {
  const normalizedEmail = email.toLowerCase().trim();
  
  return this.findOne({ email: normalizedEmail }).populate('linkedUserId');
};

// Méthode pour générer un token de session
userInvitedSchema.methods.generateSessionToken = async function() {
  const crypto = await import('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  
  this.sessionToken = token;
  this.sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 jours
  this.lastLoginAt = new Date();
  await this.save();
  
  return token;
};

// Méthode pour valider un token de session
userInvitedSchema.methods.validateSessionToken = function(token) {
  if (!this.sessionToken || !this.sessionExpiresAt) {
    return false;
  }
  
  if (this.sessionToken !== token) {
    return false;
  }
  
  if (new Date() > this.sessionExpiresAt) {
    return false;
  }
  
  return true;
};

// Méthode pour invalider la session
userInvitedSchema.methods.invalidateSession = async function() {
  this.sessionToken = null;
  this.sessionExpiresAt = null;
  await this.save();
};

// Méthode toJSON pour exclure les champs sensibles
userInvitedSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.sessionToken;
  return obj;
};

// Méthode pour obtenir les infos publiques
userInvitedSchema.methods.getPublicInfo = function() {
  return {
    id: this._id.toString(),
    email: this.email,
    firstName: this.firstName,
    lastName: this.lastName,
    name: this.name,
    image: this.image,
    requiresPassword: this.requiresPassword,
    linkedUserId: this.linkedUserId?.toString() || null,
    stats: this.stats,
    createdAt: this.createdAt
  };
};

const UserInvited = mongoose.model('UserInvited', userInvitedSchema);

export default UserInvited;
