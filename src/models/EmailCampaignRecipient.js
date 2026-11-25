import mongoose from "mongoose";

/**
 * Destinataire d'une campagne e-mail, créé au lancement (audience figée).
 *
 * Statuts : PENDING (à envoyer) → SENT (accepté par le service d'envoi) ou
 * SIMULATED (mode simulation, aucun envoi réel) → DELIVERED, BOUNCED,
 * COMPLAINED ou FAILED selon les événements du service d'envoi. SKIPPED :
 * campagne annulée avant son tour. Ouvertures, clics et désinscription
 * n'en changent pas : ils ont leurs propres dates et compteurs.
 *
 * `lockedAt` / `batchKey` : destinataire réservé par un lot en cours
 * d'envoi ; un verrou de plus de 10 minutes (processus arrêté en plein
 * envoi) est levé par le cron et le destinataire repart avec le lot suivant.
 *
 * `trackingExpired` : durée de conservation du suivi dépassée, ouvertures
 * et clics effacés (voir services/emailCampaigns/retention.js) ; le pixel
 * et les liens suivis n'enregistrent plus rien pour ce destinataire.
 */

export const RECIPIENT_STATUSES = [
  "PENDING",
  "SENT",
  "DELIVERED",
  "BOUNCED",
  "COMPLAINED",
  "FAILED",
  "SIMULATED",
  "SKIPPED",
];

/** Variables de personnalisation figées au lancement. */
const varsSchema = new mongoose.Schema(
  {
    prenom: { type: String, default: "" },
    nom: { type: String, default: "" },
    nom_complet: { type: String, default: "" },
    entreprise: { type: String, default: "" },
    email: { type: String, default: "" },
    ville: { type: String, default: "" },
  },
  { _id: false },
);

const emailCampaignRecipientSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailCampaign",
      required: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
    },
    email: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, default: "" },
    vars: { type: varsSchema, default: () => ({}) },
    status: { type: String, enum: RECIPIENT_STATUSES, default: "PENDING" },
    attempts: { type: Number, default: 0 },
    lockedAt: { type: Date, default: null },
    batchKey: { type: String, default: null },
    resendId: { type: String, default: undefined },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    openCount: { type: Number, default: 0 },
    clickedAt: { type: Date, default: null },
    clickCount: { type: Number, default: 0 },
    trackingExpired: { type: Boolean, default: false },
    bouncedAt: { type: Date, default: null },
    bounceType: { type: String, default: null },
    complainedAt: { type: Date, default: null },
    unsubscribedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

// Une adresse ne reçoit la campagne qu'une fois
emailCampaignRecipientSchema.index(
  { campaignId: 1, email: 1 },
  { unique: true },
);
// Événements du service d'envoi (identifiant de l'e-mail envoyé)
emailCampaignRecipientSchema.index({ resendId: 1 }, { sparse: true });
// Lots à envoyer (dans l'ordre de création), filtres du rapport
emailCampaignRecipientSchema.index({ campaignId: 1, status: 1, _id: 1 });
// Quota du mois : e-mails envoyés (et en attente d'envoi) par l'espace
emailCampaignRecipientSchema.index({ workspaceId: 1, sentAt: 1 });
emailCampaignRecipientSchema.index({ workspaceId: 1, status: 1 });

export default mongoose.models.EmailCampaignRecipient ||
  mongoose.model("EmailCampaignRecipient", emailCampaignRecipientSchema);
