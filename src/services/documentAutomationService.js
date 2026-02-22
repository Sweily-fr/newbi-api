import DocumentAutomation from '../models/DocumentAutomation.js';
import DocumentAutomationLog from '../models/DocumentAutomationLog.js';
import SharedDocument from '../models/SharedDocument.js';
import SharedFolder from '../models/SharedFolder.js';
import Invoice from '../models/Invoice.js';
import Quote from '../models/Quote.js';
import CreditNote from '../models/CreditNote.js';
import cloudflareService from './cloudflareService.js';
import axios from 'axios';

const DOCUMENT_TYPE_LABELS = {
  invoice: 'Facture',
  quote: 'Devis',
  creditNote: 'Avoir',
  expense: 'Depense',
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
  };

  const endpoint = endpointMap[documentType];
  if (!endpoint) {
    throw new Error(`Type de document non supporté pour la génération PDF: ${documentType}`);
  }

  const bodyKeyMap = {
    invoice: 'invoiceId',
    quote: 'quoteId',
    creditNote: 'creditNoteId',
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
function buildFileName(pattern, documentContext) {
  const typeLabel = DOCUMENT_TYPE_LABELS[documentContext.documentType] || documentContext.documentType;
  const number = documentContext.prefix
    ? `${documentContext.prefix}${documentContext.documentNumber}`
    : documentContext.documentNumber;

  let fileName = pattern
    .replace('{documentType}', typeLabel)
    .replace('{number}', number || '')
    .replace('{clientName}', documentContext.clientName || 'Sans_client');

  return sanitizeFileName(fileName) + '.pdf';
}

/**
 * Résout le dossier cible, en créant les sous-dossiers dynamiques si nécessaire
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

  // Résoudre les variables du pattern
  const resolvedPattern = pattern
    .replace('{year}', year)
    .replace('{month}', month)
    .replace('{clientName}', clientName);

  // Découper le pattern en niveaux (ex: "2026/01" → ["2026", "01"])
  const levels = resolvedPattern.split('/').filter(Boolean);

  let currentParentId = actionConfig.targetFolderId;

  for (const levelName of levels) {
    // Chercher le sous-dossier existant
    let folder = await SharedFolder.findOne({
      workspaceId,
      parentId: currentParentId,
      name: levelName,
      trashedAt: null,
    });

    if (!folder) {
      // Créer le sous-dossier
      folder = new SharedFolder({
        name: levelName,
        workspaceId,
        parentId: currentParentId,
        createdBy: userId,
        isSharedWithAccountant: true,
      });
      await folder.save();
    }

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
      console.log(`🔍 [DocumentAutomation] Recherche automations: trigger=${triggerType}, workspace=${workspaceId}`);

      const automations = await DocumentAutomation.find({
        workspaceId,
        triggerType,
        isActive: true,
      });

      console.log(`🔍 [DocumentAutomation] ${automations.length} automation(s) trouvée(s) pour ${triggerType}`);

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

          console.log(`📄 [DocumentAutomation] Génération PDF pour ${documentContext.documentType} ${documentContext.documentId} (automation: "${automation.name}")`);

          // Générer le PDF
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

          console.log(`✅ [DocumentAutomation] PDF généré: ${pdfBuffer.length} bytes`);

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
            documentContext
          );

          // Upload vers R2
          const uploadResult = await cloudflareService.uploadImage(
            pdfBuffer,
            fileName,
            userId,
            'sharedDocuments',
            workspaceId
          );

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
            mimeType: 'application/pdf',
            fileSize: pdfBuffer.length,
            fileExtension: 'pdf',
            workspaceId,
            folderId: targetFolderId,
            uploadedBy: userId,
            uploadedByName: 'Automatisation',
            status: automation.actionConfig.documentStatus || 'classified',
            isSharedWithAccountant: true,
            tags: automation.actionConfig.tags || [],
          });

          await sharedDocument.save();

          console.log(`✅ [DocumentAutomation] SharedDocument créé: ${sharedDocument._id} dans dossier "${targetFolderName}" (${targetFolderId})`);

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
            fileSize: pdfBuffer.length,
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
      INVOICE_SENT:      { model: Invoice,    status: 'PENDING',   docType: 'invoice' },
      INVOICE_PAID:      { model: Invoice,    status: 'COMPLETED', docType: 'invoice' },
      INVOICE_CANCELED:  { model: Invoice,    status: 'CANCELED',  docType: 'invoice' },
      QUOTE_SENT:        { model: Quote,      status: 'PENDING',   docType: 'quote' },
      QUOTE_ACCEPTED:    { model: Quote,      status: 'COMPLETED', docType: 'quote' },
      QUOTE_CANCELED:    { model: Quote,      status: 'CANCELED',  docType: 'quote' },
      CREDIT_NOTE_CREATED: { model: CreditNote, status: null,      docType: 'creditNote' },
    };
    return TRIGGER_TO_QUERY[triggerType] || null;
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

    const documents = await config.model.find(query).select('_id').lean();
    if (documents.length === 0) return 0;

    // Compter ceux qui ont déjà un log SUCCESS
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

    const documents = await config.model.find(query).lean();
    if (documents.length === 0) return [];

    // Récupérer les IDs qui ont déjà un log SUCCESS
    const successLogs = await DocumentAutomationLog.find({
      automationId: automation._id,
      sourceDocumentType: config.docType,
      sourceDocumentId: { $in: documents.map(d => d._id) },
      status: 'SUCCESS',
    }).select('sourceDocumentId').lean();

    const successIds = new Set(successLogs.map(l => l.sourceDocumentId.toString()));

    return documents
      .filter(d => !successIds.has(d._id.toString()))
      .map(d => ({
        documentId: d._id.toString(),
        documentType: config.docType,
        documentNumber: d.number || '',
        prefix: d.prefix || '',
        clientName: d.client?.name || '',
      }));
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

    // Convertir le base64 en Buffer
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('Le PDF reçu est vide');
    }

    // Récupérer le document source pour le contexte
    const config = this._getTriggerConfig(automation.triggerType);
    if (!config) {
      throw new Error(`Type de trigger non supporté: ${automation.triggerType}`);
    }

    const doc = await config.model.findById(documentId).lean();
    if (!doc) {
      throw new Error(`Document non trouvé: ${documentId}`);
    }

    const documentContext = {
      documentId: doc._id.toString(),
      documentType,
      documentNumber: doc.number || '',
      prefix: doc.prefix || '',
      clientName: doc.client?.name || '',
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
      documentContext
    );

    // Upload vers R2
    const uploadResult = await cloudflareService.uploadImage(
      pdfBuffer,
      fileName,
      userId,
      'sharedDocuments',
      workspaceId
    );

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
      mimeType: 'application/pdf',
      fileSize: pdfBuffer.length,
      fileExtension: 'pdf',
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
      fileSize: pdfBuffer.length,
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
      console.log(`⚠️ [DocumentAutomation] Trigger "${automation.triggerType}" non supporté pour le traitement rétroactif`);
      return { successCount: 0, skipCount: 0, failCount: 0, total: 0 };
    }

    try {
      const query = { workspaceId };
      if (config.status) {
        query.status = config.status;
      }

      const documents = await config.model.find(query).lean();

      if (documents.length === 0) {
        console.log(`ℹ️ [DocumentAutomation] Aucun document existant pour "${automation.name}" (${automation.triggerType})`);
        return { successCount: 0, skipCount: 0, failCount: 0, total: 0 };
      }

      console.log(`🔄 [DocumentAutomation] Traitement rétroactif: ${documents.length} documents pour "${automation.name}"`);

      let successCount = 0;
      let skipCount = 0;
      let failCount = 0;
      let firstError = null;

      const BATCH_SIZE = 5;
      const BATCH_DELAY = 500;

      for (let i = 0; i < documents.length; i += BATCH_SIZE) {
        const batch = documents.slice(i, i + BATCH_SIZE);

        // Pause entre batches (sauf le premier)
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }

        for (const doc of batch) {
          try {
            // Ne skip que les logs SUCCESS (les FAILED peuvent être réessayés)
            const existingSuccessLog = await DocumentAutomationLog.findOne({
              sourceDocumentType: config.docType,
              sourceDocumentId: doc._id,
              automationId: automation._id,
              status: 'SUCCESS',
            });

            if (existingSuccessLog) {
              skipCount++;
              continue;
            }

            // Supprimer les anciens logs FAILED pour ce document (avant de réessayer)
            await DocumentAutomationLog.deleteMany({
              sourceDocumentType: config.docType,
              sourceDocumentId: doc._id,
              automationId: automation._id,
              status: 'FAILED',
            });

            const documentContext = {
              documentId: doc._id.toString(),
              documentType: config.docType,
              documentNumber: doc.number,
              prefix: doc.prefix || '',
              clientName: doc.client?.name || '',
            };

            // Générer le PDF
            const pdfBuffer = await generateDocumentPdf(documentContext.documentId, config.docType);
            if (!pdfBuffer || pdfBuffer.length === 0) {
              throw new Error('Le PDF généré est vide');
            }

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
              documentContext
            );

            // Upload vers R2
            const uploadResult = await cloudflareService.uploadImage(
              pdfBuffer,
              fileName,
              userId,
              'sharedDocuments',
              workspaceId
            );

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
              mimeType: 'application/pdf',
              fileSize: pdfBuffer.length,
              fileExtension: 'pdf',
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
              fileSize: pdfBuffer.length,
            });

            // Mettre à jour les stats
            await DocumentAutomation.findByIdAndUpdate(automation._id, {
              $inc: { 'stats.totalExecutions': 1 },
              $set: {
                'stats.lastExecutedAt': new Date(),
                'stats.lastDocumentId': sharedDocument._id,
              },
            });

            successCount++;
          } catch (error) {
            console.error(
              `❌ [DocumentAutomation] Erreur rétroactive doc ${doc._id} pour "${automation.name}":`,
              error.message
            );

            // Logger l'échec
            try {
              await DocumentAutomationLog.create({
                automationId: automation._id,
                workspaceId,
                sourceDocumentType: config.docType,
                sourceDocumentId: doc._id,
                sourceDocumentNumber: doc.prefix
                  ? `${doc.prefix}${doc.number}`
                  : doc.number || '',
                status: 'FAILED',
                error: error.message,
              });
            } catch (logError) {
              if (logError.code !== 11000) {
                console.error('❌ [DocumentAutomation] Erreur log rétroactif:', logError.message);
              }
            }

            await DocumentAutomation.findByIdAndUpdate(automation._id, {
              $inc: { 'stats.failedExecutions': 1 },
            }).catch(() => {});

            if (!firstError) {
              firstError = error.message;
            }
            failCount++;
          }
        }
      }

      console.log(
        `✅ [DocumentAutomation] Traitement rétroactif terminé pour "${automation.name}": ` +
        `${successCount} succès, ${skipCount} ignorés, ${failCount} échecs sur ${documents.length} documents`
      );

      return { successCount, skipCount, failCount, total: documents.length, firstError };
    } catch (error) {
      console.error(`❌ [DocumentAutomation] Erreur globale rétroactive pour "${automation.name}":`, error);
      return { successCount: 0, skipCount: 0, failCount: 0, total: 0, firstError: error.message };
    }
  },
};

export default documentAutomationService;
