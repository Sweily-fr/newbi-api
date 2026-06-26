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
import shippingSchema from "./schemas/shipping.js";
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
        return `F-${year}${month}`;
      },
      trim: true,
      validate: {
        validator: function (value) {
          // Un préfixe vide est autorisé : les documents importés conservent
          // leur référence d'origine (dans `number`) sans préfixe.
          return !value || value.length <= 10;
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
    invoiceType: {
      type: String,
      enum: ["standard", "deposit", "situation"],
      default: "standard",
    },
    situationNumber: {
      type: Number,
      min: 1,
      default: 1,
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
      required: false,
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
    situationReference: {
      type: String,
      trim: true,
      validate: {
        validator: function (value) {
          return !value || /^[A-Za-z0-9-_\s]{1,100}$/.test(value);
        },
        message:
          "La référence de situation doit contenir uniquement des lettres, chiffres, tirets, underscores ou espaces (max 100 caractères)",
      },
    },
    contractTotal: {
      type: Number,
      min: 0,
      default: 0,
      validate: {
        validator: isPositiveAmount,
        message: "Le montant total du contrat doit être un nombre positif",
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
    finalTotalVAT: {
      type: Number,
      min: 0,
      validate: {
        validator: isPositiveAmount,
        message: "Le montant final de TVA doit être un nombre positif",
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
      ref: "Organization", // Référence vers la collection Better Auth
      required: true,
      index: true,
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
    // Paiement en ligne via Stripe Connect (encaissement sur le compte du vendeur)
    stripePaymentIntentId: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    stripeCheckoutSessionId: {
      type: String,
      trim: true,
      sparse: true,
    },
    // "paid" une fois l'encaissement confirmé par webhook (idempotence)
    stripePaymentStatus: {
      type: String,
      trim: true,
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
    // Informations de livraison
    shipping: {
      type: shippingSchema,
      default: () => ({
        billShipping: false,
        shippingAmountHT: 0,
        shippingVatRate: 20,
      }),
    },
    // Auto-liquidation de TVA (reverse charge)
    isReverseCharge: {
      type: Boolean,
      default: false,
    },
    // Position du client dans le PDF (false = centre, true = droite)
    clientPositionRight: {
      type: Boolean,
      default: false,
    },
    // Retenue de garantie (en pourcentage)
    retenueGarantie: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    // Escompte (en pourcentage)
    escompte: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    // Nature de l'opération (réforme facturation électronique 2026)
    operationType: {
      type: String,
      enum: ["LB", "PS", "LBPS"],
      default: null,
    },

    // Rapprochement avec transaction bancaire
    linkedTransactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
      index: true,
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

    // === E-INVOICING SUPERPDP ===

    // ID de la facture chez SuperPDP
    superPdpInvoiceId: {
      type: String,
      sparse: true,
      index: true,
    },

    // Statut e-invoicing (statut d'AFFICHAGE dérivé du dernier événement SuperPDP).
    // L'enum est un SURENSEMBLE : on conserve les 9 valeurs historiques (compat prod)
    // et on ajoute les valeurs correspondant aux statuts officiels fr:* (cycle de vie DGFiP).
    eInvoiceStatus: {
      type: String,
      enum: [
        "NOT_SENT", // Pas encore envoyée à SuperPDP
        "PENDING_VALIDATION", // En cours de validation chez SuperPDP (api:uploaded / fr:200)
        "VALIDATED", // Validée par SuperPDP (api:validated)
        "SENT_TO_RECIPIENT", // Émise / transmise (api:sent / fr:201)
        "RECEIVED", // Reçue / mise à disposition (api:received / fr:202-204)
        "ACCEPTED", // Approuvée / complétée (api:accepted / fr:205 / fr:209)
        "PARTIALLY_ACCEPTED", // Approuvée partiellement (fr:206)
        "DISPUTED", // Litige / contestée (fr:207)
        "ON_HOLD", // Suspendue (fr:208)
        "REFUSED", // Refusée (fr:210)
        "PAYMENT_SENT", // Paiement transmis (fr:211)
        "REJECTED", // Rejetée (api:rejected / fr:213)
        "PAID", // Paiement reçu (fr:212)
        "ERROR", // Erreur / irrecevable (api:invalid / fr:501)
      ],
      default: "NOT_SENT",
    },

    // Historique BRUT des événements SuperPDP (fidélité totale au modèle "array of statuses").
    // SuperPDP n'est pas une state machine : on conserve tous les codes api:* / fr:* / ppf:*.
    eInvoiceEvents: [
      {
        code: { type: String }, // ex. "fr:205", "api:sent", "ppf:validated"
        label: { type: String }, // libellé lisible (status_text SuperPDP)
        occurredAt: { type: Date },
      },
    ],

    // Dernier code brut SuperPDP (ex. "fr:205") — source du statut d'affichage dérivé
    eInvoiceLastCode: {
      type: String,
    },

    // Date d'envoi à SuperPDP
    eInvoiceSentAt: {
      type: Date,
    },

    // URL du PDF Factur-X archivé (Cloudflare R2 ou SuperPDP)
    archivedPdfUrl: {
      type: String,
    },

    // Clé de l'objet PDF Factur-X sur Cloudflare R2 (bucket privé).
    // On sert le document via une URL signée générée à la demande.
    archivedPdfKey: {
      type: String,
    },

    // Date d'archivage du PDF Factur-X
    archivedPdfStoredAt: {
      type: Date,
    },

    // Origine du PDF archivé : "NEWBI" (généré par Newbi) ou "SUPERPDP" (copie de secours)
    archivedPdfSource: {
      type: String,
      enum: ["NEWBI", "SUPERPDP"],
    },

    // Erreur e-invoicing (si applicable)
    eInvoiceError: {
      type: String,
    },

    // Données XML Factur-X (pour référence)
    facturXData: {
      xmlGenerated: { type: Boolean, default: false },
      profile: { type: String, default: "EN16931" }, // Profil Factur-X utilisé
      generatedAt: { type: Date },
    },

    // === ROUTING E-INVOICING / E-REPORTING ===

    // Type de flux déterminé par le routage
    eInvoiceFlowType: {
      type: String,
      enum: [
        "E_INVOICING",
        "E_REPORTING_TRANSACTION",
        "E_REPORTING_PAYMENT",
        "NONE",
      ],
      default: "NONE",
    },

    // Raison du routage (explication française)
    eInvoiceFlowReason: String,

    // Détails du routage (pour debug/affichage)
    eInvoiceRoutingDetails: {
      isB2B: Boolean,
      sellerInFrance: Boolean,
      clientInFrance: Boolean,
      sellerVatRegistered: Boolean,
      clientVatRegistered: Boolean,
      obligationActive: Boolean,
      companySize: String,
      evaluatedAt: Date,
    },

    // === E-REPORTING (B2C / international / paiements) ===

    // Statut e-reporting transaction (déclaration des données de transaction au PPF)
    eReportingStatus: {
      type: String,
      enum: ["NOT_REPORTED", "PENDING_REPORT", "REPORTED", "ERROR"],
      default: "NOT_REPORTED",
    },

    // Statut e-reporting paiement (TVA sur encaissements)
    eReportingPaymentStatus: {
      type: String,
      enum: ["NOT_APPLICABLE", "PENDING_REPORT", "REPORTED", "ERROR"],
      default: "NOT_APPLICABLE",
    },

    // Date du paiement déclaré en e-reporting
    eReportingPaymentDate: { type: Date },

    // Identifiants SuperPDP des enregistrements e-reporting
    eReportingTransactionId: { type: String },
    eReportingPaymentId: { type: String },

    // Erreur e-reporting (si applicable)
    eReportingError: { type: String },
  },
  {
    timestamps: true,
  },
);

// Index pour améliorer les performances des recherches
// Index composés workspace + autres champs pour les requêtes fréquentes
invoiceSchema.index({ workspaceId: 1, createdAt: -1 });
invoiceSchema.index({ workspaceId: 1, status: 1 });
invoiceSchema.index({ workspaceId: 1, "client.name": 1 });
invoiceSchema.index({ workspaceId: 1, dueDate: 1 });
// Index pour le routage e-invoicing
invoiceSchema.index({ workspaceId: 1, eInvoiceFlowType: 1 });
// Index legacy pour la migration et audit trail
invoiceSchema.index({ createdBy: 1 });
invoiceSchema.index({ issueDate: -1 });
invoiceSchema.index({ workspaceId: 1, issueDate: -1 });
// Index pour les factures de situation (situationInvoicedTotal dans quote resolver)
invoiceSchema.index({ workspaceId: 1, invoiceType: 1, purchaseOrderNumber: 1 });

// Ajout d'un champ virtuel pour l'année d'émission
invoiceSchema.virtual("issueYear").get(function () {
  return this.issueDate
    ? this.issueDate.getFullYear()
    : new Date().getFullYear();
});

// Middleware pre-save pour définir l'année d'émission
invoiceSchema.pre("save", function (next) {
  if (this.issueDate) {
    this.issueYear = this.issueDate.getFullYear();
  } else {
    this.issueYear = new Date().getFullYear();
  }
  next();
});

// Ajout du champ issueYear au schéma pour l'index
invoiceSchema.add({
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

// Création d'un index composé pour garantir l'unicité des numéros de facture par préfixe, année et organisation
// Cela permet de réutiliser les numéros d'une année à l'autre, d'avoir les mêmes numéros dans différentes organisations
// et d'avoir les mêmes numéros avec des préfixes différents
invoiceSchema.index(
  {
    prefix: 1,
    number: 1,
    workspaceId: 1,
    issueYear: 1,
  },
  {
    unique: true,
    partialFilterExpression: { number: { $exists: true } }, // Ignorer les documents sans numéro
    name: "prefix_number_workspaceId_year_unique",
  },
);

// Ajout d'une méthode statique pour vérifier si un numéro existe déjà pour une année donnée dans une organisation
invoiceSchema.statics.numberExistsForYear = async function (
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

export default mongoose.models.Invoice ||
  mongoose.model("Invoice", invoiceSchema);
