import mongoose from "mongoose";

/**
 * Crédits de prospection achetés à l'unité (paiement Stripe ponctuel).
 *
 * Écrits par le site (webhook Stripe et retour de Checkout, une seule fois
 * par session de paiement), lus ici pour le solde de l'espace. Ils
 * n'expirent pas et sont dépensés après les crédits offerts du mois.
 *
 * Un achat est d'abord une commande (« pending ») : ses crédits ne sont
 * utilisables (« paid ») qu'une fois activés par prospectOrders.js, quand le
 * stock de Newbi chez le fournisseur les couvre sans prendre la part gardée
 * pour les crédits offerts des abonnements. « refunded » : remboursé ou
 * contesté, crédits retirés.
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
      enum: ["pending", "paid", "refunded"],
      default: "pending",
    },
    // Commande activée (crédits devenus utilisables)
    activatedAt: {
      type: Date,
      default: null,
    },
    // Équipe prévenue de la commande (une fois)
    teamNotifiedAt: {
      type: Date,
      default: null,
    },
    // Client prévenu de l'activation (une fois)
    customerNotifiedAt: {
      type: Date,
      default: null,
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
// Commandes en attente, traitées dans l'ordre d'arrivée
prospectCreditPurchaseSchema.index({ status: 1, createdAt: 1 });

export default mongoose.model(
  "ProspectCreditPurchase",
  prospectCreditPurchaseSchema,
);
