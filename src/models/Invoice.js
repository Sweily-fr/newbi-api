import mongoose from "mongoose";
import {
  isDateAfter,
  URL_REGEX,
  isPositiveAmount,
  isValidFooterNotes,
} from "../utils/validators.js";

import clientSchema from "./schemas/client.js";
import itemSchema from "./schemas/item.js";
import companyInfoSchema from "./schemas/companyInfo.js";
import customFieldSchema from "./schemas/customField.js";
import bankDetailsSchema from "./schemas/bankDetails.js";
import {
  INVOICE_STATUS,
  PAYMENT_METHOD,
  DISCOUNT_TYPE,
} from "./constants/enums.js";

/**
 * Schéma principal de facture
 */
const invoiceSchema = new mongoose.Schema(
  {
    prefix: {
      type: String,
      default: function () {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        return `F-${year}${month}-`;
      },
      trim: true,
      validate: {
        validator: function (value) {
          return value && value.length <= 10;
        },
        message: "Le préfixe ne doit pas dépasser 10 caractères",
      },
    },
    number: {
      type: String,
      required: function () {
        return this.status !== "DRAFT"; // Le numéro est obligatoire sauf pour les brouillons
      },
      // L'unicité est maintenant gérée par un index composé avec l'année d'émission
      sparse: true, // Permet d'avoir plusieurs documents sans numéro
      trim: true,
      validate: {
        validator: function (value) {
          if (!value && this.status === "DRAFT") return true; // Valide si pas de numéro pour un brouillon
          return /^[A-Za-z0-9-]{1,50}$/.test(value);
        },
        message:
          "Le numéro de facture doit contenir uniquement des lettres, chiffres ou tirets (max 50 caractères)",
      },
    },
    issueDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    executionDate: {
      type: Date,
      validate: {
        validator: function (value) {
          // La date d'exécution n'est pas obligatoire, mais si elle est fournie,
          // elle doit être valide
          return !value || value instanceof Date;
        },
        message: "La date d'exécution doit être une date valide",
      },
    },
    dueDate: {
      type: Date,
      validate: {
        validator: function (value) {
          return !this.issueDate || isDateAfter(this.issueDate, value);
        },
        message:
          "La date d'échéance doit être postérieure ou égale à la date d'émission",
      },
    },
    isDeposit: {
      type: Boolean,
      default: false,
    },
    depositAmount: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: isPositiveAmount,
        message: "Le montant de l'acompte doit être un nombre positif",
      },
    },
    items: {
      type: [itemSchema],
      required: true,
      validate: {
        validator: function (value) {
          return value && value.length > 0;
        },
        message: "Une facture doit contenir au moins un article",
      },
    },
    companyInfo: {
      type: companyInfoSchema,
      required: true,
    },
    client: {
      type: clientSchema,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(INVOICE_STATUS),
      default: INVOICE_STATUS.DRAFT,
    },
    paymentMethod: {
      type: String,
      enum: Object.values(PAYMENT_METHOD),
      default: PAYMENT_METHOD.BANK_TRANSFER,
    },
    paymentDate: {
      type: Date,
    },
    headerNotes: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 1000;
        },
        message: "Les notes ne doivent pas dépasser 1000 caractères",
      },
    },
    footerNotes: {
      type: String,
      trim: true,
      validate: {
        validator: isValidFooterNotes,
        message:
          "Les notes de bas de page ne doivent pas dépasser 2000 caractères ou contiennent des caractères non autorisés",
      },
    },
    termsAndConditions: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 2000;
        },
        message:
          "Les conditions générales ne doivent pas dépasser 2000 caractères",
      },
    },
    termsAndConditionsLinkTitle: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 100;
        },
        message:
          "Le titre du lien des conditions générales ne doit pas dépasser 100 caractères",
      },
    },
    termsAndConditionsLink: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          if (!value) return true;
          return URL_REGEX.test(value);
        },
        message:
          "Veuillez fournir une URL valide pour le lien des conditions générales",
      },
    },
    purchaseOrderNumber: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || /^[A-Za-z0-9-/]{1,50}$/.test(value);
        },
        message:
          "Le numéro de bon de commande doit contenir uniquement des lettres, chiffres, tirets ou slashs (max 50 caractères)",
      },
    },
    discount: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: isPositiveAmount,
        message: "La remise doit être un nombre positif",
      },
    },
    discountType: {
      type: String,
      enum: Object.values(DISCOUNT_TYPE),
      default: DISCOUNT_TYPE.FIXED,
    },
    customFields: [customFieldSchema],
    showBankDetails: {
      type: Boolean,
      default: false,
    },
    bankDetails: {
      type: bankDetailsSchema,
      required: function () {
        return this.showBankDetails;
      },
    },
    totalHT: {
      type: Number,
      min: 0,
      validate: {
        validator: isPositiveAmount,
        message: "Le montant HT doit être un nombre positif",
      },
    },
    totalTTC: {
      type: Number,
      min: 0,
      validate: {
        validator: isPositiveAmount,
        message: "Le montant TTC doit être un nombre positif",
      },
    },
    totalVAT: {
      type: Number,
      min: 0,
      validate: {
        validator: isPositiveAmount,
        message: "Le montant de TVA doit être un nombre positif",
      },
    },
    finalTotalHT: {
      type: Number,
      min: 0,
      validate: {
        validator: isPositiveAmount,
        message: "Le montant final HT doit être un nombre positif",
      },
    },
    finalTotalTTC: {
      type: Number,
      min: 0,
      validate: {
        validator: isPositiveAmount,
        message: "Le montant final TTC doit être un nombre positif",
      },
    },
    // Référence vers l'organisation/workspace (Better Auth)
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization", // Référence vers la collection Better Auth
      required: true,
      index: true
    },
    // Utilisateur qui a créé la facture (pour audit trail)
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    stripeInvoiceId: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    sourceQuote: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Quote",
    },
    appearance: {
      textColor: {
        type: String,
        default: "#000000",
        trim: true,
      },
      headerTextColor: {
        type: String,
        default: "#ffffff",
        trim: true,
      },
      headerBgColor: {
        type: String,
        default: "#1d1d1b",
        trim: true,
      },
    },
  },
  {
    timestamps: true,
  }
);

