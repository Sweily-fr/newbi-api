import mongoose from "mongoose";

const CASHFLOW_TYPE = {
  INCOME: "INCOME",
  EXPENSE: "EXPENSE",
};

const CASHFLOW_FREQUENCY = {
  ONCE: "ONCE",
  WEEKLY: "WEEKLY",
  MONTHLY: "MONTHLY",
  QUARTERLY: "QUARTERLY",
  SEMIANNUAL: "SEMIANNUAL",
  ANNUAL: "ANNUAL",
};

const CASHFLOW_CATEGORY = [
  "SALES",
  "REFUNDS_RECEIVED",
  "OTHER_INCOME",
  "RENT",
  "SUBSCRIPTIONS",
  "OFFICE_SUPPLIES",
  "SERVICES",
  "TRANSPORT",
  "MEALS",
  "TELECOMMUNICATIONS",
  "INSURANCE",
  "ENERGY",
  "SOFTWARE",
  "HARDWARE",
  "MARKETING",
  "TRAINING",
  "MAINTENANCE",
  "TAXES",
  "UTILITIES",
  "SALARIES",
  "OTHER_EXPENSE",
];

const manualCashflowEntrySchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    type: {
      type: String,
      required: true,
      enum: Object.values(CASHFLOW_TYPE),
    },
    category: {
      type: String,
      enum: CASHFLOW_CATEGORY,
    },
    amount: {
      type: Number,
      required: true,
      min: [0, "Le montant doit être positif"],
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      default: null,
    },
    frequency: {
      type: String,
      required: true,
      enum: Object.values(CASHFLOW_FREQUENCY),
      default: CASHFLOW_FREQUENCY.ONCE,
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

manualCashflowEntrySchema.index({ workspaceId: 1, startDate: 1 });

manualCashflowEntrySchema.statics.CASHFLOW_TYPE = CASHFLOW_TYPE;
manualCashflowEntrySchema.statics.CASHFLOW_FREQUENCY = CASHFLOW_FREQUENCY;

const ManualCashflowEntry = mongoose.model(
  "ManualCashflowEntry",
  manualCashflowEntrySchema,
);
export default ManualCashflowEntry;
