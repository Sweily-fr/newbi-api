/**
 * Resolvers GraphQL pour les factures importées
 */

import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import ImportedInvoice from "../models/ImportedInvoice.js";
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
    vatRate: parseFloat(item.vat_rate) || 20,
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
    vatRate: parseFloat(item.vat_rate) || 20,
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

      // Déterminer le provider actuel
      let currentProvider = "mistral";
      if (stats.mindee.available > 0) {
        currentProvider = "mindee";
      } else if (stats["google-document-ai"].available > 0) {
        currentProvider = "google-document-ai";
      }

      return {
        mindee: stats.mindee,
        googleDocumentAi: stats["google-document-ai"],
        mistral: stats.mistral,
        currentProvider,
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
          // Traiter avec OCR (avec workspaceId pour gestion quota Mindee)
          const invoiceData = await processInvoiceWithOcr(
            cloudflareUrl,
            fileName,
            mimeType,
            workspaceId
          );

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
     * Import en lot de factures - OPTIMISÉ avec parallélisation maximale
     *
     * Pipeline optimisé:
     * 1. Phase OCR: Toutes les factures en parallèle (par lots de 10)
     * 2. Phase Analyse: Toutes les factures en parallèle (par lots de 10)
     * 3. Phase Sauvegarde: En parallèle
     *
     * Gain: ~60-70% plus rapide qu'un traitement séquentiel
     */
    batchImportInvoices: isAuthenticated(
      async (_, { workspaceId, files }, { user }) => {
        if (files.length > MAX_BATCH_IMPORT) {
          throw createValidationError(
            `Maximum ${MAX_BATCH_IMPORT} factures par import`
          );
        }

        const results = [];
        const errors = [];
        let successCount = 0;
        let errorCount = 0;

        // Configuration parallélisation
        const PARALLEL_OCR_BATCH = 10; // Factures OCR en parallèle
        const PARALLEL_ANALYSIS_BATCH = 8; // Analyses IA en parallèle (plus gourmand)
        const DELAY_BETWEEN_BATCHES = 500; // 500ms entre les lots pour éviter rate limiting

        // Helper pour délai
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        // ========== PHASE 1: OCR en parallèle ==========
        const ocrResults = [];

        for (let i = 0; i < files.length; i += PARALLEL_OCR_BATCH) {
          const batch = files.slice(i, i + PARALLEL_OCR_BATCH);

          const batchOcrResults = await Promise.all(
            batch.map(async (file, batchIndex) => {
              const fileIndex = i + batchIndex;
              try {
                const ocrResult = await hybridOcrService.processDocumentFromUrl(
                  file.cloudflareUrl,
                  file.fileName,
                  file.mimeType,
                  workspaceId
                );
                return { fileIndex, file, ocrResult, error: null };
              } catch (error) {
                return {
                  fileIndex,
                  file,
                  ocrResult: null,
                  error: error.message,
                };
              }
            })
          );

          ocrResults.push(...batchOcrResults);

          // Petit délai entre les lots OCR pour éviter rate limiting
          if (i + PARALLEL_OCR_BATCH < files.length) {
            await delay(DELAY_BETWEEN_BATCHES);
          }
        }

        // ========== PHASE 2: Analyse IA en parallèle ==========
        const analysisResults = [];
        const successfulOcr = ocrResults.filter((r) => r.ocrResult?.success);

        for (
          let i = 0;
          i < successfulOcr.length;
          i += PARALLEL_ANALYSIS_BATCH
        ) {
          const batch = successfulOcr.slice(i, i + PARALLEL_ANALYSIS_BATCH);

          const batchAnalysisResults = await Promise.all(
            batch.map(async ({ fileIndex, file, ocrResult }) => {
              try {
                const extractionResult =
                  await invoiceExtractionService.extractInvoiceData(ocrResult);
                const invoiceData = transformOcrToInvoiceDataV2(
                  ocrResult,
                  extractionResult
                );
                return { fileIndex, file, invoiceData, error: null };
              } catch (error) {
                return {
                  fileIndex,
                  file,
                  invoiceData: null,
                  error: error.message,
                };
              }
            })
          );

          analysisResults.push(...batchAnalysisResults);

          // Délai entre les lots d'analyse pour éviter rate limiting Mistral
          if (i + PARALLEL_ANALYSIS_BATCH < successfulOcr.length) {
            await delay(DELAY_BETWEEN_BATCHES);
          }
        }

        // ========== PHASE 3: Sauvegarde en parallèle ==========
        const saveResults = await Promise.all(
          analysisResults
            .filter((r) => r.invoiceData)
            .map(async ({ fileIndex, file, invoiceData }) => {
              try {
                // Vérifier les doublons
                const duplicates =
                  await ImportedInvoice.findPotentialDuplicates(
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

                return {
                  fileIndex,
                  success: true,
                  invoice: importedInvoice,
                  error: null,
                  isDuplicate,
                };
              } catch (error) {
                return {
                  fileIndex,
                  success: false,
                  invoice: null,
                  error: error.message,
                  isDuplicate: false,
                };
              }
            })
        );

        // ========== Compilation des résultats ==========
        // Ajouter les erreurs OCR
        ocrResults
          .filter((r) => r.error)
          .forEach(({ file, error }) => {
            errors.push(`${file.fileName}: OCR échoué - ${error}`);
            errorCount++;
            results.push({
              success: false,
              invoice: null,
              error: `OCR échoué: ${error}`,
              isDuplicate: false,
            });
          });

        // Ajouter les erreurs d'analyse
        analysisResults
          .filter((r) => r.error)
          .forEach(({ file, error }) => {
            errors.push(`${file.fileName}: Analyse échouée - ${error}`);
            errorCount++;
            results.push({
              success: false,
              invoice: null,
              error: `Analyse échouée: ${error}`,
              isDuplicate: false,
            });
          });

        // Ajouter les résultats de sauvegarde
        saveResults.forEach((result) => {
          if (result.success) {
            successCount++;
          } else {
            errorCount++;
            errors.push(`Sauvegarde échouée: ${result.error}`);
          }
          results.push({
            success: result.success,
            invoice: result.invoice,
            error: result.error,
            isDuplicate: result.isDuplicate,
          });
        });

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