// Index pour améliorer les performances des recherches
// Index composés workspace + autres champs pour les requêtes fréquentes
invoiceSchema.index({ workspaceId: 1, createdAt: -1 });
invoiceSchema.index({ workspaceId: 1, status: 1 });
invoiceSchema.index({ workspaceId: 1, "client.name": 1 });
invoiceSchema.index({ workspaceId: 1, dueDate: 1 });
// Index legacy pour la migration et audit trail
invoiceSchema.index({ createdBy: 1 });
invoiceSchema.index({ issueDate: -1 });

// Création d'un index composé pour garantir l'unicité des numéros de facture par année
// Cela permet de réutiliser les numéros d'une année à l'autre
invoiceSchema.index(
  {
    number: 1,
    createdBy: 1,
    // Utilisation de l'opérateur $year pour extraire l'année de la date d'émission
    // Cela permet d'avoir un numéro unique par année pour chaque utilisateur
  },
  {
    unique: true,
    partialFilterExpression: { number: { $exists: true } }, // Ignorer les documents sans numéro
    name: "number_createdBy_year_unique",
  }
);

// Ajout d'une méthode statique pour vérifier si un numéro existe déjà pour une année donnée
invoiceSchema.statics.numberExistsForYear = async function (
  number,
  userId,
  year
) {
  const startDate = new Date(year, 0, 1); // 1er janvier de l'année
  const endDate = new Date(year, 11, 31, 23, 59, 59); // 31 décembre de l'année

  const count = await this.countDocuments({
    number,
    createdBy: userId,
    issueDate: { $gte: startDate, $lte: endDate },
  });

  return count > 0;
};

export default mongoose.model("Invoice", invoiceSchema);
