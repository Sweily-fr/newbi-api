import mongoose from "mongoose";

/**
 * Demande de suppression des données reçue de Meta (« Data deletion
 * request callback », exigé pour la validation des applis) : code de
 * confirmation aléatoire renvoyé à Meta, affiché sur la page de suivi
 * /social-connect/meta/data-deletion/<code>. Rien d'autre n'est gardé
 * (ni identifiant de l'utilisateur, ni jeton).
 */
const socialDataDeletionRequestSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    // Appli qui a transmis la demande : « meta » (Facebook Login),
    // « instagram » (Instagram Login), « instagram_facebook »
    source: { type: String, required: true },
    // Comptes déconnectés et accès supprimés
    accountCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const SocialDataDeletionRequest =
  mongoose.models.SocialDataDeletionRequest ||
  mongoose.model("SocialDataDeletionRequest", socialDataDeletionRequestSchema);

export default SocialDataDeletionRequest;
