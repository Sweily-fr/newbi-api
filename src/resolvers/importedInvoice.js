import logger from "../utils/logger.js";
/**
 * Resolvers GraphQL pour les factures importées
 */

import mongoose from "mongoose";
import crypto from "crypto";
import { GraphQLUpload } from "graphql-upload";
import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import {
  requireRead,
  requireWrite,
  requireDelete,
  checkSubscriptionActive,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import ImportedInvoice from "../models/ImportedInvoice.js";
import UserOcrQuota from "../models/UserOcrQuota.js";
import hybridOcrService from "../services/hybridOcrService.js";
import claudeVisionOcrService from "../services/claudeVisionOcrService.js";
import invoiceExtractionService from "../services/invoiceExtractionService.js";
import cloudflareService from "../services/cloudflareService.js";
import {
  createValidationError,
  createNotFoundError,
  createInternalServerError,
} from "../utils/errors.js";
import documentAutomationService from "../services/documentAutomationService.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Supplier from "../models/Supplier.js";

// Limite maximale d'import en lot
const MAX_BATCH_IMPORT = 100;

// Cache mémoire pour les plans utilisateurs (évite une requête MongoDB par import dans un batch)
const planCache = new Map();
const PLAN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Mapping des noms de plan Better Auth/Stripe → clés PLAN_QUOTAS
const PLAN_NAME_MAP = {
  freelance: "FREELANCE",
  pme: "TPE",
  entreprise: "ENTREPRISE",
};

/**
 * Récupère le plan de l'utilisateur depuis sa subscription Stripe/Better Auth
 */
async function getUserPlan(userId, workspaceId) {
  const defaultPlan = process.env.DEFAULT_USER_PLAN || "FREE";

  if (!workspaceId) {
    return defaultPlan;
  }

  // Vérifier le cache
  const cacheKey = String(workspaceId);
  const cached = planCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PLAN_CACHE_TTL) {
    return cached.plan;
  }

  try {
    const db = mongoose.connection.db;
    if (!db) {
      console.warn("⚠️ getUserPlan: connexion MongoDB non disponible");
      return defaultPlan;
    }

    // Chercher la subscription active avec les deux formats d'ID (string et ObjectId)
    let subscription = null;
    try {
      const { ObjectId } = mongoose.Types;
      const orgObjectId = new ObjectId(workspaceId);
      subscription = await db.collection("subscription").findOne({
        $and: [
          {
            $or: [
              { referenceId: cacheKey },
              { referenceId: orgObjectId },
              { organizationId: cacheKey },
              { organizationId: orgObjectId },
            ],
          },
          { status: { $in: ["active", "trialing"] } },
        ],
      });
    } catch {
      // Si workspaceId n'est pas un ObjectId valide, chercher uniquement en string
      subscription = await db.collection("subscription").findOne({
        $and: [
          {
            $or: [{ referenceId: cacheKey }, { organizationId: cacheKey }],
          },
          { status: { $in: ["active", "trialing"] } },
        ],
      });
    }

    const plan = subscription?.plan
      ? PLAN_NAME_MAP[subscription.plan] || defaultPlan
      : defaultPlan;

    logger.debug(
      `📋 getUserPlan: workspace=${cacheKey}, subscription=${subscription?.plan || "none"}, plan=${plan}`,
    );

    // Mettre en cache
    planCache.set(cacheKey, { plan, timestamp: Date.now() });

    return plan;
  } catch (error) {
    console.warn("⚠️ Erreur récupération plan utilisateur:", error.message);
    return defaultPlan;
  }
}

/**
 * Vérifie le quota OCR de l'utilisateur avant import
 * @throws {Error} Si quota épuisé
 */
async function checkUserOcrQuota(userId, workspaceId, filesCount = 1) {
  const plan = await getUserPlan(userId, workspaceId);
  const quotaInfo = await UserOcrQuota.checkQuotaAvailable(
    userId,
    workspaceId,
    plan,
  );

  if (!quotaInfo.hasQuota) {
    throw createValidationError(
      `Quota OCR épuisé (${quotaInfo.usedThisMonth}/${quotaInfo.monthlyQuota} utilisés ce mois). ` +
        "Passez à un plan supérieur pour augmenter votre quota.",
    );
  }

  if (quotaInfo.remaining < filesCount) {
    throw createValidationError(
      `Quota OCR insuffisant. Vous avez ${quotaInfo.remaining} import(s) disponible(s) mais vous essayez d'en importer ${filesCount}. ` +
        "Réduisez le nombre de fichiers ou passez à un plan supérieur.",
    );
  }

  return { plan, quotaInfo };
}

/**
 * Enregistre l'utilisation OCR après un import réussi
 */
async function recordOcrUsage(userId, workspaceId, plan, documentInfo) {
  try {
    await UserOcrQuota.recordUsage(userId, workspaceId, plan, documentInfo);
  } catch (error) {
    console.warn("⚠️ Erreur enregistrement usage OCR:", error.message);
    // Ne pas bloquer l'import si l'enregistrement échoue
  }
}

/**
 * Vérifie l'accès à une facture importée (IDOR fix: filtre par workspaceId)
 */
async function checkInvoiceAccess(invoiceId, workspaceId) {
  const invoice = await ImportedInvoice.findOne({
    _id: invoiceId,
    workspaceId,
  });
  if (!invoice) {
    throw createNotFoundError("Facture importée non trouvée");
  }
  return invoice;
}

/**
 * Transforme les données OCR en données de facture
 */
