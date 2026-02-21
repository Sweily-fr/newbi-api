import ClientAutomation from '../models/ClientAutomation.js';
import ClientList from '../models/ClientList.js';
import Client from '../models/Client.js';
import Invoice from '../models/Invoice.js';
import {
  requireWrite,
  requireRead,
  requireDelete,
} from '../middlewares/rbac.js';
import {
  createNotFoundError,
  createValidationError,
} from '../utils/errors.js';
import mongoose from 'mongoose';

/**
 * Service pour exécuter les automatisations
 */
export const automationService = {
  /**
   * Exécute les automatisations pour un déclencheur donné
   * @param {string} triggerType - Type de déclencheur
   * @param {string} workspaceId - ID du workspace
   * @param {string} clientId - ID du client concerné
   * @param {object} context - Contexte supplémentaire (montant, etc.)
   */
  async executeAutomations(triggerType, workspaceId, clientId, context = {}) {
    try {
      // Récupérer les automatisations actives pour ce déclencheur
      const automations = await ClientAutomation.find({
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
          // Vérifier les conditions du déclencheur
          if (!this.checkTriggerConditions(automation, context)) {
            continue;
          }

          // Vérifier si le client est dans la liste source (si spécifiée)
          if (automation.sourceListId) {
            const sourceList = await ClientList.findById(automation.sourceListId);
            if (!sourceList || !sourceList.clients.includes(clientId)) {
              continue;
            }
          }

          // Exécuter l'action
          await this.executeAction(automation, clientId);

          // Mettre à jour les statistiques
          await ClientAutomation.findByIdAndUpdate(automation._id, {
            $inc: { 'stats.totalExecutions': 1 },
            $set: {
              'stats.lastExecutedAt': new Date(),
              'stats.lastClientId': clientId,
            },
          });

          results.push({
            automationId: automation._id,
            automationName: automation.name,
            success: true,
          });
        } catch (error) {
          console.error(
            `Erreur lors de l'exécution de l'automatisation ${automation._id}:`,
            error
          );
          results.push({
            automationId: automation._id,
            automationName: automation.name,
            success: false,
            error: error.message,
          });
        }
      }

      return { executed: results.filter((r) => r.success).length, results };
    } catch (error) {
      console.error("Erreur lors de l'exécution des automatisations:", error);
      return { executed: 0, results: [], error: error.message };
    }
  },

  /**
   * Vérifie les conditions du déclencheur
   */
  checkTriggerConditions(automation, context) {
    const { triggerConfig } = automation;

    // Vérifier le montant minimum si configuré
    if (triggerConfig?.minAmount && context.amount) {
      if (context.amount < triggerConfig.minAmount) {
        return false;
      }
    }

    // Pour FIRST_INVOICE_PAID, vérifier que c'est bien la première facture
    if (automation.triggerType === "FIRST_INVOICE_PAID") {
      if (!context.isFirstInvoice) {
        return false;
      }
    }

    return true;
  },

  /**
   * Exécute l'action de l'automatisation
   */
  async executeAction(automation, clientId) {
    const { actionType, sourceListId, targetListId } = automation;

    switch (actionType) {
    case 'MOVE_TO_LIST':
      // Retirer de la liste source si spécifiée
      if (sourceListId) {
        await ClientList.findByIdAndUpdate(sourceListId, {
          $pull: { clients: clientId },
        });
      } else {
        // Retirer de toutes les listes du workspace
        await ClientList.updateMany(
          { workspaceId: automation.workspaceId },
          { $pull: { clients: clientId } }
        );
      }
      // Ajouter à la liste cible
      await ClientList.findByIdAndUpdate(targetListId, {
        $addToSet: { clients: clientId },
      });
      break;

    case 'ADD_TO_LIST':
      // Ajouter à la liste cible sans retirer des autres
      await ClientList.findByIdAndUpdate(targetListId, {
        $addToSet: { clients: clientId },
      });
      break;

    case 'REMOVE_FROM_LIST':
      // Retirer de la liste cible
      await ClientList.findByIdAndUpdate(targetListId, {
        $pull: { clients: clientId },
      });
      break;

    default:
      throw new Error(`Action non supportée: ${actionType}`);
    }

    // Enregistrer l'activité dans le client
    await Client.findByIdAndUpdate(clientId, {
      $push: {
        activity: {
          id: new mongoose.Types.ObjectId().toString(),
          type: 'automation_executed',
          userName: 'Système',
          description: `Automatisation "${automation.name}" exécutée`,
          metadata: {
            automationId: automation._id.toString(),
            automationName: automation.name,
            actionType,
            targetListId: targetListId.toString(),
          },
          createdAt: new Date(),
        },
      },
    });
  },

  /**
   * Vérifie si c'est la première facture payée d'un client
   */
  async isFirstPaidInvoice(clientId, workspaceId, currentInvoiceId) {
    const paidInvoicesCount = await Invoice.countDocuments({
      'client.id': clientId,
      workspaceId,
      status: 'COMPLETED',
      _id: { $ne: currentInvoiceId },
    });

    return paidInvoicesCount === 0;
  },
};

