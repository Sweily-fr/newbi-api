import mongoose from "mongoose";
import { isPositiveAmount, URL_REGEX } from "../utils/validators.js";

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
  { _id: true, timestamps: true }
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
  },
  { _id: false }
);

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
    },
    amountTVA: {
      type: Number,
      default: 0,
    },
    vatRate: {
      type: Number,
      default: 20,
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
      enum: ["MANUAL", "OCR", "SUPERPDP"],
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
        "REJECTED",
        "PAID",
        "ERROR",
      ],
      default: "NOT_APPLICABLE",
    },
    eInvoiceReceivedAt: {
      type: Date,
    },
    eInvoiceRawData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    archivedPdfUrl: {
      type: String,
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
  }
);

purchaseInvoiceSchema.index({ workspaceId: 1, issueDate: -1 });
purchaseInvoiceSchema.index({ workspaceId: 1, status: 1 });
purchaseInvoiceSchema.index({ workspaceId: 1, dueDate: 1 });
purchaseInvoiceSchema.index({ workspaceId: 1, supplierId: 1 });
purchaseInvoiceSchema.index({ workspaceId: 1, category: 1 });
purchaseInvoiceSchema.index({ supplierName: "text", invoiceNumber: "text" });
purchaseInvoiceSchema.index({ workspaceId: 1, superPdpInvoiceId: 1 }, { sparse: true });

purchaseInvoiceSchema.statics.PURCHASE_INVOICE_STATUS = PURCHASE_INVOICE_STATUS;
purchaseInvoiceSchema.statics.PURCHASE_INVOICE_CATEGORY = PURCHASE_INVOICE_CATEGORY;
purchaseInvoiceSchema.statics.PAYMENT_METHOD = PAYMENT_METHOD;

const PurchaseInvoice = mongoose.model("PurchaseInvoice", purchaseInvoiceSchema);
export default PurchaseInvoice;
