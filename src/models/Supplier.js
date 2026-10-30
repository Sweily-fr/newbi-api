import mongoose from "mongoose";
import addressSchema from "./schemas/address.js";

const supplierSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Le nom du fournisseur est requis"],
      trim: true,
      // Raison sociale complète d'un fournisseur (souvent au-delà de 100
      // caractères), même limite que le nom d'un client entreprise
      validate: {
        validator: function (v) {
          return v && v.length >= 2 && v.length <= 200;
        },
        message: "Le nom doit contenir entre 2 et 200 caractères",
      },
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    siret: {
      type: String,
      trim: true,
    },
    vatNumber: {
      type: String,
      trim: true,
    },
    address: {
      type: addressSchema,
    },
    iban: {
      type: String,
      trim: true,
    },
    bic: {
      type: String,
      trim: true,
    },
    defaultCategory: {
      type: String,
      enum: [
        "RENT",
        "SUBSCRIPTIONS",
        "OFFICE_SUPPLIES",
        "SERVICES",
        "TRANSPORT",
        "MEALS",
        "TELECOMMUNICATIONS",
        "INSURANCE",
        "ENERGY",
        "SOFTWARE",
        "HARDWARE",
        "MARKETING",
        "TRAINING",
        "MAINTENANCE",
        "TAXES",
        "UTILITIES",
        "OTHER",
      ],
      default: "OTHER",
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 1000,
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

supplierSchema.index({ workspaceId: 1, name: 1 });
supplierSchema.index({ workspaceId: 1, siret: 1 });
supplierSchema.index({ name: "text" }, { weights: { name: 10 } });

export default mongoose.model("Supplier", supplierSchema);