const clientAutomationResolvers = {
  Query: {
    clientAutomations: requireRead('clients')(
      async (_, { workspaceId }) => {
        const automations = await ClientAutomation.find({ workspaceId })
          .populate('createdBy')
          .populate('sourceListId')
          .populate('targetListId')
          .sort({ createdAt: -1 });

        return automations;
      }
    ),

    clientAutomation: requireRead('clients')(
      async (_, { workspaceId, id }) => {
        const automation = await ClientAutomation.findOne({
          _id: id,
          workspaceId,
        })
          .populate('createdBy')
          .populate('sourceListId')
          .populate('targetListId');

        if (!automation) {
          throw createNotFoundError('Automatisation');
        }

        return automation;
      }
    ),
  },

  Mutation: {
    createClientAutomation: requireWrite('clients')(
      async (_, { workspaceId, input }, context) => {
        const { user } = context;

        // Vérifier que la liste cible existe
        const targetList = await ClientList.findOne({
          _id: input.targetListId,
          workspaceId,
        });

        if (!targetList) {
          throw createValidationError('La liste cible n\'existe pas', {
            targetListId: 'Liste cible invalide',
          });
        }

        // Vérifier que la liste source existe si spécifiée
        if (input.sourceListId) {
          const sourceList = await ClientList.findOne({
            _id: input.sourceListId,
            workspaceId,
          });

          if (!sourceList) {
            throw createValidationError('La liste source n\'existe pas', {
              sourceListId: 'Liste source invalide',
            });
          }
        }

        const automation = new ClientAutomation({
          ...input,
          workspaceId,
          createdBy: user._id,
        });

        await automation.save();

        return await ClientAutomation.findById(automation._id)
          .populate('createdBy')
          .populate('sourceListId')
          .populate('targetListId');
      }
    ),

    updateClientAutomation: requireWrite('clients')(
      async (_, { workspaceId, id, input }) => {
        const automation = await ClientAutomation.findOne({
          _id: id,
          workspaceId,
        });

        if (!automation) {
          throw createNotFoundError('Automatisation');
        }

        // Vérifier la liste cible si modifiée
        if (input.targetListId) {
          const targetList = await ClientList.findOne({
            _id: input.targetListId,
            workspaceId,
          });

          if (!targetList) {
            throw createValidationError('La liste cible n\'existe pas', {
              targetListId: 'Liste cible invalide',
            });
          }
        }

        // Vérifier la liste source si modifiée
        if (input.sourceListId) {
          const sourceList = await ClientList.findOne({
            _id: input.sourceListId,
            workspaceId,
          });

          if (!sourceList) {
            throw createValidationError('La liste source n\'existe pas', {
              sourceListId: 'Liste source invalide',
            });
          }
        }

        Object.assign(automation, input);
        await automation.save();

        return await ClientAutomation.findById(automation._id)
          .populate('createdBy')
          .populate('sourceListId')
          .populate('targetListId');
      }
    ),

    deleteClientAutomation: requireDelete('clients')(
      async (_, { workspaceId, id }) => {
        const automation = await ClientAutomation.findOne({
          _id: id,
          workspaceId,
        });

        if (!automation) {
          throw createNotFoundError('Automatisation');
        }

        await ClientAutomation.deleteOne({ _id: id });

        return true;
      }
    ),

    toggleClientAutomation: requireWrite('clients')(
      async (_, { workspaceId, id }) => {
        const automation = await ClientAutomation.findOne({
          _id: id,
          workspaceId,
        });

        if (!automation) {
          throw createNotFoundError('Automatisation');
        }

        automation.isActive = !automation.isActive;
        await automation.save();

        return await ClientAutomation.findById(automation._id)
          .populate('createdBy')
          .populate('sourceListId')
          .populate('targetListId');
      }
    ),
  },

  ClientAutomation: {
    id: (parent) => parent._id?.toString() || parent.id,
    sourceList: (parent) => parent.sourceListId,
    targetList: (parent) => parent.targetListId,
    createdAt: (parent) =>
      parent.createdAt ? new Date(parent.createdAt).toISOString() : null,
    updatedAt: (parent) =>
      parent.updatedAt ? new Date(parent.updatedAt).toISOString() : null,
  },

  AutomationStats: {
    lastExecutedAt: (parent) =>
      parent.lastExecutedAt
        ? new Date(parent.lastExecutedAt).toISOString()
        : null,
    lastClientId: (parent) =>
      parent.lastClientId ? parent.lastClientId.toString() : null,
  },
};

export default clientAutomationResolvers;
