import mongoose from "mongoose";
import { isPositiveAmount, URL_REGEX } from "../utils/validators.js";
import { deriveVatRate } from "../utils/purchaseInvoiceVat.js";

const fileSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true, trim: true },
    originalFilename: { type: String, required: true, trim: true },
    mimetype: { type: String, required: true },
    path: { type: String, required: true },
    size: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => v > 0,
        message: "La taille du fichier doit être supérieure à 0",
      },
    },
    url: {
      type: String,
      required: true,
      validate: {
        validator: (v) => URL_REGEX.test(v),
        message: "L'URL du fichier n'est pas valide",
      },
    },
    ocrProcessed: { type: Boolean, default: false },
    ocrData: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: true, timestamps: true },
);

const ocrMetadataSchema = new mongoose.Schema(
  {
    supplierName: { type: String, trim: true },
    supplierAddress: { type: String, trim: true },
    supplierVatNumber: { type: String, trim: true },
    supplierSiret: { type: String, trim: true },
    invoiceNumber: { type: String, trim: true },
    invoiceDate: { type: Date },
    dueDate: { type: Date },
    amountHT: { type: Number },
    amountTVA: { type: Number },
    vatRate: { type: Number },
    amountTTC: { type: Number },
    currency: { type: String, trim: true },
    iban: { type: String, trim: true },
    bic: { type: String, trim: true },
    confidenceScore: { type: Number, min: 0, max: 1 },
    rawExtractedText: { type: String },
    // Moteur qui a produit les champs (claude-vision, mistral, tesseract...)
    provider: { type: String, trim: true },
    // Qualité de l'extraction :
    //  - full    : IA (Claude Vision ou analyse Mistral), champs fiables
    //  - partial : secours sans IA (regex sur le texte OCR), à vérifier
    //  - none    : aucune donnée extraite, facture créée depuis la transaction
    //  - reviewed: partial/none puis enregistrée par l'utilisateur (vérifiée)
    extractionQuality: {
      type: String,
      enum: ["full", "partial", "none", "reviewed"],
    },
  },
  { _id: false },
);

// Une ligne par taux de TVA (cf. utils/purchaseInvoiceVat.js) : renseignée
// seulement quand la facture mêle au moins deux taux, amountHT / amountTVA /
// vatRate en sont alors le résumé.
const vatLineSchema = new mongoose.Schema(
  {
    rate: { type: Number, required: true, min: 0, max: 100 },
    baseHT: { type: Number, required: true },
    amountTVA: { type: Number, required: true },
  },
  { _id: false },
);

// HT / TVA / taux reçus à null (champ vidé dans un formulaire) : Mongoose
// n'applique le défaut qu'à un champ absent et enregistrait null, que le
// schéma GraphQL (Float!) refuse : toute la liste de l'espace tombait
// (incident du 15/10/2026). Le setter vaut aussi pour les mises à jour.
const nullToDefault = (fallback) => (value) =>
  value === null ? fallback : value;

const PURCHASE_INVOICE_STATUS = {
  TO_PROCESS: "TO_PROCESS",
  TO_PAY: "TO_PAY",
  PENDING: "PENDING",
  PAID: "PAID",
  OVERDUE: "OVERDUE",
  ARCHIVED: "ARCHIVED",
};

const PURCHASE_INVOICE_CATEGORY = {
  RENT: "RENT",
  SUBSCRIPTIONS: "SUBSCRIPTIONS",
  OFFICE_SUPPLIES: "OFFICE_SUPPLIES",
  SERVICES: "SERVICES",
  TRANSPORT: "TRANSPORT",
  MEALS: "MEALS",
  TELECOMMUNICATIONS: "TELECOMMUNICATIONS",
  INSURANCE: "INSURANCE",
  ENERGY: "ENERGY",
  SOFTWARE: "SOFTWARE",
  HARDWARE: "HARDWARE",
  MARKETING: "MARKETING",
  TRAINING: "TRAINING",
  MAINTENANCE: "MAINTENANCE",
  TAXES: "TAXES",
  UTILITIES: "UTILITIES",
  OTHER: "OTHER",
};

const PAYMENT_METHOD = {
  BANK_TRANSFER: "BANK_TRANSFER",
  CREDIT_CARD: "CREDIT_CARD",
  DIRECT_DEBIT: "DIRECT_DEBIT",
  CHECK: "CHECK",
  CASH: "CASH",
  OTHER: "OTHER",
};

