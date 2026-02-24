/**
 * Resolvers GraphQL pour les devis importés
 */

import mongoose from "mongoose";
import crypto from "crypto";
import { GraphQLUpload } from "graphql-upload";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import ImportedQuote from "../models/ImportedQuote.js";
import UserOcrQuota from "../models/UserOcrQuota.js";
import claudeVisionOcrService from "../services/claudeVisionOcrService.js";
import invoiceExtractionService from "../services/invoiceExtractionService.js";
import cloudflareService from "../services/cloudflareService.js";
import {
  createValidationError,
  createNotFoundError,
  createInternalServerError,
} from "../utils/errors.js";
import documentAutomationService from "../services/documentAutomationService.js";

// Cache mémoire pour les plans utilisateurs
const planCache = new Map();
const PLAN_CACHE_TTL = 5 * 60 * 1000;

const PLAN_NAME_MAP = {
  freelance: "FREELANCE",
  pme: "TPE",
  entreprise: "ENTREPRISE",
};

async function getUserPlan(userId, workspaceId) {
  const defaultPlan = process.env.DEFAULT_USER_PLAN || "FREE";

  if (!workspaceId) {
    return defaultPlan;
  }

  const cacheKey = String(workspaceId);
  const cached = planCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PLAN_CACHE_TTL) {
    return cached.plan;
  }

  try {
    const db = mongoose.connection.db;
    if (!db) {
      return defaultPlan;
    }

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

    planCache.set(cacheKey, { plan, timestamp: Date.now() });
    return plan;
  } catch (error) {
    console.warn("⚠️ Erreur récupération plan utilisateur:", error.message);
    return defaultPlan;
  }
}

async function checkUserOcrQuota(userId, workspaceId, filesCount = 1) {
  const plan = await getUserPlan(userId, workspaceId);
  const quotaInfo = await UserOcrQuota.checkQuotaAvailable(userId, workspaceId, plan);

  if (!quotaInfo.hasQuota) {
    throw createValidationError(
      `Quota OCR épuisé (${quotaInfo.usedThisMonth}/${quotaInfo.monthlyQuota} utilisés ce mois). ` +
      `Passez à un plan supérieur pour augmenter votre quota.`
    );
  }

  if (quotaInfo.remaining < filesCount) {
    throw createValidationError(
      `Quota OCR insuffisant. Vous avez ${quotaInfo.remaining} import(s) disponible(s) mais vous essayez d'en importer ${filesCount}. ` +
      `Réduisez le nombre de fichiers ou passez à un plan supérieur.`
    );
  }

  return { plan, quotaInfo };
}

async function recordOcrUsage(userId, workspaceId, plan, documentInfo) {
  try {
    await UserOcrQuota.recordUsage(userId, workspaceId, plan, documentInfo);
  } catch (error) {
    console.warn("⚠️ Erreur enregistrement usage OCR:", error.message);
  }
}

async function checkQuoteAccess(quoteId, userId) {
  const quote = await ImportedQuote.findById(quoteId);
  if (!quote) {
    throw createNotFoundError("Devis importé non trouvé");
  }
  return quote;
}

/**
 * Transforme les données d'extraction en données de devis
 */
