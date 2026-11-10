import mongoose from "mongoose";

/**
 * Journal des crédits consommés chez le fournisseur de prospects (Societeinfo).
 *
 * - kind « search » : une page de résultats (1 crédit pour Newbi, hors quota
 *   de l'espace).
 * - kind « unlock » : une fiche débloquée et ajoutée aux clients de l'espace.
 *   Décomptée du quota de l'espace (bucket) et gardée comme trace RGPD
 *   (qui, quand, quelle source).
 *
 * Le total du mois, tous espaces confondus, sert au plafond de dépense global.
 */
const prospectCreditUsageSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    kind: {
      type: String,
      enum: ["search", "unlock"],
      required: true,
    },
    credits: {
      type: Number,
      required: true,
      min: 0,
    },
    provider: {
      type: String,
      default: "societeinfo",
    },
    // Déblocage : SIREN de l'entreprise et fiche client créée
    siren: {
      type: String,
      trim: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
    },
    // Quota utilisé : « monthly » (TPE, Entreprise) ou « welcome » (Freelance)
    bucket: {
      type: String,
      enum: ["monthly", "welcome"],
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

// Une entreprise n'est jamais facturée deux fois au même espace
prospectCreditUsageSchema.index(
  { workspaceId: 1, siren: 1 },
  {
    unique: true,
    partialFilterExpression: { kind: "unlock" },
    name: "prospect_unlock_once_per_workspace",
  },
);
prospectCreditUsageSchema.index({ workspaceId: 1, kind: 1, createdAt: 1 });
prospectCreditUsageSchema.index({ createdAt: 1 });

export default mongoose.model("ProspectCreditUsage", prospectCreditUsageSchema);
