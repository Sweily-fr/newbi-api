/**
 * Resolvers GraphQL pour les factures importées
 */

import { isAuthenticated } from '../middlewares/better-auth-jwt.js';
import ImportedInvoice from '../models/ImportedInvoice.js';
import mistralOcrService from '../services/mistralOcrService.js';
import mistralIntelligentAnalysisService from '../services/mistralIntelligentAnalysisService.js';
import cloudflareService from '../services/cloudflareService.js';
import {
  createValidationError,
  createNotFoundError,
  createInternalServerError,
} from '../utils/errors.js';

// Limite maximale d'import en lot
const MAX_BATCH_IMPORT = 100;

/**
 * Vérifie l'accès à une facture importée
 */
async function checkInvoiceAccess(invoiceId, userId) {
  const invoice = await ImportedInvoice.findById(invoiceId);
  if (!invoice) {
    throw createNotFoundError('Facture importée non trouvée');
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
    'OFFICE_SUPPLIES': 'OFFICE_SUPPLIES',
    'TRAVEL': 'TRAVEL',
    'MEALS': 'MEALS',
    'EQUIPMENT': 'EQUIPMENT',
    'MARKETING': 'MARKETING',
    'TRAINING': 'TRAINING',
    'SERVICES': 'SERVICES',
    'RENT': 'RENT',
    'SALARIES': 'SALARIES',
    'UTILITIES': 'UTILITIES',
    'INSURANCE': 'INSURANCE',
    'SUBSCRIPTIONS': 'SUBSCRIPTIONS',
  };

  // Mapper le moyen de paiement
  const paymentMethodMap = {
    'card': 'CARD',
    'cash': 'CASH',
    'check': 'CHECK',
    'transfer': 'TRANSFER',
    'direct_debit': 'DIRECT_DEBIT',
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
  const items = (financialAnalysis?.line_items || []).map(item => ({
    description: item.description || '',
    quantity: parseFloat(item.quantity) || 1,
    unitPrice: parseFloat(item.unit_price) || 0,
    totalPrice: parseFloat(item.total) || 0,
    vatRate: parseFloat(item.vat_rate) || 20,
    productCode: item.product_code || null,
  }));

  return {
    originalInvoiceNumber: transactionData.document_number || null,
    vendor: {
      name: transactionData.vendor_name || '',
      address: extractedFields.vendor_address || '',
      city: extractedFields.vendor_city || '',
      postalCode: extractedFields.vendor_postal_code || '',
      country: extractedFields.vendor_country || 'France',
      siret: extractedFields.vendor_siret || null,
      vatNumber: extractedFields.vendor_vat_number || null,
      email: extractedFields.vendor_email || null,
      phone: extractedFields.vendor_phone || null,
    },
    invoiceDate,
    dueDate,
    paymentDate: transactionData.payment_date ? new Date(transactionData.payment_date) : null,
    totalHT: parseFloat(transactionData.amount_ht) || 0,
    totalVAT: parseFloat(transactionData.tax_amount) || 0,
    totalTTC: parseFloat(transactionData.amount) || 0,
    currency: transactionData.currency || 'EUR',
    items,
    category: categoryMap[transactionData.category?.toUpperCase()] || 'OTHER',
    paymentMethod: paymentMethodMap[transactionData.payment_method?.toLowerCase()] || 'UNKNOWN',
    ocrData: {
      extractedText: ocrResult.extractedText || '',
      rawData: ocrResult.data || {},
      financialAnalysis: financialAnalysis || {},
      confidence: documentAnalysis.confidence || 0,
      processedAt: new Date(),
    },
  };
}

/**
 * Traite une facture avec OCR
 */
async function processInvoiceWithOcr(cloudflareUrl, fileName, mimeType) {
  // Étape 1: OCR avec Mistral
  const ocrResult = await mistralOcrService.processDocumentFromUrl(
    cloudflareUrl,
    fileName,
    mimeType,
    {}
  );

  if (!ocrResult.success) {
    throw createInternalServerError('Erreur lors du traitement OCR');
  }

  // Étape 2: Analyse financière intelligente
  const financialAnalysis = await mistralIntelligentAnalysisService.analyzeDocument(ocrResult);

  // Étape 3: Transformer en données de facture
  return transformOcrToInvoiceData(ocrResult, financialAnalysis);
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
    importedInvoices: isAuthenticated(async (_, { workspaceId, page = 1, limit = 20, filters = {} }, { user }) => {
      const query = { workspaceId };

      // Appliquer les filtres
      if (filters.status) {
        query.status = filters.status;
      }
      if (filters.category) {
        query.category = filters.category;
      }
      if (filters.vendorName) {
        query['vendor.name'] = { $regex: new RegExp(filters.vendorName, 'i') };
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
      if (filters.minAmount !== undefined || filters.maxAmount !== undefined) {
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
    }),

    /**
     * Statistiques des factures importées
     */
    importedInvoiceStats: isAuthenticated(async (_, { workspaceId }, { user }) => {
      const stats = await ImportedInvoice.getStats(workspaceId);
      
      const result = {
        pendingReview: 0,
        validated: 0,
        rejected: 0,
        archived: 0,
        totalAmount: 0,
      };

      stats.forEach(stat => {
        const statusKey = stat._id?.toLowerCase().replace('_', '');
        if (stat._id === 'PENDING_REVIEW') result.pendingReview = stat.count;
        else if (stat._id === 'VALIDATED') result.validated = stat.count;
        else if (stat._id === 'REJECTED') result.rejected = stat.count;
        else if (stat._id === 'ARCHIVED') result.archived = stat.count;
        
        if (stat._id !== 'REJECTED') {
          result.totalAmount += stat.totalAmount || 0;
        }
      });

      return result;
    }),
  },

  Mutation: {
    /**
     * Importe une facture avec OCR
     */
    importInvoice: isAuthenticated(async (_, { workspaceId, cloudflareUrl, fileName, mimeType, fileSize, cloudflareKey }, { user }) => {
      try {
        // Traiter avec OCR
        const invoiceData = await processInvoiceWithOcr(cloudflareUrl, fileName, mimeType);

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
        console.error('Erreur import facture:', error);
        return {
          success: false,
          invoice: null,
          error: error.message,
          isDuplicate: false,
        };
      }
    }),

    /**
     * Import en lot de factures
     */
    batchImportInvoices: isAuthenticated(async (_, { workspaceId, files }, { user }) => {
      if (files.length > MAX_BATCH_IMPORT) {
        throw createValidationError(`Maximum ${MAX_BATCH_IMPORT} factures par import`);
      }

      const results = [];
      const errors = [];
      let successCount = 0;
      let errorCount = 0;

      // Traiter les fichiers en parallèle par lots de 5
      const batchSize = 5;
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        
        const batchResults = await Promise.all(
          batch.map(async (file) => {
            try {
              // Traiter avec OCR
              const invoiceData = await processInvoiceWithOcr(
                file.cloudflareUrl,
                file.fileName,
                file.mimeType
              );

              // Vérifier les doublons
              const duplicates = await ImportedInvoice.findPotentialDuplicates(
                workspaceId,
                invoiceData.originalInvoiceNumber,
                invoiceData.vendor?.name,
                invoiceData.totalTTC
              );

              const isDuplicate = duplicates.length > 0;

              // Créer la facture
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
              successCount++;

              return {
                success: true,
                invoice: importedInvoice,
                error: null,
                isDuplicate,
              };
            } catch (error) {
              errorCount++;
              errors.push(`${file.fileName}: ${error.message}`);
              return {
                success: false,
                invoice: null,
                error: error.message,
                isDuplicate: false,
              };
            }
          })
        );

        results.push(...batchResults);
      }

      return {
        success: errorCount === 0,
        totalProcessed: files.length,
        successCount,
        errorCount,
        results,
        errors,
      };
    }),

    /**
     * Met à jour une facture importée
     */
    updateImportedInvoice: isAuthenticated(async (_, { id, input }, { user }) => {
      const invoice = await checkInvoiceAccess(id, user.id);

      // Mettre à jour les champs du vendor si fournis
      if (input.vendorName !== undefined) invoice.vendor.name = input.vendorName;
      if (input.vendorAddress !== undefined) invoice.vendor.address = input.vendorAddress;
      if (input.vendorCity !== undefined) invoice.vendor.city = input.vendorCity;
      if (input.vendorPostalCode !== undefined) invoice.vendor.postalCode = input.vendorPostalCode;
      if (input.vendorCountry !== undefined) invoice.vendor.country = input.vendorCountry;
      if (input.vendorSiret !== undefined) invoice.vendor.siret = input.vendorSiret;
      if (input.vendorVatNumber !== undefined) invoice.vendor.vatNumber = input.vendorVatNumber;

      // Mettre à jour les autres champs
      if (input.originalInvoiceNumber !== undefined) invoice.originalInvoiceNumber = input.originalInvoiceNumber;
      if (input.invoiceDate !== undefined) invoice.invoiceDate = input.invoiceDate ? new Date(input.invoiceDate) : null;
      if (input.dueDate !== undefined) invoice.dueDate = input.dueDate ? new Date(input.dueDate) : null;
      if (input.paymentDate !== undefined) invoice.paymentDate = input.paymentDate ? new Date(input.paymentDate) : null;
      if (input.totalHT !== undefined) invoice.totalHT = input.totalHT;
      if (input.totalVAT !== undefined) invoice.totalVAT = input.totalVAT;
      if (input.totalTTC !== undefined) invoice.totalTTC = input.totalTTC;
      if (input.currency !== undefined) invoice.currency = input.currency;
      if (input.category !== undefined) invoice.category = input.category;
      if (input.paymentMethod !== undefined) invoice.paymentMethod = input.paymentMethod;
      if (input.notes !== undefined) invoice.notes = input.notes;

      await invoice.save();
      return invoice;
    }),

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
    rejectImportedInvoice: isAuthenticated(async (_, { id, reason }, { user }) => {
      const invoice = await checkInvoiceAccess(id, user.id);
      return invoice.reject(reason);
    }),

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
      extractedText: parent.ocrData?.extractedText || '',
      confidence: parent.ocrData?.confidence || 0,
      processedAt: parent.ocrData?.processedAt?.toISOString() || null,
    }),
  },
};

export default importedInvoiceResolvers;
