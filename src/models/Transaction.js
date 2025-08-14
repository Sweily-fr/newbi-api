import mongoose from "mongoose";

const transactionSchema = new mongoose.Schema(
  {
    // Identifiants Bridge
    bridgeTransactionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    bridgeAccountId: {
      type: String,
      required: true,
      index: true,
    },
    bridgeUserId: {
      type: String,
      required: true,
      index: true,
    },

    // Référence vers l'organisation/workspace (Better Auth)
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    // Référence utilisateur local (pour audit trail)
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Informations de la transaction
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      required: true,
      default: "EUR",
    },
    description: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },

    // Statut et type
    status: {
      type: String,
      enum: ["pending", "completed", "failed", "cancelled"],
      default: "completed",
    },
    type: {
      type: String,
      enum: ["debit", "credit"],
      required: true,
    },

    // Informations détaillées Bridge
    bridgeData: {
      // Données brutes de Bridge pour référence
      raw_description: String,
      clean_description: String,
      category_id: Number,
      category: String,
      is_deleted: Boolean,
      is_future: Boolean,
      show_client_side: Boolean,

      // Informations bancaires
      bank_description: String,

      // Métadonnées
      updated_at: Date,
      created_at: Date,
    },

    // Catégorisation locale
    category: {
      type: String,
      enum: [
        "alimentation",
        "transport",
        "logement",
        "sante",
        "loisirs",
        "shopping",
        "services",
        "salaire",
        "virement",
        "autre",
      ],
      default: "autre",
    },

    // Métadonnées de synchronisation
    lastSyncAt: {
      type: Date,
      default: Date.now,
    },
    syncStatus: {
      type: String,
      enum: ["synced", "pending", "error"],
      default: "synced",
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Index composé pour les requêtes fréquentes
// Index composés workspace + autres champs
transactionSchema.index({ workspaceId: 1, date: -1 });
transactionSchema.index({ workspaceId: 1, category: 1 });
transactionSchema.index({ workspaceId: 1, bridgeUserId: 1, date: -1 });
// Index legacy pour la migration
transactionSchema.index({ userId: 1, date: -1 });
transactionSchema.index({ bridgeUserId: 1, date: -1 });

// Virtual pour le montant formaté
transactionSchema.virtual("formattedAmount").get(function () {
  const sign = this.type === "debit" ? "-" : "+";
  return `${sign}${Math.abs(this.amount).toFixed(2)} ${this.currency}`;
});

// Virtual pour la date formatée
transactionSchema.virtual("formattedDate").get(function () {
  return this.date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
});

// Méthode statique pour synchroniser les transactions Bridge
transactionSchema.statics.syncBridgeTransactions = async function (
  userId,
  bridgeTransactions
) {
  const results = {
    created: 0,
    updated: 0,
    errors: 0,
  };

  // Fonction utilitaire pour valider et parser les dates
  const parseDate = (dateValue, fieldName = "date") => {
    if (!dateValue) {
      console.log(`⚠️ ${fieldName} manquante, utilisation de null`);
      return null; // Laisser null pour les champs optionnels
    }

    const parsedDate = new Date(dateValue);
    if (isNaN(parsedDate.getTime())) {
      console.log(
        `⚠️ ${fieldName} invalide:`,
        dateValue,
        "utilisation de null"
      );
      return null; // Laisser null pour les dates invalides
    }

    console.log(
      `✅ ${fieldName} valide:`,
      dateValue,
      "→",
      parsedDate.toISOString()
    );
    return parsedDate;
  };

  for (const bridgeTransaction of bridgeTransactions) {
    try {
      // Log de la transaction Bridge pour debug
      console.log("🔍 Traitement transaction Bridge:", {
        id: bridgeTransaction.id,
        date: bridgeTransaction.date,
        created_at: bridgeTransaction.created_at,
        updated_at: bridgeTransaction.updated_at,
        amount: bridgeTransaction.amount,
      });

      const transactionData = {
        bridgeTransactionId: bridgeTransaction.id,
        bridgeAccountId: bridgeTransaction.account_id,
        bridgeUserId: bridgeTransaction.user_id || userId,
        userId: userId,
        amount: Math.abs(bridgeTransaction.amount),
        currency: bridgeTransaction.currency_code || "EUR",
        description:
          bridgeTransaction.clean_description ||
          bridgeTransaction.raw_description,
        date: parseDate(bridgeTransaction.date, "date") || new Date(), // Date obligatoire
        type: bridgeTransaction.amount < 0 ? "debit" : "credit",
        status: bridgeTransaction.is_deleted ? "cancelled" : "completed",
        bridgeData: {
          raw_description: bridgeTransaction.raw_description,
          clean_description: bridgeTransaction.clean_description,
          category_id: bridgeTransaction.category_id,
          category: bridgeTransaction.category,
          is_deleted: bridgeTransaction.is_deleted,
          is_future: bridgeTransaction.is_future,
          show_client_side: bridgeTransaction.show_client_side,
          bank_description: bridgeTransaction.bank_description,
          updated_at: parseDate(bridgeTransaction.updated_at, "updated_at"),
          created_at: parseDate(bridgeTransaction.created_at, "created_at"),
        },
        category: this.mapBridgeCategory(bridgeTransaction.category),
        lastSyncAt: new Date(),
        syncStatus: "synced",
      };

      const existingTransaction = await this.findOne({
        bridgeTransactionId: bridgeTransaction.id,
      });

      if (existingTransaction) {
        await this.findByIdAndUpdate(existingTransaction._id, transactionData);
        results.updated++;
        console.log("✅ Transaction mise à jour:", bridgeTransaction.id);
      } else {
        await this.create(transactionData);
        results.created++;
        console.log("✅ Transaction créée:", bridgeTransaction.id);
      }
    } catch (error) {
      console.error("❌ Erreur sync transaction:", error);
      console.error(
        "❌ Transaction problématique:",
        JSON.stringify(bridgeTransaction, null, 2)
      );
      results.errors++;
    }
  }

  return results;
};

// Méthode statique pour mapper les catégories Bridge vers nos catégories
transactionSchema.statics.mapBridgeCategory = function (bridgeCategory) {
  const categoryMap = {
    food: "alimentation",
    groceries: "alimentation",
    restaurant: "alimentation",
    transport: "transport",
    fuel: "transport",
    housing: "logement",
    rent: "logement",
    utilities: "logement",
    health: "sante",
    medical: "sante",
    entertainment: "loisirs",
    leisure: "loisirs",
    shopping: "shopping",
    services: "services",
    salary: "salaire",
    income: "salaire",
    transfer: "virement",
  };

  if (!bridgeCategory) return "autre";

  const lowerCategory = bridgeCategory.toLowerCase();
  return categoryMap[lowerCategory] || "autre";
};

// Méthode d'instance pour formater la transaction
transactionSchema.methods.toDisplayFormat = function () {
  return {
    id: this._id,
    amount: this.formattedAmount,
    description: this.description,
    date: this.formattedDate,
    category: this.category,
    type: this.type,
    status: this.status,
  };
};

const Transaction = mongoose.model("Transaction", transactionSchema);

export default Transaction;
