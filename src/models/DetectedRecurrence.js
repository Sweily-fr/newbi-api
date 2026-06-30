import mongoose from "mongoose";

const RECURRENCE_SOURCE = {
  PURCHASE_INVOICE: "PURCHASE_INVOICE",
  INVOICE: "INVOICE",
  TRANSACTION: "TRANSACTION",
};

// Détectées par analyse des intervalles entre occurrences (plus seulement
// mensuel) : hebdomadaire, bi-mensuel, mensuel, trimestriel, semestriel, annuel.
const RECURRENCE_FREQUENCY = {
  WEEKLY: "WEEKLY",
  BIWEEKLY: "BIWEEKLY",
  MONTHLY: "MONTHLY",
  QUARTERLY: "QUARTERLY",
  SEMIANNUAL: "SEMIANNUAL",
  ANNUAL: "ANNUAL",
};

const detectedRecurrenceSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: Object.values(RECURRENCE_SOURCE),
      required: true,
    },
    // INCOME (client invoices, incoming transactions) or EXPENSE
    // (purchase invoices, outgoing transactions)
    type: {
      type: String,
      enum: ["INCOME", "EXPENSE"],
      required: true,
    },
    // Normalized supplier (purchase) or client (invoice) name for matching.
    partyKey: { type: String, required: true },
    partyName: { type: String, required: true },
    category: { type: String },
    averageAmount: { type: Number, required: true, min: 0 },
    // Périodicité détectée à partir des intervalles entre occurrences.
    frequency: {
      type: String,
      enum: Object.values(RECURRENCE_FREQUENCY),
      default: RECURRENCE_FREQUENCY.MONTHLY,
    },
    // Intervalle nominal en jours (7, 14, 30, 91, 182, 365) — sert à projeter
    // les occurrences futures dans les prévisions.
    intervalDays: { type: Number, default: 30 },
    // Nombre d'occurrences observées dans la fenêtre d'analyse.
    occurrenceCount: { type: Number, default: 0 },
    // Date exacte de la dernière occurrence observée (pour la projection).
    lastSeenDate: { type: Date },
    // YYYY-MM of the most recent matched occurrence.
    lastSeenMonth: { type: String, required: true },
    consecutiveMonths: { type: Number, default: 0 },
    isActive: { type: Boolean, default: false, index: true },
    isMuted: { type: Boolean, default: false },
    // Mois (format YYYY-MM) pour lesquels une occurrence projetée de cette
    // récurrence a été supprimée individuellement. Préservé par le cron de
    // détection (cf. recurringInvoiceDetectionCron) et ignoré à la projection.
    excludedMonths: { type: [String], default: [] },
    lastDetectedAt: { type: Date },
  },
  { timestamps: true },
);

detectedRecurrenceSchema.index(
  { workspaceId: 1, source: 1, partyKey: 1, category: 1 },
  { unique: true, name: "detected_recurrence_unique" },
);

detectedRecurrenceSchema.statics.RECURRENCE_SOURCE = RECURRENCE_SOURCE;
detectedRecurrenceSchema.statics.RECURRENCE_FREQUENCY = RECURRENCE_FREQUENCY;

const DetectedRecurrence = mongoose.model(
  "DetectedRecurrence",
  detectedRecurrenceSchema,
);
export default DetectedRecurrence;
