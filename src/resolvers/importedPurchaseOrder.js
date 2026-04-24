/**
 * Resolvers GraphQL pour les bons de commande importés
 */

import mongoose from "mongoose";
import crypto from "crypto";
import { GraphQLUpload } from "graphql-upload";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import ImportedPurchaseOrder from "../models/ImportedPurchaseOrder.js";
import UserOcrQuota from "../models/UserOcrQuota.js";
import claudeVisionOcrService from "../services/claudeVisionOcrService.js";
import invoiceExtractionService from "../services/invoiceExtractionService.js";
import cloudflareService from "../services/cloudflareService.js";
import {
  createValidationError,
  createNotFoundError,
  createInternalServerError,
} from "../utils/errors.js";

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

async function checkPurchaseOrderAccess(poId, userId) {
  const po = await ImportedPurchaseOrder.findById(poId);
  if (!po) {
    throw createNotFoundError("Bon de commande importé non trouvé");
  }
  return po;
}

/**
 * Transforme les données d'extraction en données de bon de commande
 */
function transformOcrToPurchaseOrderData(ocrResult, extractionResult) {
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

  let purchaseOrderDate = null;
  if (transactionData.transaction_date) {
    try {
      purchaseOrderDate = new Date(transactionData.transaction_date);
      if (isNaN(purchaseOrderDate.getTime())) purchaseOrderDate = null;
    } catch (e) {
      purchaseOrderDate = null;
    }
  }

  let deliveryDate = null;
  if (transactionData.due_date) {
    try {
      deliveryDate = new Date(transactionData.due_date);
      if (isNaN(deliveryDate.getTime())) deliveryDate = null;
    } catch (e) {
      deliveryDate = null;
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
    originalPurchaseOrderNumber: transactionData.document_number || null,
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
    purchaseOrderDate,
    deliveryDate,
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

const importedPurchaseOrderResolvers = {
  Upload: GraphQLUpload,

  Query: {
    importedPurchaseOrder: isAuthenticated(async (_, { id }, { user }) => {
      const po = await checkPurchaseOrderAccess(id, user.id);
      return po;
    }),

    importedPurchaseOrders: isAuthenticated(
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
          query.purchaseOrderDate = {};
          if (filters.dateFrom) query.purchaseOrderDate.$gte = new Date(filters.dateFrom);
          if (filters.dateTo) query.purchaseOrderDate.$lte = new Date(filters.dateTo);
        }
        if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
          query.totalTTC = {};
          if (filters.minAmount !== undefined) query.totalTTC.$gte = filters.minAmount;
          if (filters.maxAmount !== undefined) query.totalTTC.$lte = filters.maxAmount;
        }

        const skip = (page - 1) * limit;
        const [purchaseOrders, total] = await Promise.all([
          ImportedPurchaseOrder.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit),
          ImportedPurchaseOrder.countDocuments(query),
        ]);

        return {
          purchaseOrders,
          total,
          page,
          limit,
          hasMore: skip + purchaseOrders.length < total,
        };
      }
    ),

    importedPurchaseOrderStats: isAuthenticated(
      async (_, { workspaceId }, { user }) => {
        const stats = await ImportedPurchaseOrder.getStats(workspaceId);

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
    importPurchaseOrderDirect: isAuthenticated(
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

          console.log(`🔍 importPurchaseOrderDirect: OCR direct pour ${filename}`);
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

          let poData;
          if (structuredResult.transaction_data) {
            poData = transformOcrToPurchaseOrderData(structuredResult, structuredResult);
          } else {
            const extractionResult = await invoiceExtractionService.extractInvoiceData(structuredResult);
            poData = transformOcrToPurchaseOrderData(structuredResult, extractionResult);
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
            "importedPurchaseOrder",
            organizationId
          );

          await recordOcrUsage(user.id, workspaceId, plan, {
            fileName: filename,
            provider: rawResult.provider || "claude-vision",
            success: true,
          });

          const duplicates = await ImportedPurchaseOrder.findPotentialDuplicates(
            workspaceId,
            poData.originalPurchaseOrderNumber,
            poData.vendor?.name,
            poData.totalTTC
          );

          const isDuplicate = duplicates.length > 0;

          const importedPurchaseOrder = new ImportedPurchaseOrder({
            workspaceId,
            importedBy: user.id,
            ...poData,
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

          await importedPurchaseOrder.save();

          return {
            success: true,
            purchaseOrder: importedPurchaseOrder,
            error: null,
            isDuplicate,
          };
        } catch (error) {
          console.error("Erreur importPurchaseOrderDirect:", error);
          return {
            success: false,
            purchaseOrder: null,
            error: error.message,
            isDuplicate: false,
          };
        }
      }
    ),

    updateImportedPurchaseOrder: isAuthenticated(
      async (_, { id, input }, { user }) => {
        const po = await checkPurchaseOrderAccess(id, user.id);

        if (input.vendorName !== undefined) po.vendor.name = input.vendorName;
        if (input.vendorAddress !== undefined) po.vendor.address = input.vendorAddress;
        if (input.vendorCity !== undefined) po.vendor.city = input.vendorCity;
        if (input.vendorPostalCode !== undefined) po.vendor.postalCode = input.vendorPostalCode;
        if (input.vendorCountry !== undefined) po.vendor.country = input.vendorCountry;
        if (input.vendorSiret !== undefined) po.vendor.siret = input.vendorSiret;
        if (input.vendorVatNumber !== undefined) po.vendor.vatNumber = input.vendorVatNumber;

        if (input.clientName !== undefined || input.clientSiret !== undefined ||
            input.clientAddress !== undefined || input.clientCity !== undefined ||
            input.clientPostalCode !== undefined) {
          if (!po.client) po.client = {};
          if (input.clientName !== undefined) po.client.name = input.clientName;
          if (input.clientSiret !== undefined) po.client.siret = input.clientSiret;
          if (input.clientAddress !== undefined) po.client.address = input.clientAddress;
          if (input.clientCity !== undefined) po.client.city = input.clientCity;
          if (input.clientPostalCode !== undefined) po.client.postalCode = input.clientPostalCode;
        }

        if (input.originalPurchaseOrderNumber !== undefined) po.originalPurchaseOrderNumber = input.originalPurchaseOrderNumber;
        if (input.purchaseOrderDate !== undefined) po.purchaseOrderDate = input.purchaseOrderDate ? new Date(input.purchaseOrderDate) : null;
        if (input.deliveryDate !== undefined) po.deliveryDate = input.deliveryDate ? new Date(input.deliveryDate) : null;
        if (input.dueDate !== undefined) po.dueDate = input.dueDate ? new Date(input.dueDate) : null;
        if (input.totalHT !== undefined) po.totalHT = input.totalHT;
        if (input.totalVAT !== undefined) po.totalVAT = input.totalVAT;
        if (input.totalTTC !== undefined) po.totalTTC = input.totalTTC;
        if (input.currency !== undefined) po.currency = input.currency;
        if (input.category !== undefined) po.category = input.category;
        if (input.paymentMethod !== undefined) po.paymentMethod = input.paymentMethod;
        if (input.notes !== undefined) po.notes = input.notes;

        await po.save();
        return po;
      }
    ),

    validateImportedPurchaseOrder: isAuthenticated(async (_, { id }, { user }) => {
      const po = await checkPurchaseOrderAccess(id, user.id);
      return po.validate();
    }),

    rejectImportedPurchaseOrder: isAuthenticated(
      async (_, { id, reason }, { user }) => {
        const po = await checkPurchaseOrderAccess(id, user.id);
        return po.reject(reason);
      }
    ),

    archiveImportedPurchaseOrder: isAuthenticated(async (_, { id }, { user }) => {
      const po = await checkPurchaseOrderAccess(id, user.id);
      return po.archive();
    }),

    deleteImportedPurchaseOrder: isAuthenticated(async (_, { id }, { user }) => {
      const po = await checkPurchaseOrderAccess(id, user.id);

      const cloudflareKey = po.file?.cloudflareKey;
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

      await ImportedPurchaseOrder.findByIdAndDelete(id);
      return true;
    }),

    deleteImportedPurchaseOrders: isAuthenticated(async (_, { ids }) => {
      const purchaseOrders = await ImportedPurchaseOrder.find({ _id: { $in: ids } });

      for (const po of purchaseOrders) {
        const cloudflareKey = po.file?.cloudflareKey;
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

      const result = await ImportedPurchaseOrder.deleteMany({ _id: { $in: ids } });
      return result.deletedCount;
    }),
  },

  ImportedPurchaseOrder: {
    id: (parent) => parent._id?.toString() || parent.id,
    workspaceId: (parent) => parent.workspaceId?.toString(),
    importedBy: (parent) => parent.importedBy?.toString(),
    linkedExpenseId: (parent) => parent.linkedExpenseId?.toString() || null,
    duplicateOf: (parent) => parent.duplicateOf?.toString() || null,
    purchaseOrderDate: (parent) => parent.purchaseOrderDate?.toISOString() || null,
    deliveryDate: (parent) => parent.deliveryDate?.toISOString() || null,
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

export default importedPurchaseOrderResolvers;
