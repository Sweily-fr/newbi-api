import mongoose from "mongoose";

/**
 * Compte de réseau social connecté à un espace (page Facebook, compte
 * Instagram professionnel, profil ou page LinkedIn, compte X, compte TikTok).
 * Copie locale de la liste du fournisseur, resynchronisée au retour OAuth et
 * à la demande ; un compte absent chez le fournisseur garde sa ligne avec
 * deletedAt (les posts passés gardent leurs cibles).
 */
const socialAccountSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    provider: { type: String, required: true, default: "zernio" },
    platform: {
      type: String,
      required: true,
      enum: ["instagram", "facebook", "linkedin", "twitter", "tiktok"],
    },
    externalAccountId: { type: String, required: true },
    username: { type: String, default: null },
    displayName: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    status: {
      type: String,
      enum: ["active", "needs_reconnect"],
      default: "active",
    },
    connectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lastSyncedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

socialAccountSchema.index(
  { provider: 1, externalAccountId: 1 },
  { unique: true },
);
socialAccountSchema.index({ workspaceId: 1, deletedAt: 1 });

const SocialAccount =
  mongoose.models.SocialAccount ||
  mongoose.model("SocialAccount", socialAccountSchema);

export default SocialAccount;
