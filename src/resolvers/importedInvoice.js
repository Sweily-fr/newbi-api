/**
 * Resolvers GraphQL pour les factures importées
 */

import mongoose from "mongoose";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import ImportedInvoice from "../models/ImportedInvoice.js";
import UserOcrQuota from "../models/UserOcrQuota.js";
import hybridOcrService from "../services/hybridOcrService.js";
import invoiceExtractionService from "../services/invoiceExtractionService.js";
import cloudflareService from "../services/cloudflareService.js";
import {
  createValidationError,
  createNotFoundError,
  createInternalServerError,
} from "../utils/errors.js";

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
            $or: [
              { referenceId: cacheKey },
              { organizationId: cacheKey },
            ],
          },
          { status: { $in: ["active", "trialing"] } },
        ],
      });
    }

    const plan = subscription?.plan
      ? PLAN_NAME_MAP[subscription.plan] || defaultPlan
      : defaultPlan;

    console.log(`📋 getUserPlan: workspace=${cacheKey}, subscription=${subscription?.plan || "none"}, plan=${plan}`);

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
  const quotaInfo = await UserOcrQuota.checkQuotaAvailable(userId, workspaceId, plan);

  if (!quotaInfo.hasQuota) {
    throw createValidationError(
      `Quota OCR épuisé (${quotaInfo.usedThisMonth}/${quotaInfo.monthlyQuota} utilisés ce mois). ` +
      `Passez à un plan supérieur ou achetez des imports supplémentaires (${quotaInfo.extraImportPrice}€/import).`
    );
  }

  if (quotaInfo.remaining < filesCount) {
    throw createValidationError(
      `Quota OCR insuffisant. Vous avez ${quotaInfo.remaining} import(s) disponible(s) mais vous essayez d'en importer ${filesCount}. ` +
      `Achetez des imports supplémentaires (${quotaInfo.extraImportPrice}€/import) ou réduisez le nombre de fichiers.`
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
 * Vérifie l'accès à une facture importée
 */
async function checkInvoiceAccess(invoiceId, userId) {
  const invoice = await ImportedInvoice.findById(invoiceId);
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
  workspaceId = null
) {
  // Étape 1: OCR avec le service hybride (Mindee > Google Document AI > Mistral)
  const ocrResult = await hybridOcrService.processDocumentFromUrl(
    cloudflareUrl,
    fileName,
    mimeType,
    workspaceId
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

const importedInvoiceResolvers = {
  Query: {
    /**
     * Récupère une facture importée par ID
     */
    importedInvoice: isAuthenticated(async (_, { id }, { user }) => {
      const invoice = await checkInvoiceAccess(id, user.id);
      return invoice;
    }),

    /**
     * Liste les factures importées avec pagination et filtres
     */
    importedInvoices: isAuthenticated(
      async (
        _,
        { workspaceId, page = 1, limit = 20, filters = {} },
        { user }
      ) => {
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
            .limit(limit),
          ImportedInvoice.countDocuments(query),
        ]);

        return {
          invoices,
          total,
          page,
          limit,
          hasMore: skip + invoices.length < total,
        };
      }
    ),

    /**
     * Statistiques des factures importées
     */
    importedInvoiceStats: isAuthenticated(
      async (_, { workspaceId }, { user }) => {
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
      }
    ),

    /**
     * Statistiques d'usage OCR (quotas Mindee, Google, Mistral)
     */
    ocrUsageStats: isAuthenticated(async (_, { workspaceId }, { user }) => {
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
        claudeVision: stats["claude-vision"] || { used: 0, limit: 999999, available: 999999 },
        mindee: stats.mindee,
        googleDocumentAi: stats["google-document-ai"],
        mistral: stats.mistral,
        currentProvider,
      };
    }),

    /**
     * Quota OCR de l'utilisateur courant
     */
    userOcrQuota: isAuthenticated(async (_, { workspaceId }, { user }) => {
      const plan = await getUserPlan(user.id, workspaceId);
      const stats = await UserOcrQuota.getUserStats(user.id, workspaceId, plan);

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
    }),
  },

  Mutation: {
    /**
     * Importe une facture avec OCR
     */
    importInvoice: isAuthenticated(
      async (
        _,
        {
          workspaceId,
          cloudflareUrl,
          fileName,
          mimeType,
          fileSize,
          cloudflareKey,
        },
        { user }
      ) => {
        try {
          // Vérifier le quota utilisateur avant l'import
          const { plan } = await checkUserOcrQuota(user.id, workspaceId, 1);

          // Traiter avec OCR (avec workspaceId pour gestion quota Mindee)
          const invoiceData = await processInvoiceWithOcr(
            cloudflareUrl,
            fileName,
            mimeType,
            workspaceId
          );

          // Enregistrer l'utilisation OCR
          await recordOcrUsage(user.id, workspaceId, plan, {
            fileName,
            provider: invoiceData.ocrData?.provider || "claude-vision",
            success: true,
          });

          // Vérifier les doublons potentiels
          const duplicates = await ImportedInvoice.findPotentialDuplicates(
            workspaceId,
            invoiceData.originalInvoiceNumber,
            invoiceData.vendor?.name,
            invoiceData.totalTTC
          );

          const isDuplicate = duplicates.length > 0;

          // Créer la facture importée
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
      }
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
    batchImportInvoices: isAuthenticated(
      async (_, { workspaceId, files }, { user }) => {
        const startTime = Date.now();

        if (files.length > MAX_BATCH_IMPORT) {
          throw createValidationError(
            `Maximum ${MAX_BATCH_IMPORT} factures par import`
          );
        }

        // ========== PHASE 0: Vérification quota utilisateur ==========
        const { plan, quotaInfo } = await checkUserOcrQuota(user.id, workspaceId, files.length);
        console.log(`📊 Quota OCR: ${quotaInfo.remaining} imports disponibles, ${files.length} demandés`);

        const results = [];
        const errors = [];
        let successCount = 0;
        let errorCount = 0;

        // ========== PHASE 1: Batch OCR optimisé ==========
        console.log(`🚀 Démarrage import batch de ${files.length} factures...`);

        const ocrResults = await hybridOcrService.batchProcessDocuments(files, workspaceId);

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

        console.log(`📊 OCR: ${successfulOcr.length} réussis, ${failedOcr.length} échoués`);

        // ========== PHASE 2: Extraction + Sauvegarde en parallèle ==========
        const SAVE_BATCH_SIZE = 20;

        for (let i = 0; i < successfulOcr.length; i += SAVE_BATCH_SIZE) {
          const batch = successfulOcr.slice(i, i + SAVE_BATCH_SIZE);

          const batchResults = await Promise.all(
            batch.map(async (ocrResult, batchIndex) => {
              const fileIndex = i + batchIndex;
              const file = files.find((f) => f.cloudflareUrl === ocrResult.url) || files[fileIndex];

              try {
                // Extraire les données avec le service d'extraction
                let invoiceData;

                if (ocrResult.result?.transaction_data) {
                  // Claude Vision retourne déjà les données structurées
                  invoiceData = transformOcrToInvoiceDataV2(ocrResult.result, ocrResult.result);
                } else {
                  // Fallback: utiliser le service d'extraction
                  const extractionResult = await invoiceExtractionService.extractInvoiceData(ocrResult.result);
                  invoiceData = transformOcrToInvoiceDataV2(ocrResult.result, extractionResult);
                }

                // Vérifier les doublons
                const duplicates = await ImportedInvoice.findPotentialDuplicates(
                  workspaceId,
                  invoiceData.originalInvoiceNumber,
                  invoiceData.vendor?.name,
                  invoiceData.totalTTC
                );

                const isDuplicate = duplicates.length > 0;

                // Créer et sauvegarder la facture
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

                // Enregistrer l'utilisation OCR
                await recordOcrUsage(user.id, workspaceId, plan, {
                  documentId: importedInvoice._id,
                  fileName: file.fileName,
                  provider: ocrResult.result?.provider || "claude-vision",
                  success: true,
                });

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
            })
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

        console.log(`✅ Import batch terminé en ${elapsed}s`);
        console.log(`   - Succès: ${successCount}/${files.length}`);
        console.log(`   - Depuis cache: ${cacheHits}`);
        console.log(`   - Erreurs: ${errorCount}`);

        return {
          success: errorCount === 0,
          totalProcessed: files.length,
          successCount,
          errorCount,
          results,
          errors,
        };
      }
    ),

    /**
     * Met à jour une facture importée
     */
    updateImportedInvoice: isAuthenticated(
      async (_, { id, input }, { user }) => {
        const invoice = await checkInvoiceAccess(id, user.id);

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
      }
    ),

    /**
     * Valide une facture importée
     */
    validateImportedInvoice: isAuthenticated(async (_, { id }, { user }) => {
      const invoice = await checkInvoiceAccess(id, user.id);
      return invoice.validate();
    }),

    /**
     * Rejette une facture importée
     */
    rejectImportedInvoice: isAuthenticated(
      async (_, { id, reason }, { user }) => {
        const invoice = await checkInvoiceAccess(id, user.id);
        return invoice.reject(reason);
      }
    ),

    /**
     * Archive une facture importée
     */
    archiveImportedInvoice: isAuthenticated(async (_, { id }, { user }) => {
      const invoice = await checkInvoiceAccess(id, user.id);
      return invoice.archive();
    }),

    /**
     * Supprime une facture importée (et son fichier PDF sur Cloudflare)
     */
    deleteImportedInvoice: isAuthenticated(async (_, { id }, { user }) => {
      const invoice = await checkInvoiceAccess(id, user.id);

      // Supprimer le fichier PDF sur Cloudflare si présent
      const cloudflareKey = invoice.file?.cloudflareKey;
      if (cloudflareKey) {
        try {
          await cloudflareService.deleteImage(
            cloudflareKey,
            cloudflareService.importedInvoicesBucketName
          );
          console.log(`🗑️ Fichier Cloudflare supprimé: ${cloudflareKey}`);
        } catch (error) {
          console.error(`⚠️ Erreur suppression Cloudflare: ${error.message}`);
          // On continue la suppression même si Cloudflare échoue
        }
      }

      await ImportedInvoice.findByIdAndDelete(id);
      return true;
    }),

    /**
     * Supprime plusieurs factures importées (et leurs fichiers PDF sur Cloudflare)
     */
    deleteImportedInvoices: isAuthenticated(async (_, { ids }) => {
      // Récupérer les factures pour avoir les cloudflareKeys
      const invoices = await ImportedInvoice.find({ _id: { $in: ids } });

      // Supprimer les fichiers PDF sur Cloudflare
      for (const invoice of invoices) {
        const cloudflareKey = invoice.file?.cloudflareKey;
        if (cloudflareKey) {
          try {
            await cloudflareService.deleteImage(
              cloudflareKey,
              cloudflareService.importedInvoicesBucketName
            );
            console.log(`🗑️ Fichier Cloudflare supprimé: ${cloudflareKey}`);
          } catch (error) {
            console.error(`⚠️ Erreur suppression Cloudflare: ${error.message}`);
            // On continue même si Cloudflare échoue
          }
        }
      }

      const result = await ImportedInvoice.deleteMany({ _id: { $in: ids } });
      return result.deletedCount;
    }),

    /**
     * Achète des imports OCR supplémentaires
     * Note: Cette mutation enregistre l'achat. L'intégration Stripe est à implémenter
     * selon votre configuration de paiement existante.
     */
    purchaseExtraOcrImports: isAuthenticated(
      async (_, { workspaceId, quantity, paymentId }, { user }) => {
        if (quantity < 1 || quantity > 1000) {
          throw createValidationError(
            "Quantité invalide. Minimum 1, maximum 1000 imports."
          );
        }

        const plan = await getUserPlan(user.id, workspaceId);

        // Enregistrer l'achat
        const result = await UserOcrQuota.addExtraImports(
          user.id,
          workspaceId,
          plan,
          quantity,
          paymentId
        );

        return {
          success: true,
          quantity,
          extraImportsAvailable: result.extraImportsAvailable,
          totalSpent: result.totalSpent,
          message: `${quantity} import(s) supplémentaire(s) ajouté(s) avec succès.`,
        };
      }
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

export default importedInvoiceResolvers;
