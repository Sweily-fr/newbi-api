import DocumentAutomation from "../models/DocumentAutomation.js";
import DocumentAutomationLog from "../models/DocumentAutomationLog.js";
import SharedFolder from "../models/SharedFolder.js";
import {
  withOrganization,
  resolveWorkspaceId,
  checkSubscriptionActive,
} from "../middlewares/rbac.js";
import { createNotFoundError, createValidationError } from "../utils/errors.js";
import documentAutomationService, {
  getAutomationProgress,
} from "../services/documentAutomationService.js";

// Wrapper lecture : valide l'appartenance à l'organisation (withOrganization)
// et impose le workspace validé par RBAC (jamais l'ID brut des args). Ferme
// l'IDOR cross-org : un membre de l'org A ne peut plus cibler l'org B via
// args.workspaceId — resolveWorkspaceId renvoie le workspace du contexte validé.
const scopedQuery = (fn) =>
  withOrganization(async (parent, args, context, info) => {
    const workspaceId = resolveWorkspaceId(
      args.workspaceId,
      context.workspaceId,
    );
    return fn(parent, { ...args, workspaceId }, context, info);
  });

// Wrapper écriture : idem + contrôle d'abonnement APRÈS enrichissement RBAC
// (context.workspaceId est alors défini, ne dépend plus d'un header client).
const scopedMutation = (fn) =>
  withOrganization(async (parent, args, context, info) => {
    const workspaceId = resolveWorkspaceId(
      args.workspaceId,
      context.workspaceId,
    );
    await checkSubscriptionActive(context);
    return fn(parent, { ...args, workspaceId }, context, info);
  });

