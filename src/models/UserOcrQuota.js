/**
 * Modèle pour la gestion des quotas OCR par utilisateur
 * Supporte les quotas mensuels par plan et les achats supplémentaires
 */

import mongoose from "mongoose";

/**
 * Configuration des quotas par plan
 * Modifiable via variables d'environnement
 */
export const PLAN_QUOTAS = {
  FREE: {
    monthlyQuota: parseInt(process.env.OCR_QUOTA_FREE) || 5,
    extraImportPrice: 0.30, // Prix par import supplémentaire
    name: "Gratuit",
  },
  FREELANCE: {
    monthlyQuota: parseInt(process.env.OCR_QUOTA_FREELANCE) || 50,
    extraImportPrice: 0.25,
    name: "Freelance",
  },
  TPE: {
    monthlyQuota: parseInt(process.env.OCR_QUOTA_TPE) || 200,
    extraImportPrice: 0.20,
    name: "TPE",
  },
  ENTREPRISE: {
    monthlyQuota: parseInt(process.env.OCR_QUOTA_ENTREPRISE) || 1000,
    extraImportPrice: 0.15,
    name: "Entreprise",
  },
  UNLIMITED: {
    monthlyQuota: 999999,
    extraImportPrice: 0.10,
    name: "Illimité",
  },
};

/**
 * Schéma pour le suivi des quotas OCR par utilisateur
 */
const userOcrQuotaSchema = new mongoose.Schema(
  {
    // Utilisateur concerné
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
      index: true,
    },

    // Workspace/Organisation
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },

    // Plan actuel de l'utilisateur
    plan: {
      type: String,
      enum: ["FREE", "FREELANCE", "TPE", "ENTREPRISE", "UNLIMITED"],
      default: "FREE",
    },

    // Mois concerné (format: "2025-01")
    month: {
      type: String,
      required: true,
    },

    // Nombre d'imports utilisés ce mois (inclus dans le plan)
    usedQuota: {
      type: Number,
      default: 0,
    },

    // Imports supplémentaires achetés ce mois
    extraImportsPurchased: {
      type: Number,
      default: 0,
    },

    // Imports supplémentaires utilisés ce mois
    extraImportsUsed: {
      type: Number,
      default: 0,
    },

    // Montant total dépensé en imports supplémentaires (en centimes)
    extraImportsSpent: {
      type: Number,
      default: 0,
    },

    // Date de reset du compteur (1er du mois suivant)
    resetDate: {
      type: Date,
      required: true,
    },

    // Historique détaillé des imports (limité aux 200 derniers)
    importHistory: [
      {
        timestamp: { type: Date, default: Date.now },
        documentId: { type: mongoose.Schema.Types.ObjectId },
        fileName: String,
        provider: {
          type: String,
          enum: ["claude-vision", "mindee", "google-document-ai", "mistral-ocr"],
        },
        success: { type: Boolean, default: true },
        tokensUsed: Number, // Pour Claude Vision
        isExtra: { type: Boolean, default: false }, // Import supplémentaire payant
      },
    ],

    // Historique des achats d'imports supplémentaires
    purchaseHistory: [
      {
        timestamp: { type: Date, default: Date.now },
        quantity: Number,
        unitPrice: Number, // En centimes
        totalPrice: Number, // En centimes
        paymentId: String, // ID Stripe si applicable
      },
    ],
  },
  {
    timestamps: true,
  }
);

// Index composé pour requêtes rapides
userOcrQuotaSchema.index(
  { userId: 1, workspaceId: 1, month: 1 },
  { unique: true }
);

// Index pour les requêtes par workspace
userOcrQuotaSchema.index({ workspaceId: 1, month: 1 });

/**
 * Méthodes statiques
 */

/**
 * Récupère ou crée le quota du mois actuel pour un utilisateur
 */
