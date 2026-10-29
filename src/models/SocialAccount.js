import mongoose from "mongoose";
import { applyFieldEncryption } from "../utils/encryption.js";

/**
 * Compte de réseau social connecté à un espace (page Facebook, compte
 * Instagram professionnel, profil ou page LinkedIn, compte X, compte TikTok).
 * Copie locale de la liste du fournisseur, resynchronisée au retour OAuth et
 * à la demande ; un compte absent chez le fournisseur garde sa ligne avec
 * deletedAt (les posts passés gardent leurs cibles).
 *
 * provider : « zernio » (jetons gardés par Zernio) ou « direct » (notre
 * propre appli chez le réseau : jetons chiffrés ici, avec
 * utils/encryption.js, jamais lus sans .select("+accessToken")).
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

    // ── Comptes « direct » seulement ──
    // Jetons chiffrés au repos (AES-256-GCM, DATA_ENCRYPTION_KEY)
    accessToken: { type: String, default: null, select: false },
    refreshToken: { type: String, default: null, select: false },
    tokenExpiresAt: { type: Date, default: null },
    refreshTokenExpiresAt: { type: Date, default: null },
    tokenScopes: { type: [String], default: undefined },
    // Bail du rafraîchissement (X fait tourner le jeton de rafraîchissement :
    // deux rafraîchissements simultanés invalideraient le compte)
    tokenRefreshLockedUntil: { type: Date, default: null },
    // Comptes qui partagent le même jeton (profil et pages LinkedIn d'un
    // même membre) : un rafraîchissement les met tous à jour
    credentialGroup: { type: String, default: null },
    // Données propres au réseau (ex. page Facebook liée au compte Instagram)
    platformData: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

applyFieldEncryption(socialAccountSchema, ["accessToken", "refreshToken"]);

socialAccountSchema.index(
  { provider: 1, externalAccountId: 1 },
  { unique: true },
);
socialAccountSchema.index({ workspaceId: 1, deletedAt: 1 });

const SocialAccount =
  mongoose.models.SocialAccount ||
  mongoose.model("SocialAccount", socialAccountSchema);

export default SocialAccount;
