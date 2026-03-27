import mongoose from "mongoose";

const pennylaneSyncLogSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["INVOICE", "EXPENSE", "CLIENT", "SUPPLIER", "PRODUCT"],
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    pennylaneId: {
      type: String,
    },
    status: {
      type: String,
      enum: ["SUCCESS", "ERROR"],
      required: true,
    },
    error: String,
  },
  { timestamps: true },
);

const pennylaneAccountSchema = new mongoose.Schema(
  {
    organizationId: {
      type: String,
      required: true,
    },
    apiToken: {
      type: String,
      required: true,
    },
    isConnected: {
      type: Boolean,
      default: true,
    },
    companyName: {
      type: String,
      trim: true,
    },
    companyId: {
      type: String,
    },
    environment: {
      type: String,
      enum: ["production", "sandbox"],
      default: "production",
    },
    lastSyncAt: {
      type: Date,
    },
    syncStatus: {
      type: String,
      enum: ["IDLE", "IN_PROGRESS", "SUCCESS", "ERROR"],
      default: "IDLE",
    },
    syncError: {
      type: String,
    },
    // Compteurs de sync
    stats: {
      invoicesSynced: { type: Number, default: 0 },
      expensesSynced: { type: Number, default: 0 },
      clientsSynced: { type: Number, default: 0 },
      productsSynced: { type: Number, default: 0 },
      lastErrors: [pennylaneSyncLogSchema],
    },
    // Préférences de sync automatique
    autoSync: {
      invoices: { type: Boolean, default: true },
      supplierInvoices: { type: Boolean, default: true },
      quotes: { type: Boolean, default: false },
    },
    connectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

// Un seul compte Pennylane par organisation
pennylaneAccountSchema.index({ organizationId: 1 }, { unique: true });

const PennylaneAccount = mongoose.model(
  "PennylaneAccount",
  pennylaneAccountSchema,
);

export default PennylaneAccount;