function transformOcrToQuoteData(ocrResult, extractionResult) {
  const transactionData = extractionResult?.transaction_data || {};
  const extractedFields = extractionResult?.extracted_fields || {};
  const documentAnalysis = extractionResult?.document_analysis || {};

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

  const paymentMethodMap = {
    card: "CARD",
    cash: "CASH",
    check: "CHECK",
    transfer: "TRANSFER",
    direct_debit: "DIRECT_DEBIT",
    unknown: "UNKNOWN",
  };

  let quoteDate = null;
  if (transactionData.transaction_date) {
    try {
      quoteDate = new Date(transactionData.transaction_date);
      if (isNaN(quoteDate.getTime())) quoteDate = null;
    } catch (e) {
      quoteDate = null;
    }
  }

  let validUntil = null;
  if (transactionData.due_date) {
    try {
      validUntil = new Date(transactionData.due_date);
      if (isNaN(validUntil.getTime())) validUntil = null;
    } catch (e) {
      validUntil = null;
    }
  }

  const items = (extractedFields.items || []).map((item) => ({
    description: item.description || "",
    quantity: parseFloat(item.quantity) || 1,
    unitPrice:
      parseFloat(item.unit_price_ht) || parseFloat(item.unit_price_ttc) || 0,
    totalPrice: parseFloat(item.total_ttc) || parseFloat(item.total_ht) || 0,
    vatRate: item.vat_rate != null ? parseFloat(item.vat_rate) : 20,
    productCode: item.code || null,
  }));

  const totals = extractedFields.totals || {};

  return {
    originalQuoteNumber: transactionData.document_number || null,
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
    client: {
      name: extractedFields.client_name || transactionData.client_name || null,
      address: extractedFields.client_address || null,
      city: extractedFields.client_city || null,
      postalCode: extractedFields.client_postal_code || null,
      siret: extractedFields.client_siret || null,
      clientNumber:
        extractedFields.client_number || transactionData.client_number || null,
    },
    quoteDate,
    validUntil,
    totalHT: parseFloat(totals.total_ht) || 0,
    totalVAT:
      parseFloat(totals.total_tax) ||
      parseFloat(transactionData.tax_amount) ||
      0,
    totalTTC:
      parseFloat(totals.total_ttc) || parseFloat(transactionData.amount) || 0,
    currency: transactionData.currency || "EUR",
    items,
    category: categoryMap[transactionData.category?.toUpperCase()] || "OTHER",
    paymentMethod:
      paymentMethodMap[transactionData.payment_method?.toLowerCase()] ||
      "UNKNOWN",
    ocrData: {
      extractedText: ocrResult.extractedText || "",
      rawData: ocrResult.data || {},
      financialAnalysis: extractionResult || {},
      confidence: documentAnalysis.confidence || 0,
      processedAt: new Date(),
    },
  };
}

