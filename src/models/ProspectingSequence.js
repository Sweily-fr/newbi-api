import mongoose from "mongoose";
import { audienceSchema } from "./EmailCampaign.js";

/**
 * Prospection (Communication > Prospection) : un message envoyé une fois à
 * chaque prospect d'une audience, depuis la boîte Gmail ou Outlook de son
 * auteur (MailboxConnection), au rythme de cette boîte. V1 : un seul
 * message par prospect, aucune relance, aucun suivi d'ouverture ni de clic.
 *
 * Cycle de vie : DRAFT → ACTIVE ⇄ PAUSED → COMPLETED (plus aucun envoi en
 * attente) ou CANCELED (arrêtée, envois restants SKIPPED). Seul un
 * brouillon se modifie. Au lancement, les destinataires et leurs variables
 * sont figés (ProspectingRecipient), ainsi que l'identité de l'expéditeur
 * et la signature (`snapshot`).
 *
 * Pause (`pauseKind`) : MANUAL (par le membre), MAILBOX (boîte déconnectée,
 * suspendue ou changée), REPUTATION (réservé : le coupe-circuit suspend la
 * boîte, ses prospections passent en MAILBOX).
 *
 * `stats` : nombre de destinataires par statut actuel (`recipients` = tous),
 * recalculé après chaque changement (services/prospecting/stats.js).
 *
 * Une prospection lancée puis supprimée est seulement masquée
 * (`deletedAt`) : ses envois comptent toujours pour la règle des 30 jours
 * et l'historique des contacts.
 */

export const SEQUENCE_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "COMPLETED",
  "CANCELED",
];

export const SEQUENCE_PAUSE_KINDS = ["MANUAL", "MAILBOX", "REPUTATION"];

export const EMPTY_SEQUENCE_STATS = Object.freeze({
  recipients: 0,
  pending: 0,
  sent: 0,
  simulated: 0,
  replied: 0,
  bounced: 0,
  unsubscribed: 0,
  failed: 0,
  skipped: 0,
});

const statsSchema = new mongoose.Schema(
  Object.fromEntries(
    Object.keys(EMPTY_SEQUENCE_STATS).map((key) => [
      key,
      { type: Number, default: 0 },
    ]),
  ),
  { _id: false },
);

const snapshotSchema = new mongoose.Schema(
  {
    senderEmail: { type: String, default: "" },
    senderName: { type: String, default: "" },
    companyName: { type: String, default: "" },
    companyAddress: { type: String, default: null },
    dataPageUrl: { type: String, default: "" },
    // Signature rendue au lancement (identique dans tous les messages)
    signatureHtml: { type: String, default: "" },
    signatureText: { type: String, default: "" },
  },
  { _id: false },
);

const prospectingSequenceSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    mailboxId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MailboxConnection",
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    createdByName: { type: String, default: null },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: SEQUENCE_STATUSES, default: "DRAFT" },
    pauseKind: {
      type: String,
      enum: [...SEQUENCE_PAUSE_KINDS, null],
      default: null,
    },
    pausedReason: { type: String, default: null },
    // Listes choisies explicitement : pas « tous les contacts » par défaut
    audience: {
      type: audienceSchema,
      default: () => ({ mode: "LISTS", listIds: [], excludeListIds: [] }),
    },
    subject: { type: String, default: "", maxlength: 200 },
    // HTML simple nettoyé (services/prospecting/render.js)
    body: { type: String, default: "" },
    signatureId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailSignatureV2",
      default: null,
    },

    // Figés au lancement
    consentAt: { type: Date, default: null },
    consentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    snapshot: { type: snapshotSchema, default: null },

    stats: { type: statsSchema, default: () => ({}) },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },

    // Lancement en cours (création des destinataires) : ni second
    // lancement ni modification pendant ce temps
    launchLockedUntil: { type: Date, default: null },
    // Tour de rôle entre les prospections d'une même boîte
    lastSendAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false, collection: "prospecting_sequences" },
);

// Liste de l'espace, filtrée par statut, la plus récente d'abord
prospectingSequenceSchema.index({ workspaceId: 1, status: 1, updatedAt: -1 });
// Cron : prospections en cours d'une boîte
prospectingSequenceSchema.index({ status: 1, mailboxId: 1 });

export default mongoose.models.ProspectingSequence ||
  mongoose.model("ProspectingSequence", prospectingSequenceSchema);
