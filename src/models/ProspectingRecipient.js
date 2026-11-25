import mongoose from "mongoose";

/**
 * Destinataire d'une prospection, créé au lancement (audience et variables
 * figées). Un seul message par destinataire en V1.
 *
 * Statuts :
 *   PENDING       en attente de son tour ;
 *   SENT          envoyé depuis la boîte du membre ;
 *   SIMULATED     envoi simulé (mode d'envoi des campagnes : hors
 *                 production, seules les adresses autorisées reçoivent) ;
 *   REPLIED       marqué « A répondu » par l'espace ;
 *   BOUNCED       rejeté par la messagerie du destinataire (réservé : la
 *                 boîte n'est pas lue en V1) ;
 *   UNSUBSCRIBED  désinscrit (lien, désabonnement en un clic, ou « Ne plus
 *                 contacter ») ;
 *   FAILED        refusé par le fournisseur, ou trois essais en échec ;
 *   SKIPPED       écarté avant l'envoi (`skippedReason` : désinscrit, déjà
 *                 prospecté, prospection arrêtée…).
 *
 * `lockedAt` : réservé par un envoi en cours (levé au bout de 10 minutes si
 * le processus s'est arrêté avant l'appel au fournisseur ; après, FAILED :
 * jamais deux fois le même message). `simulated` : l'envoi n'est pas parti
 * pour de vrai (coupe-circuit et règle des 30 jours ne comptent que les
 * vrais).
 */

export const PROSPECTING_RECIPIENT_STATUSES = [
  "PENDING",
  "SENT",
  "SIMULATED",
  "REPLIED",
  "BOUNCED",
  "UNSUBSCRIBED",
  "FAILED",
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
    activite: { type: String, default: "" },
    site: { type: String, default: "" },
  },
  { _id: false },
);

const prospectingRecipientSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    sequenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProspectingSequence",
      required: true,
    },
    mailboxId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MailboxConnection",
      required: true,
    },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
    },
    email: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, default: "" },
    company: { type: String, default: "" },
    vars: { type: varsSchema, default: () => ({}) },
    // Contact issu de « Générer des prospects » (client.prospect.provider)
    isGeneratedProspect: { type: Boolean, default: false },
    status: {
      type: String,
      enum: PROSPECTING_RECIPIENT_STATUSES,
      default: "PENDING",
    },
    attempts: { type: Number, default: 0 },
    lockedAt: { type: Date, default: null },
    // Appel au fournisseur commencé : un arrêt brutal à ce moment ne relance
    // jamais l'envoi (le message est peut-être parti), il le passe en FAILED
    sendStartedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    simulated: { type: Boolean, default: false },
    providerMessageId: { type: String, default: null },
    threadId: { type: String, default: null },
    repliedAt: { type: Date, default: null },
    bouncedAt: { type: Date, default: null },
    unsubscribedAt: { type: Date, default: null },
    skippedReason: { type: String, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true, collection: "prospecting_recipients" },
);

// Une adresse ne reçoit la prospection qu'une fois
prospectingRecipientSchema.index({ sequenceId: 1, email: 1 }, { unique: true });
// File du cron (boîte, statut, ordre de création)
prospectingRecipientSchema.index({ mailboxId: 1, status: 1, _id: 1 });
// Règle des 30 jours : adresses prospectées récemment par l'espace
prospectingRecipientSchema.index({ workspaceId: 1, email: 1, sentAt: 1 });
// Rapport d'une prospection, plus ancien destinataire en attente
prospectingRecipientSchema.index({ sequenceId: 1, status: 1, _id: 1 });
// Envois du jour d'une boîte et coupe-circuit (derniers envois)
prospectingRecipientSchema.index({ mailboxId: 1, sentAt: -1 });
// Historique d'un contact (fiche contact)
prospectingRecipientSchema.index({ workspaceId: 1, clientId: 1 });

export default mongoose.models.ProspectingRecipient ||
  mongoose.model("ProspectingRecipient", prospectingRecipientSchema);