function transformOcrToInvoiceData(ocrResult, financialAnalysis) {
  const transactionData = financialAnalysis?.transaction_data || {};
  const extractedFields = financialAnalysis?.extracted_fields || {};
  const documentAnalysis = financialAnalysis?.document_analysis || {};

  // Mapper la catégorie
  const categoryMap = {
    OFFICE_SUPPLIES: "OFFICE_SUPPLIES",
    TRAVEL: "TRAVEL",
    MEALS: "MEALS",
    EQUIPMENT: "EQUIPMENT",
    MARKETING: "MARKETING",
    TRAINING: "TRAINING",
    SERVICES: "SERVICES",
    RENT: "RENT",
    SALARIES: "SALARIES",
    UTILITIES: "UTILITIES",
    INSURANCE: "INSURANCE",
    SUBSCRIPTIONS: "SUBSCRIPTIONS",
  };

  // Mapper le moyen de paiement
  const paymentMethodMap = {
    card: "CARD",
    cash: "CASH",
    check: "CHECK",
    transfer: "TRANSFER",
    direct_debit: "DIRECT_DEBIT",
  };

  // Parser la date
  let invoiceDate = null;
  if (transactionData.transaction_date) {
    try {
      invoiceDate = new Date(transactionData.transaction_date);
      if (isNaN(invoiceDate.getTime())) {
        invoiceDate = null;
      }
    } catch (e) {
      invoiceDate = null;
    }
  }

  let dueDate = null;
  if (transactionData.due_date) {
    try {
      dueDate = new Date(transactionData.due_date);
      if (isNaN(dueDate.getTime())) {
        dueDate = null;
      }
    } catch (e) {
      dueDate = null;
    }
  }

  // Extraire les items si disponibles
  const items = (financialAnalysis?.line_items || []).map((item) => ({
    description: item.description || "",
    quantity: parseFloat(item.quantity) || 1,
    unitPrice: parseFloat(item.unit_price) || 0,
    totalPrice: parseFloat(item.total) || 0,
    vatRate: item.vat_rate != null ? parseFloat(item.vat_rate) : 20,
    productCode: item.product_code || null,
  }));

  return {
    originalInvoiceNumber: transactionData.document_number || null,
    vendor: {
      name: transactionData.vendor_name || "",
      address: extractedFields.vendor_address || "",
      city: extractedFields.vendor_city || "",
      postalCode: extractedFields.vendor_postal_code || "",
      country: extractedFields.vendor_country || "France",
      siret: extractedFields.vendor_siret || null,
      vatNumber: extractedFields.vendor_vat_number || null,
      email: extractedFields.vendor_email || null,
      phone: extractedFields.vendor_phone || null,
    },
    invoiceDate,
    dueDate,
    paymentDate: transactionData.payment_date
      ? new Date(transactionData.payment_date)
      : null,
    totalHT: parseFloat(transactionData.amount_ht) || 0,
    totalVAT: parseFloat(transactionData.tax_amount) || 0,
    totalTTC: parseFloat(transactionData.amount) || 0,
    currency: transactionData.currency || "EUR",
    items,
    category: categoryMap[transactionData.category?.toUpperCase()] || "OTHER",
    paymentMethod:
      paymentMethodMap[transactionData.payment_method?.toLowerCase()] ||
      "UNKNOWN",
    ocrData: {
      extractedText: ocrResult.extractedText || "",
      rawData: ocrResult.data || {},
      financialAnalysis: financialAnalysis || {},
      confidence: documentAnalysis.confidence || 0,
      processedAt: new Date(),
    },
  };
}

/**
 * Traite une facture avec OCR - Version améliorée
 * Utilise le nouveau service d'extraction avec patterns français
 * @param {string} cloudflareUrl - URL du document sur Cloudflare
 * @param {string} fileName - Nom du fichier
 * @param {string} mimeType - Type MIME
 * @param {string} workspaceId - ID du workspace (pour gestion quota Mindee)
 */
async function processInvoiceWithOcr(
  cloudflareUrl,
  fileName,
  mimeType,
  workspaceId = null,
) {
  // Étape 1: OCR avec le service hybride (Mindee > Google Document AI > Mistral)
  const ocrResult = await hybridOcrService.processDocumentFromUrl(
    cloudflareUrl,
    fileName,
    mimeType,
    workspaceId,
  );

  if (!ocrResult.success) {
    throw createInternalServerError("Erreur lors du traitement OCR");
  }

  // Étape 2: Extraction intelligente avec le nouveau service amélioré
  const extractionResult =
    await invoiceExtractionService.extractInvoiceData(ocrResult);

  // Étape 3: Transformer en données de facture
  return transformOcrToInvoiceDataV2(ocrResult, extractionResult);
}

/**
 * Transforme les données d'extraction améliorées en données de facture
 */
function transformOcrToInvoiceDataV2(ocrResult, extractionResult) {
  const transactionData = extractionResult?.transaction_data || {};
  const extractedFields = extractionResult?.extracted_fields || {};
  const documentAnalysis = extractionResult?.document_analysis || {};

  // Mapper la catégorie
  const categoryMap = {
    OFFICE_SUPPLIES: "OFFICE_SUPPLIES",
    TRAVEL: "TRAVEL",
    MEALS: "MEALS",
    EQUIPMENT: "EQUIPMENT",
    MARKETING: "MARKETING",
    TRAINING: "TRAINING",
    SERVICES: "SERVICES",
    RENT: "RENT",
    SALARIES: "SALARIES",
    UTILITIES: "UTILITIES",
    INSURANCE: "INSURANCE",
    SUBSCRIPTIONS: "SUBSCRIPTIONS",
  };

  // Mapper le moyen de paiement
  const paymentMethodMap = {
    card: "CARD",
    cash: "CASH",
    check: "CHECK",
    transfer: "TRANSFER",
    direct_debit: "DIRECT_DEBIT",
    unknown: "UNKNOWN",
  };

  // Parser les dates
  let invoiceDate = null;
  if (transactionData.transaction_date) {
    try {
      invoiceDate = new Date(transactionData.transaction_date);
      if (isNaN(invoiceDate.getTime())) {
        invoiceDate = null;
      }
    } catch (e) {
      invoiceDate = null;
    }
  }

  let dueDate = null;
  if (transactionData.due_date) {
    try {
      dueDate = new Date(transactionData.due_date);
      if (isNaN(dueDate.getTime())) {
        dueDate = null;
      }
    } catch (e) {
      dueDate = null;
    }
  }

  let paymentDate = null;
  if (transactionData.payment_date) {
    try {
      paymentDate = new Date(transactionData.payment_date);
      if (isNaN(paymentDate.getTime())) {
        paymentDate = null;
      }
    } catch (e) {
      paymentDate = null;
    }
  }

  // Extraire les items
  const items = (extractedFields.items || []).map((item) => ({
    description: item.description || "",
    quantity: parseFloat(item.quantity) || 1,
    unitPrice:
      parseFloat(item.unit_price_ht) || parseFloat(item.unit_price_ttc) || 0,
    totalPrice: parseFloat(item.total_ttc) || parseFloat(item.total_ht) || 0,
    vatRate: item.vat_rate != null ? parseFloat(item.vat_rate) : 20,
    productCode: item.code || null,
    unit: item.unit || "unité",
  }));

  // Construire les totaux
  const totals = extractedFields.totals || {};

  return {
    originalInvoiceNumber: transactionData.document_number || null,
    vendor: {
      name: transactionData.vendor_name || "",
      address: extractedFields.vendor_address || "",
      city: extractedFields.vendor_city || "",
      postalCode: extractedFields.vendor_postal_code || "",
      country: extractedFields.vendor_country || "France",
      siret: extractedFields.vendor_siret || null,
      vatNumber: extractedFields.vendor_vat_number || null,
      email: extractedFields.vendor_email || null,
      phone: extractedFields.vendor_phone || null,
      website: extractedFields.vendor_website || null,
      rcs: extractedFields.vendor_rcs || null,
      ape: extractedFields.vendor_ape || null,
      capitalSocial: extractedFields.vendor_capital || null,
    },
    client: {
      name: extractedFields.client_name || transactionData.client_name || null,
      address: extractedFields.client_address || null,
      city: extractedFields.client_city || null,
      postalCode: extractedFields.client_postal_code || null,
      siret: extractedFields.client_siret || null,
      clientNumber:
        extractedFields.client_number || transactionData.client_number || null,
    },
    invoiceDate,
    dueDate,
    paymentDate,
    totalHT: parseFloat(totals.total_ht) || 0,
    totalVAT:
      parseFloat(totals.total_tax) ||
      parseFloat(transactionData.tax_amount) ||
      0,
    totalTTC:
      parseFloat(totals.total_ttc) || parseFloat(transactionData.amount) || 0,
    currency: transactionData.currency || "EUR",
    items,
    taxDetails: extractedFields.tax_details || [],
    category: categoryMap[transactionData.category?.toUpperCase()] || "OTHER",
    paymentMethod:
      paymentMethodMap[transactionData.payment_method?.toLowerCase()] ||
      "UNKNOWN",
    paymentDetails: {
      iban: extractedFields.payment_details?.iban || null,
      bic: extractedFields.payment_details?.bic || null,
      bankName: extractedFields.payment_details?.bank_name || null,
    },
    ocrData: {
      extractedText: ocrResult.extractedText || "",
      rawData: ocrResult.data || {},
      financialAnalysis: extractionResult || {},
      confidence: documentAnalysis.confidence || 0,
      processedAt: new Date(),
    },
    description: transactionData.description || "Facture importée",
  };
}

