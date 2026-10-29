import mongoose from "mongoose";

/**
 * Parcours de connexion d'un compte de réseau social en cours : jeton
 * aléatoire (192 bits) transmis dans l'adresse de retour, usage unique
 * (supprimé atomiquement au retour), expiré au bout de 15 minutes.
 *
 * Pourquoi pas le state signé de utils/signedOAuthState.js : X limite le
 * state OAuth à 500 caractères et Zernio y loge notre adresse de retour
 * (environ 170 caractères utiles). Un state signé (espace, utilisateur,
 * réseau, page de retour) dépasse cette limite ; un jeton court adossé à
 * cette collection garde les mêmes garanties (infalsifiable, usage unique,
 * durée de vie courte), sans dépendre de Redis. Même jeton pour l'OAuth de
 * nos propres applis (provider « direct »), qui y garde aussi le
 * vérificateur PKCE.
 */
const socialConnectStateSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    platform: { type: String, required: true },
    // « zernio » ou « direct » (OAuth de notre propre appli chez le réseau)
    provider: { type: String, default: "zernio" },
    // Vérificateur PKCE (X), jamais transmis au navigateur
    codeVerifier: { type: String, default: null },
    returnTo: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Purge automatique des parcours abandonnés
socialConnectStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SocialConnectState =
  mongoose.models.SocialConnectState ||
  mongoose.model("SocialConnectState", socialConnectStateSchema);

export default SocialConnectState;
