/**
 * Modèle pour les dossiers de documents partagés
 * Permet d'organiser les documents en dossiers
 */

import mongoose from "mongoose";

const SharedFolderSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },

    // Organisation
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    // Dossier parent (pour hiérarchie)
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SharedFolder",
      default: null,
    },

    // Couleur et icône pour personnalisation
    color: {
      type: String,
      default: "#6366f1", // Indigo par défaut
    },
    icon: {
      type: String,
      default: "folder",
    },

    // Créateur
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    // Partage avec le comptable
    isSharedWithAccountant: {
      type: Boolean,
      default: true,
    },

    // Ordre d'affichage
    order: {
      type: Number,
      default: 0,
    },

    // Dossier système (non supprimable)
    isSystem: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Index composés
SharedFolderSchema.index({ workspaceId: 1, parentId: 1 });
SharedFolderSchema.index({ workspaceId: 1, order: 1 });

const SharedFolder = mongoose.model("SharedFolder", SharedFolderSchema);

export default SharedFolder;
