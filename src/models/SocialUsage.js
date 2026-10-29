import mongoose from "mongoose";

/**
 * Compteur mensuel des publications faites par nos propres applis, par
 * espace et par réseau. Sert d'abord pour X, qui facture chaque création
 * de post à Sweily (0,015 $, 0,20 $ si le texte contient un lien) : base
 * d'un plafond par espace à venir.
 */
const socialUsageSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    platform: { type: String, required: true },
    // Mois UTC « AAAA-MM »
    month: { type: String, required: true },
    posts: { type: Number, default: 0 },
    postsWithUrl: { type: Number, default: 0 },
    // Coût estimé en dollars (tarif connu au moment de la publication)
    estimatedCostUsd: { type: Number, default: 0 },
  },
  { timestamps: true },
);

socialUsageSchema.index(
  { workspaceId: 1, platform: 1, month: 1 },
  { unique: true },
);

const SocialUsage =
  mongoose.models.SocialUsage ||
  mongoose.model("SocialUsage", socialUsageSchema);

export default SocialUsage;
