import DocumentAutomation from '../models/DocumentAutomation.js';
import DocumentAutomationLog from '../models/DocumentAutomationLog.js';
import SharedDocument from '../models/SharedDocument.js';
import SharedFolder from '../models/SharedFolder.js';
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
          // Vérifier le dédoublonnage
          const existingLog = await DocumentAutomationLog.findOne({
            sourceDocumentType: documentContext.documentType,
            sourceDocumentId: documentContext.documentId,
            automationId: automation._id,
          });

          if (existingLog) {
            results.push({
              automationId: automation._id,
              automationName: automation.name,
              success: true,
              skipped: true,
            });
            continue;
          }

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
          // Vérifier le dédoublonnage
          const existingLog = await DocumentAutomationLog.findOne({
            sourceDocumentType: 'expense',
            sourceDocumentId: expenseContext.documentId,
            automationId: automation._id,
          });

          if (existingLog) {
            results.push({
              automationId: automation._id,
              automationName: automation.name,
              success: true,
              skipped: true,
            });
            continue;
          }

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
};

export default documentAutomationService;
