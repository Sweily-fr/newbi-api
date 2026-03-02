import DocumentAutomation from '../models/DocumentAutomation.js';
import DocumentAutomationLog from '../models/DocumentAutomationLog.js';
import SharedDocument from '../models/SharedDocument.js';
import SharedFolder from '../models/SharedFolder.js';
import Invoice from '../models/Invoice.js';
import Quote from '../models/Quote.js';
import CreditNote from '../models/CreditNote.js';
import ImportedInvoice from '../models/ImportedInvoice.js';
import ImportedQuote from '../models/ImportedQuote.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import PurchaseInvoice from '../models/PurchaseInvoice.js';
import Transaction from '../models/Transaction.js';
import cloudflareService from './cloudflareService.js';
import axios from 'axios';

// Suivi de progression en mémoire pour les automatisations en cours
const _progressMap = new Map();

export function getAutomationProgress(automationId) {
  return _progressMap.get(automationId) || null;
}

/**
 * Cache le PDF d'un document dans R2 et met à jour le champ cachedPdf du document.
 * Permet aux automatisations suivantes d'utiliser une copie R2 serveur-à-serveur.
 */
async function cacheDocumentPdf(documentId, documentType, pdfBuffer, workspaceId) {
  const ModelMap = { invoice: Invoice, quote: Quote, creditNote: CreditNote, purchaseOrder: PurchaseOrder };
  const Model = ModelMap[documentType];
  if (!Model) return null;

  const uploadResult = await cloudflareService.uploadImage(
    pdfBuffer,
    `${documentId}.pdf`,
    'system',
    'sharedDocuments',
    workspaceId
  );

  await Model.updateOne(
    { _id: documentId },
    { $set: { cachedPdf: { key: uploadResult.key, url: uploadResult.url, generatedAt: new Date() } } }
  );

  return { key: uploadResult.key, url: uploadResult.url };
}

const DOCUMENT_TYPE_LABELS = {
  invoice: 'Facture',
  quote: 'Devis',
  creditNote: 'Avoir',
  expense: 'Depense',
  importedInvoice: 'Facture_importee',
  importedQuote: 'Devis_importe',
  purchaseOrder: 'BonCommande',
  purchaseInvoice: 'Facture_achat',
  transaction: 'Justificatif',
};

/**
 * Génère le PDF d'un document via l'API Next.js
 * Réutilise le même pattern que documentEmailService.generateDocumentPdf
 */
async function generateDocumentPdf(documentId, documentType) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  const endpointMap = {
    invoice: '/api/invoices/generate-pdf',
    quote: '/api/quotes/generate-pdf',
    creditNote: '/api/credit-notes/generate-pdf',
    purchaseOrder: '/api/purchase-orders/generate-pdf',
  };

  const endpoint = endpointMap[documentType];
  if (!endpoint) {
    throw new Error(`Type de document non supporté pour la génération PDF: ${documentType}`);
  }

  const bodyKeyMap = {
    invoice: 'invoiceId',
    quote: 'quoteId',
    creditNote: 'creditNoteId',
    purchaseOrder: 'purchaseOrderId',
  };

  const body = { [bodyKeyMap[documentType]]: documentId };

  const response = await axios.post(
    `${frontendUrl}${endpoint}`,
    body,
    { responseType: 'arraybuffer', timeout: 60000 }
  );

  return Buffer.from(response.data);
}

/**
 * Sanitize un nom de fichier en remplaçant les caractères spéciaux
 */
function sanitizeFileName(name) {
  return name
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim();
}

/**
 * Construit le nom du fichier à partir du pattern et du contexte
 */
function buildFileName(pattern, documentContext, extension = 'pdf') {
  const typeLabel = DOCUMENT_TYPE_LABELS[documentContext.documentType] || documentContext.documentType;
  const number = documentContext.prefix
    ? `${documentContext.prefix}${documentContext.documentNumber}`
    : documentContext.documentNumber;

  let fileName = pattern
    .replace('{documentType}', typeLabel)
    .replace('{number}', number || '')
    .replace('{clientName}', documentContext.clientName || 'Sans_client');

  return sanitizeFileName(fileName) + '.' + (extension || 'pdf');
}

// Cache mémoire pour les sous-dossiers résolus (évite les requêtes DB répétées)
const _folderCache = new Map();
const FOLDER_CACHE_TTL = 60 * 1000; // 1 minute

/**
 * Résout le dossier cible, en créant les sous-dossiers dynamiques si nécessaire.
 * Utilise un cache mémoire pour éviter les requêtes répétées dans un batch.
 */
async function resolveTargetFolder(actionConfig, workspaceId, documentContext, userId) {
  if (!actionConfig.createSubfolder) {
    return actionConfig.targetFolderId;
  }

  const pattern = actionConfig.subfolderPattern || '{year}';
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const clientName = sanitizeFileName(documentContext.clientName || 'Sans_client');

  const resolvedPattern = pattern
    .replace('{year}', year)
    .replace('{month}', month)
    .replace('{clientName}', clientName);

  const levels = resolvedPattern.split('/').filter(Boolean);

  let currentParentId = actionConfig.targetFolderId;

  for (const levelName of levels) {
    const cacheKey = `${workspaceId}:${currentParentId}:${levelName}`;
    const cached = _folderCache.get(cacheKey);

    if (cached && Date.now() - cached.ts < FOLDER_CACHE_TTL) {
      currentParentId = cached.id;
      continue;
    }

    let folder = await SharedFolder.findOne({
      workspaceId,
      parentId: currentParentId,
      name: levelName,
      trashedAt: null,
    });

    if (!folder) {
      folder = new SharedFolder({
        name: levelName,
        workspaceId,
        parentId: currentParentId,
        createdBy: userId,
        isSharedWithAccountant: true,
      });
      await folder.save();
    }

    _folderCache.set(cacheKey, { id: folder._id, ts: Date.now() });
    currentParentId = folder._id;
  }

  return currentParentId;
}

/**
 * Service principal d'exécution des automatisations de documents
 */
