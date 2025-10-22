import mongoose from 'mongoose';
import {
  URL_REGEX,
  isPositiveAmount,
  isValidFooterNotes,
} from '../utils/validators.js';

import clientSchema from './schemas/client.js';
import creditNoteItemSchema from './schemas/creditNoteItem.js';
import companyInfoSchema from './schemas/companyInfo.js';
import customFieldSchema from './schemas/customField.js';
import bankDetailsSchema from './schemas/bankDetails.js';
import shippingSchema from './schemas/shipping.js';
import {
  CREDIT_NOTE_STATUS,
  DISCOUNT_TYPE,
} from './constants/enums.js';

/**
 * Schéma principal d'avoir (credit note)
 */
const creditNoteSchema = new mongoose.Schema(
  {
    prefix: {
      type: String,
      default: function () {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        return `AV-${year}${month}-`;
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
      required: true, // Le numéro est toujours obligatoire pour les avoirs
      trim: true,
      validate: {
        validator: function (value) {
          return /^[A-Za-z0-9-]{1,50}$/.test(value);
        },
        message:
          "Le numéro d'avoir doit contenir uniquement des lettres, chiffres ou tirets (max 50 caractères)",
      },
    },
    // Référence obligatoire vers la facture originale
    originalInvoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      required: true,
      index: true,
    },
    // Numéro de la facture originale (pour affichage et référence)
    originalInvoiceNumber: {
      type: String,
      required: true,
      trim: true,
    },
    // Type d'avoir
    creditType: {
      type: String,
      enum: ["CORRECTION", "COMMERCIAL_GESTURE", "REFUND", "STOCK_SHORTAGE"],
      required: true,
    },
    // Raison de l'avoir (texte libre) - optionnel
    reason: {
      type: String,
      required: false,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 500;
        },
        message: "La raison ne doit pas dépasser 500 caractères",
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
          return !value || value instanceof Date;
        },
        message: "La date d'exécution doit être une date valide",
      },
    },
    // Les articles de l'avoir (peuvent être différents de la facture originale)
    items: {
      type: [creditNoteItemSchema],
      required: true,
      validate: {
        validator: function (value) {
          return value && value.length > 0;
        },
        message: "Un avoir doit contenir au moins un article",
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
      enum: Object.values(CREDIT_NOTE_STATUS),
      default: CREDIT_NOTE_STATUS.CREATED,
    },
    // Mode de remboursement
    refundMethod: {
      type: String,
      enum: ["NEXT_INVOICE", "BANK_TRANSFER", "CHECK", "VOUCHER", "CASH"],
      default: "NEXT_INVOICE",
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
    // Auto-liquidation de TVA (reverse charge) - copié depuis la facture originale
    isReverseCharge: {
      type: Boolean,
      default: false,
    },
    // Montants de l'avoir (toujours négatifs pour représenter un crédit)
    totalHT: {
      type: Number,
      max: 0, // Négatif car c'est un avoir
      validate: {
        validator: function (value) {
          return value <= 0; // Doit être négatif ou zéro
        },
        message: "Le montant HT d'un avoir doit être négatif ou nul",
      },
    },
    totalTTC: {
      type: Number,
      max: 0, // Négatif car c'est un avoir
      validate: {
        validator: function (value) {
          return value <= 0; // Doit être négatif ou zéro
        },
        message: "Le montant TTC d'un avoir doit être négatif ou nul",
      },
    },
    totalVAT: {
      type: Number,
      max: 0, // Négatif car c'est un avoir
      validate: {
        validator: function (value) {
          return value <= 0; // Doit être négatif ou zéro
        },
        message: "Le montant de TVA d'un avoir doit être négatif ou nul",
      },
    },
    finalTotalHT: {
      type: Number,
      max: 0, // Négatif car c'est un avoir
      validate: {
        validator: function (value) {
          return value <= 0; // Doit être négatif ou zéro
        },
        message: "Le montant final HT d'un avoir doit être négatif ou nul",
      },
    },
    finalTotalVAT: {
      type: Number,
      max: 0, // Négatif car c'est un avoir
      validate: {
        validator: function (value) {
          return value <= 0; // Doit être négatif ou zéro
        },
        message: "Le montant final de TVA d'un avoir doit être négatif ou nul",
      },
    },
    finalTotalTTC: {
      type: Number,
      max: 0, // Négatif car c'est un avoir
      validate: {
        validator: function (value) {
          return value <= 0; // Doit être négatif ou zéro
        },
        message: "Le montant final TTC d'un avoir doit être négatif ou nul",
      },
    },
    // Référence vers l'organisation/workspace (Better Auth)
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    // Utilisateur qui a créé l'avoir (pour audit trail)
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Informations de livraison (copiées depuis la facture originale)
    shipping: {
      type: shippingSchema,
      required: false,
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
creditNoteSchema.index({ workspaceId: 1, createdAt: -1 });
creditNoteSchema.index({ workspaceId: 1, status: 1 });
creditNoteSchema.index({ workspaceId: 1, "client.name": 1 });
creditNoteSchema.index({ workspaceId: 1, originalInvoice: 1 });
creditNoteSchema.index({ createdBy: 1 });
creditNoteSchema.index({ issueDate: -1 });

// Ajout d'un champ virtuel pour l'année d'émission
creditNoteSchema.virtual('issueYear').get(function() {
  return this.issueDate ? this.issueDate.getFullYear() : new Date().getFullYear();
});

// Middleware pre-save pour définir l'année d'émission
creditNoteSchema.pre('save', function(next) {
  if (this.issueDate) {
    this.issueYear = this.issueDate.getFullYear();
  } else {
    this.issueYear = new Date().getFullYear();
  }
  next();
});

// Ajout du champ issueYear au schéma pour l'index
creditNoteSchema.add({
  issueYear: {
    type: Number,
    default: function() {
      return this.issueDate ? this.issueDate.getFullYear() : new Date().getFullYear();
    },
    index: true
  }
});

// Index composé pour garantir l'unicité des numéros d'avoir par année et organisation
creditNoteSchema.index(
  {
    number: 1,
    workspaceId: 1,
    issueYear: 1
  },
  {
    unique: true,
    partialFilterExpression: { number: { $exists: true } },
    name: "creditnote_number_workspaceId_year_unique",
  }
);

// Méthode statique pour vérifier si un numéro existe déjà pour une année donnée dans une organisation
creditNoteSchema.statics.numberExistsForYear = async function (
  number,
  workspaceId,
  year
) {
  const count = await this.countDocuments({
    number,
    workspaceId,
    issueYear: year,
  });

  return count > 0;
};

// Méthode pour obtenir les avoirs liés à une facture
creditNoteSchema.statics.findByInvoice = async function (invoiceId) {
  return this.find({ originalInvoice: invoiceId }).sort({ createdAt: -1 });
};

export default mongoose.model("CreditNote", creditNoteSchema);