// === Conversion ImportedInvoice → PurchaseInvoice helpers ===

const CATEGORY_MAP = {
  TRAVEL: "TRANSPORT",
  EQUIPMENT: "HARDWARE",
  SALARIES: "OTHER",
};

function mapCategory(importedCategory) {
  if (!importedCategory) return "OTHER";
  return CATEGORY_MAP[importedCategory] || importedCategory;
}

const PAYMENT_METHOD_MAP = {
  CARD: "CREDIT_CARD",
  TRANSFER: "BANK_TRANSFER",
};

function mapPaymentMethod(importedMethod) {
  if (!importedMethod || importedMethod === "UNKNOWN") return null;
  return PAYMENT_METHOD_MAP[importedMethod] || importedMethod;
}

async function findOrCreateSupplier(vendor, workspaceId, userId) {
  if (!vendor?.name) return null;

  const wsId = new mongoose.Types.ObjectId(workspaceId);

  // Search by siret first
  if (vendor.siret) {
    const bySiret = await Supplier.findOne({
      workspaceId: wsId,
      siret: vendor.siret,
    });
    if (bySiret) return bySiret;
  }

  // Search by name (case-insensitive)
  const escapedName = vendor.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const byName = await Supplier.findOne({
    workspaceId: wsId,
    name: { $regex: new RegExp(`^${escapedName}$`, "i") },
  });
  if (byName) return byName;

  // Create new supplier
  return Supplier.create({
    workspaceId: wsId,
    name: vendor.name,
    email: vendor.email || undefined,
    phone: vendor.phone || undefined,
    siret: vendor.siret || undefined,
    vatNumber: vendor.vatNumber || undefined,
    address: {
      street: vendor.address || undefined,
      city: vendor.city || undefined,
      postalCode: vendor.postalCode || undefined,
      country: vendor.country || undefined,
    },
    createdBy: userId,
  });
}

async function convertSingleImportedInvoice(importedInvoice, userId) {
  const supplier = await findOrCreateSupplier(
    importedInvoice.vendor,
    importedInvoice.workspaceId,
    userId,
  );

  const file = importedInvoice.file;
  const files = file
    ? [
        {
          filename: file.cloudflareKey || file.originalFileName,
          originalFilename: file.originalFileName,
          mimetype: file.mimeType || "application/pdf",
          path: file.url,
          size: file.fileSize || 1,
          url: file.url,
          ocrProcessed: true,
        },
      ]
    : [];

  const ocrMetadata = {
    supplierName: importedInvoice.vendor?.name || null,
    supplierSiret: importedInvoice.vendor?.siret || null,
    supplierVatNumber: importedInvoice.vendor?.vatNumber || null,
    invoiceNumber: importedInvoice.originalInvoiceNumber || null,
    invoiceDate: importedInvoice.invoiceDate
      ? new Date(importedInvoice.invoiceDate)
      : null,
    dueDate: importedInvoice.dueDate ? new Date(importedInvoice.dueDate) : null,
    amountHT: importedInvoice.totalHT || null,
    amountTVA: importedInvoice.totalVAT || null,
    amountTTC: importedInvoice.totalTTC || null,
    confidenceScore: importedInvoice.ocrData?.confidence || null,
  };

  const purchaseInvoice = await PurchaseInvoice.create({
    supplierName: importedInvoice.vendor?.name || "Fournisseur inconnu",
    supplierId: supplier?._id || null,
    invoiceNumber: importedInvoice.originalInvoiceNumber || null,
    issueDate: importedInvoice.invoiceDate
      ? new Date(importedInvoice.invoiceDate)
      : new Date(),
    dueDate: importedInvoice.dueDate ? new Date(importedInvoice.dueDate) : null,
    amountHT: importedInvoice.totalHT || 0,
    amountTVA: importedInvoice.totalVAT || 0,
    amountTTC: importedInvoice.totalTTC,
    currency: importedInvoice.currency || "EUR",
    status: "TO_PROCESS",
    category: mapCategory(importedInvoice.category),
    paymentMethod: mapPaymentMethod(importedInvoice.paymentMethod),
    notes: importedInvoice.notes || null,
    files,
    ocrMetadata,
    source: "OCR",
    workspaceId: new mongoose.Types.ObjectId(importedInvoice.workspaceId),
    createdBy: userId,
  });

  // Mark the imported invoice as VALIDATED
  importedInvoice.status = "VALIDATED";
  await importedInvoice.save();

  return purchaseInvoice;
}