const documentAutomationService = {
  /**
   * Exécute toutes les automatisations correspondant à un trigger
   */
  async executeAutomations(triggerType, workspaceId, documentContext, userId) {
    try {
      const automations = await DocumentAutomation.find({
        workspaceId,
        triggerType,
        isActive: true,
      });

      if (automations.length === 0) {
        return { executed: 0, results: [] };
      }

      const results = [];

      for (const automation of automations) {
        try {
          // Ne skip que les logs SUCCESS (les FAILED peuvent être réessayés)
          const existingSuccessLog = await DocumentAutomationLog.findOne({
            sourceDocumentType: documentContext.documentType,
            sourceDocumentId: documentContext.documentId,
            automationId: automation._id,
            status: 'SUCCESS',
          });

          if (existingSuccessLog) {
            // Si le SharedDocument est en corbeille, le restaurer
            if (existingSuccessLog.sharedDocumentId) {
              await SharedDocument.updateOne(
                {
                  _id: existingSuccessLog.sharedDocumentId,
                  trashedAt: { $ne: null },
                },
                {
                  $set: { trashedAt: null },
                  $unset: { originalFolderId: '' },
                }
              );
            }

            results.push({
              automationId: automation._id,
              automationName: automation.name,
              success: true,
              skipped: true,
            });
            continue;
          }

          // Supprimer les anciens logs FAILED pour ce document (avant de réessayer)
          await DocumentAutomationLog.deleteMany({
            sourceDocumentType: documentContext.documentType,
            sourceDocumentId: documentContext.documentId,
            automationId: automation._id,
            status: 'FAILED',
          });

          // Résoudre le dossier cible
          const targetFolderId = await resolveTargetFolder(
            automation.actionConfig,
            workspaceId,
            documentContext,
            userId
          );

          // Construire le nom du fichier (extension par défaut .pdf, corrigée pour les transactions)
          let fileName = buildFileName(
            automation.actionConfig.documentNaming || '{documentType}-{number}-{clientName}',
            documentContext
          );

          // Chercher le PDF en cache pour éviter la regénération Puppeteer
          const CacheModelMap = { invoice: Invoice, quote: Quote, creditNote: CreditNote, purchaseOrder: PurchaseOrder };
          const CacheModel = CacheModelMap[documentContext.documentType];
          const cachedDoc = CacheModel
            ? await CacheModel.findById(documentContext.documentId).select('cachedPdf').lean()
            : null;

          let uploadResult;
          let fileSize;
          let fileMimeType = 'application/pdf';
          let fileExt = 'pdf';

          if (documentContext.documentType === 'transaction') {
            // Transaction : copier le justificatif existant (image ou PDF)
            const txn = await Transaction.findById(documentContext.documentId).select('receiptFile').lean();
            if (!txn?.receiptFile?.url) {
              throw new Error('Aucun justificatif pour cette transaction');
            }
            const response = await axios.get(txn.receiptFile.url, { responseType: 'arraybuffer', timeout: 30000 });
            const fileBuffer = Buffer.from(response.data);
            fileMimeType = txn.receiptFile.mimetype || 'application/pdf';
            fileExt = txn.receiptFile.filename?.split('.').pop() || 'pdf';
            // Reconstruire le nom du fichier avec la bonne extension
            fileName = buildFileName(
              automation.actionConfig.documentNaming || '{documentType}-{number}-{clientName}',
              documentContext,
              fileExt
            );
            uploadResult = await cloudflareService.uploadImage(
              fileBuffer,
              fileName,
              userId,
              'sharedDocuments',
              workspaceId
            );
            fileSize = fileBuffer.length;
          } else if (cachedDoc?.cachedPdf?.key) {
            // Copie R2 serveur-à-serveur (instantanée, pas de Puppeteer)
            uploadResult = await cloudflareService.copyToSharedDocuments(
              cachedDoc.cachedPdf.key,
              cloudflareService.sharedDocumentsBucketName,
              fileName,
              workspaceId
            );
            fileSize = 0; // Taille inconnue en copie R2, pas critique
          } else {
            // Fallback : générer le PDF puis le cacher pour les prochaines fois
            let pdfBuffer;
            try {
              pdfBuffer = await generateDocumentPdf(
                documentContext.documentId,
                documentContext.documentType
              );
            } catch (pdfError) {
              throw new Error(`Erreur génération PDF: ${pdfError.message}`);
            }

            if (!pdfBuffer || pdfBuffer.length === 0) {
              throw new Error('Le PDF généré est vide');
            }

            uploadResult = await cloudflareService.uploadImage(
              pdfBuffer,
              fileName,
              userId,
              'sharedDocuments',
              workspaceId
            );
            fileSize = pdfBuffer.length;

            // Cacher le PDF pour les automatisations futures (fire-and-forget)
            if (CacheModel) {
              cacheDocumentPdf(documentContext.documentId, documentContext.documentType, pdfBuffer, workspaceId)
                .catch(() => {});
            }
          }

          // Récupérer le nom du dossier cible pour le log
          const targetFolder = await SharedFolder.findById(targetFolderId);
          const targetFolderName = targetFolder?.name || 'Inconnu';

          // Créer le SharedDocument
          const sharedDocument = new SharedDocument({
            name: fileName,
            originalName: fileName,
            description: `Importé automatiquement par l'automatisation "${automation.name}"`,
            fileUrl: uploadResult.url,
            fileKey: uploadResult.key,
            mimeType: fileMimeType,
            fileSize: fileSize,
            fileExtension: fileExt,
            workspaceId,
            folderId: targetFolderId,
            uploadedBy: userId,
            uploadedByName: 'Automatisation',
            status: automation.actionConfig.documentStatus || 'classified',
            isSharedWithAccountant: true,
            tags: automation.actionConfig.tags || [],
          });

          await sharedDocument.save();

          // Logger le succès
          await DocumentAutomationLog.create({
            automationId: automation._id,
            workspaceId,
            sourceDocumentType: documentContext.documentType,
            sourceDocumentId: documentContext.documentId,
            sourceDocumentNumber: documentContext.prefix
              ? `${documentContext.prefix}${documentContext.documentNumber}`
              : documentContext.documentNumber || '',
            sharedDocumentId: sharedDocument._id,
            targetFolderId,
            targetFolderName,
            status: 'SUCCESS',
            fileName,
            fileSize: fileSize,
          });

          // Mettre à jour les stats
          await DocumentAutomation.findByIdAndUpdate(automation._id, {
            $inc: { 'stats.totalExecutions': 1 },
            $set: {
              'stats.lastExecutedAt': new Date(),
              'stats.lastDocumentId': sharedDocument._id,
            },
          });

          results.push({
            automationId: automation._id,
            automationName: automation.name,
            success: true,
          });
        } catch (error) {
          console.error(
            `❌ [DocumentAutomation] Erreur automation "${automation.name}" (${automation._id}):`,
            error.message
          );

          // Logger l'échec
          try {
            await DocumentAutomationLog.create({
              automationId: automation._id,
              workspaceId,
              sourceDocumentType: documentContext.documentType,
              sourceDocumentId: documentContext.documentId,
              sourceDocumentNumber: documentContext.prefix
                ? `${documentContext.prefix}${documentContext.documentNumber}`
                : documentContext.documentNumber || '',
              status: 'FAILED',
              error: error.message,
            });
          } catch (logError) {
            // Erreur de dédoublonnage (déjà loggé) — ignorer
            if (logError.code !== 11000) {
              console.error('❌ [DocumentAutomation] Erreur log:', logError.message);
            }
          }

          // Incrémenter les stats d'échec
          await DocumentAutomation.findByIdAndUpdate(automation._id, {
            $inc: { 'stats.failedExecutions': 1 },
          }).catch(() => {});

          results.push({
            automationId: automation._id,
            automationName: automation.name,
            success: false,
            error: error.message,
          });
        }
      }

      return { executed: results.filter(r => r.success).length, results };
    } catch (error) {
      console.error('❌ [DocumentAutomation] Erreur globale:', error);
      return { executed: 0, results: [], error: error.message };
    }
  },

  /**
   * Variante pour les dépenses importées (copie le fichier R2 existant)
   */
  async executeAutomationsForExpense(triggerType, workspaceId, expenseContext, userId) {
    try {
      const automations = await DocumentAutomation.find({
        workspaceId,
        triggerType,
        isActive: true,
      });

      if (automations.length === 0) {
        return { executed: 0, results: [] };
      }

      const results = [];

      for (const automation of automations) {
        try {
          // Ne skip que les logs SUCCESS (les FAILED peuvent être réessayés)
          const existingSuccessLog = await DocumentAutomationLog.findOne({
            sourceDocumentType: 'expense',
            sourceDocumentId: expenseContext.documentId,
            automationId: automation._id,
            status: 'SUCCESS',
          });

          if (existingSuccessLog) {
            // Si le SharedDocument est en corbeille, le restaurer
            if (existingSuccessLog.sharedDocumentId) {
              await SharedDocument.updateOne(
                {
                  _id: existingSuccessLog.sharedDocumentId,
                  trashedAt: { $ne: null },
                },
                {
                  $set: { trashedAt: null },
                  $unset: { originalFolderId: '' },
                }
              );
            }

            results.push({
              automationId: automation._id,
              automationName: automation.name,
              success: true,
              skipped: true,
            });
            continue;
          }

          // Supprimer les anciens logs FAILED pour cette dépense (avant de réessayer)
          await DocumentAutomationLog.deleteMany({
            sourceDocumentType: 'expense',
            sourceDocumentId: expenseContext.documentId,
            automationId: automation._id,
            status: 'FAILED',
          });

          // Récupérer le fichier existant via son URL publique
          let fileBuffer;
          try {
            const response = await axios.get(expenseContext.cloudflareUrl, {
              responseType: 'arraybuffer',
              timeout: 30000,
            });
            fileBuffer = Buffer.from(response.data);
          } catch (fetchError) {
            throw new Error(`Erreur récupération fichier: ${fetchError.message}`);
          }

          if (!fileBuffer || fileBuffer.length === 0) {
            throw new Error('Le fichier source est vide');
          }

          // Résoudre le dossier cible
          const targetFolderId = await resolveTargetFolder(
            automation.actionConfig,
            workspaceId,
            expenseContext,
            userId
          );

          // Construire le nom du fichier
          const fileName = buildFileName(
            automation.actionConfig.documentNaming || '{documentType}-{number}-{clientName}',
            expenseContext
          );

          // Upload vers R2
          const uploadResult = await cloudflareService.uploadImage(
            fileBuffer,
            fileName,
            userId,
            'sharedDocuments',
            workspaceId
          );

          const targetFolder = await SharedFolder.findById(targetFolderId);
          const targetFolderName = targetFolder?.name || 'Inconnu';

          // Créer le SharedDocument
          const sharedDocument = new SharedDocument({
            name: fileName,
            originalName: fileName,
            description: `Importé automatiquement par l'automatisation "${automation.name}"`,
            fileUrl: uploadResult.url,
            fileKey: uploadResult.key,
            mimeType: expenseContext.mimeType || 'application/pdf',
            fileSize: fileBuffer.length,
            fileExtension: expenseContext.fileExtension || 'pdf',
            workspaceId,
            folderId: targetFolderId,
            uploadedBy: userId,
            uploadedByName: 'Automatisation',
            status: automation.actionConfig.documentStatus || 'classified',
            isSharedWithAccountant: true,
            tags: automation.actionConfig.tags || [],
          });

          await sharedDocument.save();

          await DocumentAutomationLog.create({
            automationId: automation._id,
            workspaceId,
            sourceDocumentType: 'expense',
            sourceDocumentId: expenseContext.documentId,
            sourceDocumentNumber: expenseContext.documentNumber || '',
            sharedDocumentId: sharedDocument._id,
            targetFolderId,
            targetFolderName,
            status: 'SUCCESS',
            fileName,
            fileSize: fileBuffer.length,
          });

          await DocumentAutomation.findByIdAndUpdate(automation._id, {
            $inc: { 'stats.totalExecutions': 1 },
            $set: {
              'stats.lastExecutedAt': new Date(),
              'stats.lastDocumentId': sharedDocument._id,
            },
          });

          results.push({
            automationId: automation._id,
            automationName: automation.name,
            success: true,
          });
        } catch (error) {
          console.error(
            `❌ [DocumentAutomation] Erreur automation expense "${automation.name}":`,
            error.message
          );

          try {
            await DocumentAutomationLog.create({
              automationId: automation._id,
              workspaceId,
              sourceDocumentType: 'expense',
              sourceDocumentId: expenseContext.documentId,
              sourceDocumentNumber: expenseContext.documentNumber || '',
              status: 'FAILED',
              error: error.message,
            });
          } catch (logError) {
            if (logError.code !== 11000) {
              console.error('❌ [DocumentAutomation] Erreur log:', logError.message);
            }
          }

          await DocumentAutomation.findByIdAndUpdate(automation._id, {
            $inc: { 'stats.failedExecutions': 1 },
          }).catch(() => {});

          results.push({
            automationId: automation._id,
            automationName: automation.name,
            success: false,
            error: error.message,
          });
        }
      }

      return { executed: results.filter(r => r.success).length, results };
    } catch (error) {
      console.error('❌ [DocumentAutomation] Erreur globale expense:', error);
      return { executed: 0, results: [], error: error.message };
    }
  },

  /**
   * Mapping trigger → modèle, statut, type de document
   */
  _getTriggerConfig(triggerType) {
    const TRIGGER_TO_QUERY = {
      INVOICE_DRAFT:     { model: Invoice,    status: 'DRAFT',     docType: 'invoice' },
      INVOICE_SENT:      { model: Invoice,    status: 'PENDING',   docType: 'invoice' },
      INVOICE_PAID:      { model: Invoice,    status: 'COMPLETED', docType: 'invoice' },
      INVOICE_OVERDUE:   { model: Invoice,    status: 'OVERDUE',   docType: 'invoice' },
      INVOICE_CANCELED:  { model: Invoice,    status: 'CANCELED',  docType: 'invoice' },
      QUOTE_DRAFT:       { model: Quote,      status: 'DRAFT',     docType: 'quote' },
      QUOTE_SENT:        { model: Quote,      status: 'PENDING',   docType: 'quote' },
      QUOTE_ACCEPTED:    { model: Quote,      status: 'COMPLETED', docType: 'quote' },
      QUOTE_CANCELED:    { model: Quote,      status: 'CANCELED',  docType: 'quote' },
      CREDIT_NOTE_CREATED: { model: CreditNote, status: null,      docType: 'creditNote' },
      INVOICE_IMPORTED:    { model: ImportedInvoice, status: 'VALIDATED', docType: 'importedInvoice' },
      QUOTE_IMPORTED:      { model: ImportedQuote,   status: 'VALIDATED', docType: 'importedQuote' },
      PURCHASE_ORDER_DRAFT:       { model: PurchaseOrder,   status: 'DRAFT',       docType: 'purchaseOrder' },
      PURCHASE_ORDER_CONFIRMED:   { model: PurchaseOrder,   status: 'CONFIRMED',   docType: 'purchaseOrder' },
      PURCHASE_ORDER_IN_PROGRESS: { model: PurchaseOrder,   status: 'IN_PROGRESS', docType: 'purchaseOrder' },
      PURCHASE_ORDER_DELIVERED:   { model: PurchaseOrder,   status: 'DELIVERED',   docType: 'purchaseOrder' },
      PURCHASE_ORDER_CANCELED:    { model: PurchaseOrder,   status: 'CANCELED',    docType: 'purchaseOrder' },
      PURCHASE_INVOICE_TO_PROCESS: { model: PurchaseInvoice, status: 'TO_PROCESS', docType: 'purchaseInvoice' },
      PURCHASE_INVOICE_TO_PAY:     { model: PurchaseInvoice, status: 'TO_PAY',     docType: 'purchaseInvoice' },
      PURCHASE_INVOICE_PENDING:    { model: PurchaseInvoice, status: 'PENDING',    docType: 'purchaseInvoice' },
      PURCHASE_INVOICE_PAID:       { model: PurchaseInvoice, status: 'PAID',       docType: 'purchaseInvoice' },
      PURCHASE_INVOICE_OVERDUE:    { model: PurchaseInvoice, status: 'OVERDUE',    docType: 'purchaseInvoice' },
      PURCHASE_INVOICE_ARCHIVED:   { model: PurchaseInvoice, status: 'ARCHIVED',   docType: 'purchaseInvoice' },
      TRANSACTION_RECEIPT:         { model: Transaction,     status: null,          docType: 'transaction', customFilter: { 'receiptFile.url': { $exists: true, $ne: null } } },
    };
    return TRIGGER_TO_QUERY[triggerType] || null;
  },

  /**
   * Supprime les logs SUCCESS dont le SharedDocument associé a été supprimé.
   * Permet de re-traiter un document si l'utilisateur a supprimé le fichier partagé.
   */
  async _cleanOrphanedLogs(automationId, docType, documentIds) {
    try {
      const successLogs = await DocumentAutomationLog.find({
        automationId,
        sourceDocumentType: docType,
        sourceDocumentId: { $in: documentIds },
        status: 'SUCCESS',
        sharedDocumentId: { $ne: null },
      }).lean();

      if (successLogs.length === 0) return;

      // Vérifier quels SharedDocuments existent encore
      const sharedDocIds = successLogs.map(l => l.sharedDocumentId).filter(Boolean);
      const existingDocs = await SharedDocument.find({
        _id: { $in: sharedDocIds },
      }).select('_id').lean();

      const existingIds = new Set(existingDocs.map(d => d._id.toString()));

      // Supprimer les logs dont le SharedDocument n'existe plus
      const orphanedLogIds = successLogs
        .filter(l => l.sharedDocumentId && !existingIds.has(l.sharedDocumentId.toString()))
        .map(l => l._id);

      if (orphanedLogIds.length > 0) {
        await DocumentAutomationLog.deleteMany({ _id: { $in: orphanedLogIds } });

        // Décrémenter le compteur totalExecutions
        await DocumentAutomation.findByIdAndUpdate(automationId, {
          $inc: { 'stats.totalExecutions': -orphanedLogIds.length },
        });

        // Orphaned logs cleaned
      }
    } catch (error) {
      console.error('⚠️ [DocumentAutomation] Erreur nettoyage logs orphelins:', error.message);
    }
  },

  /**
   * Restaure les SharedDocuments en corbeille qui avaient été créés par une automatisation.
   * Quand on relance une automatisation, les documents en corbeille sont restaurés
   * vers leur dossier d'origine au lieu d'être re-créés.
   */
  async _restoreTrashedAutomationDocs(automationId, docType, documentIds) {
    try {
      const successLogs = await DocumentAutomationLog.find({
        automationId,
        sourceDocumentType: docType,
        sourceDocumentId: { $in: documentIds },
        status: 'SUCCESS',
        sharedDocumentId: { $ne: null },
      }).lean();

      if (successLogs.length === 0) return 0;

      const sharedDocIds = successLogs.map(l => l.sharedDocumentId).filter(Boolean);

      // Restaurer les SharedDocuments en corbeille (folderId est déjà correct)
      const result = await SharedDocument.updateMany(
        {
          _id: { $in: sharedDocIds },
          trashedAt: { $ne: null },
        },
        {
          $set: { trashedAt: null },
          $unset: { originalFolderId: '' },
        }
      );

      return result.modifiedCount || 0;
    } catch (error) {
      console.error('⚠️ [DocumentAutomation] Erreur restauration docs corbeille:', error.message);
      return 0;
    }
  },

  /**
   * Compte les documents existants qui matchent le trigger et n'ont pas encore de log SUCCESS.
   */
  async countExistingDocuments(automation, workspaceId) {
    const config = this._getTriggerConfig(automation.triggerType);
    if (!config) return 0;

    const query = { workspaceId };
    if (config.status) {
      query.status = config.status;
    }
    if (config.customFilter) {
      Object.assign(query, config.customFilter);
    }

    const documents = await config.model.find(query).select('_id').lean();
    if (documents.length === 0) return 0;

    // Nettoyer les logs SUCCESS dont le SharedDocument a été supprimé
    await this._cleanOrphanedLogs(automation._id, config.docType, documents.map(d => d._id));

    // Compter ceux qui ont déjà un log SUCCESS valide
    const successLogs = await DocumentAutomationLog.countDocuments({
      automationId: automation._id,
      sourceDocumentType: config.docType,
      sourceDocumentId: { $in: documents.map(d => d._id) },
      status: 'SUCCESS',
    });

    return documents.length - successLogs;
  },

  /**
   * Retourne les documents existants qui matchent le trigger et n'ont pas encore de log SUCCESS.
   * Utilisé par le frontend pour générer les PDFs côté client.
   */
  async getDocumentsForAutomation(automation, workspaceId) {
    const config = this._getTriggerConfig(automation.triggerType);
    if (!config) return [];

    const query = { workspaceId };
    if (config.status) {
      query.status = config.status;
    }
    if (config.customFilter) {
      Object.assign(query, config.customFilter);
    }

    const documents = await config.model.find(query).lean();
    if (documents.length === 0) return [];

    // Nettoyer les logs SUCCESS dont le SharedDocument a été supprimé
    await this._cleanOrphanedLogs(automation._id, config.docType, documents.map(d => d._id));

    // Récupérer les IDs qui ont déjà un log SUCCESS valide
    const successLogs = await DocumentAutomationLog.find({
      automationId: automation._id,
      sourceDocumentType: config.docType,
      sourceDocumentId: { $in: documents.map(d => d._id) },
      status: 'SUCCESS',
    }).select('sourceDocumentId').lean();

    const successIds = new Set(successLogs.map(l => l.sourceDocumentId.toString()));

    return documents
      .filter(d => !successIds.has(d._id.toString()))
      .map(d => {
        let clientName = d.client?.name || d.vendor?.name || '';
        let documentNumber = d.number || d.originalInvoiceNumber || d.originalQuoteNumber || '';

        if (config.docType === 'purchaseInvoice') {
          clientName = d.supplierName || '';
          documentNumber = d.invoiceNumber || '';
        } else if (config.docType === 'transaction') {
          clientName = d.description || '';
          documentNumber = d.externalId || '';
        }

        return {
          documentId: d._id.toString(),
          documentType: config.docType,
          documentNumber,
          prefix: d.prefix || '',
          clientName,
        };
      });
  },

  /**
   * Traite un document avec un PDF généré côté client.
   * Reçoit le PDF en base64, fait l'upload R2, crée le SharedDocument et le log.
   */
  async processAutomationDocumentWithPDF(automationId, workspaceId, documentId, documentType, pdfBase64, userId) {
    const automation = await DocumentAutomation.findById(automationId);
    if (!automation) {
      throw new Error('Automatisation non trouvée');
    }

    // Supprimer les anciens logs FAILED pour ce document (avant de réessayer)
    await DocumentAutomationLog.deleteMany({
      sourceDocumentType: documentType,
      sourceDocumentId: documentId,
      automationId: automation._id,
      status: 'FAILED',
    });

    // Récupérer le document source pour le contexte
    const config = this._getTriggerConfig(automation.triggerType);
    if (!config) {
      throw new Error(`Type de trigger non supporté: ${automation.triggerType}`);
    }

    const doc = await config.model.findById(documentId).lean();
    if (!doc) {
      throw new Error(`Document non trouvé: ${documentId}`);
    }

    // Récupérer le fichier selon le type de document
    let fileBuffer = null;
    let fileMimeType = 'application/pdf';
    let fileExt = 'pdf';
    let fileSize = 0;
    let r2CopySource = null; // Pour copie serveur-à-serveur R2

    if (documentType === 'importedInvoice' || documentType === 'importedQuote') {
      // Document importé : copie serveur-à-serveur R2 (sans transit par le serveur)
      const sourceKey = doc.file?.cloudflareKey;
      if (!sourceKey) throw new Error('Clé R2 introuvable pour le document importé');
      r2CopySource = {
        key: sourceKey,
        bucket: cloudflareService.importedInvoicesBucketName,
      };
      fileMimeType = doc.file?.mimeType || 'application/pdf';
      fileExt = doc.file?.originalFileName?.split('.').pop() || 'pdf';
      fileSize = doc.file?.fileSize || 0;
    } else if (documentType === 'purchaseInvoice') {
      // Facture d'achat : copie du premier fichier attaché
      const sourceFile = doc.files?.[0];
      if (!sourceFile?.url) throw new Error('Aucun fichier attaché à la facture d\'achat');
      const response = await axios.get(sourceFile.url, { responseType: 'arraybuffer', timeout: 30000 });
      fileBuffer = Buffer.from(response.data);
      fileMimeType = sourceFile.mimetype || 'application/pdf';
      fileExt = sourceFile.filename?.split('.').pop() || 'pdf';
      fileSize = fileBuffer.length;
    } else if (documentType === 'transaction') {
      // Transaction : copie du justificatif (receiptFile)
      const receiptUrl = doc.receiptFile?.url;
      if (!receiptUrl) throw new Error('Aucun justificatif pour cette transaction');
      const response = await axios.get(receiptUrl, { responseType: 'arraybuffer', timeout: 30000 });
      fileBuffer = Buffer.from(response.data);
      fileMimeType = doc.receiptFile?.mimetype || 'application/pdf';
      fileExt = doc.receiptFile?.filename?.split('.').pop() || 'pdf';
      fileSize = fileBuffer.length;
    } else if (pdfBase64) {
      // PDF fourni par le client
      fileBuffer = Buffer.from(pdfBase64, 'base64');
      fileSize = fileBuffer.length;
      // Cacher le PDF pour les automatisations futures (fire-and-forget)
      cacheDocumentPdf(documentId, documentType, fileBuffer, workspaceId).catch(() => {});
    } else if (doc.cachedPdf?.key) {
      // Copie R2 serveur-à-serveur depuis le cache (instantanée)
      r2CopySource = {
        key: doc.cachedPdf.key,
        bucket: cloudflareService.sharedDocumentsBucketName,
      };
    } else {
      // Générer le PDF côté serveur via l'API Next.js
      fileBuffer = await generateDocumentPdf(documentId, documentType);
      fileSize = fileBuffer?.length || 0;
      // Cacher le PDF pour les automatisations futures (fire-and-forget)
      if (fileBuffer) {
        cacheDocumentPdf(documentId, documentType, fileBuffer, workspaceId).catch(() => {});
      }
    }

    if (!r2CopySource && (!fileBuffer || fileBuffer.length === 0)) {
      throw new Error('Le fichier généré/récupéré est vide');
    }

    let contextClientName = doc.client?.name || doc.vendor?.name || '';
    let contextDocNumber = doc.number || doc.originalInvoiceNumber || doc.originalQuoteNumber || '';
    if (documentType === 'purchaseInvoice') {
      contextClientName = doc.supplierName || '';
      contextDocNumber = doc.invoiceNumber || '';
    } else if (documentType === 'transaction') {
      contextClientName = doc.description || '';
      contextDocNumber = doc.externalId || '';
    }

    const documentContext = {
      documentId: doc._id.toString(),
      documentType,
      documentNumber: contextDocNumber,
      prefix: doc.prefix || '',
      clientName: contextClientName,
    };

    // Résoudre le dossier cible
    const targetFolderId = await resolveTargetFolder(
      automation.actionConfig,
      workspaceId,
      documentContext,
      userId
    );

    // Construire le nom du fichier
    const fileName = buildFileName(
      automation.actionConfig.documentNaming || '{documentType}-{number}-{clientName}',
      documentContext,
      fileExt
    );

    // Upload ou copie vers R2
    let uploadResult;
    if (r2CopySource) {
      // Copie serveur-à-serveur R2 (pas de transit réseau)
      uploadResult = await cloudflareService.copyToSharedDocuments(
        r2CopySource.key, r2CopySource.bucket, fileName, workspaceId
      );
    } else {
      uploadResult = await cloudflareService.uploadImage(
        fileBuffer, fileName, userId, 'sharedDocuments', workspaceId
      );
    }

    // Récupérer le nom du dossier cible
    const targetFolder = await SharedFolder.findById(targetFolderId);
    const targetFolderName = targetFolder?.name || 'Inconnu';

    // Créer le SharedDocument
    const sharedDocument = new SharedDocument({
      name: fileName,
      originalName: fileName,
      description: `Importé automatiquement par l'automatisation "${automation.name}"`,
      fileUrl: uploadResult.url,
      fileKey: uploadResult.key,
      mimeType: fileMimeType,
      fileSize: fileSize,
      fileExtension: fileExt,
      workspaceId,
      folderId: targetFolderId,
      uploadedBy: userId,
      uploadedByName: 'Automatisation',
      status: automation.actionConfig.documentStatus || 'classified',
      isSharedWithAccountant: true,
      tags: automation.actionConfig.tags || [],
    });

    await sharedDocument.save();

    // Logger le succès
    await DocumentAutomationLog.create({
      automationId: automation._id,
      workspaceId,
      sourceDocumentType: documentType,
      sourceDocumentId: documentId,
      sourceDocumentNumber: documentContext.prefix
        ? `${documentContext.prefix}${documentContext.documentNumber}`
        : documentContext.documentNumber || '',
      sharedDocumentId: sharedDocument._id,
      targetFolderId,
      targetFolderName,
      status: 'SUCCESS',
      fileName,
      fileSize: fileSize,
    });

    // Mettre à jour les stats
    await DocumentAutomation.findByIdAndUpdate(automation._id, {
      $inc: { 'stats.totalExecutions': 1 },
      $set: {
        'stats.lastExecutedAt': new Date(),
        'stats.lastDocumentId': sharedDocument._id,
      },
    });

    return {
      success: true,
      sharedDocumentId: sharedDocument._id.toString(),
      fileName,
    };
  },

  /**
   * Exécute une automatisation rétroactivement sur tous les documents existants
   * qui correspondent aux conditions du trigger.
   * Ne skip que les logs SUCCESS (les FAILED peuvent être réessayés).
   * Traite par batch de 5 avec 500ms de pause entre batches.
   */
  async executeAutomationForExistingDocuments(automation, workspaceId, userId) {
    const config = this._getTriggerConfig(automation.triggerType);
    if (!config) {
      // Trigger non supporté pour le traitement rétroactif
      return { successCount: 0, skipCount: 0, failCount: 0, restoredCount: 0, total: 0 };
    }

    try {
      const query = { workspaceId };
      if (config.status) {
        query.status = config.status;
      }
      if (config.customFilter) {
        Object.assign(query, config.customFilter);
      }

      const documents = await config.model.find(query).lean();

      if (documents.length === 0) {
        // Aucun document existant
        return { successCount: 0, skipCount: 0, failCount: 0, restoredCount: 0, total: 0 };
      }

      // Nettoyer les logs SUCCESS dont le SharedDocument a été supprimé définitivement
      await this._cleanOrphanedLogs(automation._id, config.docType, documents.map(d => d._id));

      // Restaurer les SharedDocuments en corbeille vers leur dossier d'origine
      const restoredCount = await this._restoreTrashedAutomationDocs(
        automation._id, config.docType, documents.map(d => d._id)
      );

      let successCount = 0;
      let skipCount = 0;
      let failCount = 0;
      let firstError = null;

      // Pré-charger TOUS les logs SUCCESS en une seule requête
      const allDocIds = documents.map(d => d._id);
      const existingSuccessLogs = await DocumentAutomationLog.find({
        sourceDocumentType: config.docType,
        sourceDocumentId: { $in: allDocIds },
        automationId: automation._id,
        status: 'SUCCESS',
      }).select('sourceDocumentId').lean();

      const alreadyProcessedIds = new Set(
        existingSuccessLogs.map(log => log.sourceDocumentId.toString())
      );

      // Filtrer les documents à traiter (exclure ceux déjà traités)
      const docsToProcess = documents.filter(doc => !alreadyProcessedIds.has(doc._id.toString()));
      skipCount = documents.length - docsToProcess.length;

      if (docsToProcess.length === 0) {
        return { successCount: 0, skipCount, failCount: 0, restoredCount, total: documents.length };
      }

      // Supprimer TOUS les logs FAILED en une seule requête
      await DocumentAutomationLog.deleteMany({
        sourceDocumentType: config.docType,
        sourceDocumentId: { $in: docsToProcess.map(d => d._id) },
        automationId: automation._id,
        status: 'FAILED',
      });

      // Pré-résoudre le dossier cible (souvent le même pour tous les docs)
      const sampleContext = {
        documentId: docsToProcess[0]._id.toString(),
        documentType: config.docType,
        documentNumber: '',
        prefix: '',
        clientName: '',
      };
      const preResolvedFolderId = await resolveTargetFolder(
        automation.actionConfig, workspaceId, sampleContext, userId
      );
      const preResolvedFolder = await SharedFolder.findById(preResolvedFolderId).lean();
      const preResolvedFolderName = preResolvedFolder?.name || 'Inconnu';

      const isR2Copy = config.docType === 'importedInvoice' || config.docType === 'importedQuote';
      const isFileCopy = config.docType === 'purchaseInvoice' || config.docType === 'transaction';
      const BATCH_SIZE = 5;
      const BATCH_DELAY = 200;
      const automationIdStr = automation._id.toString();

      // Initialiser le suivi de progression
      _progressMap.set(automationIdStr, { current: 0, total: docsToProcess.length });

      for (let i = 0; i < docsToProcess.length; i += BATCH_SIZE) {
        const batch = docsToProcess.slice(i, i + BATCH_SIZE);

        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }

        // Traitement séquentiel document par document
        for (const doc of batch) {
          try {
            let ctxClientName = doc.client?.name || doc.vendor?.name || '';
            let ctxDocNumber = doc.number || doc.originalInvoiceNumber || doc.originalQuoteNumber || '';
            if (config.docType === 'purchaseInvoice') {
              ctxClientName = doc.supplierName || '';
              ctxDocNumber = doc.invoiceNumber || '';
            } else if (config.docType === 'transaction') {
              ctxClientName = doc.description || '';
              ctxDocNumber = doc.externalId || '';
            }

            const documentContext = {
              documentId: doc._id.toString(),
              documentType: config.docType,
              documentNumber: ctxDocNumber,
              prefix: doc.prefix || '',
              clientName: ctxClientName,
            };

            let fileBuffer = null;
            let fileMimeType = 'application/pdf';
            let fileExt = 'pdf';
            let fileSize = 0;
            let r2CopySource = null;

            if (isR2Copy) {
              const sourceKey = doc.file?.cloudflareKey;
              if (!sourceKey) throw new Error('Clé R2 introuvable pour la facture importée');
              r2CopySource = {
                key: sourceKey,
                bucket: cloudflareService.importedInvoicesBucketName,
              };
              fileMimeType = doc.file?.mimeType || 'application/pdf';
              fileExt = doc.file?.originalFileName?.split('.').pop() || 'pdf';
              fileSize = doc.file?.fileSize || 0;
            } else if (isFileCopy) {
              // Facture d'achat ou transaction : récupérer le fichier existant via URL
              let sourceUrl, sourceMime, sourceFilename;
              if (config.docType === 'purchaseInvoice') {
                const sourceFile = doc.files?.[0];
                if (!sourceFile?.url) throw new Error('Aucun fichier attaché à la facture d\'achat');
                sourceUrl = sourceFile.url;
                sourceMime = sourceFile.mimetype || 'application/pdf';
                sourceFilename = sourceFile.filename || '';
              } else {
                if (!doc.receiptFile?.url) throw new Error('Aucun justificatif pour cette transaction');
                sourceUrl = doc.receiptFile.url;
                sourceMime = doc.receiptFile.mimetype || 'application/pdf';
                sourceFilename = doc.receiptFile.filename || '';
              }
              const response = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 30000 });
              fileBuffer = Buffer.from(response.data);
              fileMimeType = sourceMime;
              fileExt = sourceFilename.split('.').pop() || 'pdf';
              fileSize = fileBuffer.length;
            } else if (doc.cachedPdf?.key) {
              // Copie R2 serveur-à-serveur depuis le cache (instantanée)
              r2CopySource = {
                key: doc.cachedPdf.key,
                bucket: cloudflareService.sharedDocumentsBucketName,
              };
            } else {
              fileBuffer = await generateDocumentPdf(documentContext.documentId, config.docType);
              fileSize = fileBuffer?.length || 0;
            }

            if (!r2CopySource && (!fileBuffer || fileBuffer.length === 0)) {
              throw new Error('Le fichier généré/récupéré est vide');
            }

            let targetFolderId = preResolvedFolderId;
            let targetFolderName = preResolvedFolderName;
            if (automation.actionConfig.createSubfolder && automation.actionConfig.subfolderPattern) {
              targetFolderId = await resolveTargetFolder(
                automation.actionConfig, workspaceId, documentContext, userId
              );
              if (targetFolderId.toString() !== preResolvedFolderId.toString()) {
                const folder = await SharedFolder.findById(targetFolderId).lean();
                targetFolderName = folder?.name || 'Inconnu';
              }
            }

            const fileName = buildFileName(
              automation.actionConfig.documentNaming || '{documentType}-{number}-{clientName}',
              documentContext,
              fileExt
            );

            let uploadResult;
            if (r2CopySource) {
              uploadResult = await cloudflareService.copyToSharedDocuments(
                r2CopySource.key, r2CopySource.bucket, fileName, workspaceId
              );
            } else {
              uploadResult = await cloudflareService.uploadImage(
                fileBuffer, fileName, userId, 'sharedDocuments', workspaceId
              );
              // Cacher le PDF pour les prochaines automatisations (fire-and-forget)
              if (!isR2Copy && !isFileCopy && fileBuffer) {
                cacheDocumentPdf(doc._id.toString(), config.docType, fileBuffer, workspaceId)
                  .catch(() => {});
              }
            }

            // Créer le SharedDocument
            const sharedDocument = new SharedDocument({
              name: fileName,
              originalName: fileName,
              description: `Importé automatiquement par l'automatisation "${automation.name}"`,
              fileUrl: uploadResult.url,
              fileKey: uploadResult.key,
              mimeType: fileMimeType,
              fileSize: fileSize,
              fileExtension: fileExt,
              workspaceId,
              folderId: targetFolderId,
              uploadedBy: userId,
              uploadedByName: 'Automatisation',
              status: automation.actionConfig.documentStatus || 'classified',
              isSharedWithAccountant: true,
              tags: automation.actionConfig.tags || [],
            });

            await sharedDocument.save();

            // Logger le succès
            await DocumentAutomationLog.create({
              automationId: automation._id,
              workspaceId,
              sourceDocumentType: config.docType,
              sourceDocumentId: doc._id,
              sourceDocumentNumber: documentContext.prefix
                ? `${documentContext.prefix}${documentContext.documentNumber}`
                : documentContext.documentNumber || '',
              sharedDocumentId: sharedDocument._id,
              targetFolderId,
              targetFolderName,
              status: 'SUCCESS',
              fileName,
              fileSize,
            });

            successCount++;
          } catch (error) {
            if (!firstError) firstError = error.message;
            failCount++;
          }

          // Mettre à jour la progression après chaque document
          _progressMap.set(automationIdStr, { current: successCount + failCount, total: docsToProcess.length });
        }
      }

      // Une seule mise à jour de stats à la fin
      const statsUpdate = {};
      if (successCount > 0) {
        statsUpdate.$inc = { 'stats.totalExecutions': successCount };
        statsUpdate.$set = { 'stats.lastExecutedAt': new Date() };
      }
      if (failCount > 0) {
        if (!statsUpdate.$inc) statsUpdate.$inc = {};
        statsUpdate.$inc['stats.failedExecutions'] = failCount;
      }
      if (Object.keys(statsUpdate).length > 0) {
        await DocumentAutomation.findByIdAndUpdate(automation._id, statsUpdate).catch(() => {});
      }

      _progressMap.delete(automationIdStr);
      return { successCount, skipCount, failCount, restoredCount, total: documents.length, firstError };
    } catch (error) {
      _progressMap.delete(automation._id.toString());
      return { successCount: 0, skipCount: 0, failCount: 0, restoredCount: 0, total: 0, firstError: error.message };
    }
  },

  /**
   * Vérifie les factures en retard et déclenche les automatisations OVERDUE.
   * Appelé par le cron quotidien.
   * - Factures (Invoice) : PENDING + dueDate dépassée → trigger INVOICE_OVERDUE
   * - Factures d'achat (PurchaseInvoice) : TO_PAY + dueDate dépassée → trigger PURCHASE_INVOICE_OVERDUE
   */
  async checkOverdueAutomations() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    console.log('🔍 [OverdueCron] Vérification des documents en retard...');

    // Trouver tous les workspaces ayant des automatisations OVERDUE actives
    const overdueAutomations = await DocumentAutomation.find({
      triggerType: { $in: ['INVOICE_OVERDUE', 'PURCHASE_INVOICE_OVERDUE'] },
      isActive: true,
    }).lean();

    if (overdueAutomations.length === 0) {
      console.log('ℹ️ [OverdueCron] Aucune automatisation OVERDUE active.');
      return { processed: 0 };
    }

    let totalProcessed = 0;

    // Grouper par workspace
    const byWorkspace = {};
    for (const auto of overdueAutomations) {
      const wsId = auto.workspaceId.toString();
      if (!byWorkspace[wsId]) byWorkspace[wsId] = [];
      byWorkspace[wsId].push(auto);
    }

    for (const [workspaceId, automations] of Object.entries(byWorkspace)) {
      for (const automation of automations) {
        try {
          if (automation.triggerType === 'INVOICE_OVERDUE') {
            // Factures PENDING dont la date d'échéance est dépassée
            const overdueInvoices = await Invoice.find({
              workspaceId,
              status: 'PENDING',
              dueDate: { $lt: today },
            }).lean();

            for (const inv of overdueInvoices) {
              // Vérifier si déjà traité par cette automatisation
              const alreadyProcessed = await DocumentAutomationLog.findOne({
                automationId: automation._id,
                sourceDocumentId: inv._id,
                status: 'SUCCESS',
              });
              if (alreadyProcessed) {
                // Vérifier que le SharedDocument existe encore
                const exists = await SharedDocument.findById(alreadyProcessed.sharedDocumentId);
                if (exists) continue;
              }

              // Déclencher l'automatisation
              await this.executeAutomations('INVOICE_OVERDUE', workspaceId, {
                documentId: inv._id.toString(),
                documentType: 'invoice',
                documentNumber: inv.number,
                prefix: inv.prefix || '',
                clientName: inv.client?.name || '',
              }, automation.createdBy.toString());
              totalProcessed++;
            }
          } else if (automation.triggerType === 'PURCHASE_INVOICE_OVERDUE') {
            // Factures d'achat TO_PAY dont la date d'échéance est dépassée
            const overduePIs = await PurchaseInvoice.find({
              workspaceId: automation.workspaceId,
              status: 'TO_PAY',
              dueDate: { $lt: today },
            }).lean();

            for (const pi of overduePIs) {
              const alreadyProcessed = await DocumentAutomationLog.findOne({
                automationId: automation._id,
                sourceDocumentId: pi._id,
                status: 'SUCCESS',
              });
              if (alreadyProcessed) {
                const exists = await SharedDocument.findById(alreadyProcessed.sharedDocumentId);
                if (exists) continue;
              }

              await this.executeAutomationsForExpense('PURCHASE_INVOICE_OVERDUE', workspaceId, {
                documentId: pi._id.toString(),
                documentType: 'purchaseInvoice',
                documentNumber: pi.invoiceNumber || '',
                supplierName: pi.supplierName || '',
                fileUrl: pi.files?.[0]?.url || null,
                fileKey: pi.files?.[0]?.path || null,
                fileName: pi.files?.[0]?.originalFilename || null,
                mimeType: pi.files?.[0]?.mimetype || 'application/pdf',
              }, automation.createdBy.toString());
              totalProcessed++;
            }
          }
        } catch (err) {
          console.error(`❌ [OverdueCron] Erreur automation ${automation._id}:`, err.message);
        }
      }
    }

    console.log(`✅ [OverdueCron] ${totalProcessed} document(s) en retard traité(s).`);
    return { processed: totalProcessed };
  },
};

export default documentAutomationService;
