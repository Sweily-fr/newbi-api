import mongoose from "mongoose";
import { isPositiveAmount, URL_REGEX } from "../utils/validators.js";

// Schéma pour les fichiers (reçus, factures scannées, etc.)
const fileSchema = new mongoose.Schema(
  {
    filename: {
      type: String,
      required: true,
      trim: true,
    },
    originalFilename: {
      type: String,
      required: true,
      trim: true,
    },
    mimetype: {
      type: String,
      required: true,
    },
    path: {
      type: String,
      required: true,
    },
    size: {
      type: Number,
      required: true,
      validate: {
        validator: function (value) {
          return value > 0;
        },
        message: "La taille du fichier doit être supérieure à 0",
      },
    },
    url: {
      type: String,
      required: true,
      validate: {
        validator: function (value) {
          return URL_REGEX.test(value);
        },
        message: "L'URL du fichier n'est pas valide",
      },
    },
    ocrProcessed: {
      type: Boolean,
      default: false,
    },
    ocrData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { _id: true, timestamps: true }
);

// Schéma pour les métadonnées extraites par OCR
const ocrMetadataSchema = new mongoose.Schema(
  {
    vendorName: {
      type: String,
      trim: true,
    },
    vendorAddress: {
      type: String,
      trim: true,
    },
    vendorVatNumber: {
      type: String,
      trim: true,
    },
    invoiceNumber: {
      type: String,
      trim: true,
    },
    invoiceDate: {
      type: Date,
    },
    totalAmount: {
      type: Number,
    },
    vatAmount: {
      type: Number,
    },
    currency: {
      type: String,
      trim: true,
    },
    confidenceScore: {
      type: Number,
      min: 0,
      max: 1,
    },
    rawExtractedText: {
      type: String,
    },
  },
  { _id: false }
);

// Énumération pour les catégories de dépenses
const EXPENSE_CATEGORY = {
  OFFICE_SUPPLIES: "OFFICE_SUPPLIES",
  TRAVEL: "TRAVEL",
  MEALS: "MEALS",
  ACCOMMODATION: "ACCOMMODATION",
  SOFTWARE: "SOFTWARE",
  HARDWARE: "HARDWARE",
  SERVICES: "SERVICES",
  MARKETING: "MARKETING",
  TAXES: "TAXES",
  RENT: "RENT",
  UTILITIES: "UTILITIES",
  SALARIES: "SALARIES",
  INSURANCE: "INSURANCE",
  MAINTENANCE: "MAINTENANCE",
  TRAINING: "TRAINING",
  SUBSCRIPTIONS: "SUBSCRIPTIONS",
  OTHER: "OTHER",
};

// Énumération pour les statuts de dépenses
const EXPENSE_STATUS = {
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  PAID: "PAID",
};

// Énumération pour les méthodes de paiement
const EXPENSE_PAYMENT_METHOD = {
  CREDIT_CARD: "CREDIT_CARD",
  BANK_TRANSFER: "BANK_TRANSFER",
  CASH: "CASH",
  CHECK: "CHECK",
  PAYPAL: "PAYPAL",
  OTHER: "OTHER",
};

/**
 * Schéma principal de dépense
 */
const expenseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: function (value) {
          return value && value.length <= 100;
        },
        message: "Le titre ne doit pas dépasser 100 caractères",
      },
    },
    description: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 1000;
        },
        message: "La description ne doit pas dépasser 1000 caractères",
      },
    },
    amount: {
      type: Number,
      required: true,
      validate: {
        validator: isPositiveAmount,
        message: "Le montant doit être un nombre positif",
      },
    },
    currency: {
      type: String,
      required: true,
      default: "EUR",
      trim: true,
      validate: {
        validator: function (value) {
          return /^[A-Z]{3}$/.test(value);
        },
        message:
          "La devise doit être un code de 3 lettres majuscules (ex: EUR, USD)",
      },
    },
    category: {
      type: String,
      required: true,
      enum: Object.values(EXPENSE_CATEGORY),
      default: EXPENSE_CATEGORY.OTHER,
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    vendor: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 100;
        },
        message: "Le nom du fournisseur ne doit pas dépasser 100 caractères",
      },
    },
    vendorVatNumber: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 30;
        },
        message:
          "Le numéro de TVA du fournisseur ne doit pas dépasser 30 caractères",
      },
    },
    invoiceNumber: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 50;
        },
        message: "Le numéro de facture ne doit pas dépasser 50 caractères",
      },
    },
    documentNumber: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 50;
        },
        message:
          "Le numéro de pièce justificative ne doit pas dépasser 50 caractères",
      },
    },
    accountingAccount: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 20;
        },
        message: "Le compte comptable ne doit pas dépasser 20 caractères",
      },
    },
    vatAmount: {
      type: Number,
      default: 0,
      validate: {
        validator: isPositiveAmount,
        message: "Le montant de TVA doit être un nombre positif",
      },
    },
    vatRate: {
      type: Number,
      default: 0,
      validate: {
        validator: isPositiveAmount,
        message: "Le taux de TVA doit être un nombre positif",
      },
    },
    isVatDeductible: {
      type: Boolean,
      default: true,
    },
    status: {
      type: String,
      enum: Object.values(EXPENSE_STATUS),
      default: EXPENSE_STATUS.DRAFT,
    },
    paymentMethod: {
      type: String,
      enum: Object.values(EXPENSE_PAYMENT_METHOD),
      default: EXPENSE_PAYMENT_METHOD.BANK_TRANSFER,
    },
    paymentDate: {
      type: Date,
    },
    files: [fileSchema],
    ocrMetadata: {
      type: ocrMetadataSchema,
      default: () => ({}),
    },
    notes: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 1000;
        },
        message: "Les notes ne doivent pas dépasser 1000 caractères",
      },
    },
    tags: [
      {
        type: String,
        trim: true,
        validate: {
          validator: function (value) {
            return value && value.length <= 30;
          },
          message: "Un tag ne doit pas dépasser 30 caractères",
        },
      },
    ],
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

// Index pour améliorer les performances des recherches
expenseSchema.index({ createdBy: 1 });
expenseSchema.index({ date: -1 });
expenseSchema.index({ category: 1 });
expenseSchema.index({ status: 1 });
expenseSchema.index({ vendor: "text" });
expenseSchema.index({ tags: 1 });

// Exporter les constantes pour les utiliser dans d'autres fichiers
expenseSchema.statics.EXPENSE_CATEGORY = EXPENSE_CATEGORY;
expenseSchema.statics.EXPENSE_STATUS = EXPENSE_STATUS;
expenseSchema.statics.EXPENSE_PAYMENT_METHOD = EXPENSE_PAYMENT_METHOD;

export default mongoose.model("Expense", expenseSchema);
