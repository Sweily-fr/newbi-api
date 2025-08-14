import mongoose from 'mongoose';

const bridgeAccountSchema = new mongoose.Schema({
  // Identifiants
  bridgeId: {
    type: String,
    required: true,
    unique: true,
    index: true
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
    required: true,
    index: true
  },
  
  // Informations du compte
  name: {
    type: String,
    required: true
  },
  balance: {
    type: Number,
    default: 0
  },
  currency: {
    type: String,
    default: 'EUR'
  },
  type: {
    type: String,
    enum: ['checking', 'savings', 'loan', 'credit', 'investment', 'unknown'],
    default: 'unknown'
  },
  status: {
    type: String,
    enum: ['successful', 'failed', 'pending', 'ACTIVE', 'INACTIVE', 'unknown'],
    default: 'unknown'
  },
  iban: {
    type: String,
    default: null
  },
  
  // Informations de la banque
  bank: {
    name: {
      type: String,
      required: true
    },
    logo: {
      type: String,
      default: null
    }
  },
  
  // Métadonnées Bridge
  lastRefreshedAt: {
    type: Date,
    default: null
  },
  bridgeCreatedAt: {
    type: Date,
    default: null
  },
  
  // Synchronisation
  lastSyncAt: {
    type: Date,
    default: Date.now
  },
  syncStatus: {
    type: String,
    enum: ['success', 'error', 'pending'],
    default: 'success'
  },
  syncError: {
    type: String,
    default: null
  },
  
  // Activation/Désactivation
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  collection: 'bridgeaccounts'
});

// Index composé pour optimiser les requêtes
// Index composés workspace + autres champs
bridgeAccountSchema.index({ workspaceId: 1, isActive: 1 });
bridgeAccountSchema.index({ workspaceId: 1, bridgeId: 1 });
// Index legacy pour la migration
bridgeAccountSchema.index({ userId: 1, isActive: 1 });
bridgeAccountSchema.index({ bridgeId: 1, userId: 1 });

// Méthodes statiques
bridgeAccountSchema.statics.findByUserId = function(userId) {
  return this.find({ userId, isActive: true }).sort({ createdAt: -1 });
};

bridgeAccountSchema.statics.findByBridgeId = function(bridgeId) {
  return this.findOne({ bridgeId, isActive: true });
};

bridgeAccountSchema.statics.syncAccountsForUser = async function(userId, bridgeAccounts) {
  const existingAccounts = await this.find({ userId });
  const existingBridgeIds = existingAccounts.map(acc => acc.bridgeId);
  
  // Marquer les comptes supprimés comme inactifs
  const currentBridgeIds = bridgeAccounts.map(acc => acc.id);
  const deletedAccounts = existingBridgeIds.filter(id => !currentBridgeIds.includes(id));
  
  if (deletedAccounts.length > 0) {
    await this.updateMany(
      { bridgeId: { $in: deletedAccounts }, userId },
      { isActive: false, lastSyncAt: new Date() }
    );
  }
  
  // Créer ou mettre à jour les comptes
  const upsertPromises = bridgeAccounts.map(account => {
    return this.findOneAndUpdate(
      { bridgeId: account.id, userId },
      {
        name: account.name || 'Compte sans nom',
        balance: account.balance || 0,
        currency: account.currency_code || 'EUR',
        type: account.type || 'unknown',
        status: account.status || account.last_refresh_status || 'unknown',
        iban: account.iban || null,
        bank: {
          name: account.bank?.name || account.provider?.name || 'Banque inconnue',
          logo: account.bank?.logo_url || account.provider?.logo_url || null
        },
        lastRefreshedAt: account.last_refreshed_at ? new Date(account.last_refreshed_at) : null,
        bridgeCreatedAt: account.created_at ? new Date(account.created_at) : null,
        lastSyncAt: new Date(),
        syncStatus: 'success',
        syncError: null,
        isActive: true
      },
      { 
        upsert: true, 
        new: true,
        setDefaultsOnInsert: true
      }
    );
  });
  
  return Promise.all(upsertPromises);
};

// Méthodes d'instance
bridgeAccountSchema.methods.updateFromBridge = function(bridgeData) {
  this.name = bridgeData.name || this.name;
  this.balance = bridgeData.balance !== undefined ? bridgeData.balance : this.balance;
  this.currency = bridgeData.currency_code || this.currency;
  this.type = bridgeData.type || this.type;
  this.status = bridgeData.status || bridgeData.last_refresh_status || this.status;
  this.iban = bridgeData.iban || this.iban;
  this.bank = {
    name: bridgeData.bank?.name || bridgeData.provider?.name || this.bank.name,
    logo: bridgeData.bank?.logo_url || bridgeData.provider?.logo_url || this.bank.logo
  };
  this.lastRefreshedAt = bridgeData.last_refreshed_at ? new Date(bridgeData.last_refreshed_at) : this.lastRefreshedAt;
  this.lastSyncAt = new Date();
  this.syncStatus = 'success';
  this.syncError = null;
  
  return this.save();
};

const BridgeAccount = mongoose.model('BridgeAccount', bridgeAccountSchema);
export default BridgeAccount;
