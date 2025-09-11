import mongoose from 'mongoose';

const accessGrantSchema = new mongoose.Schema({
  transferId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FileTransfer',
    required: true,
    index: true
  },
  fileId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false, // null = accès à tous les fichiers du transfert
    index: true
  },
  buyerEmail: {
    type: String,
    required: true,
    index: true
  },
  buyerId: {
    type: String,
    required: false // ID utilisateur si connecté
  },
  stripeSessionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  stripePaymentIntentId: {
    type: String,
    required: false
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'expired', 'revoked'],
    default: 'pending',
    index: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  remainingDownloads: {
    type: Number,
    default: 10, // Limite par défaut
    min: 0
  },
  maxDownloads: {
    type: Number,
    default: 10
  },
  paidAmount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true,
    default: 'eur'
  },
  buyerIp: {
    type: String,
    required: false
  },
  buyerUserAgent: {
    type: String,
    required: false
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Index composé pour les requêtes fréquentes
accessGrantSchema.index({ transferId: 1, buyerEmail: 1 });
accessGrantSchema.index({ status: 1, expiresAt: 1 });
accessGrantSchema.index({ stripeSessionId: 1, status: 1 });

// Méthodes d'instance
accessGrantSchema.methods.isValid = function() {
  return this.status === 'active' && 
         this.expiresAt > new Date() && 
         this.remainingDownloads > 0;
};

accessGrantSchema.methods.canDownload = function(fileId = null) {
  if (!this.isValid()) return false;
  
  // Si fileId spécifié, vérifier que l'accès couvre ce fichier
  if (fileId && this.fileId && this.fileId.toString() !== fileId.toString()) {
    return false;
  }
  
  return true;
};

accessGrantSchema.methods.consumeDownload = async function() {
  if (!this.canDownload()) {
    throw new Error('Accès non valide pour téléchargement');
  }
  
  this.remainingDownloads -= 1;
  
  // Marquer comme expiré si plus de téléchargements
  if (this.remainingDownloads <= 0) {
    this.status = 'expired';
  }
  
  return await this.save();
};

// Méthodes statiques
accessGrantSchema.statics.createFromStripeSession = async function(sessionData) {
  const {
    sessionId,
    transferId,
    fileId,
    buyerEmail,
    paidAmount,
    currency,
    buyerIp,
    buyerUserAgent
  } = sessionData;
  
  // Durée d'accès : 48h par défaut
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 48);
  
  return await this.create({
    transferId,
    fileId,
    buyerEmail,
    stripeSessionId: sessionId,
    status: 'active',
    expiresAt,
    remainingDownloads: 10,
    maxDownloads: 10,
    paidAmount,
    currency,
    buyerIp,
    buyerUserAgent
  });
};

accessGrantSchema.statics.findValidGrant = async function(transferId, buyerEmail, fileId = null) {
  const query = {
    transferId,
    buyerEmail,
    status: 'active',
    expiresAt: { $gt: new Date() },
    remainingDownloads: { $gt: 0 }
  };
  
  // Si fileId spécifié, chercher un accès spécifique ou global
  if (fileId) {
    query.$or = [
      { fileId: fileId },
      { fileId: null } // Accès global au transfert
    ];
  }
  
  return await this.findOne(query).sort({ createdAt: -1 });
};

// Middleware pour nettoyer les accès expirés
accessGrantSchema.statics.cleanupExpired = async function() {
  const result = await this.updateMany(
    {
      status: 'active',
      $or: [
        { expiresAt: { $lt: new Date() } },
        { remainingDownloads: { $lte: 0 } }
      ]
    },
    { status: 'expired' }
  );
  
  return result.modifiedCount;
};

const AccessGrant = mongoose.model('AccessGrant', accessGrantSchema);

export default AccessGrant;
