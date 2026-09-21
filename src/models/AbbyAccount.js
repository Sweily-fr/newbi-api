import mongoose from "mongoose";
import { applyFieldEncryption, decrypt } from "../utils/encryption.js";

/**
 * Compte Abby (logiciel de facturation / comptabilité des indépendants)
 * connecté à une organisation Newbi par clé API.
 *
 * Contrairement à Qonto ou Pennylane, Abby est lui-même un outil de
 * facturation : on ne recrée jamais une facture Newbi dans Abby (elle
 * recevrait un second numéro). Le sens Newbi → Abby alimente les livres
 * comptables d'Abby (livre des recettes à l'encaissement d'une facture,
 * livre des achats au paiement d'une facture d'achat). Le sens Abby → Newbi
 * importe par polling les factures et devis finalisés dans Abby.
 */

const abbyAccountSchema = new mongoose.Schema(
  {
    organizationId: {
      type: String,
      required: true,
    },
    // Clé API générée dans Abby → Paramètres → Intégrations → Clés API (suk_…)
    apiKey: {
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
    abbyCompanyId: {
      type: String,
    },
    // Compte Abby en mode test : ses documents portent `test: true` et ne
    // sont listés qu'avec ce filtre (cf. abbyService.listBillings)
    isTestMode: {
      type: Boolean,
      default: false,
    },
    // Type de produit (référentiel Abby) utilisé pour les recettes créées par
    // Newbi : 1 vente de marchandises, 2 prestation commerciale/artisanale,
    // 3 prestation libérale (BNC), 4/5 autres (cf. schéma Abby).
    incomeProductType: {
      type: Number,
      enum: [1, 2, 3, 4, 5],
      default: 2,
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
      clientInvoicesImported: { type: Number, default: 0 },
      quotesImported: { type: Number, default: 0 },
    },
    autoSync: {
      // Newbi → Abby
      invoices: { type: Boolean, default: true },
      supplierInvoices: { type: Boolean, default: true },
      // Abby → Newbi (cron de polling, cf. abbyImportCron)
      importClientInvoices: { type: Boolean, default: true },
      importQuotes: { type: Boolean, default: true },
    },
    // Borne basse (date d'émission) du polling Abby → Newbi
    importCursors: {
      clientInvoices: { type: Date },
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

// Un seul compte Abby par organisation
abbyAccountSchema.index({ organizationId: 1 }, { unique: true });

// Même convention que PennylaneAccount / QontoAccount : la lecture directe de
// `apiKey` renvoie le chiffré, le déchiffrement est explicite.
abbyAccountSchema.methods.getDecryptedApiKey = function () {
  return decrypt(this.apiKey);
};

applyFieldEncryption(abbyAccountSchema, ["apiKey"]);

const AbbyAccount = mongoose.model("AbbyAccount", abbyAccountSchema);

export default AbbyAccount;
