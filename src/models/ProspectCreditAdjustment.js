import mongoose from "mongoose";

/**
 * Ajustements de crédits de prospection faits depuis le back-office
 * (newbi-admin, page « Crédits de prospection ») : gestes commerciaux,
 * corrections, remboursements partiels traités à la main.
 *
 * L'admin saisit le nouveau solde voulu ; on n'écrase rien : le solde reste
 * calculé (crédits offerts du mois + achetés + ajustements − dépensés) et
 * chaque ajustement garde la différence, qui l'a faite, quand et pourquoi.
 *
 * La différence est répartie sur les deux soldes de l'espace :
 * - `purchasedCredits` : crédits sans expiration (ceux des achats), dépensés
 *   après les crédits du mois. Un ajout va toujours là ; un retrait y est
 *   pris d'abord, pour qu'annuler un geste revienne exactement à l'avant.
 * - `planCredits` (≤ 0) : crédits du mois retirés, pour le mois (heure de
 *   Paris) de `createdAt` seulement ; le mois suivant, l'offre redonne ses
 *   crédits.
 * Ces deux parts peuvent dépasser `credits` quand un solde était dépassé
 * (deux dépenses simultanées) : l'ajustement l'efface pour arriver au solde
 * demandé.
 */
const prospectCreditAdjustmentSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    // Différence vue par l'admin : nouveau solde − solde avant
    credits: {
      type: Number,
      required: true,
    },
    purchasedCredits: {
      type: Number,
      default: 0,
    },
    planCredits: {
      type: Number,
      default: 0,
      max: 0,
    },
    balanceBefore: {
      type: Number,
      required: true,
      min: 0,
    },
    balanceAfter: {
      type: Number,
      required: true,
      min: 0,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
    },
    adminEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    // Numéro de l'ajustement dans l'espace (1, 2, 3...) : deux ajustements
    // simultanés calculés sur le même solde ne passent pas tous les deux
    sequence: {
      type: Number,
      required: true,
      min: 1,
    },
  },
  { timestamps: true, collection: "prospect_credit_adjustments" },
);

prospectCreditAdjustmentSchema.index(
  { workspaceId: 1, sequence: 1 },
  { unique: true, name: "prospect_adjustment_sequence_per_workspace" },
);
prospectCreditAdjustmentSchema.index({ workspaceId: 1, createdAt: 1 });

export default mongoose.model(
  "ProspectCreditAdjustment",
  prospectCreditAdjustmentSchema,
);
