import mongoose from "mongoose";

export const SOCIAL_POST_STATUSES = [
  "scheduled",
  "publishing",
  "published",
  "partial",
  "failed",
  "cancelled",
];
export const SOCIAL_TARGET_STATUSES = [
  "pending",
  "publishing",
  "published",
  "failed",
  "cancelled",
];

const targetSchema = new mongoose.Schema(
  {
    socialAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SocialAccount",
    },
    platform: { type: String, required: true },
    externalAccountId: { type: String, required: true },
    username: { type: String, default: null },
    displayName: { type: String, default: null },
    status: {
      type: String,
      enum: SOCIAL_TARGET_STATUSES,
      default: "pending",
    },
    platformPostUrl: { type: String, default: null },
    // Message d'origine du réseau ; traduit en français à l'affichage
    errorMessage: { type: String, default: null },
    errorCategory: { type: String, default: null },
    publishedAt: { type: Date, default: null },

    // « zernio » : la cible fait partie du post Zernio (externalPostId du
    // post) ; « direct » : publiée par notre cron (socialDirectPublisher.js)
    provider: { type: String, default: "zernio" },
    // ── Cibles « direct » seulement ──
    // Identifiant du post chez le réseau (publish_id TikTok tant que la
    // publication est en cours)
    externalPostId: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    // Nouvel essai après une erreur passagère
    nextAttemptAt: { type: Date, default: null },
    // Bail de publication (une seule instance publie la cible)
    lockedUntil: { type: Date, default: null },
    // Envoi accepté par le réseau, publication pas encore confirmée (TikTok)
    submittedAt: { type: Date, default: null },
    // Adresse du post encore attendue jusqu'à cette date (TikTok)
    urlCheckUntil: { type: Date, default: null },
    // État intermédiaire d'une publication en deux temps, gardé jusqu'à la
    // publication : conteneur Instagram, URN de vidéo LinkedIn, media_id X
    processingRef: { type: String, default: null },
    // Stories déjà publiées (Instagram, Facebook), dans l'ordre : un nouvel
    // essai reprend après la dernière, jamais de story en double
    storyIds: { type: [String], default: undefined },
    // « draft » : envoyé dans les brouillons TikTok du client (pas d'adresse
    // de post) ; null sinon
    deliveredAs: { type: String, default: null },
  },
  { _id: false },
);

// Son choisi pour un réseau (Instagram via Facebook, TikTok Business) :
// identifiant du réseau, affichage (titre, artiste, pochette) et volumes
const soundSchema = new mongoose.Schema(
  {
    soundId: { type: String, required: true },
    title: { type: String, required: true },
    artist: { type: String, default: null },
    coverUrl: { type: String, default: null },
    // Musique et son d'origine de la vidéo, de 0 à 100
    volume: { type: Number, default: 80 },
    videoVolume: { type: Number, default: 50 },
  },
  { _id: false },
);

const mediaSchema = new mongoose.Schema(
  {
    mediaId: { type: mongoose.Schema.Types.ObjectId, ref: "SocialPostMedia" },
    // « image » ou « video » (une seule vidéo par post, jamais avec des
    // images) ; toujours prête au moment de programmer
    kind: { type: String, default: "image" },
    url: { type: String, required: true },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    contentType: { type: String, default: "image/jpeg" },
    // Vidéo : vignette JPEG, durée et poids (envoi à LinkedIn et X)
    thumbnailUrl: { type: String, default: null },
    durationMs: { type: Number, default: null },
    size: { type: Number, default: null },
  },
  { _id: false },
);

/**
 * Post programmé sur les réseaux sociaux depuis le kanban : une carte
 * (taskId) par post. La date de publication suit la date d'échéance de la
 * carte (voir updateTask) ; le statut est suivi par le cron
 * socialPostSyncCron (cibles Zernio) et publié par socialDirectPublishCron
 * (cibles « direct ») ; le statut global agrège les deux.
 */
const socialPostSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    boardId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Board",
      required: true,
    },
    taskId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task",
      required: true,
      unique: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // « zernio », « direct » ou « mixed » (cibles des deux fournisseurs)
    provider: { type: String, required: true, default: "zernio" },
    // Post Zernio des cibles Zernio ; null quand toutes les cibles sont
    // publiées en direct
    externalPostId: { type: String, default: null },
    idempotencyKey: { type: String, required: true },
    content: { type: String, default: "" },
    media: { type: [mediaSchema], default: [] },
    targets: { type: [targetSchema], default: [] },
    scheduledFor: { type: Date, required: true },
    timezone: { type: String, default: "Europe/Paris" },
    status: {
      type: String,
      enum: SOCIAL_POST_STATUSES,
      default: "scheduled",
    },
    tiktokSettings: {
      type: new mongoose.Schema(
        {
          privacyLevel: String,
          allowComment: Boolean,
          // Divulgation du contenu commercial : votre marque (contenu
          // promotionnel) et contenu de marque (partenariat rémunéré)
          brandOrganic: Boolean,
          brandContent: Boolean,
          // Vidéo seulement : duos et collages (Stitch)
          allowDuet: Boolean,
          allowStitch: Boolean,
          // « direct » (défaut) ou « draft » (brouillon dans l'appli TikTok)
          mode: String,
          // Comptes TikTok Business seulement
          sound: { type: soundSchema, default: undefined },
        },
        { _id: false },
      ),
      default: null,
    },
    // Instagram : « post » ou « story », son du Reel (comptes connectés via
    // Facebook) ; null quand Instagram n'est pas visé
    instagramSettings: {
      type: new mongoose.Schema(
        {
          format: { type: String, default: "post" },
          sound: { type: soundSchema, default: undefined },
        },
        { _id: false },
      ),
      default: null,
    },
    // Facebook : « post » ou « story » ; null quand Facebook n'est pas visé
    facebookSettings: {
      type: new mongoose.Schema(
        { format: { type: String, default: "post" } },
        { _id: false },
      ),
      default: null,
    },
    lastSyncedAt: { type: Date, default: null },
    // Bail de synchronisation (une seule instance traite le post à la fois)
    syncLockedUntil: { type: Date, default: null },
    syncFailureCount: { type: Number, default: 0 },
    // Dernier statut final notifié à l'auteur (une notification par statut)
    notifiedStatus: { type: String, default: null },
    // Carte supprimée : le post n'est plus affiché sur le tableau
    taskDeletedAt: { type: Date, default: null },
    // Nouveaux essais vers X (un par cible X en échec) : chaque envoi à X
    // est facturé et compte dans la limite mensuelle (xPostQuota.js)
    xRetriedAt: { type: [Date], default: [] },
  },
  { timestamps: true },
);

socialPostSchema.index({ workspaceId: 1, boardId: 1, taskDeletedAt: 1 });
socialPostSchema.index({ status: 1, scheduledFor: 1 });
socialPostSchema.index({ workspaceId: 1, "targets.socialAccountId": 1 });
socialPostSchema.index({ workspaceId: 1, scheduledFor: 1 });

const SocialPost =
  mongoose.models.SocialPost || mongoose.model("SocialPost", socialPostSchema);

export default SocialPost;
