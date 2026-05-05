import mongoose from "mongoose";
import { applyFieldEncryption, decrypt } from "../utils/encryption.js";

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

// Explicit decryption — callers MUST use this method to access the
// plaintext token; reading `account.apiToken` directly returns the
// ciphertext stored in DB. This makes the decryption boundary visible
// in code (no silent magic on every find).
pennylaneAccountSchema.methods.getDecryptedApiToken = function () {
  return decrypt(this.apiToken);
};

// Encrypt apiToken at rest using AES-256-GCM. See src/utils/encryption.js
// for the centralized helper. Existing accounts that predate this change
// must be migrated via scripts/migrations/encrypt-pennylane-tokens.js.
applyFieldEncryption(pennylaneAccountSchema, ["apiToken"]);

const PennylaneAccount = mongoose.model(
  "PennylaneAccount",
  pennylaneAccountSchema,
);

export default PennylaneAccount;
