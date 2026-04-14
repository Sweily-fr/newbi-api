import mongoose from "mongoose";

const RECURRENCE_SOURCE = {
  PURCHASE_INVOICE: "PURCHASE_INVOICE",
  INVOICE: "INVOICE",
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
    // INCOME (client invoices) or EXPENSE (purchase invoices)
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
    // YYYY-MM of the most recent matched occurrence.
    lastSeenMonth: { type: String, required: true },
    consecutiveMonths: { type: Number, default: 0 },
    isActive: { type: Boolean, default: false, index: true },
    isMuted: { type: Boolean, default: false },
    lastDetectedAt: { type: Date },
  },
  { timestamps: true },
);

detectedRecurrenceSchema.index(
  { workspaceId: 1, source: 1, partyKey: 1, category: 1 },
  { unique: true, name: "detected_recurrence_unique" },
);

detectedRecurrenceSchema.statics.RECURRENCE_SOURCE = RECURRENCE_SOURCE;

const DetectedRecurrence = mongoose.model(
  "DetectedRecurrence",
  detectedRecurrenceSchema,
);
export default DetectedRecurrence;
