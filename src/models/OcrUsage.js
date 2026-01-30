/**
 * Modèle pour le suivi de l'utilisation des services OCR
 * Permet de gérer les quotas mensuels par workspace et provider
 */

import mongoose from "mongoose";

const ocrUsageSchema = new mongoose.Schema(
  {
    // Workspace concerné
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    // Provider OCR (claude-vision, mindee, google-document-ai, mistral)
    provider: {
      type: String,
      enum: ["claude-vision", "mindee", "google-document-ai", "mistral"],
      required: true,
    },

    // Mois concerné (format: "2025-01")
    month: {
      type: String,
      required: true,
    },

    // Nombre d'utilisations ce mois
    count: {
      type: Number,
      default: 0,
    },

    // Limite mensuelle pour ce provider
    limit: {
      type: Number,
      default: 250, // Limite Mindee par défaut
    },

    // Date de reset du compteur
    resetDate: {
      type: Date,
      required: true,
    },

    // Historique des utilisations (optionnel, pour debug)
    usageHistory: [
      {
        timestamp: { type: Date, default: Date.now },
        documentId: { type: mongoose.Schema.Types.ObjectId },
        fileName: String,
        success: Boolean,
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Index composé pour requêtes rapides
ocrUsageSchema.index(
  { workspaceId: 1, provider: 1, month: 1 },
  { unique: true }
);

/**
 * Méthodes statiques
 */

/**
 * Récupère l'usage actuel pour un workspace et un provider
 */
ocrUsageSchema.statics.getCurrentUsage = async function (
  workspaceId,
  provider
) {
  const currentMonth = new Date().toISOString().slice(0, 7); // "2025-01"

  const usage = await this.findOne({
    workspaceId,
    provider,
    month: currentMonth,
  });

  return usage?.count || 0;
};

/**
 * Vérifie si le quota est disponible
 */
ocrUsageSchema.statics.hasQuotaAvailable = async function (
  workspaceId,
  provider,
  limit = 250
) {
  const currentUsage = await this.getCurrentUsage(workspaceId, provider);
  return currentUsage < limit;
};

/**
 * Incrémente le compteur d'usage
 */
ocrUsageSchema.statics.incrementUsage = async function (
  workspaceId,
  provider,
  documentInfo = {}
) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  // Calculer la date de reset (1er du mois suivant)
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  nextMonth.setDate(1);
  nextMonth.setHours(0, 0, 0, 0);

  // Définir les limites par provider
  const limits = {
    "claude-vision": 999999, // Pas de limite, géré par UserOcrQuota
    mindee: 250,
    "google-document-ai": 1000,
    mistral: 999999, // Pas de limite réelle pour Mistral (payant)
  };

  const updateData = {
    $inc: { count: 1 },
    $setOnInsert: {
      limit: limits[provider] || 250,
      resetDate: nextMonth,
    },
  };

  // Ajouter à l'historique si des infos sont fournies
  if (documentInfo.fileName || documentInfo.documentId) {
    updateData.$push = {
      usageHistory: {
        $each: [
          {
            timestamp: new Date(),
            documentId: documentInfo.documentId,
            fileName: documentInfo.fileName,
            success: documentInfo.success !== false,
          },
        ],
        $slice: -100, // Garder les 100 dernières entrées
      },
    };
  }

  const result = await this.findOneAndUpdate(
    { workspaceId, provider, month: currentMonth },
    updateData,
    { upsert: true, new: true }
  );

  return result;
};

/**
 * Récupère les statistiques d'usage pour un workspace
 */
ocrUsageSchema.statics.getUsageStats = async function (workspaceId) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  const stats = await this.find({
    workspaceId,
    month: currentMonth,
  });

  const result = {
    "claude-vision": { used: 0, limit: 999999, available: 999999 },
    mindee: { used: 0, limit: 250, available: 250 },
    "google-document-ai": { used: 0, limit: 1000, available: 1000 },
    mistral: { used: 0, limit: 999999, available: 999999 },
  };

  stats.forEach((stat) => {
    if (result[stat.provider]) {
      result[stat.provider].used = stat.count;
      result[stat.provider].limit = stat.limit;
      result[stat.provider].available = Math.max(0, stat.limit - stat.count);
    }
  });

  return result;
};

/**
 * Nettoie les anciens enregistrements (plus de 6 mois)
 */
ocrUsageSchema.statics.cleanupOldRecords = async function () {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const cutoffMonth = sixMonthsAgo.toISOString().slice(0, 7);

  const result = await this.deleteMany({
    month: { $lt: cutoffMonth },
  });

  return result.deletedCount;
};

const OcrUsage = mongoose.model("OcrUsage", ocrUsageSchema);

export default OcrUsage;
