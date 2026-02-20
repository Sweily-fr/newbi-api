import mongoose from "mongoose";

const SOURCES = [
  "Recherche Google",
  "Réseaux sociaux",
  "Bouche à oreille",
  "Blog / Article",
  "Publicité",
  "Événement / Salon",
  "Autre",
];

const guideLeadSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: [true, "Le prénom est requis"],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, "Le nom est requis"],
      trim: true,
    },
    companyName: {
      type: String,
      required: [true, "Le nom d'entreprise est requis"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "L'email est requis"],
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    source: {
      type: String,
      enum: SOURCES,
    },
    guideSlug: {
      type: String,
      default: "facturation-electronique",
    },
    acceptedTerms: {
      type: Boolean,
      required: [true, "L'acceptation des conditions est requise"],
    },
  },
  {
    timestamps: true,
  }
);

guideLeadSchema.index({ email: 1, guideSlug: 1 }, { unique: true });

export default mongoose.model("GuideLead", guideLeadSchema);