const importedInvoiceResolvers = {
  Upload: GraphQLUpload,

  Query: {
    /**
     * Récupère une facture importée par ID
     */
    importedInvoice: withWorkspace(async (_, { id }, { workspaceId }) => {
      const invoice = await checkInvoiceAccess(id, workspaceId);
      return invoice;
    }),

    /**
     * Liste les factures importées avec pagination et filtres
     */
    importedInvoices: requireRead("importedInvoices")(
      async (
        _,
        { workspaceId: inputWorkspaceId, page = 1, limit = 20, filters = {} },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const query = { workspaceId };

        // Appliquer les filtres
        if (filters.status) {
          query.status = filters.status;
        }
        if (filters.category) {
          query.category = filters.category;
        }
        if (filters.vendorName) {
          query["vendor.name"] = {
            $regex: new RegExp(filters.vendorName, "i"),
          };
        }
        if (filters.dateFrom || filters.dateTo) {
          query.invoiceDate = {};
          if (filters.dateFrom) {
            query.invoiceDate.$gte = new Date(filters.dateFrom);
          }
          if (filters.dateTo) {
            query.invoiceDate.$lte = new Date(filters.dateTo);
          }
        }
        if (
          filters.minAmount !== undefined ||
          filters.maxAmount !== undefined
        ) {
          query.totalTTC = {};
          if (filters.minAmount !== undefined) {
            query.totalTTC.$gte = filters.minAmount;
          }
          if (filters.maxAmount !== undefined) {
            query.totalTTC.$lte = filters.maxAmount;
          }
        }

        const skip = (page - 1) * limit;
        const [invoices, total] = await Promise.all([
          ImportedInvoice.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
          ImportedInvoice.countDocuments(query),
        ]);

        return {
          invoices,
          total,
          page,
          limit,
          hasMore: skip + invoices.length < total,
        };
      },
    ),

    /**
     * Statistiques des factures importées
     */
    importedInvoiceStats: requireRead("importedInvoices")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const stats = await ImportedInvoice.getStats(workspaceId);

        const result = {
          pendingReview: 0,
          validated: 0,
          rejected: 0,
          archived: 0,
          totalAmount: 0,
        };

        stats.forEach((stat) => {
          const statusKey = stat._id?.toLowerCase().replace("_", "");
          if (stat._id === "PENDING_REVIEW") result.pendingReview = stat.count;
          else if (stat._id === "VALIDATED") result.validated = stat.count;
          else if (stat._id === "REJECTED") result.rejected = stat.count;
          else if (stat._id === "ARCHIVED") result.archived = stat.count;

          if (stat._id !== "REJECTED") {
            result.totalAmount += stat.totalAmount || 0;
          }
        });

        return result;
      },
    ),

    /**
     * Statistiques d'usage OCR (quotas Mindee, Google, Mistral)
     */
    ocrUsageStats: requireRead("importedInvoices")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const OcrUsage = (await import("../models/OcrUsage.js")).default;
        const stats = await OcrUsage.getUsageStats(workspaceId);

        // Déterminer le provider actuel (Claude Vision par défaut)
        let currentProvider = process.env.OCR_PROVIDER || "claude-vision";
        if (stats["claude-vision"]?.used > 0) {
          currentProvider = "claude-vision";
        } else if (stats.mindee?.available > 0) {
          currentProvider = "mindee";
        } else if (stats["google-document-ai"]?.available > 0) {
          currentProvider = "google-document-ai";
        }

        return {
          claudeVision: stats["claude-vision"] || {
            used: 0,
            limit: 999999,
            available: 999999,
          },
          mindee: stats.mindee,
          googleDocumentAi: stats["google-document-ai"],
          mistral: stats.mistral,
          currentProvider,
        };
      },
    ),

    /**
     * Quota OCR de l'utilisateur courant
     */
    userOcrQuota: requireRead("importedInvoices")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const plan = await getUserPlan(user.id, workspaceId);
        const stats = await UserOcrQuota.getUserStats(
          user.id,
          workspaceId,
          plan,
        );

        return {
          plan: stats.plan,
          monthlyQuota: stats.monthlyQuota,
          usedQuota: stats.usedQuota,
          remainingQuota: stats.remainingQuota,
          extraImportsPurchased: stats.extraImportsPurchased,
          extraImportsUsed: stats.extraImportsUsed,
          extraImportsAvailable: stats.extraImportsAvailable,
          extraImportPrice: stats.extraImportPrice,
          totalUsedThisMonth: stats.totalUsedThisMonth,
          totalAvailable: stats.totalAvailable,
          month: stats.month,
          resetDate: stats.resetDate?.toISOString() || null,
          lastImports: stats.lastImports || [],
        };
      },
    ),
  },

  Mutation: {
    /**
     * Importe une facture avec OCR
     */
    importInvoice: requireWrite("importedInvoices")(
      async (
        _,
        {
          workspaceId: inputWorkspaceId,
          cloudflareUrl,
          fileName,
          mimeType,
          fileSize,
          cloudflareKey,
        },
        context,
      ) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        try {
          // Vérifier le quota utilisateur avant l'import
          const { plan } = await checkUserOcrQuota(user.id, workspaceId, 1);

          // Traiter avec OCR (avec workspaceId pour gestion quota Mindee)
          const invoiceData = await processInvoiceWithOcr(
            cloudflareUrl,
            fileName,
            mimeType,
            workspaceId,
          );

          // OPTIMISATION: Enregistrer usage OCR + détecter doublons en parallèle
          const [duplicates] = await Promise.all([
            ImportedInvoice.findPotentialDuplicates(
              workspaceId,
              invoiceData.originalInvoiceNumber,
              invoiceData.vendor?.name,
              invoiceData.totalTTC,
            ),
            recordOcrUsage(user.id, workspaceId, plan, {
              fileName,
              provider: invoiceData.ocrData?.provider || "claude-vision",
              success: true,
            }),
          ]);

          const isDuplicate = duplicates.length > 0;

          // Créer et sauvegarder la facture importée
          const importedInvoice = new ImportedInvoice({
            workspaceId,
            importedBy: user.id,
            ...invoiceData,
            file: {
              url: cloudflareUrl,
              cloudflareKey,
              originalFileName: fileName,
              mimeType,
              fileSize: fileSize || 0,
            },
            isDuplicate,
            duplicateOf: isDuplicate ? duplicates[0]._id : null,
          });

          await importedInvoice.save();

          // Déclencher les automatisations (fire-and-forget, pas de await)
          documentAutomationService
            .executeAutomationsForExpense(
              "INVOICE_IMPORTED",
              workspaceId,
              {
                documentId: importedInvoice._id.toString(),
                documentType: "importedInvoice",
                documentNumber: importedInvoice.originalInvoiceNumber || "",
                clientName:
                  importedInvoice.vendor?.name ||
                  importedInvoice.client?.name ||
                  "",
                cloudflareUrl: cloudflareUrl,
                mimeType: mimeType,
                fileExtension: fileName?.split(".").pop() || "pdf",
                issueDate:
                  importedInvoice.invoiceDate || importedInvoice.createdAt,
                clientId: importedInvoice.client?._id || null,
              },
              user.id,
            )
            .catch((err) =>
              console.error("Erreur automatisation facture importée:", err),
            );

          return {
            success: true,
            invoice: importedInvoice,
            error: null,
            isDuplicate,
          };
        } catch (error) {
          console.error("Erreur import facture:", error);
          return {
            success: false,
            invoice: null,
            error: error.message,
            isDuplicate: false,
          };
        }
      },
    ),

    /**
     * Importe une facture PDF avec OCR — upload direct (pas de pré-upload Cloudflare)
     * Le fichier est envoyé directement au backend, OCR via Claude Vision en base64,
     * puis upload serveur-à-serveur vers Cloudflare (attendu car besoin de l'URL).
     */
    importInvoiceDirect: requireWrite("importedInvoices")(
      async (_, { file, workspaceId: inputWorkspaceId }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        try {
          const { createReadStream, filename, mimetype } = await file;

          if (!filename) {
            throw createValidationError("Nom de fichier requis");
          }

          // Lecture du fichier en mémoire
          const stream = createReadStream();
          const chunks = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          const fileBuffer = Buffer.concat(chunks);

          // Validation de la taille (max 10MB)
          const maxSize = 10 * 1024 * 1024;
          if (fileBuffer.length > maxSize) {
            throw createValidationError("Fichier trop volumineux (max 10MB)");
          }

          // Récupérer organizationId pour l'upload Cloudflare
          let organizationId = null;
          const rawOrgId =
            user.organizationId ||
            user.organization?.id ||
            user.organization?._id ||
            user.currentOrganizationId;

          if (rawOrgId) {
            organizationId =
              typeof rawOrgId === "object"
                ? rawOrgId._id?.toString() ||
                  rawOrgId.id?.toString() ||
                  rawOrgId.toString()
                : rawOrgId.toString();
          } else {
            try {
              const memberRecord = await mongoose.connection.db
                .collection("member")
                .findOne({ userId: new mongoose.Types.ObjectId(user.id) });
              if (memberRecord?.organizationId) {
                organizationId = memberRecord.organizationId.toString();
              }
            } catch (err) {
              console.warn(
                "⚠️ Impossible de récupérer organizationId:",
                err.message,
              );
            }
          }

          // Upload Cloudflare en premier (indispensable, même si l'OCR échoue
          // on doit garder le PDF stocké pour saisie manuelle).
          logger.debug(
            `☁️ importInvoiceDirect: Upload Cloudflare pour ${filename}`,
          );
          const uploadResult = await cloudflareService.uploadImage(
            fileBuffer,
            filename,
            user.id,
            "importedInvoice",
            organizationId,
          );

          // Chaîne OCR : Claude Vision (quota) → Tesseract (gratuit, fallback).
          // Toujours en PENDING_REVIEW à la sortie : la sidebar permet l'édition.
          let invoiceData = {};
          let ocrProvider = null;
          let plan = null;
          let consumedQuota = false;
          try {
            const quotaResult = await checkUserOcrQuota(
              user.id,
              workspaceId,
              1,
            );
            plan = quotaResult.plan;

            if (claudeVisionOcrService.isAvailable()) {
              const base64Data = fileBuffer.toString("base64");
              const contentHash = crypto
                .createHash("sha256")
                .update(fileBuffer)
                .digest("hex");

              logger.debug(
                `🔍 importInvoiceDirect: Claude Vision pour ${filename}`,
              );
              const rawResult = await claudeVisionOcrService.processFromBase64(
                base64Data,
                mimetype,
                filename,
                contentHash,
              );

              if (!rawResult.success) {
                throw createInternalServerError(
                  `Erreur OCR: ${rawResult.error || rawResult.message}`,
                );
              }

              const structuredResult =
                claudeVisionOcrService.toInvoiceFormat(rawResult);

              if (structuredResult.transaction_data) {
                invoiceData = transformOcrToInvoiceDataV2(
                  structuredResult,
                  structuredResult,
                );
              } else {
                const extractionResult =
                  await invoiceExtractionService.extractInvoiceData(
                    structuredResult,
                  );
                invoiceData = transformOcrToInvoiceDataV2(
                  structuredResult,
                  extractionResult,
                );
              }
              ocrProvider = rawResult.provider || "claude-vision";
            } else {
              logger.debug(
                `🔍 importInvoiceDirect: Fallback OCR hybride pour ${filename}`,
              );
              invoiceData = await processInvoiceWithOcr(
                uploadResult.url,
                filename,
                mimetype,
                workspaceId,
              );
              ocrProvider = invoiceData.ocrData?.provider || "hybrid";
            }
            consumedQuota = true;
          } catch (claudeError) {
            console.warn(
              `⚠️ OCR principal indisponible pour ${filename} (${claudeError.message}). Fallback OCR hybride (Mindee / Google / Mistral).`,
            );
            try {
              invoiceData = await processInvoiceWithOcr(
                uploadResult.url,
                filename,
                mimetype,
                workspaceId,
              );
              ocrProvider = invoiceData.ocrData?.provider || "hybrid";
            } catch (fallbackError) {
              console.warn(
                `⚠️ OCR de fallback échec pour ${filename}: ${fallbackError.message}. Champs vides, à compléter via la sidebar.`,
              );
            }
          }

          if (consumedQuota && plan) {
            await recordOcrUsage(user.id, workspaceId, plan, {
              fileName: filename,
              provider: ocrProvider,
              success: true,
            });
          }

          const duplicates = invoiceData.originalInvoiceNumber
            ? await ImportedInvoice.findPotentialDuplicates(
                workspaceId,
                invoiceData.originalInvoiceNumber,
                invoiceData.vendor?.name,
                invoiceData.totalTTC,
              )
            : [];

          const isDuplicate = duplicates.length > 0;

          const importedInvoice = new ImportedInvoice({
            workspaceId,
            importedBy: user.id,
            ...invoiceData,
            // À vérifier : l'utilisateur valide chaque facture importée une par une
            // via la sidebar (passage en VALIDATED = comptée dans le CA).
            status: "PENDING_REVIEW",
            file: {
              url: uploadResult.url,
              cloudflareKey: uploadResult.key,
              originalFileName: filename,
              mimeType: mimetype,
              fileSize: fileBuffer.length,
            },
            isDuplicate,
            duplicateOf: isDuplicate ? duplicates[0]._id : null,
          });

          await importedInvoice.save();

          documentAutomationService
            .executeAutomationsForExpense(
              "INVOICE_IMPORTED",
              workspaceId,
              {
                documentId: importedInvoice._id.toString(),
                documentType: "importedInvoice",
                documentNumber: importedInvoice.originalInvoiceNumber || "",
                clientName:
                  importedInvoice.vendor?.name ||
                  importedInvoice.client?.name ||
                  "",
                cloudflareUrl: uploadResult.url,
                mimeType: mimetype,
                fileExtension: filename?.split(".").pop() || "pdf",
                issueDate:
                  importedInvoice.invoiceDate || importedInvoice.createdAt,
                clientId: importedInvoice.client?._id || null,
              },
              user.id,
            )
            .catch((err) =>
              console.error("Erreur automatisation facture importée:", err),
            );

          return {
            success: true,
            invoice: importedInvoice,
            error: null,
            isDuplicate,
          };
        } catch (error) {
          console.error("Erreur importInvoiceDirect:", error);
          return {
            success: false,
            invoice: null,
            error: error.message,
            isDuplicate: false,
          };
        }
      },
    ),

    /**
     * Import en lot de factures - VERSION ULTRA-OPTIMISÉE
     *
     * Pipeline optimisé v2:
     * 0. Vérification quota utilisateur
     * 1. Batch OCR: Pré-téléchargement en masse + traitement parallèle (40 requêtes)
     * 2. Extraction + Sauvegarde en parallèle
     *
     * Performances: 100 factures en 25-35s (vs 90-120s avant)
     */
    batchImportInvoices: requireWrite("importedInvoices")(
      async (_, { workspaceId: inputWorkspaceId, files }, context) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const startTime = Date.now();

        if (files.length > MAX_BATCH_IMPORT) {
          throw createValidationError(
            `Maximum ${MAX_BATCH_IMPORT} factures par import`,
          );
        }

        // ========== PHASE 0: Vérification quota utilisateur ==========
        const { plan, quotaInfo } = await checkUserOcrQuota(
          user.id,
          workspaceId,
          files.length,
        );
        logger.debug(
          `📊 Quota OCR: ${quotaInfo.remaining} imports disponibles, ${files.length} demandés`,
        );

        const results = [];
        const errors = [];
        let successCount = 0;
        let errorCount = 0;

        // ========== PHASE 1: Batch OCR optimisé ==========
        logger.debug(
          `🚀 Démarrage import batch de ${files.length} factures...`,
        );

        const ocrResults = await hybridOcrService.batchProcessDocuments(
          files,
          workspaceId,
        );

        // Séparer succès et échecs
        const successfulOcr = ocrResults.filter((r) => r.success);
        const failedOcr = ocrResults.filter((r) => !r.success);

        // Ajouter les erreurs OCR
        failedOcr.forEach((r) => {
          errors.push(`${r.fileName}: OCR échoué - ${r.error}`);
          errorCount++;
          results.push({
            success: false,
            invoice: null,
            error: `OCR échoué: ${r.error}`,
            isDuplicate: false,
          });
        });

        logger.debug(
          `📊 OCR: ${successfulOcr.length} réussis, ${failedOcr.length} échoués`,
        );

        // ========== PHASE 2: Extraction + Sauvegarde en parallèle (optimisé) ==========
        const SAVE_BATCH_SIZE = 40; // Augmenté de 20 à 40 grâce au pool MongoDB élargi

        for (let i = 0; i < successfulOcr.length; i += SAVE_BATCH_SIZE) {
          const batch = successfulOcr.slice(i, i + SAVE_BATCH_SIZE);

          const batchResults = await Promise.all(
            batch.map(async (ocrResult, batchIndex) => {
              const fileIndex = i + batchIndex;
              const file =
                files.find((f) => f.cloudflareUrl === ocrResult.url) ||
                files[fileIndex];

              try {
                // Extraire les données avec le service d'extraction
                let invoiceData;

                if (ocrResult.result?.transaction_data) {
                  invoiceData = transformOcrToInvoiceDataV2(
                    ocrResult.result,
                    ocrResult.result,
                  );
                } else {
                  const extractionResult =
                    await invoiceExtractionService.extractInvoiceData(
                      ocrResult.result,
                    );
                  invoiceData = transformOcrToInvoiceDataV2(
                    ocrResult.result,
                    extractionResult,
                  );
                }

                // Doublons + enregistrement OCR en parallèle
                const [duplicates] = await Promise.all([
                  ImportedInvoice.findPotentialDuplicates(
                    workspaceId,
                    invoiceData.originalInvoiceNumber,
                    invoiceData.vendor?.name,
                    invoiceData.totalTTC,
                  ),
                  recordOcrUsage(user.id, workspaceId, plan, {
                    documentId: null,
                    fileName: file.fileName,
                    provider: ocrResult.result?.provider || "claude-vision",
                    success: true,
                  }),
                ]);

                const isDuplicate = duplicates.length > 0;

                const importedInvoice = new ImportedInvoice({
                  workspaceId,
                  importedBy: user.id,
                  ...invoiceData,
                  file: {
                    url: file.cloudflareUrl,
                    cloudflareKey: file.cloudflareKey,
                    originalFileName: file.fileName,
                    mimeType: file.mimeType,
                    fileSize: file.fileSize || 0,
                  },
                  isDuplicate,
                  duplicateOf: isDuplicate ? duplicates[0]._id : null,
                });

                await importedInvoice.save();

                // Automatisations fire-and-forget
                documentAutomationService
                  .executeAutomationsForExpense(
                    "INVOICE_IMPORTED",
                    workspaceId,
                    {
                      documentId: importedInvoice._id.toString(),
                      documentType: "importedInvoice",
                      documentNumber:
                        importedInvoice.originalInvoiceNumber || "",
                      clientName:
                        importedInvoice.vendor?.name ||
                        importedInvoice.client?.name ||
                        "",
                      cloudflareUrl: file.cloudflareUrl,
                      mimeType: file.mimeType,
                      fileExtension: file.fileName?.split(".").pop() || "pdf",
                      issueDate:
                        importedInvoice.invoiceDate ||
                        importedInvoice.createdAt,
                      clientId: importedInvoice.client?._id || null,
                    },
                    user.id,
                  )
                  .catch((err) =>
                    console.error(
                      "Erreur automatisation facture importée (batch):",
                      err,
                    ),
                  );

                return {
                  success: true,
                  invoice: importedInvoice,
                  error: null,
                  isDuplicate,
                  fromCache: ocrResult.fromCache,
                };
              } catch (error) {
                return {
                  success: false,
                  invoice: null,
                  error: error.message,
                  isDuplicate: false,
                };
              }
            }),
          );

          // Compiler les résultats du batch
          batchResults.forEach((result) => {
            if (result.success) {
              successCount++;
            } else {
              errorCount++;
              errors.push(`Sauvegarde échouée: ${result.error}`);
            }
            results.push(result);
          });
        }

        // ========== Résumé ==========
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const cacheHits = successfulOcr.filter((r) => r.fromCache).length;

        logger.debug(`✅ Import batch terminé en ${elapsed}s`);
        logger.debug(`   - Succès: ${successCount}/${files.length}`);
        logger.debug(`   - Depuis cache: ${cacheHits}`);
        logger.debug(`   - Erreurs: ${errorCount}`);

        return {
          success: errorCount === 0,
          totalProcessed: files.length,
          successCount,
          errorCount,
          results,
          errors,
        };
      },
    ),

    /**
     * Met à jour une facture importée
     */
    updateImportedInvoice: requireWrite("importedInvoices")(
      async (_, { id, input }, { workspaceId }) => {
        const invoice = await checkInvoiceAccess(id, workspaceId);

        // Mettre à jour les champs du vendor si fournis
        if (input.vendorName !== undefined)
          invoice.vendor.name = input.vendorName;
        if (input.vendorAddress !== undefined)
          invoice.vendor.address = input.vendorAddress;
        if (input.vendorCity !== undefined)
          invoice.vendor.city = input.vendorCity;
        if (input.vendorPostalCode !== undefined)
          invoice.vendor.postalCode = input.vendorPostalCode;
        if (input.vendorCountry !== undefined)
          invoice.vendor.country = input.vendorCountry;
        if (input.vendorSiret !== undefined)
          invoice.vendor.siret = input.vendorSiret;
        if (input.vendorVatNumber !== undefined)
          invoice.vendor.vatNumber = input.vendorVatNumber;

        // Mettre à jour les champs du client si fournis
        if (
          input.clientName !== undefined ||
          input.clientSiret !== undefined ||
          input.clientAddress !== undefined ||
          input.clientCity !== undefined ||
          input.clientPostalCode !== undefined
        ) {
          if (!invoice.client) invoice.client = {};
          if (input.clientName !== undefined)
            invoice.client.name = input.clientName;
          if (input.clientSiret !== undefined)
            invoice.client.siret = input.clientSiret;
          if (input.clientAddress !== undefined)
            invoice.client.address = input.clientAddress;
          if (input.clientCity !== undefined)
            invoice.client.city = input.clientCity;
          if (input.clientPostalCode !== undefined)
            invoice.client.postalCode = input.clientPostalCode;
        }

        // Mettre à jour les autres champs
        if (input.originalInvoiceNumber !== undefined)
          invoice.originalInvoiceNumber = input.originalInvoiceNumber;
        if (input.invoiceDate !== undefined)
          invoice.invoiceDate = input.invoiceDate
            ? new Date(input.invoiceDate)
            : null;
        if (input.dueDate !== undefined)
          invoice.dueDate = input.dueDate ? new Date(input.dueDate) : null;
        if (input.paymentDate !== undefined)
          invoice.paymentDate = input.paymentDate
            ? new Date(input.paymentDate)
            : null;
        if (input.totalHT !== undefined) invoice.totalHT = input.totalHT;
        if (input.totalVAT !== undefined) invoice.totalVAT = input.totalVAT;
        if (input.totalTTC !== undefined) invoice.totalTTC = input.totalTTC;
        if (input.currency !== undefined) invoice.currency = input.currency;
        if (input.category !== undefined) invoice.category = input.category;
        if (input.paymentMethod !== undefined)
          invoice.paymentMethod = input.paymentMethod;
        if (input.notes !== undefined) invoice.notes = input.notes;

        await invoice.save();
        return invoice;
      },
    ),

    /**
     * Valide une facture importée
     */
    validateImportedInvoice: requireWrite("importedInvoices")(
      async (_, { id }, { workspaceId }) => {
        const invoice = await checkInvoiceAccess(id, workspaceId);
        return invoice.validate();
      },
    ),

    /**
     * Rejette une facture importée
     */
    rejectImportedInvoice: requireWrite("importedInvoices")(
      async (_, { id, reason }, { workspaceId }) => {
        const invoice = await checkInvoiceAccess(id, workspaceId);
        return invoice.reject(reason);
      },
    ),

    /**
     * Archive une facture importée
     */
    archiveImportedInvoice: requireWrite("importedInvoices")(
      async (_, { id }, { workspaceId }) => {
        const invoice = await checkInvoiceAccess(id, workspaceId);
        return invoice.archive();
      },
    ),

    /**
     * Supprime une facture importée (et son fichier PDF sur Cloudflare)
     */
    deleteImportedInvoice: requireDelete("importedInvoices")(
      async (_, { id }, { workspaceId }) => {
        const invoice = await checkInvoiceAccess(id, workspaceId);

        // Supprimer le fichier PDF sur Cloudflare si présent
        const cloudflareKey = invoice.file?.cloudflareKey;
        if (cloudflareKey) {
          try {
            await cloudflareService.deleteImage(
              cloudflareKey,
              cloudflareService.importedInvoicesBucketName,
            );
            logger.debug(`🗑️ Fichier Cloudflare supprimé: ${cloudflareKey}`);
          } catch (error) {
            console.error(`⚠️ Erreur suppression Cloudflare: ${error.message}`);
            // On continue la suppression même si Cloudflare échoue
          }
        }

        await ImportedInvoice.findOneAndDelete({ _id: id, workspaceId });
        return true;
      },
    ),

    /**
     * Supprime plusieurs factures importées (et leurs fichiers PDF sur Cloudflare)
     */
    deleteImportedInvoices: requireDelete("importedInvoices")(
      async (_, { ids }, { workspaceId }) => {
        // Récupérer les factures pour avoir les cloudflareKeys (IDOR fix: filtre par workspaceId)
        const invoices = await ImportedInvoice.find({
          _id: { $in: ids },
          workspaceId,
        }).lean();

        // Supprimer les fichiers PDF sur Cloudflare
        for (const invoice of invoices) {
          const cloudflareKey = invoice.file?.cloudflareKey;
          if (cloudflareKey) {
            try {
              await cloudflareService.deleteImage(
                cloudflareKey,
                cloudflareService.importedInvoicesBucketName,
              );
              logger.debug(`🗑️ Fichier Cloudflare supprimé: ${cloudflareKey}`);
            } catch (error) {
              console.error(
                `⚠️ Erreur suppression Cloudflare: ${error.message}`,
              );
              // On continue même si Cloudflare échoue
            }
          }
        }

        const result = await ImportedInvoice.deleteMany({
          _id: { $in: ids },
          workspaceId,
        });
        return result.deletedCount;
      },
    ),

    /**
     * Achète des imports OCR supplémentaires
     * Note: Cette mutation enregistre l'achat. L'intégration Stripe est à implémenter
     * selon votre configuration de paiement existante.
     */
    purchaseExtraOcrImports: requireWrite("importedInvoices")(
      async (
        _,
        { workspaceId: inputWorkspaceId, quantity, paymentId },
        context,
      ) => {
        const { user } = context;
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        if (quantity < 1 || quantity > 1000) {
          throw createValidationError(
            "Quantité invalide. Minimum 1, maximum 1000 imports.",
          );
        }

        const plan = await getUserPlan(user.id, workspaceId);

        // Enregistrer l'achat
        const result = await UserOcrQuota.addExtraImports(
          user.id,
          workspaceId,
          plan,
          quantity,
          paymentId,
        );

        return {
          success: true,
          quantity,
          extraImportsAvailable: result.extraImportsAvailable,
          totalSpent: result.totalSpent,
          message: `${quantity} import(s) supplémentaire(s) ajouté(s) avec succès.`,
        };
      },
    ),

    /**
     * Convertit une facture importée en facture d'achat (PurchaseInvoice)
     */
    convertImportedInvoiceToPurchaseInvoice: requireWrite("importedInvoices")(
      async (_, { id }, { user, workspaceId }) => {
        const importedInvoice = await ImportedInvoice.findOne({
          _id: id,
          workspaceId,
        });
        if (!importedInvoice) {
          throw createNotFoundError("Facture importée introuvable");
        }
        if (importedInvoice.status !== "PENDING_REVIEW") {
          throw createValidationError(
            `Impossible de convertir : statut actuel "${importedInvoice.status}" (attendu PENDING_REVIEW)`,
          );
        }
        return convertSingleImportedInvoice(importedInvoice, user.id);
      },
    ),

    /**
     * Convertit plusieurs factures importées en factures d'achat
     */
    convertImportedInvoicesToPurchaseInvoices: requireWrite("importedInvoices")(
      async (_, { ids }, { user, workspaceId }) => {
        let converted = 0;
        let skipped = 0;
        let errors = 0;

        // Batch-load toutes les factures importées en une seule query (IDOR fix: filtre par workspaceId)
        const importedInvoices = await ImportedInvoice.find({
          _id: { $in: ids },
          status: "PENDING_REVIEW",
          workspaceId,
        });
        const invoiceMap = new Map(
          importedInvoices.map((inv) => [inv._id.toString(), inv]),
        );

        for (const id of ids) {
          try {
            const importedInvoice = invoiceMap.get(id.toString());
            if (!importedInvoice) {
              skipped++;
              continue;
            }
            await convertSingleImportedInvoice(importedInvoice, user.id);
            converted++;
          } catch (err) {
            console.error(
              `Erreur conversion facture importée ${id}:`,
              err.message,
            );
            errors++;
          }
        }

        return {
          success: errors === 0,
          converted,
          skipped,
          errors,
          message: `${converted} convertie(s), ${skipped} ignorée(s), ${errors} erreur(s)`,
        };
      },
    ),
  },

  // Resolvers de champs
  ImportedInvoice: {
    id: (parent) => parent._id?.toString() || parent.id,
    workspaceId: (parent) => parent.workspaceId?.toString(),
    importedBy: (parent) => parent.importedBy?.toString(),
    linkedExpenseId: (parent) => parent.linkedExpenseId?.toString() || null,
    duplicateOf: (parent) => parent.duplicateOf?.toString() || null,
    invoiceDate: (parent) => parent.invoiceDate?.toISOString() || null,
    dueDate: (parent) => parent.dueDate?.toISOString() || null,
    paymentDate: (parent) => parent.paymentDate?.toISOString() || null,
    createdAt: (parent) => parent.createdAt?.toISOString(),
    updatedAt: (parent) => parent.updatedAt?.toISOString(),
    ocrData: (parent) => ({
      extractedText: parent.ocrData?.extractedText || "",
      confidence: parent.ocrData?.confidence || 0,
      processedAt: parent.ocrData?.processedAt?.toISOString() || null,
    }),
  },
};

// Wrap all mutations with subscription check
const _origMutations_importedInvoiceResolvers =
  importedInvoiceResolvers.Mutation;
importedInvoiceResolvers.Mutation = Object.fromEntries(
  Object.entries(_origMutations_importedInvoiceResolvers).map(([name, fn]) => [
    name,
    async (parent, args, context, info) => {
      await checkSubscriptionActive(context);
      return fn(parent, args, context, info);
    },
  ]),
);

export default importedInvoiceResolvers;