const documentAutomationResolvers = {
  Query: {
    documentAutomations: scopedQuery(async (_, { workspaceId }) => {
      const automations = await DocumentAutomation.find({ workspaceId })
        .populate("createdBy")
        .sort({ createdAt: -1 });

      return automations;
    }),

    documentAutomation: scopedQuery(async (_, { workspaceId, id }) => {
      const automation = await DocumentAutomation.findOne({
        _id: id,
        workspaceId,
      }).populate("createdBy");

      if (!automation) {
        throw createNotFoundError("Automatisation");
      }

      return automation;
    }),

    documentAutomationLogs: scopedQuery(
      async (_, { workspaceId, automationId, limit }) => {
        const filter = { workspaceId };
        if (automationId) {
          filter.automationId = automationId;
        }

        const logs = await DocumentAutomationLog.find(filter)
          .sort({ createdAt: -1 })
          .limit(limit || 50);

        return logs;
      },
    ),

    documentsForAutomation: scopedQuery(
      async (_, { workspaceId, automationId }) => {
        const automation = await DocumentAutomation.findOne({
          _id: automationId,
          workspaceId,
        });

        if (!automation) {
          throw createNotFoundError("Automatisation");
        }

        return documentAutomationService.getDocumentsForAutomation(
          automation,
          workspaceId,
        );
      },
    ),

    documentAutomationProgress: scopedQuery(
      async (_, { workspaceId, automationId }) => {
        // Vérifier que l'automatisation appartient bien au workspace validé
        // avant de renvoyer une progression stockée dans une Map globale.
        const automation = await DocumentAutomation.findOne({
          _id: automationId,
          workspaceId,
        }).lean();

        if (!automation) {
          throw createNotFoundError("Automatisation");
        }

        return getAutomationProgress(automationId) || null;
      },
    ),
  },

  Mutation: {
    createDocumentAutomation: scopedMutation(
      async (_, { workspaceId, input }, context) => {
        const { user } = context;

        // Vérifier que le dossier cible existe
        const targetFolder = await SharedFolder.findOne({
          _id: input.actionConfig.targetFolderId,
          workspaceId,
          trashedAt: null,
        });

        if (!targetFolder) {
          throw createValidationError("Le dossier cible n'existe pas", {
            targetFolderId: "Dossier cible invalide",
          });
        }

        const automation = new DocumentAutomation({
          name: input.name,
          description: input.description || "",
          workspaceId,
          createdBy: user._id,
          triggerType: input.triggerType,
          actionConfig: {
            targetFolderId: input.actionConfig.targetFolderId,
            createSubfolder: input.actionConfig.createSubfolder || false,
            subfolderPattern: input.actionConfig.subfolderPattern || "year",
            filterYear: input.actionConfig.filterYear || null,
            filterClientId: input.actionConfig.filterClientId || null,
            filterClientName: input.actionConfig.filterClientName || null,
            documentNaming:
              input.actionConfig.documentNaming ||
              "{documentType}-{number}-{clientName}",
            tags: input.actionConfig.tags || [],
            documentStatus: input.actionConfig.documentStatus || "classified",
          },
          isActive: input.isActive ?? true,
        });

        await automation.save();

        // Le traitement rétroactif des documents existants est désormais
        // effectué côté client (génération PDF navigateur) après la création.

        return await DocumentAutomation.findById(automation._id).populate(
          "createdBy",
        );
      },
    ),

    updateDocumentAutomation: scopedMutation(
      async (_, { workspaceId, id, input }) => {
        const automation = await DocumentAutomation.findOne({
          _id: id,
          workspaceId,
        });

        if (!automation) {
          throw createNotFoundError("Automatisation");
        }

        // Vérifier le dossier cible si modifié
        if (input.actionConfig?.targetFolderId) {
          const targetFolder = await SharedFolder.findOne({
            _id: input.actionConfig.targetFolderId,
            workspaceId,
            trashedAt: null,
          });

          if (!targetFolder) {
            throw createValidationError("Le dossier cible n'existe pas", {
              targetFolderId: "Dossier cible invalide",
            });
          }
        }

        // Construire l'objet $set pour la mise à jour directe MongoDB
        const $set = {};

        if (input.name !== undefined) $set.name = input.name;
        if (input.description !== undefined)
          $set.description = input.description;
        if (input.triggerType !== undefined)
          $set.triggerType = input.triggerType;
        if (input.isActive !== undefined) $set.isActive = input.isActive;

        // Mettre à jour l'actionConfig champ par champ via $set (plus fiable que Mongoose subdoc)
        if (input.actionConfig) {
          const currentConfig = automation.actionConfig || {};
          $set["actionConfig.targetFolderId"] =
            input.actionConfig.targetFolderId || currentConfig.targetFolderId;
          $set["actionConfig.createSubfolder"] =
            input.actionConfig.createSubfolder ??
            currentConfig.createSubfolder ??
            false;
          $set["actionConfig.subfolderPattern"] =
            input.actionConfig.subfolderPattern ||
            currentConfig.subfolderPattern ||
            "year";
          $set["actionConfig.filterYear"] =
            input.actionConfig.filterYear !== undefined
              ? input.actionConfig.filterYear
              : currentConfig.filterYear || null;
          $set["actionConfig.filterClientId"] =
            input.actionConfig.filterClientId !== undefined
              ? input.actionConfig.filterClientId
              : currentConfig.filterClientId || null;
          $set["actionConfig.filterClientName"] =
            input.actionConfig.filterClientName !== undefined
              ? input.actionConfig.filterClientName
              : currentConfig.filterClientName || null;
          $set["actionConfig.documentNaming"] =
            input.actionConfig.documentNaming ||
            currentConfig.documentNaming ||
            "{documentType}-{number}-{clientName}";
          $set["actionConfig.tags"] =
            input.actionConfig.tags !== undefined
              ? input.actionConfig.tags
              : currentConfig.tags || [];
          $set["actionConfig.documentStatus"] =
            input.actionConfig.documentStatus ||
            currentConfig.documentStatus ||
            "classified";
        }

        // Scoper la mise à jour au workspace (défense en profondeur)
        await DocumentAutomation.findOneAndUpdate(
          { _id: id, workspaceId },
          { $set },
          { runValidators: true },
        );

        return await DocumentAutomation.findById(id).populate("createdBy");
      },
    ),

    deleteDocumentAutomation: scopedMutation(async (_, { workspaceId, id }) => {
      const automation = await DocumentAutomation.findOne({
        _id: id,
        workspaceId,
      });

      if (!automation) {
        throw createNotFoundError("Automatisation");
      }

      await DocumentAutomation.deleteOne({ _id: id, workspaceId });

      // Nettoyer les logs associés
      await DocumentAutomationLog.deleteMany({ automationId: id, workspaceId });

      return true;
    }),

    toggleDocumentAutomation: scopedMutation(async (_, { workspaceId, id }) => {
      const automation = await DocumentAutomation.findOne({
        _id: id,
        workspaceId,
      });

      if (!automation) {
        throw createNotFoundError("Automatisation");
      }

      automation.isActive = !automation.isActive;
      await automation.save();

      return await DocumentAutomation.findById(automation._id).populate(
        "createdBy",
      );
    }),

    testDocumentAutomation: scopedMutation(async (_, { workspaceId, id }) => {
      const automation = await DocumentAutomation.findOne({
        _id: id,
        workspaceId,
      });

      if (!automation) {
        throw createNotFoundError("Automatisation");
      }

      // Vérifier que le dossier cible existe toujours
      const targetFolder = await SharedFolder.findOne({
        _id: automation.actionConfig.targetFolderId,
        workspaceId,
        trashedAt: null,
      });

      if (!targetFolder) {
        throw createValidationError("Le dossier cible n'existe plus");
      }

      return true;
    }),

    processAutomationDocument: scopedMutation(
      async (
        _,
        { workspaceId, automationId, documentId, documentType, pdfBase64 },
        context,
      ) => {
        const { user } = context;

        // Vérifier que l'automatisation appartient bien au workspace validé
        // avant d'injecter un PDF dans l'arborescence de documents partagés.
        const automation = await DocumentAutomation.findOne({
          _id: automationId,
          workspaceId,
        }).lean();

        if (!automation) {
          throw createNotFoundError("Automatisation");
        }

        try {
          const result =
            await documentAutomationService.processAutomationDocumentWithPDF(
              automationId,
              workspaceId,
              documentId,
              documentType,
              pdfBase64,
              user._id,
            );

          return result;
        } catch (error) {
          console.error(
            `❌ [DocumentAutomation] Erreur processAutomationDocument doc=${documentId}:`,
            error.message,
          );

          // Logger l'échec
          try {
            await DocumentAutomationLog.create({
              automationId,
              workspaceId,
              sourceDocumentType: documentType,
              sourceDocumentId: documentId,
              status: "FAILED",
              error: error.message,
            });
          } catch (logError) {
            if (logError.code !== 11000) {
              console.error(
                "❌ [DocumentAutomation] Erreur log:",
                logError.message,
              );
            }
          }

          // Incrémenter les stats d'échec
          await DocumentAutomation.findOneAndUpdate(
            { _id: automationId, workspaceId },
            {
              $inc: { "stats.failedExecutions": 1 },
            },
          ).catch(() => {});

          return {
            success: false,
            error: error.message,
          };
        }
      },
    ),

    runDocumentAutomation: scopedMutation(
      async (_, { workspaceId, id }, context) => {
        const { user } = context;

        const automation = await DocumentAutomation.findOne({
          _id: id,
          workspaceId,
        });

        if (!automation) {
          throw createNotFoundError("Automatisation");
        }

        if (!automation.isActive) {
          throw createValidationError(
            "L'automatisation doit être active pour être exécutée",
          );
        }

        // Vérifier que le dossier cible existe
        const targetFolder = await SharedFolder.findOne({
          _id: automation.actionConfig.targetFolderId,
          workspaceId,
          trashedAt: null,
        });

        if (!targetFolder) {
          throw createValidationError("Le dossier cible n'existe plus");
        }

        // Lancer le traitement (inclut restauration corbeille + traitement nouveaux docs)
        const stats =
          await documentAutomationService.executeAutomationForExistingDocuments(
            automation,
            workspaceId,
            user._id,
          );

        const totalDocuments = stats.total;

        if (
          totalDocuments === 0 ||
          (stats.successCount === 0 &&
            stats.failCount === 0 &&
            stats.restoredCount === 0)
        ) {
          return {
            automationId: automation._id.toString(),
            status: "NO_DOCUMENTS",
            totalDocuments: 0,
            message: "Aucun document à traiter",
          };
        }

        let status;
        let message;

        const restoredNote =
          stats.restoredCount > 0
            ? `, ${stats.restoredCount} restauré(s) depuis la corbeille`
            : "";

        if (stats.failCount === 0 && stats.successCount > 0) {
          status = "COMPLETED";
          message = `${stats.successCount} document(s) traité(s) avec succès${restoredNote}`;
        } else if (stats.successCount > 0 && stats.failCount > 0) {
          status = "PARTIAL";
          message = `${stats.successCount} succès, ${stats.failCount} échec(s)${restoredNote}${stats.firstError ? ` — ${stats.firstError}` : ""}`;
        } else if (stats.failCount > 0) {
          status = "FAILED";
          message =
            stats.firstError || `${stats.failCount} document(s) en échec`;
        } else if (stats.restoredCount > 0) {
          status = "COMPLETED";
          message = `${stats.restoredCount} document(s) restauré(s) depuis la corbeille`;
        } else {
          status = "COMPLETED";
          message = "Aucun nouveau document à traiter";
        }

        return {
          automationId: automation._id.toString(),
          status,
          totalDocuments,
          message,
          successCount: stats.successCount,
          failCount: stats.failCount,
          firstError: stats.firstError || null,
        };
      },
    ),
  },

  DocumentAutomation: {
    id: (parent) => parent._id?.toString() || parent.id,
    createdAt: (parent) =>
      parent.createdAt ? new Date(parent.createdAt).toISOString() : null,
    updatedAt: (parent) =>
      parent.updatedAt ? new Date(parent.updatedAt).toISOString() : null,
    matchingDocumentsCount: async (parent) => {
      try {
        const count =
          await documentAutomationService.countDocumentsForAutomation(parent);
        return count;
      } catch {
        return null;
      }
    },
  },

  DocumentAutomationActionConfig: {
    targetFolder: async (parent) => {
      if (!parent.targetFolderId) return null;
      // Scoper au workspace de l'automatisation parente (défense en profondeur)
      return await SharedFolder.findOne({
        _id: parent.targetFolderId,
        ...(parent.workspaceId ? { workspaceId: parent.workspaceId } : {}),
      });
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
