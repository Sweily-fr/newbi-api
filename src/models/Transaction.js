import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  // ID externe du provider (Bridge, Stripe, etc.)
  externalId: {
    type: String,
    required: true,
    index: true
  },
  
  // Provider utilisé
  provider: {
    type: String,
    required: true,
    enum: ['bridge', 'stripe', 'paypal', 'mock'],
    index: true
  },
  
  // Type de transaction
  type: {
    type: String,
    required: true,
    enum: ['payment', 'refund', 'transfer', 'withdrawal', 'deposit'],
    index: true
  },
  
  // Statut de la transaction
  status: {
    type: String,
    required: true,
    enum: ['pending', 'completed', 'failed', 'cancelled', 'refunded'],
    default: 'pending',
    index: true
  },
  
  // Montant et devise
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  
  currency: {
    type: String,
    required: true,
    default: 'EUR',
    uppercase: true
  },
  
  // Description
  description: {
    type: String,
    required: true
  },
  
  // Comptes impliqués
  fromAccount: {
    type: String,
    index: true
  },
  
  toAccount: {
    type: String,
    index: true
  },
  
  // Workspace et utilisateur
  workspaceId: {
    type: String,
    required: true,
    index: true
  },
  
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    index: true
  },
  
  // Dates importantes
  processedAt: {
    type: Date
  },
  
  // Raison d'échec
  failureReason: {
    type: String
  },
  
  // Frais
  fees: {
    amount: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      default: 'EUR'
    },
    provider: {
      type: String
    }
  },
  
  // Métadonnées flexibles
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Réponse brute de l'API pour debug
  raw: {
    type: mongoose.Schema.Types.Mixed
  },
  
  // Clé d'idempotence
  idempotencyKey: {
    type: String,
    unique: true,
    sparse: true
  }
}, {
  timestamps: true,
  collection: 'transactions'
});

// Index composés pour les requêtes fréquentes
transactionSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
transactionSchema.index({ userId: 1, type: 1, createdAt: -1 });
transactionSchema.index({ provider: 1, externalId: 1 }, { unique: true });
transactionSchema.index({ fromAccount: 1, createdAt: -1 });
transactionSchema.index({ toAccount: 1, createdAt: -1 });

// Méthodes d'instance
transactionSchema.methods.isCompleted = function() {
  return this.status === 'completed';
};

transactionSchema.methods.isFailed = function() {
  return this.status === 'failed';
};

transactionSchema.methods.canBeRefunded = function() {
  return this.status === 'completed' && this.type === 'payment';
};

// Méthodes statiques
transactionSchema.statics.findByWorkspace = function(workspaceId, filters = {}) {
  return this.find({ workspaceId, ...filters }).sort({ createdAt: -1 });
};

transactionSchema.statics.findByProvider = function(provider, externalId) {
  return this.findOne({ provider, externalId });
};

transactionSchema.statics.getWorkspaceStats = function(workspaceId, startDate, endDate) {
  return this.aggregate([
    {
      $match: {
        workspaceId,
        createdAt: { $gte: startDate, $lte: endDate },
        status: 'completed'
      }
    },
    {
      $group: {
        _id: '$type',
        totalAmount: { $sum: '$amount' },
        count: { $sum: 1 },
        avgAmount: { $avg: '$amount' }
      }
    }
  ]);
};

const Transaction = mongoose.model('Transaction', transactionSchema);

export default Transaction;