const purchaseInvoiceSchema = new mongoose.Schema(
  {
    supplierName: {
      type: String,
      required: [true, "Le nom du fournisseur est requis"],
      trim: true,
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Supplier",
      default: null,
      index: true,
    },
    invoiceNumber: {
      type: String,
      trim: true,
    },
    issueDate: {
      type: Date,
      required: [true, "La date d'émission est requise"],
      default: Date.now,
    },
    dueDate: {
      type: Date,
    },
    amountHT: {
      type: Number,
      default: 0,
      set: nullToDefault(0),
    },
    amountTVA: {
      type: Number,
      default: 0,
      set: nullToDefault(0),
    },
    vatRate: {
      type: Number,
      default: 20,
      set: nullToDefault(20),
    },
    vatBreakdown: {
      type: [vatLineSchema],
      default: [],
    },
    amountTTC: {
      type: Number,
      required: [true, "Le montant TTC est requis"],
      validate: {
        validator: isPositiveAmount,
        message: "Le montant TTC doit être un nombre positif",
      },
    },
    currency: {
      type: String,
      required: true,
      default: "EUR",
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(PURCHASE_INVOICE_STATUS),
      default: PURCHASE_INVOICE_STATUS.TO_PROCESS,
      index: true,
    },
    category: {
      type: String,
      enum: Object.values(PURCHASE_INVOICE_CATEGORY),
      default: PURCHASE_INVOICE_CATEGORY.OTHER,
    },
    // Sous-catégorie fine (même référentiel que la page Transactions, cf.
    // utils/categoryTaxonomy.js). `category` en est la catégorie large
    // dérivée ; propagée telle quelle aux transactions rapprochées.
    subcategory: { type: String, default: null },
    tags: [
      {
        type: String,
        trim: true,
        maxlength: 30,
      },
    ],
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
    internalReference: {
      type: String,
      trim: true,
      maxlength: 100,
    },
    files: [fileSchema],
    ocrMetadata: {
      type: ocrMetadataSchema,
      default: () => ({}),
    },
    paymentDate: {
      type: Date,
    },
    paymentMethod: {
      type: String,
      enum: Object.values(PAYMENT_METHOD),
    },
    linkedTransactionIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Transaction",
      },
    ],
    isReconciled: {
      type: Boolean,
      default: false,
    },
    source: {
      type: String,
      enum: ["MANUAL", "OCR", "SUPERPDP", "QONTO"],
      default: "MANUAL",
    },
    // Champs e-invoicing (SuperPDP)
    superPdpInvoiceId: {
      type: String,
      index: true,
      sparse: true,
    },
    eInvoiceStatus: {
      type: String,
      enum: [
        "NOT_APPLICABLE",
        "RECEIVED",
        "PENDING_VALIDATION",
        "VALIDATED",
        "ACCEPTED",
        "PARTIALLY_ACCEPTED",
        "DISPUTED",
        "REJECTED",
        "PAID",
        "ERROR",
      ],
      default: "NOT_APPLICABLE",
    },
    eInvoiceReceivedAt: {
      type: Date,
    },
    // Statut du signalement de paiement à SuperPDP (événement fr:211).
    // ERROR → repris par le cron de relance purchaseInvoicePaymentRetryCron.
    eInvoicePaymentReportStatus: {
      type: String,
      enum: ["NOT_APPLICABLE", "REPORTED", "ERROR"],
      default: "NOT_APPLICABLE",
    },
    eInvoiceRawData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    archivedPdfUrl: {
      type: String,
    },
    // === PENNYLANE SYNC ===
    pennylaneId: {
      type: String,
      sparse: true,
      index: true,
    },
    pennylaneSyncStatus: {
      type: String,
      enum: ["NOT_SYNCED", "SYNCED", "ERROR"],
      default: "NOT_SYNCED",
    },

    // === QONTO SYNC ===
    qontoId: {
      type: String,
      sparse: true,
      index: true,
    },
    qontoSyncStatus: {
      type: String,
      enum: ["NOT_SYNCED", "SYNCED", "ERROR"],
      default: "NOT_SYNCED",
    },

    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

purchaseInvoiceSchema.index({ workspaceId: 1, issueDate: -1 });
purchaseInvoiceSchema.index({ workspaceId: 1, status: 1 });
purchaseInvoiceSchema.index({ workspaceId: 1, dueDate: 1 });
purchaseInvoiceSchema.index({ workspaceId: 1, supplierId: 1 });
purchaseInvoiceSchema.index({ workspaceId: 1, category: 1 });
purchaseInvoiceSchema.index({ supplierName: "text", invoiceNumber: "text" });
purchaseInvoiceSchema.index(
  { workspaceId: 1, superPdpInvoiceId: 1 },
  { sparse: true },
);

// Taux cohérent avec la TVA, quel que soit le chemin d'enregistrement
// (justificatif, formulaire, app mobile, imports, facture électronique) :
// une TVA nulle est à 0 % (plus de « TVA 0 € à 20 % » laissées par le taux
// par défaut), une TVA positive sans taux prend celui des montants. Un détail
// par taux (au moins deux lignes) porte son propre résumé ; un avoir (TVA
// négative) n'est pas touché.
purchaseInvoiceSchema.pre("validate", function alignVatRateWithAmount() {
  if ((this.vatBreakdown?.length || 0) >= 2) return;
  const tva = Number(this.amountTVA) || 0;
  if (tva === 0) {
    if (this.vatRate !== 0) this.vatRate = 0;
  } else if (tva > 0 && !(this.vatRate > 0)) {
    this.vatRate = deriveVatRate({
      amountHT: this.amountHT,
      amountTVA: tva,
      amountTTC: this.amountTTC,
    });
  }
});

purchaseInvoiceSchema.statics.PURCHASE_INVOICE_STATUS = PURCHASE_INVOICE_STATUS;
purchaseInvoiceSchema.statics.PURCHASE_INVOICE_CATEGORY =
  PURCHASE_INVOICE_CATEGORY;
purchaseInvoiceSchema.statics.PAYMENT_METHOD = PAYMENT_METHOD;

const PurchaseInvoice = mongoose.model(
  "PurchaseInvoice",
  purchaseInvoiceSchema,
);
export default PurchaseInvoice;
