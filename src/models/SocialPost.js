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
  },
  { _id: false },
);

const mediaSchema = new mongoose.Schema(
  {
    mediaId: { type: mongoose.Schema.Types.ObjectId, ref: "SocialPostMedia" },
    url: { type: String, required: true },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    contentType: { type: String, default: "image/jpeg" },
  },
  { _id: false },
);

/**
 * Post programmé sur les réseaux sociaux depuis le kanban : une carte
 * (taskId) par post. La date de publication suit la date d'échéance de la
 * carte (voir updateTask) ; le statut est suivi par le cron
 * socialPostSyncCron.
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
    provider: { type: String, required: true, default: "zernio" },
    externalPostId: { type: String, required: true },
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
          brandOrganic: Boolean,
        },
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
  },
  { timestamps: true },
);

socialPostSchema.index({ workspaceId: 1, boardId: 1, taskDeletedAt: 1 });
socialPostSchema.index({ status: 1, scheduledFor: 1 });
socialPostSchema.index({ workspaceId: 1, "targets.socialAccountId": 1 });

const SocialPost =
  mongoose.models.SocialPost || mongoose.model("SocialPost", socialPostSchema);

export default SocialPost;