userOcrQuotaSchema.statics.getOrCreateCurrentQuota = async function (
  userId,
  workspaceId,
  plan = "FREE"
) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  // Calculer la date de reset (1er du mois suivant)
  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  nextMonth.setDate(1);
  nextMonth.setHours(0, 0, 0, 0);

  let quota = await this.findOne({
    userId,
    workspaceId,
    month: currentMonth,
  });

  if (!quota) {
    quota = await this.create({
      userId,
      workspaceId,
      plan,
      month: currentMonth,
      resetDate: nextMonth,
    });
  } else if (quota.plan !== plan) {
    // Mettre à jour le plan si changé
    quota.plan = plan;
    await quota.save();
  }

  return quota;
};

/**
 * Vérifie si l'utilisateur a du quota disponible
 * @returns {Object} { hasQuota, remaining, canBuyExtra, message }
 */
userOcrQuotaSchema.statics.checkQuotaAvailable = async function (
  userId,
  workspaceId,
  plan = "FREE"
) {
  const quota = await this.getOrCreateCurrentQuota(userId, workspaceId, plan);
  const planConfig = PLAN_QUOTAS[plan] || PLAN_QUOTAS.FREE;

  const usedFromPlan = quota.usedQuota;
  const remainingFromPlan = Math.max(0, planConfig.monthlyQuota - usedFromPlan);
  const remainingExtra = quota.extraImportsPurchased - quota.extraImportsUsed;
  const totalRemaining = remainingFromPlan + remainingExtra;

  return {
    hasQuota: totalRemaining > 0,
    remaining: totalRemaining,
    remainingFromPlan,
    remainingExtra,
    usedThisMonth: usedFromPlan + quota.extraImportsUsed,
    monthlyQuota: planConfig.monthlyQuota,
    plan: planConfig.name,
    canBuyExtra: true,
    extraImportPrice: planConfig.extraImportPrice,
    message: totalRemaining > 0
      ? null
      : `Quota OCR épuisé. Passez à un plan supérieur ou achetez des imports supplémentaires (${planConfig.extraImportPrice}€/import).`,
  };
};

/**
 * Incrémente le compteur d'usage après un import réussi
 */
userOcrQuotaSchema.statics.recordUsage = async function (
  userId,
  workspaceId,
  plan,
  documentInfo = {}
) {
  const quota = await this.getOrCreateCurrentQuota(userId, workspaceId, plan);
  const planConfig = PLAN_QUOTAS[plan] || PLAN_QUOTAS.FREE;

  // Déterminer si on utilise le quota du plan ou les extras
  const remainingFromPlan = Math.max(0, planConfig.monthlyQuota - quota.usedQuota);
  const isExtra = remainingFromPlan <= 0;

  // Mettre à jour les compteurs
  if (isExtra) {
    quota.extraImportsUsed += 1;
  } else {
    quota.usedQuota += 1;
  }

  // Ajouter à l'historique
  quota.importHistory.push({
    timestamp: new Date(),
    documentId: documentInfo.documentId,
    fileName: documentInfo.fileName,
    provider: documentInfo.provider || "claude-vision",
    success: documentInfo.success !== false,
    tokensUsed: documentInfo.tokensUsed,
    isExtra,
  });

  // Limiter l'historique à 200 entrées
  if (quota.importHistory.length > 200) {
    quota.importHistory = quota.importHistory.slice(-200);
  }

  await quota.save();

  return {
    isExtra,
    usedQuota: quota.usedQuota,
    extraImportsUsed: quota.extraImportsUsed,
  };
};

/**
 * Ajoute des imports supplémentaires achetés
 */
