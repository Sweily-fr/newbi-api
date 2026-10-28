import mongoose from "mongoose";

/**
 * Profil de l'espace chez le fournisseur de publication (Zernio) : un par
 * espace, il regroupe les comptes de réseaux sociaux connectés par ses
 * membres. Aucun jeton n'est stocké chez Newbi (le fournisseur les garde).
 */
const socialProfileSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      unique: true,
    },
    provider: { type: String, required: true, default: "zernio" },
    externalProfileId: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Dernière synchronisation de la liste des comptes (au plus une fois
    // toutes les 10 minutes depuis socialPublishingStatus)
    accountsSyncedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

const SocialProfile =
  mongoose.models.SocialProfile ||
  mongoose.model("SocialProfile", socialProfileSchema);

export default SocialProfile;
