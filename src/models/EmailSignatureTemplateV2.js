/**
 * Modèle de signature enregistré par un membre (« Enregistrer comme
 * modèle ») : tout le style d'une signature (disposition, typographie,
 * couleurs), jamais ses textes ni ses images. Proposé à tout l'espace de
 * travail ; seul son auteur peut le remplacer, son auteur, le propriétaire
 * ou un administrateur de l'espace peut le supprimer.
 */

import mongoose from "mongoose";
import {
  DEFAULT_TEMPLATE_ID,
  TEMPLATE_IDS,
} from "../services/signatureRenderer/constants.js";

const emailSignatureTemplateV2Schema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true, maxlength: 60 },
    // Modèle de base : son caractère (nom en capitales, tailles…) s'applique
    templateId: {
      type: String,
      enum: TEMPLATE_IDS,
      default: DEFAULT_TEMPLATE_ID,
    },
    // Style normalisé par le générateur au moment de l'enregistrement
    style: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },

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
  { timestamps: true, minimize: false },
);

emailSignatureTemplateV2Schema.index(
  { workspaceId: 1, createdBy: 1, name: 1 },
  { unique: true },
);

export default mongoose.model(
  "EmailSignatureTemplateV2",
  emailSignatureTemplateV2Schema,
);
