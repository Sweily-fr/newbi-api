/**
 * Modèle pour les documents partagés
 * Permet de stocker et organiser les documents administratifs partagés avec le comptable
 */

import mongoose from "mongoose";

const SharedDocumentSchema = new mongoose.Schema(
  {
    // Informations du fichier
    name: {
      type: String,
      required: true,
      trim: true,
    },
    originalName: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: "",
    },

    // Stockage Cloudflare R2
    fileUrl: {
      type: String,
      required: true,
    },
    fileKey: {
      type: String,
      required: true,
    },

    // Métadonnées du fichier
    mimeType: {
      type: String,
      required: true,
    },
    fileSize: {
      type: Number,
      required: true,
    },
    fileExtension: {
      type: String,
    },

    // Organisation et dossier
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    folderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SharedFolder",
      default: null, // null = "Documents à classer"
      index: true,
    },

    // Utilisateur qui a uploadé
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    uploadedByName: {
      type: String,
    },

    // Statut et partage
    status: {
      type: String,
      enum: ["pending", "classified", "archived"],
      default: "pending",
    },
    isSharedWithAccountant: {
      type: Boolean,
      default: true,
    },

    // Tags pour la recherche
    tags: [
      {
        type: String,
        trim: true,
      },
    ],

    // Commentaires
    comments: [
      {
        text: String,
        authorId: mongoose.Schema.Types.ObjectId,
        authorName: String,
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    // Dates
    archivedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Index composés pour les recherches fréquentes
SharedDocumentSchema.index({ workspaceId: 1, folderId: 1 });
SharedDocumentSchema.index({ workspaceId: 1, status: 1 });
SharedDocumentSchema.index({ workspaceId: 1, createdAt: -1 });
SharedDocumentSchema.index({ name: "text", description: "text", tags: "text" });

const SharedDocument = mongoose.model("SharedDocument", SharedDocumentSchema);

export default SharedDocument;