const importedQuoteResolvers = {
  Upload: GraphQLUpload,

  Query: {
    importedQuote: isAuthenticated(async (_, { id }, { user }) => {
      const quote = await checkQuoteAccess(id, user.id);
      return quote;
    }),

    importedQuotes: isAuthenticated(
      async (
        _,
        { workspaceId, page = 1, limit = 20, filters = {} },
        { user }
      ) => {
        const query = { workspaceId };

        if (filters.status) query.status = filters.status;
        if (filters.category) query.category = filters.category;
        if (filters.vendorName) {
          query["vendor.name"] = {
            $regex: new RegExp(filters.vendorName, "i"),
          };
        }
        if (filters.dateFrom || filters.dateTo) {
          query.quoteDate = {};
          if (filters.dateFrom) query.quoteDate.$gte = new Date(filters.dateFrom);
          if (filters.dateTo) query.quoteDate.$lte = new Date(filters.dateTo);
        }
        if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
          query.totalTTC = {};
          if (filters.minAmount !== undefined) query.totalTTC.$gte = filters.minAmount;
          if (filters.maxAmount !== undefined) query.totalTTC.$lte = filters.maxAmount;
        }

        const skip = (page - 1) * limit;
        const [quotes, total] = await Promise.all([
          ImportedQuote.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
          ImportedQuote.countDocuments(query),
        ]);

        return {
          quotes,
          total,
          page,
          limit,
          hasMore: skip + quotes.length < total,
        };
      }
    ),

    importedQuoteStats: isAuthenticated(
      async (_, { workspaceId }, { user }) => {
        const stats = await ImportedQuote.getStats(workspaceId);

        const result = {
          pendingReview: 0,
          validated: 0,
          rejected: 0,
          archived: 0,
          totalAmount: 0,
        };

        stats.forEach((stat) => {
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
  },

  Mutation: {
    importQuoteDirect: isAuthenticated(
      async (_, { file, workspaceId }, { user }) => {
        try {
          const { plan } = await checkUserOcrQuota(user.id, workspaceId, 1);

          const { createReadStream, filename, mimetype } = await file;

          if (!filename) {
            throw createValidationError("Nom de fichier requis");
          }

          const stream = createReadStream();
          const chunks = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          const fileBuffer = Buffer.concat(chunks);

          const maxSize = 10 * 1024 * 1024;
          if (fileBuffer.length > maxSize) {
            throw createValidationError("Fichier trop volumineux (max 10MB)");
          }

          const base64Data = fileBuffer.toString("base64");
          const contentHash = crypto
            .createHash("sha256")
            .update(fileBuffer)
            .digest("hex");

          console.log(`🔍 importQuoteDirect: OCR direct pour ${filename}`);
          const rawResult = await claudeVisionOcrService.processFromBase64(
            base64Data,
            mimetype,
            filename,
            contentHash
          );

          if (!rawResult.success) {
            throw createInternalServerError(
              `Erreur OCR: ${rawResult.error || rawResult.message}`
            );
          }

          const structuredResult = claudeVisionOcrService.toInvoiceFormat(rawResult);

          let quoteData;
          if (structuredResult.transaction_data) {
            quoteData = transformOcrToQuoteData(structuredResult, structuredResult);
          } else {
            const extractionResult = await invoiceExtractionService.extractInvoiceData(structuredResult);
            quoteData = transformOcrToQuoteData(structuredResult, extractionResult);
          }

          let organizationId = null;
          const rawOrgId =
            user.organizationId ||
            user.organization?.id ||
            user.organization?._id ||
            user.currentOrganizationId;

          if (rawOrgId) {
            organizationId = typeof rawOrgId === "object"
              ? (rawOrgId._id?.toString() || rawOrgId.id?.toString() || rawOrgId.toString())
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
              console.warn("⚠️ Impossible de récupérer organizationId:", err.message);
            }
          }

          console.log(`☁️ Upload Cloudflare serveur-à-serveur pour ${filename}`);
          const uploadResult = await cloudflareService.uploadImage(
            fileBuffer,
            filename,
            user.id,
            "importedQuote",
            organizationId
          );

          await recordOcrUsage(user.id, workspaceId, plan, {
            fileName: filename,
            provider: rawResult.provider || "claude-vision",
            success: true,
          });

          const duplicates = await ImportedQuote.findPotentialDuplicates(
            workspaceId,
            quoteData.originalQuoteNumber,
            quoteData.vendor?.name,
            quoteData.totalTTC
          );

          const isDuplicate = duplicates.length > 0;

          const importedQuote = new ImportedQuote({
            workspaceId,
            importedBy: user.id,
            ...quoteData,
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

          await importedQuote.save();

          // Déclencher les automatisations QUOTE_IMPORTED (fire-and-forget)
          documentAutomationService.executeAutomationsForExpense('QUOTE_IMPORTED', workspaceId, {
            documentId: importedQuote._id.toString(),
            documentType: 'importedQuote',
            documentNumber: importedQuote.originalQuoteNumber || '',
            clientName: importedQuote.vendor?.name || importedQuote.client?.name || '',
            cloudflareUrl: uploadResult.url,
            mimeType: mimetype,
            fileExtension: filename?.split('.').pop() || 'pdf',
          }, user.id).catch(err => console.error('Erreur automatisation devis importé:', err));

          return {
            success: true,
            quote: importedQuote,
            error: null,
            isDuplicate,
          };
        } catch (error) {
          console.error("Erreur importQuoteDirect:", error);
          return {
            success: false,
            quote: null,
            error: error.message,
            isDuplicate: false,
          };
        }
      }
    ),

    updateImportedQuote: isAuthenticated(
      async (_, { id, input }, { user }) => {
        const quote = await checkQuoteAccess(id, user.id);

        if (input.vendorName !== undefined) quote.vendor.name = input.vendorName;
        if (input.vendorAddress !== undefined) quote.vendor.address = input.vendorAddress;
        if (input.vendorCity !== undefined) quote.vendor.city = input.vendorCity;
        if (input.vendorPostalCode !== undefined) quote.vendor.postalCode = input.vendorPostalCode;
        if (input.vendorCountry !== undefined) quote.vendor.country = input.vendorCountry;
        if (input.vendorSiret !== undefined) quote.vendor.siret = input.vendorSiret;
        if (input.vendorVatNumber !== undefined) quote.vendor.vatNumber = input.vendorVatNumber;

        if (input.clientName !== undefined || input.clientSiret !== undefined ||
            input.clientAddress !== undefined || input.clientCity !== undefined ||
            input.clientPostalCode !== undefined) {
          if (!quote.client) quote.client = {};
          if (input.clientName !== undefined) quote.client.name = input.clientName;
          if (input.clientSiret !== undefined) quote.client.siret = input.clientSiret;
          if (input.clientAddress !== undefined) quote.client.address = input.clientAddress;
          if (input.clientCity !== undefined) quote.client.city = input.clientCity;
          if (input.clientPostalCode !== undefined) quote.client.postalCode = input.clientPostalCode;
        }

        if (input.originalQuoteNumber !== undefined) quote.originalQuoteNumber = input.originalQuoteNumber;
        if (input.quoteDate !== undefined) quote.quoteDate = input.quoteDate ? new Date(input.quoteDate) : null;
        if (input.validUntil !== undefined) quote.validUntil = input.validUntil ? new Date(input.validUntil) : null;
        if (input.dueDate !== undefined) quote.dueDate = input.dueDate ? new Date(input.dueDate) : null;
        if (input.totalHT !== undefined) quote.totalHT = input.totalHT;
        if (input.totalVAT !== undefined) quote.totalVAT = input.totalVAT;
        if (input.totalTTC !== undefined) quote.totalTTC = input.totalTTC;
        if (input.currency !== undefined) quote.currency = input.currency;
        if (input.category !== undefined) quote.category = input.category;
        if (input.paymentMethod !== undefined) quote.paymentMethod = input.paymentMethod;
        if (input.notes !== undefined) quote.notes = input.notes;

        await quote.save();
        return quote;
      }
    ),

    validateImportedQuote: isAuthenticated(async (_, { id }, { user }) => {
      const quote = await checkQuoteAccess(id, user.id);
      return quote.validate();
    }),

    rejectImportedQuote: isAuthenticated(
      async (_, { id, reason }, { user }) => {
        const quote = await checkQuoteAccess(id, user.id);
        return quote.reject(reason);
      }
    ),

    archiveImportedQuote: isAuthenticated(async (_, { id }, { user }) => {
      const quote = await checkQuoteAccess(id, user.id);
      return quote.archive();
    }),

    deleteImportedQuote: isAuthenticated(async (_, { id }, { user }) => {
      const quote = await checkQuoteAccess(id, user.id);

      const cloudflareKey = quote.file?.cloudflareKey;
      if (cloudflareKey) {
        try {
          await cloudflareService.deleteImage(
            cloudflareKey,
            cloudflareService.importedInvoicesBucketName
          );
        } catch (error) {
          console.error(`⚠️ Erreur suppression Cloudflare: ${error.message}`);
        }
      }

      await ImportedQuote.findByIdAndDelete(id);
      return true;
    }),

    deleteImportedQuotes: isAuthenticated(async (_, { ids }) => {
      const quotes = await ImportedQuote.find({ _id: { $in: ids } });

      for (const quote of quotes) {
        const cloudflareKey = quote.file?.cloudflareKey;
        if (cloudflareKey) {
          try {
            await cloudflareService.deleteImage(
              cloudflareKey,
              cloudflareService.importedInvoicesBucketName
            );
          } catch (error) {
            console.error(`⚠️ Erreur suppression Cloudflare: ${error.message}`);
          }
        }
      }

      const result = await ImportedQuote.deleteMany({ _id: { $in: ids } });
      return result.deletedCount;
    }),
  },

  ImportedQuote: {
    id: (parent) => parent._id?.toString() || parent.id,
    workspaceId: (parent) => parent.workspaceId?.toString(),
    importedBy: (parent) => parent.importedBy?.toString(),
    linkedExpenseId: (parent) => parent.linkedExpenseId?.toString() || null,
    duplicateOf: (parent) => parent.duplicateOf?.toString() || null,
    quoteDate: (parent) => parent.quoteDate?.toISOString() || null,
    validUntil: (parent) => parent.validUntil?.toISOString() || null,
    dueDate: (parent) => parent.dueDate?.toISOString() || null,
    createdAt: (parent) => parent.createdAt?.toISOString(),
    updatedAt: (parent) => parent.updatedAt?.toISOString(),
    ocrData: (parent) => ({
      extractedText: parent.ocrData?.extractedText || "",
      confidence: parent.ocrData?.confidence || 0,
      processedAt: parent.ocrData?.processedAt?.toISOString() || null,
    }),
  },
};

export default importedQuoteResolvers;
