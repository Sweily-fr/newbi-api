import mongoose from "mongoose";
import {
  URL_REGEX,
  isValidFooterNotes,
  isValidItemDescription,
  isValidUnit,
  isPositiveAmount,
} from "../utils/validators.js";
import clientSchema from "./schemas/client.js";
import companyInfoSchema from "./schemas/companyInfo.js";
import customFieldSchema from "./schemas/customField.js";
import addressSchema from "./schemas/address.js";
import { DELIVERY_NOTE_STATUS, DISCOUNT_TYPE } from "./constants/enums.js";

/**
 * Ligne d'un bon de livraison.
 *
 * Un bon de livraison atteste la remise de marchandises : il liste des
 * produits et des quantités, jamais de montants. Les champs tarifaires
 * (unitPrice, vatRate, remise) sont conservés ici UNIQUEMENT pour pouvoir
 * réinjecter les prix lors de la génération d'une facture depuis le BL
 * (BL issu d'un devis / d'une facture). Ils ne sont jamais exposés par
 * l'API GraphQL ni rendus dans le PDF.
 *
 * orderedQuantity / deliveredQuantity préparent la v2 « livraison
 * partielle » : en MVP, deliveredQuantity = quantity.
 */
const deliveryNoteItemSchema = new mongoose.Schema({
  description: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: isValidItemDescription,
      message:
        "La description de l'article contient des caractères non autorisés ou dépasse 2000 caractères",
    },
  },
  details: {
    type: String,
    trim: true,
  },
  reference: {
    type: String,
    trim: true,
    validate: {
      validator: (v) => !v || v.length <= 100,
      message: "La référence produit ne doit pas dépasser 100 caractères",
    },
  },
  productId: {
    type: String,
    trim: true,
  },
  quantity: {
    type: Number,
    required: true,
    validate: {
      validator: isPositiveAmount,
      message: "La quantité doit être un nombre positif ou nul",
    },
  },
  orderedQuantity: {
    type: Number,
    validate: {
      validator: (v) => v === undefined || v === null || isPositiveAmount(v),
      message: "La quantité commandée doit être un nombre positif ou nul",
    },
  },
  deliveredQuantity: {
    type: Number,
    validate: {
      validator: (v) => v === undefined || v === null || isPositiveAmount(v),
      message: "La quantité livrée doit être un nombre positif ou nul",
    },
  },
  unit: {
    type: String,
    trim: true,
    default: "",
    validate: {
      validator: isValidUnit,
      message:
        "L'unité contient des caractères non autorisés ou dépasse 20 caractères",
    },
  },
  // Tarification cachée (voir commentaire d'en-tête)
  unitPrice: { type: Number, min: 0 },
  vatRate: { type: Number, min: 0, max: 100 },
  vatExemptionText: { type: String, trim: true },
  discount: { type: Number, min: 0 },
  discountType: {
    type: String,
    enum: [...Object.values(DISCOUNT_TYPE), null],
  },
});

/**
 * Schéma principal de bon de livraison
 */
