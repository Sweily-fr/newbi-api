import DocumentAutomation from '../models/DocumentAutomation.js';
import DocumentAutomationLog from '../models/DocumentAutomationLog.js';
import SharedFolder from '../models/SharedFolder.js';
import { isAuthenticated } from '../middlewares/better-auth-jwt.js';
import {
  createNotFoundError,
  createValidationError,
} from '../utils/errors.js';

const documentAutomationResolvers = {
  Query: {
    documentAutomations: isAuthenticated(
      async (_, { workspaceId }) => {
        const automations = await DocumentAutomation.find({ workspaceId })
          .populate('createdBy')
          .sort({ createdAt: -1 });

        return automations;
      }
    ),

    documentAutomation: isAuthenticated(
      async (_, { workspaceId, id }) => {
        const automation = await DocumentAutomation.findOne({
          _id: id,
          workspaceId,
        }).populate('createdBy');

        if (!automation) {
          throw createNotFoundError('Automatisation');
        }

        return automation;
      }
    ),

    documentAutomationLogs: isAuthenticated(
      async (_, { workspaceId, automationId, limit }) => {
        const filter = { workspaceId };
        if (automationId) {
          filter.automationId = automationId;
        }

        const logs = await DocumentAutomationLog.find(filter)
          .sort({ createdAt: -1 })
          .limit(limit || 50);

        return logs;
      }
    ),
  },

  Mutation: {
    createDocumentAutomation: isAuthenticated(
      async (_, { workspaceId, input }, context) => {
        const { user } = context;

        // Vérifier que le dossier cible existe
        const targetFolder = await SharedFolder.findOne({
          _id: input.actionConfig.targetFolderId,
          workspaceId,
          trashedAt: null,
        });

        if (!targetFolder) {
          throw createValidationError('Le dossier cible n\'existe pas', {
            targetFolderId: 'Dossier cible invalide',
          });
        }

        const automation = new DocumentAutomation({
          name: input.name,
          description: input.description || '',
          workspaceId,
          createdBy: user._id,
          triggerType: input.triggerType,
          actionConfig: {
            targetFolderId: input.actionConfig.targetFolderId,
            createSubfolder: input.actionConfig.createSubfolder || false,
            subfolderPattern: input.actionConfig.subfolderPattern || '{year}',
            documentNaming: input.actionConfig.documentNaming || '{documentType}-{number}-{clientName}',
            tags: input.actionConfig.tags || [],
            documentStatus: input.actionConfig.documentStatus || 'classified',
          },
          isActive: input.isActive ?? true,
        });

        await automation.save();

        return await DocumentAutomation.findById(automation._id)
          .populate('createdBy');
      }
    ),

    updateDocumentAutomation: isAuthenticated(
      async (_, { workspaceId, id, input }) => {
        const automation = await DocumentAutomation.findOne({
          _id: id,
          workspaceId,
        });

        if (!automation) {
          throw createNotFoundError('Automatisation');
        }

        // Vérifier le dossier cible si modifié
        if (input.actionConfig?.targetFolderId) {
          const targetFolder = await SharedFolder.findOne({
            _id: input.actionConfig.targetFolderId,
            workspaceId,
            trashedAt: null,
          });

          if (!targetFolder) {
            throw createValidationError('Le dossier cible n\'existe pas', {
              targetFolderId: 'Dossier cible invalide',
            });
          }
        }

        // Mettre à jour les champs simples
        if (input.name !== undefined) automation.name = input.name;
        if (input.description !== undefined) automation.description = input.description;
        if (input.triggerType !== undefined) automation.triggerType = input.triggerType;
        if (input.isActive !== undefined) automation.isActive = input.isActive;

        // Mettre à jour l'actionConfig (merge)
        if (input.actionConfig) {
          const currentConfig = automation.actionConfig || {};
          automation.actionConfig = {
            targetFolderId: input.actionConfig.targetFolderId || currentConfig.targetFolderId,
            createSubfolder: input.actionConfig.createSubfolder ?? currentConfig.createSubfolder,
            subfolderPattern: input.actionConfig.subfolderPattern || currentConfig.subfolderPattern,
            documentNaming: input.actionConfig.documentNaming || currentConfig.documentNaming,
            tags: input.actionConfig.tags !== undefined ? input.actionConfig.tags : currentConfig.tags,
            documentStatus: input.actionConfig.documentStatus || currentConfig.documentStatus,
          };
        }

        await automation.save();

        return await DocumentAutomation.findById(automation._id)
          .populate('createdBy');
      }
    ),

    deleteDocumentAutomation: isAuthenticated(
      async (_, { workspaceId, id }) => {
        const automation = await DocumentAutomation.findOne({
          _id: id,
          workspaceId,
        });

        if (!automation) {
          throw createNotFoundError('Automatisation');
        }

        await DocumentAutomation.deleteOne({ _id: id });

        // Nettoyer les logs associés
        await DocumentAutomationLog.deleteMany({ automationId: id });

        return true;
      }
    ),

    toggleDocumentAutomation: isAuthenticated(
      async (_, { workspaceId, id }) => {
        const automation = await DocumentAutomation.findOne({
          _id: id,
          workspaceId,
        });

        if (!automation) {
          throw createNotFoundError('Automatisation');
        }

        automation.isActive = !automation.isActive;
        await automation.save();

        return await DocumentAutomation.findById(automation._id)
          .populate('createdBy');
      }
    ),

    testDocumentAutomation: isAuthenticated(
      async (_, { workspaceId, id }) => {
        const automation = await DocumentAutomation.findOne({
          _id: id,
          workspaceId,
        });

        if (!automation) {
          throw createNotFoundError('Automatisation');
        }

        // Vérifier que le dossier cible existe toujours
        const targetFolder = await SharedFolder.findOne({
          _id: automation.actionConfig.targetFolderId,
          workspaceId,
          trashedAt: null,
        });

        if (!targetFolder) {
          throw createValidationError('Le dossier cible n\'existe plus');
        }

        return true;
      }
    ),
  },

  DocumentAutomation: {
    id: (parent) => parent._id?.toString() || parent.id,
    createdAt: (parent) =>
      parent.createdAt ? new Date(parent.createdAt).toISOString() : null,
    updatedAt: (parent) =>
      parent.updatedAt ? new Date(parent.updatedAt).toISOString() : null,
  },

  DocumentAutomationActionConfig: {
    targetFolder: async (parent) => {
      if (!parent.targetFolderId) return null;
      return await SharedFolder.findById(parent.targetFolderId);
    },
  },

  DocumentAutomationStats: {
    lastExecutedAt: (parent) =>
      parent.lastExecutedAt
        ? new Date(parent.lastExecutedAt).toISOString()
        : null,
    lastDocumentId: (parent) =>
      parent.lastDocumentId ? parent.lastDocumentId.toString() : null,
  },

  DocumentAutomationLog: {
    id: (parent) => parent._id?.toString() || parent.id,
    createdAt: (parent) =>
      parent.createdAt ? new Date(parent.createdAt).toISOString() : null,
  },
};

export default documentAutomationResolvers;
