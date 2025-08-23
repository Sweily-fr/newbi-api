import mongoose from 'mongoose';

const accountBankingSchema = new mongoose.Schema({
  // ID externe du provider
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
  
  // Nom du compte
  name: {
    type: String,
    required: true
  },
  
  // Type de compte
  type: {
    type: String,
    required: true,
    enum: ['checking', 'savings', 'credit', 'loan', 'investment'],
    default: 'checking'
  },
  
  // Statut du compte
  status: {
    type: String,
    required: true,
    enum: ['active', 'inactive', 'suspended', 'closed'],
    default: 'active',
    index: true
  },
  
  // Solde du compte
  balance: {
    type: Number,
    default: 0
  },
  
  // Devise
  currency: {
    type: String,
    default: 'EUR',
    uppercase: true
  },
  
  // IBAN
  iban: {
    type: String,
    index: true
  },
  
  // Workspace
  workspaceId: {
    type: String,
    required: true,
    index: true
  },
  
  // Utilisateur (optionnel pour webhooks)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    index: true
  },
  
  // Dernière synchronisation
  lastSyncAt: {
    type: Date,
    default: Date.now
  },
  
  // Données brutes du provider
  raw: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  collection: 'accounts_bankings'
});

// Index composés
accountBankingSchema.index({ workspaceId: 1, status: 1 });
accountBankingSchema.index({ userId: 1, provider: 1 });
accountBankingSchema.index({ provider: 1, externalId: 1 }, { unique: true });

// Méthodes d'instance
accountBankingSchema.methods.isActive = function() {
  return this.status === 'active';
};

accountBankingSchema.methods.hasLowBalance = function() {
  if (!this.notifications.lowBalance.enabled) return false;
  return this.balance.available < this.notifications.lowBalance.threshold;
};

accountBankingSchema.methods.canProcessTransaction = function(amount) {
  if (!this.isActive()) return false;
  if (this.balance.available < amount) return false;
  if (this.limits.perTransaction && amount > this.limits.perTransaction) return false;
  return true;
};

accountBankingSchema.methods.updateBalance = function(newBalance) {
  this.balance = { ...this.balance, ...newBalance };
  this.lastSyncAt = new Date();
  return this.save();
};

// Méthodes statiques
accountBankingSchema.statics.findByWorkspace = function(workspaceId) {
  return this.find({ workspaceId, status: 'active' });
};

accountBankingSchema.statics.findByProvider = function(provider, externalId) {
  return this.findOne({ provider, externalId });
};

accountBankingSchema.statics.findActiveAccounts = function(userId) {
  return this.find({ userId, status: 'active' });
};

const AccountBanking = mongoose.model('AccountBanking', accountBankingSchema);

export default AccountBanking;
