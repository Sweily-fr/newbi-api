import mongoose from "mongoose";

export const SOCIAL_MEDIA_KINDS = ["image", "video"];
export const SOCIAL_MEDIA_STATUSES = [
  "uploading",
  "processing",
  "ready",
  "failed",
];

/**
 * Média téléversé pour un post : image (déjà normalisée en JPEG et déposée
 * chez le fournisseur, toujours « ready ») ou vidéo.
 *
 * Vidéo : envoyée en morceaux (envoi multipart R2, « uploading »), puis
 * préparée en MP4 H.264 par le serveur (« processing »,
 * socialVideoProcessing.js), « ready » avec son adresse et sa vignette, ou
 * « failed » avec un message français.
 *
 * Un post n'accepte que des médias téléversés par son espace : jamais
 * d'adresse libre venue du client.
 */
const uploadSchema = new mongoose.Schema(
  {
    // Envoi multipart R2 de l'original (social/uploads/<uuid>)
    key: { type: String, default: null },
    uploadId: { type: String, default: null },
    fileName: { type: String, default: null },
    chunkSize: { type: Number, default: null },
    chunkCount: { type: Number, default: null },
    // ETag de chaque morceau, par index (null tant qu'il n'est pas reçu)
    etags: { type: [String], default: [] },
  },
  { _id: false },
);

const socialPostMediaSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    provider: { type: String, default: "zernio" },
    kind: { type: String, enum: SOCIAL_MEDIA_KINDS, default: "image" },
    status: { type: String, enum: SOCIAL_MEDIA_STATUSES, default: "ready" },
    // Message français d'un échec (vidéo)
    errorMessage: { type: String, default: null },
    // Vide tant qu'une vidéo n'est pas prête
    url: { type: String, default: "" },
    key: { type: String, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    contentType: { type: String, default: "image/jpeg" },
    size: { type: Number, default: null },

    // ── Vidéo ──
    thumbnailUrl: { type: String, default: null },
    thumbnailKey: { type: String, default: null },
    durationMs: { type: Number, default: null },
    upload: { type: uploadSchema, default: null },
    // Bail de préparation (une seule instance prépare la vidéo) et essais
    processingLockedUntil: { type: Date, default: null },
    processingAttempts: { type: Number, default: 0 },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Reprise des préparations interrompues et nettoyage des envois abandonnés
socialPostMediaSchema.index({ kind: 1, status: 1, processingLockedUntil: 1 });

const SocialPostMedia =
  mongoose.models.SocialPostMedia ||
  mongoose.model("SocialPostMedia", socialPostMediaSchema);

export default SocialPostMedia;
