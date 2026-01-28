import mongoose from "mongoose";

const accountBankingSchema = new mongoose.Schema(
  {
    // ID externe du provider
    externalId: {
      type: String,
      required: true,
      index: true,
    },

    // Provider utilisé
    provider: {
      type: String,
      required: true,
      enum: ["bridge", "stripe", "paypal", "mock"],
      index: true,
    },

    // Nom du compte
    name: {
      type: String,
      required: true,
    },

    // Type de compte
    type: {
      type: String,
      required: true,
      enum: ["checking", "savings", "credit", "loan", "investment"],
      default: "checking",
    },

    // Statut du compte
    status: {
      type: String,
      required: true,
      enum: ["active", "inactive", "suspended", "closed"],
      default: "active",
      index: true,
    },

    // Solde du compte
    balance: {
      type: Number,
      default: 0,
    },

    // Devise
    currency: {
      type: String,
      default: "EUR",
      uppercase: true,
    },

    // IBAN
    iban: {
      type: String,
      index: true,
    },

    // Informations de la banque (institution)
    institutionName: {
      type: String,
      default: null,
    },

    institutionLogo: {
      type: String,
      default: null,
    },

    // Workspace
    workspaceId: {
      type: String,
      required: true,
      index: true,
    },

    // Utilisateur (optionnel pour webhooks)
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      index: true,
    },

    // Dernière synchronisation
    lastSyncAt: {
      type: Date,
      default: Date.now,
    },

    // Tracking de synchronisation des transactions
    transactionSync: {
      // Date de la dernière sync réussie des transactions
      lastSyncAt: {
        type: Date,
        default: null,
      },
      // Statut de la dernière sync
      status: {
        type: String,
        enum: ["pending", "in_progress", "complete", "partial", "failed"],
        default: "pending",
      },
      // Nombre total de transactions synchronisées
      totalTransactions: {
        type: Number,
        default: 0,
      },
      // Date de la transaction la plus ancienne récupérée
      oldestTransactionDate: {
        type: Date,
        default: null,
      },
      // Date de la transaction la plus récente récupérée
      newestTransactionDate: {
        type: Date,
        default: null,
      },
      // Message d'erreur si échec
      lastError: {
        type: String,
        default: null,
      },
      // Historique des syncs (dernières 10)
      history: [
        {
          date: Date,
          status: String,
          transactionsCount: Number,
          duration: Number, // en ms
          error: String,
        },
      ],
    },

    // Données brutes du provider
    raw: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
    collection: "accounts_bankings",
  }
);

// Index composés
accountBankingSchema.index({ workspaceId: 1, status: 1 });
accountBankingSchema.index({ userId: 1, provider: 1 });
accountBankingSchema.index({ provider: 1, externalId: 1 }, { unique: true });

// Méthodes d'instance
accountBankingSchema.methods.isActive = function () {
  return this.status === "active";
};

accountBankingSchema.methods.hasLowBalance = function () {
  if (!this.notifications.lowBalance.enabled) return false;
  return this.balance.available < this.notifications.lowBalance.threshold;
};

accountBankingSchema.methods.canProcessTransaction = function (amount) {
  if (!this.isActive()) return false;
  if (this.balance.available < amount) return false;
  if (this.limits.perTransaction && amount > this.limits.perTransaction)
    return false;
  return true;
};

accountBankingSchema.methods.updateBalance = function (newBalance) {
  this.balance = { ...this.balance, ...newBalance };
  this.lastSyncAt = new Date();
  return this.save();
};

// Méthodes statiques
accountBankingSchema.statics.findByWorkspace = function (workspaceId) {
  return this.find({ workspaceId, status: "active" });
};

accountBankingSchema.statics.findByProvider = function (provider, externalId) {
  return this.findOne({ provider, externalId });
};

accountBankingSchema.statics.findActiveAccounts = function (userId) {
  return this.find({ userId, status: "active" });
};

// Met à jour le statut de sync des transactions pour un compte
accountBankingSchema.statics.updateTransactionSyncStatus = async function (
  accountId,
  workspaceId,
  provider,
  syncData
) {
  const historyEntry = {
    date: new Date(),
    status: syncData.status,
    transactionsCount: syncData.transactionsCount || 0,
    duration: syncData.duration || 0,
    error: syncData.error || null,
  };

  return this.findOneAndUpdate(
    {
      externalId: accountId,
      workspaceId: workspaceId.toString(),
      provider,
    },
    {
      $set: {
        "transactionSync.lastSyncAt": new Date(),
        "transactionSync.status": syncData.status,
        "transactionSync.totalTransactions": syncData.totalTransactions || 0,
        "transactionSync.oldestTransactionDate": syncData.oldestTransactionDate,
        "transactionSync.newestTransactionDate": syncData.newestTransactionDate,
        "transactionSync.lastError": syncData.error || null,
      },
      $push: {
        "transactionSync.history": {
          $each: [historyEntry],
          $slice: -10, // Garder seulement les 10 derniers
        },
      },
    },
    { new: true }
  );
};

const AccountBanking = mongoose.model("AccountBanking", accountBankingSchema);

export default AccountBanking;