userOcrQuotaSchema.statics.addExtraImports = async function (
  userId,
  workspaceId,
  plan,
  quantity,
  paymentId = null
) {
  const quota = await this.getOrCreateCurrentQuota(userId, workspaceId, plan);
  const planConfig = PLAN_QUOTAS[plan] || PLAN_QUOTAS.FREE;

  const unitPrice = Math.round(planConfig.extraImportPrice * 100); // Centimes
  const totalPrice = unitPrice * quantity;

  quota.extraImportsPurchased += quantity;
  quota.extraImportsSpent += totalPrice;

  quota.purchaseHistory.push({
    timestamp: new Date(),
    quantity,
    unitPrice,
    totalPrice,
    paymentId,
  });

  await quota.save();

  return {
    extraImportsPurchased: quota.extraImportsPurchased,
    extraImportsAvailable: quota.extraImportsPurchased - quota.extraImportsUsed,
    totalSpent: quota.extraImportsSpent / 100, // En euros
  };
};

/**
 * Récupère les statistiques d'usage pour un utilisateur
 */
userOcrQuotaSchema.statics.getUserStats = async function (
  userId,
  workspaceId,
  plan = "FREE"
) {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const quota = await this.findOne({
    userId,
    workspaceId,
    month: currentMonth,
  });

  const planConfig = PLAN_QUOTAS[plan] || PLAN_QUOTAS.FREE;

  if (!quota) {
    return {
      plan: planConfig.name,
      monthlyQuota: planConfig.monthlyQuota,
      usedQuota: 0,
      remainingQuota: planConfig.monthlyQuota,
      extraImportsPurchased: 0,
      extraImportsUsed: 0,
      extraImportsAvailable: 0,
      extraImportPrice: planConfig.extraImportPrice,
      totalUsedThisMonth: 0,
      totalAvailable: planConfig.monthlyQuota,
      month: currentMonth,
      resetDate: null,
    };
  }

  const remainingFromPlan = Math.max(0, planConfig.monthlyQuota - quota.usedQuota);
  const extraAvailable = quota.extraImportsPurchased - quota.extraImportsUsed;

  return {
    plan: planConfig.name,
    monthlyQuota: planConfig.monthlyQuota,
    usedQuota: quota.usedQuota,
    remainingQuota: remainingFromPlan,
    extraImportsPurchased: quota.extraImportsPurchased,
    extraImportsUsed: quota.extraImportsUsed,
    extraImportsAvailable: extraAvailable,
    extraImportPrice: planConfig.extraImportPrice,
    totalUsedThisMonth: quota.usedQuota + quota.extraImportsUsed,
    totalAvailable: remainingFromPlan + extraAvailable,
    month: currentMonth,
    resetDate: quota.resetDate,
    lastImports: (quota.importHistory || []).slice(-10).reverse(),
  };
};

/**
 * Récupère les statistiques globales d'un workspace
 */
userOcrQuotaSchema.statics.getWorkspaceStats = async function (workspaceId) {
  const currentMonth = new Date().toISOString().slice(0, 7);

  const stats = await this.aggregate([
    {
      $match: {
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        month: currentMonth,
      },
    },
    {
      $group: {
        _id: null,
        totalUsed: { $sum: "$usedQuota" },
        totalExtraUsed: { $sum: "$extraImportsUsed" },
        totalExtraPurchased: { $sum: "$extraImportsPurchased" },
        totalSpent: { $sum: "$extraImportsSpent" },
        usersCount: { $sum: 1 },
      },
    },
  ]);

  if (stats.length === 0) {
    return {
      totalUsed: 0,
      totalExtraUsed: 0,
      totalExtraPurchased: 0,
      totalSpent: 0,
      usersCount: 0,
      month: currentMonth,
    };
  }

  return {
    ...stats[0],
    totalSpent: stats[0].totalSpent / 100, // En euros
    month: currentMonth,
  };
};

/**
 * Nettoie les anciens enregistrements (plus de 12 mois)
 */
userOcrQuotaSchema.statics.cleanupOldRecords = async function () {
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  const cutoffMonth = twelveMonthsAgo.toISOString().slice(0, 7);

  const result = await this.deleteMany({
    month: { $lt: cutoffMonth },
  });

  return result.deletedCount;
};

const UserOcrQuota = mongoose.model("UserOcrQuota", userOcrQuotaSchema);

export default UserOcrQuota;
