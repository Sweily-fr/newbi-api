import mongoose from "mongoose";

/**
 * Facture récurrente : une facture de vente existante sert de modèle et une
 * nouvelle facture en est tirée à chaque échéance (tous les N jours, semaines
 * ou mois), numérotée à la suite de la séquence puis envoyée par email au
 * client avec le PDF en pièce jointe.
 *
 * Distinct de DetectedRecurrence (récurrences détectées pour la trésorerie).
 *
 * Les dates d'échéance sont des jours calendaires (heure de Paris), stockés
 * au format AAAA-MM-JJ : la comparaison de chaînes suffit et aucun décalage
 * de fuseau ne peut faire glisser une échéance d'un jour.
 */

export const RECURRENCE_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"];
export const RECURRENCE_STATUSES = ["ACTIVE", "PAUSED", "ENDED"];

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const invoiceRecurrenceSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    // Facture modèle (une seule récurrence par facture)
    sourceInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      required: true,
      unique: true,
    },
    // Utilisateur au nom duquel les factures sont créées et envoyées
    // (dernier à avoir enregistré la récurrence). S'il perd ses droits sur
    // les factures, la génération échoue et la récurrence est suspendue.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    frequency: {
      type: String,
      enum: RECURRENCE_FREQUENCIES,
      required: true,
    },
    interval: { type: Number, default: 1, min: 1, max: 365 },
    // Première échéance : sert d'ancre au calcul des suivantes (le 31 d'un
    // mois retombe sur le dernier jour des mois plus courts sans dériver).
    startDate: { type: String, required: true, match: DAY_PATTERN },
    // Dernière échéance possible (incluse), null = sans fin
    endDate: { type: String, default: null, match: DAY_PATTERN },
    nextRunDate: { type: String, default: null, match: DAY_PATTERN },
    status: {
      type: String,
      enum: RECURRENCE_STATUSES,
      default: "ACTIVE",
      index: true,
    },
    // Email envoyé au client ; null = modèle des paramètres email, comme
    // l'envoi manuel. Les variables {documentNumber}, {clientName}… sont
    // remplacées à l'envoi.
    emailSubject: { type: String, default: null, trim: true },
    emailBody: { type: String, default: null },

    generatedCount: { type: Number, default: 0 },
    lastRunDate: { type: String, default: null },
    lastInvoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
    },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
    failureCount: { type: Number, default: 0 },
    // Verrou de traitement (évite qu'une échéance soit traitée deux fois si
    // deux processus tournent pendant un redémarrage)
    lockedUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

invoiceRecurrenceSchema.index({ status: 1, nextRunDate: 1 });

export default mongoose.models.InvoiceRecurrence ||
  mongoose.model("InvoiceRecurrence", invoiceRecurrenceSchema);
