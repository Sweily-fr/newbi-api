import mongoose from "mongoose";
import addressSchema from "./schemas/address.js";
import {
  EMAIL_REGEX,
  PHONE_REGEX,
  SIRET_REGEX,
  VAT_EU_REGEX,
  NAME_REGEX,
  isValidEmail,
  isValidName,
  isValidSIRET,
  isValidVATNumberEU,
} from "../utils/validators.js";

/**
 * Schéma principal du client
 */
const clientSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Le nom est requis"],
      trim: true,
      validate: {
        validator: function (v) {
          if (this.type === "COMPANY") {
            return (
              v &&
              v.length >= 2 &&
              v.length <= 100 &&
              /^[a-zA-ZÀ-ÿ0-9\s&'"\-.,()]{2,100}$/.test(v)
            );
          } else {
            return (
              v &&
              v.length >= 2 &&
              v.length <= 50 &&
              /^[a-zA-ZÀ-ÿ\s'-]{2,50}$/.test(v)
            );
          }
        },
        message: function (props) {
          if (this.type === "COMPANY") {
            return "Le nom de l'entreprise doit contenir entre 2 et 100 caractères";
          } else {
            return "Le nom doit contenir entre 2 et 50 caractères (lettres, espaces, apostrophes et tirets uniquement)";
          }
        },
      },
    },
    email: {
      type: String,
      required: [true, "L'email est requis"],
      trim: true,
      lowercase: true,
      validate: {
        validator: isValidEmail,
        message: "Veuillez fournir une adresse email valide",
      },
    },
    phone: {
      type: String,
      trim: true,
      validate: {
        validator: function (v) {
          return !v || PHONE_REGEX.test(v);
        },
        message: "Veuillez fournir un numéro de téléphone valide",
      },
    },
    address: {
      type: addressSchema,
      required: true,
    },
    // Indique si l'adresse de livraison est différente de l'adresse de facturation
    hasDifferentShippingAddress: {
      type: Boolean,
      default: false,
    },
    // Adresse de livraison (obligatoire si hasDifferentShippingAddress est true)
    shippingAddress: {
      type: addressSchema,
      // Validation conditionnelle: obligatoire uniquement si hasDifferentShippingAddress est true
      validate: {
        validator: function (v) {
          // Si hasDifferentShippingAddress est true, shippingAddress doit être défini
          return (
            !this.hasDifferentShippingAddress ||
            (v && Object.keys(v).length > 0)
          );
        },
        message:
          "L'adresse de livraison est requise lorsque l'option \"Adresse de livraison différente\" est activée",
      },
    },
    // Type de client: 'INDIVIDUAL' (particulier) ou 'COMPANY' (entreprise)
    type: {
      type: String,
      enum: ["INDIVIDUAL", "COMPANY"],
      default: "COMPANY",
      required: true,
    },
    // Champs spécifiques pour les entreprises
    siret: {
      type: String,
      trim: true,
      validate: {
        validator: function (v) {
          // Pour les entreprises internationales, pas de validation stricte du format
          if (this.isInternational) return true;
          return !v || isValidSIRET(v);
        },
        message: "Le SIREN doit contenir 9 chiffres ou le SIRET 14 chiffres",
      },
    },
    vatNumber: {
      type: String,
      trim: true,
      validate: {
        validator: function (v) {
          // Pour les entreprises internationales, pas de validation stricte
          if (this.isInternational) return true;
          return !v || isValidVATNumberEU(v);
        },
        message: "Format de TVA invalide (ex: FR12345678901)",
      },
    },
    // Indique si l'entreprise est hors France (pas de validation SIRET/TVA stricte)
    isInternational: {
      type: Boolean,
      default: false,
    },
    // Pour les particuliers et entreprises (contact)
    firstName: {
      type: String,
      trim: true,
      validate: {
        validator: function (v) {
          return (
            !v ||
            (v.length >= 2 &&
              v.length <= 50 &&
              /^[a-zA-ZÀ-ÿ\s'-]{2,50}$/.test(v))
          );
        },
        message: function (props) {
          if (this.type === "INDIVIDUAL") {
            return "Le prénom doit contenir entre 2 et 50 caractères (lettres, espaces, apostrophes et tirets uniquement)";
          } else {
            return "Le nom du contact doit contenir entre 2 et 50 caractères (lettres, espaces, apostrophes et tirets uniquement)";
          }
        },
      },
    },
    lastName: {
      type: String,
      trim: true,
      validate: {
        validator: function (v) {
          return (
            !v ||
            (v.length >= 2 &&
              v.length <= 50 &&
              /^[a-zA-ZÀ-ÿ\s'-]{2,50}$/.test(v))
          );
        },
        message:
          "Le nom de famille doit contenir entre 2 et 50 caractères (lettres, espaces, apostrophes et tirets uniquement)",
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    // Notes ajoutées au client (comme les commentaires dans les tâches kanban)
    notes: [
      {
        id: {
          type: String,
          required: true,
          default: () => new mongoose.Types.ObjectId().toString(),
        },
        content: {
          type: String,
          required: true,
          trim: true,
        },
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        userName: String,
        userImage: String,
        createdAt: {
          type: Date,
          default: Date.now,
        },
        updatedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Historique d'activité du client
    activity: [
      {
        id: {
          type: String,
          required: true,
          default: () => new mongoose.Types.ObjectId().toString(),
        },
        type: {
          type: String,
          enum: [
            "created",
            "updated",
            "invoice_created",
            "invoice_status_changed",
            "quote_created",
            "quote_status_changed",
            "credit_note_created",
            "note_added",
            "note_updated",
            "note_deleted",
          ],
          required: true,
        },
        description: String,
        field: String,
        oldValue: mongoose.Schema.Types.Mixed,
        newValue: mongoose.Schema.Types.Mixed,
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        userName: String,
        userImage: String,
        metadata: {
          documentType: String, // 'invoice', 'quote' ou 'creditNote'
          documentId: String,
          documentNumber: String,
          status: String,
          originalInvoiceNumber: String, // Pour les avoirs
        },
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Index pour améliorer les performances des recherches
clientSchema.index({ createdBy: 1 });
clientSchema.index({ workspaceId: 1 });
clientSchema.index({ email: 1, workspaceId: 1 }, { unique: true });
clientSchema.index({ name: "text" }, { weights: { name: 10 } });

export default mongoose.model("Client", clientSchema);