const deliveryNoteSchema = new mongoose.Schema(
  {
    prefix: {
      type: String,
      default: function () {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        return `BL-${year}${month}`;
      },
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 10;
        },
        message: "Le préfixe ne doit pas dépasser 10 caractères",
      },
    },
    number: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: function (value) {
          return /^[A-Za-z0-9-]{1,20}$/.test(value);
        },
        message:
          "Le numéro de bon de livraison doit contenir uniquement des lettres, chiffres ou tirets (max 20 caractères)",
      },
    },
    issueDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    // Date de livraison prévue ou effective
    deliveryDate: {
      type: Date,
    },
    client: {
      type: clientSchema,
      required: true,
    },
    companyInfo: {
      type: companyInfoSchema,
      required: false,
    },
    items: {
      type: [deliveryNoteItemSchema],
      required: true,
      validate: {
        validator: function (value) {
          return value && value.length > 0;
        },
        message: "Un bon de livraison doit contenir au moins un article",
      },
    },
    status: {
      type: String,
      enum: Object.values(DELIVERY_NOTE_STATUS),
      default: DELIVERY_NOTE_STATUS.DRAFT,
    },

    // === Livraison ===
    // Adresse de livraison (par défaut celle du client, ou son adresse de
    // livraison distincte)
    deliveryAddress: {
      type: addressSchema,
    },
    carrier: {
      type: String,
      trim: true,
      validate: {
        validator: (v) => !v || v.length <= 100,
        message: "Le transporteur ne doit pas dépasser 100 caractères",
      },
    },
    trackingNumber: {
      type: String,
      trim: true,
      validate: {
        validator: (v) => !v || /^[A-Za-z0-9\s\-_/.]{1,100}$/.test(v),
        message:
          "Le numéro de suivi contient des caractères non autorisés ou dépasse 100 caractères",
      },
    },
    notes: {
      type: String,
      trim: true,
      validate: {
        validator: (v) => !v || v.length <= 2000,
        message: "Les notes ne doivent pas dépasser 2000 caractères",
      },
    },

    // === Réception ===
    receivedBy: {
      type: String,
      trim: true,
      validate: {
        validator: (v) => !v || v.length <= 100,
        message: "Le nom du réceptionnaire ne doit pas dépasser 100 caractères",
      },
    },
    receivedAt: {
      type: Date,
    },
    // Signature manuscrite optionnelle (data URL PNG)
    signatureDataUrl: {
      type: String,
      validate: {
        validator: (v) =>
          !v || (/^data:image\/(png|jpeg);base64,/.test(v) && v.length <= 300000),
        message: "La signature doit être une image PNG/JPEG encodée (max 300 Ko)",
      },
    },

    headerNotes: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || value.length <= 1000;
        },
        message: "Les notes d'en-tête ne doivent pas dépasser 1000 caractères",
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
    customFields: [customFieldSchema],

    // === Documents liés ===
    sourceQuote: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Quote",
    },
    sourceInvoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
    },
    // Factures générées depuis ce bon de livraison
    linkedInvoices: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Invoice",
      },
    ],

    // Cache PDF pour les automatisations (copie R2 serveur-à-serveur)
    cachedPdf: {
      key: { type: String },
      url: { type: String },
      generatedAt: { type: Date },
    },
    // Tracking d'ouverture d'email
    emailTracking: {
      emailSentAt: { type: Date },
      emailOpenedAt: { type: Date },
      emailOpenCount: { type: Number, default: 0 },
      emailClickedAt: { type: Date },
      emailClickCount: { type: Number, default: 0 },
      trackingToken: { type: String, index: true },
      resendMessageId: { type: String, index: true },
    },
    // Référence vers l'organisation/workspace (Better Auth)
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
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
    clientPositionRight: {
      type: Boolean,
      default: false,
    },

    // === ARCHIVAGE PDF (Cloudflare R2, bucket privé) ===
    archivedPdfKey: { type: String },
    archivedPdfStoredAt: { type: Date },
    archivedPdfSource: { type: String, enum: ["NEWBI"] },
  },
  {
    timestamps: true,
  },
);

// Index pour améliorer les performances des recherches
deliveryNoteSchema.index({ workspaceId: 1, createdAt: -1 });
deliveryNoteSchema.index({ workspaceId: 1, "client.name": 1 });
deliveryNoteSchema.index({ workspaceId: 1, status: 1 });
deliveryNoteSchema.index({ workspaceId: 1, deliveryDate: -1 });
deliveryNoteSchema.index({ workspaceId: 1, sourceQuote: 1 });
deliveryNoteSchema.index({ workspaceId: 1, sourceInvoice: 1 });
deliveryNoteSchema.index({ createdBy: 1 });

/**
 * Pas de calcul de totaux : un BL ne porte aucun montant.
 * On aligne seulement les quantités (v2 livraison partielle) : en MVP la
 * quantité livrée vaut la quantité de la ligne.
 */
deliveryNoteSchema.pre("save", function (next) {
  if (this.items && this.items.length > 0) {
    this.items.forEach((item) => {
      if (item.orderedQuantity === undefined || item.orderedQuantity === null) {
        item.orderedQuantity = item.quantity;
      }
      if (
        item.deliveredQuantity === undefined ||
        item.deliveredQuantity === null
      ) {
        item.deliveredQuantity = item.quantity;
      }
    });
  }
  next();
});

// Middleware pre-save pour définir l'année d'émission
deliveryNoteSchema.pre("save", function (next) {
  if (this.issueDate) {
    this.issueYear = this.issueDate.getFullYear();
  } else {
    this.issueYear = new Date().getFullYear();
  }
  next();
});

// Ajout du champ issueYear au schéma pour l'index
deliveryNoteSchema.add({
  issueYear: {
    type: Number,
    default: function () {
      return this.issueDate
        ? this.issueDate.getFullYear()
        : new Date().getFullYear();
    },
    index: true,
  },
});

// Index composé pour garantir l'unicité des numéros par préfixe, année et organisation
deliveryNoteSchema.index(
  {
    prefix: 1,
    number: 1,
    workspaceId: 1,
    issueYear: 1,
  },
  {
    unique: true,
    partialFilterExpression: { number: { $exists: true } },
    name: "dn_prefix_number_workspaceId_year_unique",
  },
);

// Méthode statique pour vérifier si un numéro existe déjà
deliveryNoteSchema.statics.numberExistsForYear = async function (
  number,
  workspaceId,
  year,
) {
  const count = await this.countDocuments({
    number,
    workspaceId,
    issueYear: year,
  });

  return count > 0;
};

export default mongoose.model("DeliveryNote", deliveryNoteSchema);
