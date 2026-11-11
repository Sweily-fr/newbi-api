import mongoose from "mongoose";

/**
 * Crédits de prospection achetés à l'unité (paiement Stripe ponctuel).
 *
 * Écrits par le site (webhook Stripe et retour de Checkout, une seule fois
 * par session de paiement), lus ici pour le solde de l'espace. Ils
 * n'expirent pas et sont dépensés après les crédits offerts du mois.
 */
const prospectCreditPurchaseSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    credits: {
      type: Number,
      required: true,
      min: 1,
    },
    // Montant payé TTC, en centimes
    amountTotal: {
      type: Number,
      default: null,
    },
    currency: {
      type: String,
      default: "eur",
    },
    status: {
      type: String,
      enum: ["paid", "refunded"],
      default: "paid",
    },
    stripeCheckoutSessionId: {
      type: String,
      required: true,
    },
    stripePaymentIntentId: {
      type: String,
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
  },
  { timestamps: true, collection: "prospect_credit_purchases" },
);

prospectCreditPurchaseSchema.index(
  { stripeCheckoutSessionId: 1 },
  { unique: true, name: "prospect_purchase_once_per_checkout" },
);
prospectCreditPurchaseSchema.index({ workspaceId: 1, status: 1 });

export default mongoose.model(
  "ProspectCreditPurchase",
  prospectCreditPurchaseSchema,
);
