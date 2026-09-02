import mongoose from "mongoose";
import { applyFieldEncryption, decrypt } from "../utils/encryption.js";

const qontoSyncLogSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["INVOICE", "EXPENSE", "PURCHASE_INVOICE", "CLIENT"],
      required: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    qontoId: {
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

// Snapshot des comptes bancaires Qonto (récupérés via GET /organization).
// L'IBAN sélectionné est celui affiché comme moyen de paiement sur les
// factures clients créées dans Qonto (payment_methods.iban).
const qontoBankAccountSchema = new mongoose.Schema(
  {
    qontoId: { type: String, required: true },
    slug: { type: String },
    name: { type: String },
    iban: { type: String },
    bic: { type: String },
    currency: { type: String, default: "EUR" },
    main: { type: Boolean, default: false },
    status: { type: String },
    // Compte externe agrégé (sandbox uniquement, jamais listé en production)
    external: { type: Boolean, default: false },
  },
  { _id: false },
);

const qontoAccountSchema = new mongoose.Schema(
  {
    organizationId: {
      type: String,
      required: true,
    },
    // Identifiant de connexion Qonto (slug de l'organisation, ex: "ma-societe-1234")
    login: {
      type: String,
      required: true,
      trim: true,
    },
    // Clé secrète générée dans Qonto → Intégrations et partenariats → Clé API
    secretKey: {
      type: String,
      required: true,
    },
    isConnected: {
      type: Boolean,
      default: true,
    },
    organizationName: {
      type: String,
      trim: true,
    },
    qontoOrganizationId: {
      type: String,
    },
    slug: {
      type: String,
    },
    environment: {
      type: String,
      enum: ["production", "sandbox"],
      default: "production",
    },
    bankAccounts: {
      type: [qontoBankAccountSchema],
      default: [],
    },
    // qontoId du compte bancaire dont l'IBAN est utilisé sur les factures
    selectedBankAccountId: {
      type: String,
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
    stats: {
      invoicesSynced: { type: Number, default: 0 },
      expensesSynced: { type: Number, default: 0 },
      clientsSynced: { type: Number, default: 0 },
      quotesSynced: { type: Number, default: 0 },
      clientInvoicesImported: { type: Number, default: 0 },
      supplierInvoicesImported: { type: Number, default: 0 },
      quotesImported: { type: Number, default: 0 },
      lastErrors: [qontoSyncLogSchema],
    },
    autoSync: {
      // Newbi → Qonto
      invoices: { type: Boolean, default: true },
      supplierInvoices: { type: Boolean, default: true },
      quotes: { type: Boolean, default: true },
      // Qonto → Newbi (cron de polling, cf. qontoImportCron)
      importClientInvoices: { type: Boolean, default: true },
      importSupplierInvoices: { type: Boolean, default: true },
      importQuotes: { type: Boolean, default: true },
    },
    // Curseurs updated_at_from du polling Qonto → Newbi
    importCursors: {
      clientInvoices: { type: Date },
      supplierInvoices: { type: Date },
      quotes: { type: Date },
    },
    lastImportAt: {
      type: Date,
    },
    importError: {
      type: String,
    },
    connectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

// Un seul compte Qonto par organisation
qontoAccountSchema.index({ organizationId: 1 }, { unique: true });

// Même convention que PennylaneAccount : la lecture directe de `secretKey`
// renvoie le chiffré. Le déchiffrement est explicite.
qontoAccountSchema.methods.getDecryptedSecretKey = function () {
  return decrypt(this.secretKey);
};

/**
 * Identifiants prêts à l'emploi pour qontoService (login + clé en clair + env).
 */
qontoAccountSchema.methods.getCredentials = function () {
  return {
    login: this.login,
    secretKey: this.getDecryptedSecretKey(),
    environment: this.environment || "production",
  };
};

/**
 * Retourne le compte bancaire à utiliser pour les factures : celui sélectionné,
 * sinon le compte principal, sinon le premier compte actif.
 */
qontoAccountSchema.methods.getInvoiceBankAccount = function () {
  const accounts = this.bankAccounts || [];
  if (accounts.length === 0) return null;
  if (this.selectedBankAccountId) {
    const selected = accounts.find(
      (a) => a.qontoId === this.selectedBankAccountId,
    );
    if (selected) return selected;
  }
  // Un IBAN masqué ("FRXXXX…", sandbox ou rôle restreint) est inutilisable
  const usable = (a) => a.status !== "closed" && !/X{4,}/i.test(a.iban || "");
  return (
    accounts.find((a) => a.main && usable(a)) ||
    accounts.find(usable) ||
    accounts.find((a) => a.main && a.status !== "closed") ||
    accounts.find((a) => a.status !== "closed") ||
    accounts[0]
  );
};

applyFieldEncryption(qontoAccountSchema, ["secretKey"]);

const QontoAccount = mongoose.model("QontoAccount", qontoAccountSchema);

export default QontoAccount;
