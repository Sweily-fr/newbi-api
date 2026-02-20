import mongoose from "mongoose";

/**
 * Schéma pour les segments dynamiques de clients
 * Les segments sont des filtres automatiques qui regroupent les clients selon des critères définis
 */
const segmentRuleSchema = new mongoose.Schema(
  {
    field: {
      type: String,
      required: [true, "Le champ est requis"],
      enum: [
        "type",
        "email",
        "name",
        "address.city",
        "address.country",
        "address.postalCode",
        "isBlocked",
        "isInternational",
        "createdAt",
        "updatedAt",
      ],
    },
    operator: {
      type: String,
      required: [true, "L'opérateur est requis"],
      enum: [
        "equals",
        "not_equals",
        "contains",
        "not_contains",
        "starts_with",
        "ends_with",
        "greater_than",
        "less_than",
        "is_true",
        "is_false",
        "is_empty",
        "is_not_empty",
        "before",
        "after",
        "in_last_days",
      ],
    },
    value: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { _id: false }
);

const clientSegmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Le nom du segment est requis"],
      trim: true,
      minlength: [2, "Le nom doit contenir au moins 2 caractères"],
      maxlength: [100, "Le nom ne peut pas dépasser 100 caractères"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, "La description ne peut pas dépasser 500 caractères"],
      default: "",
    },
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "Organization",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    // Opérateur logique entre les règles
    matchType: {
      type: String,
      enum: ["all", "any"],
      default: "all",
    },
    // Les règles de filtrage dynamiques
    rules: [segmentRuleSchema],
    // Couleur pour l'affichage
    color: {
      type: String,
      default: "#8b5cf6",
      validate: {
        validator: function (v) {
          return /^#[0-9A-F]{6}$/i.test(v);
        },
        message: "La couleur doit être au format hexadécimal (#RRGGBB)",
      },
    },
    icon: {
      type: String,
      default: "Filter",
    },
  },
  {
    timestamps: true,
  }
);

clientSegmentSchema.index({ workspaceId: 1 });
clientSegmentSchema.index({ createdBy: 1 });
clientSegmentSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

export default mongoose.model("ClientSegment", clientSegmentSchema);
