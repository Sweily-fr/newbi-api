import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import { withOrganization } from "../middlewares/rbac.js";
import DeletionRequest from "../models/DeletionRequest.js";
import { deleteUserAccount, exportUserData } from "../services/rgpd.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";

/**
 * Délai de grâce avant suppression effective (30 jours)
 */
const GRACE_PERIOD_DAYS = 30;

const rgpdResolvers = {
  Query: {
    /**
     * Récupère la demande de suppression en cours pour l'utilisateur connecté
     */
    myDeletionRequest: isAuthenticated(async (_, __, { user }) => {
      const request = await DeletionRequest.findOne({
        userId: user._id,
        status: "pending",
      }).lean();

      if (!request) return null;

      return {
        id: request._id.toString(),
        userId: request.userId.toString(),
        userEmail: request.userEmail,
        requestedAt: request.createdAt.toISOString(),
        scheduledAt: request.scheduledAt.toISOString(),
        status: request.status,
        reason: request.reason,
      };
    }),
  },

  Mutation: {
    /**
     * Demande la suppression du compte avec délai de grâce de 30 jours.
     * Conforme à l'article 17 du RGPD.
     */
    requestAccountDeletion: withOrganization(
      async (_, { reason }, { user, workspaceId }) => {
        // Vérifier qu'il n'y a pas déjà une demande en cours
        const existingRequest = await DeletionRequest.findOne({
          userId: user._id,
          status: "pending",
        });

        if (existingRequest) {
          throw new AppError(
            "Une demande de suppression est déjà en cours. Vous pouvez l'annuler ou attendre son exécution.",
            ERROR_CODES.VALIDATION_ERROR
          );
        }

        const scheduledAt = new Date();
        scheduledAt.setDate(scheduledAt.getDate() + GRACE_PERIOD_DAYS);

        const request = await DeletionRequest.create({
          userId: user._id,
          organizationId: workspaceId,
          scheduledAt,
          userEmail: user.email,
          reason: reason || null,
        });

        logger.info(
          `[RGPD] Demande de suppression créée pour l'utilisateur ${user._id} — exécution prévue le ${scheduledAt.toISOString()}`
        );

        return {
          id: request._id.toString(),
          userId: request.userId.toString(),
          userEmail: request.userEmail,
          requestedAt: request.createdAt.toISOString(),
          scheduledAt: request.scheduledAt.toISOString(),
          status: request.status,
          reason: request.reason,
        };
      }
    ),

    /**
     * Annule une demande de suppression en cours.
     */
    cancelAccountDeletion: isAuthenticated(async (_, __, { user }) => {
      const request = await DeletionRequest.findOne({
        userId: user._id,
        status: "pending",
      });

      if (!request) {
        throw new AppError(
          "Aucune demande de suppression en cours à annuler.",
          ERROR_CODES.NOT_FOUND
        );
      }

      request.status = "cancelled";
      request.cancelledAt = new Date();
      await request.save();

      logger.info(`[RGPD] Demande de suppression annulée par l'utilisateur ${user._id}`);

      return true;
    }),

    /**
     * Confirme et exécute immédiatement la suppression du compte.
     * Les factures/avoirs/devis sont anonymisés (obligation légale 10 ans).
     * Toutes les autres données sont supprimées définitivement.
     *
     * ATTENTION : Action irréversible.
     */
    confirmAccountDeletion: withOrganization(
      async (_, __, { user, workspaceId }) => {
        logger.info(
          `[RGPD] Confirmation de suppression immédiate par l'utilisateur ${user._id}`
        );

        // Annuler toute demande en attente (car l'utilisateur confirme immédiatement)
        await DeletionRequest.updateMany(
          { userId: user._id, status: "pending" },
          { status: "cancelled", cancelledAt: new Date() }
        );

        // Créer un enregistrement de la suppression pour audit
        let deletionRecord;
        try {
          deletionRecord = await DeletionRequest.create({
            userId: user._id,
            organizationId: workspaceId,
            scheduledAt: new Date(), // Immédiat
            userEmail: user.email,
            reason: "Suppression immédiate confirmée par l'utilisateur",
            status: "completed",
            completedAt: new Date(),
          });
        } catch (err) {
          // Si le unique index bloque (edge case), on continue
          logger.warn(`[RGPD] Impossible de créer l'enregistrement d'audit: ${err.message}`);
        }

        try {
          const summary = await deleteUserAccount(
            user._id.toString(),
            workspaceId.toString()
          );

          // Mettre à jour le résumé dans l'enregistrement
          if (deletionRecord) {
            deletionRecord.deletionSummary = summary;
            await deletionRecord.save({ validateBeforeSave: false });
          }

          return {
            success: true,
            summary,
          };
        } catch (error) {
          // Enregistrer l'erreur
          if (deletionRecord) {
            deletionRecord.status = "failed";
            deletionRecord.error = error.message;
            await deletionRecord.save({ validateBeforeSave: false });
          }

          logger.error(`[RGPD] Échec de la suppression pour ${user._id}:`, error);
          throw new AppError(
            "Une erreur est survenue lors de la suppression du compte. Notre équipe a été notifiée.",
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),

    /**
     * Exporte toutes les données personnelles de l'utilisateur.
     * Conforme à l'article 20 du RGPD (droit à la portabilité).
     */
    exportMyData: withOrganization(
      async (_, __, { user, workspaceId }) => {
        try {
          const data = await exportUserData(
            user._id.toString(),
            workspaceId.toString()
          );

          return {
            data: JSON.stringify(data),
            exportedAt: new Date().toISOString(),
          };
        } catch (error) {
          logger.error(`[RGPD] Erreur lors de l'export pour ${user._id}:`, error);
          throw new AppError(
            "Une erreur est survenue lors de l'export de vos données.",
            ERROR_CODES.INTERNAL_ERROR
          );
        }
      }
    ),
  },
};

export default rgpdResolvers;
