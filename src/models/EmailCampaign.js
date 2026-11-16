import mongoose from "mongoose";

/**
 * Campagne e-mail (Communication > Campagnes e-mail) : un envoi en masse aux
 * contacts de l'espace, contenu composé de blocs (`design`, voir
 * services/emailCampaigns/design.js).
 *
 * Cycle de vie : DRAFT → (SCHEDULED →) SENDING ⇄ PAUSED → SENT, ou CANCELED.
 * Seul un brouillon se modifie. Au lancement, les destinataires sont figés
 * (EmailCampaignRecipient), les liens aussi (`links`, cibles des clics
 * suivis) ainsi que l'identité de l'expéditeur (`snapshot`) : les e-mails
 * envoyés jusqu'à la fin de la campagne restent identiques.
 *
 * Une campagne envoyée puis supprimée est seulement masquée (`deletedAt`) :
 * ses destinataires comptent toujours dans le quota du mois, et les
 * événements du service d'envoi (rejets, plaintes) alimentent toujours la
 * liste d'exclusion de l'espace.
 */

export const CAMPAIGN_STATUSES = [
  "DRAFT",
  "SCHEDULED",
  "SENDING",
  "PAUSED",
  "SENT",
  "CANCELED",
];

export const AUDIENCE_MODES = ["ALL", "LISTS"];

/**
 * Origine d'une pause : à la main (MANUAL), coupe-circuit de réputation
 * (REPUTATION, ne se reprend pas), service d'envoi en panne ou mal
 * configuré (SERVICE).
 */
export const PAUSE_KINDS = ["MANUAL", "REPUTATION", "SERVICE"];

export const EMPTY_STATS = Object.freeze({
  recipients: 0,
  sent: 0,
  simulated: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  opens: 0,
  clicks: 0,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  failed: 0,
});

const statsSchema = new mongoose.Schema(
  Object.fromEntries(
    Object.keys(EMPTY_STATS).map((key) => [key, { type: Number, default: 0 }]),
  ),
  { _id: false },
);

const audienceSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: AUDIENCE_MODES, default: "ALL" },
    listIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "ClientList" }],
    excludeListIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "ClientList" },
    ],
  },
  { _id: false },
);

const snapshotSchema = new mongoose.Schema(
  {
    senderEmail: { type: String, default: "" },
    fromName: { type: String, default: "" },
    replyTo: { type: String, default: "" },
    companyName: { type: String, default: "" },
    companyAddress: { type: String, default: null },
  },
  { _id: false },
);

const emailCampaignSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: CAMPAIGN_STATUSES, default: "DRAFT" },
    templateKey: { type: String, default: null },
    subject: { type: String, default: "", maxlength: 200 },
    preheader: { type: String, default: "", maxlength: 250 },
    fromName: { type: String, default: "", maxlength: 60 },
    replyTo: { type: String, default: "", trim: true, lowercase: true },
    design: { type: mongoose.Schema.Types.Mixed, default: null },
    audience: { type: audienceSchema, default: () => ({}) },
    trackOpens: { type: Boolean, default: true },
    trackClicks: { type: Boolean, default: true },

    scheduledAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    pausedReason: { type: String, default: null },
    pauseKind: { type: String, enum: [...PAUSE_KINDS, null], default: null },

    // Figés au lancement
    links: { type: [String], default: [] },
    snapshot: { type: snapshotSchema, default: null },
    sendMode: { type: String, default: null },
    consentAt: { type: Date, default: null },
    consentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    stats: { type: statsSchema, default: () => ({}) },

    // Envoi par le cron : verrou de la campagne (une seule instance la
    // traite), attente imposée par le service d'envoi, tour de rôle
    lockedUntil: { type: Date, default: null },
    retryAfter: { type: Date, default: null },
    lastBatchAt: { type: Date, default: null },
    batchCount: { type: Number, default: 0 },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    createdByName: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

// Liste de l'espace, filtrée par statut, la plus récente d'abord
emailCampaignSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
// Cron : programmées arrivées à échéance, campagnes en cours d'envoi
emailCampaignSchema.index({ status: 1, scheduledAt: 1 });
emailCampaignSchema.index({ status: 1, lastBatchAt: 1 });

export default mongoose.models.EmailCampaign ||
  mongoose.model("EmailCampaign", emailCampaignSchema);
