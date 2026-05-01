import mongoose from "mongoose";

/**
 * Schéma pour les commissions générées par les partenaires
 */
const partnerCommissionSchema = new mongoose.Schema(
  {
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    referralId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      // Note: do not set `index: true` here — a single-field index on referralId
      // is already declared via `partnerCommissionSchema.index({ referralId: 1 })`
      // below. Both would produce a duplicate-index warning.
    },
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      required: true,
    },
    // Montant du paiement du filleul
    paymentAmount: {
      type: Number,
      required: true,
    },
    // Taux de commission appliqué au moment de la génération
    commissionRate: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    // Montant de la commission calculée
    commissionAmount: {
      type: Number,
      required: true,
    },
    // Type d'abonnement du filleul
    subscriptionType: {
      type: String,
      enum: ["monthly", "annual"],
      required: true,
    },
    // Statut de la commission
    status: {
      type: String,
      enum: ["pending", "confirmed", "paid", "cancelled"],
      default: "pending",
      index: true,
    },
    // Date de génération de la commission
    generatedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    // Date de confirmation (après période d'essai ou validation)
    confirmedAt: Date,
    // Date de paiement au partenaire
    paidAt: Date,
    // ID du retrait associé si payé
    withdrawalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Withdrawal",
    },
    // Notes ou informations supplémentaires
    notes: String,
  },
  {
    timestamps: true,
  },
);

// Index composés pour les requêtes fréquentes
partnerCommissionSchema.index({ partnerId: 1, status: 1 });
partnerCommissionSchema.index({ partnerId: 1, generatedAt: -1 });
partnerCommissionSchema.index({ referralId: 1 });

const PartnerCommission = mongoose.model(
  "PartnerCommission",
  partnerCommissionSchema,
);

export default PartnerCommission;
