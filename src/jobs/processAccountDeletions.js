import DeletionRequest from "../models/DeletionRequest.js";
import { deleteUserAccount } from "../services/rgpd.js";
import logger from "../utils/logger.js";

/**
 * Traite les demandes de suppression de compte dont le délai de grâce est écoulé.
 *
 * Ce job est exécuté périodiquement (quotidiennement) par le scheduler.
 * Il recherche toutes les demandes en statut "pending" dont la date scheduledAt
 * est passée, et exécute la suppression pour chacune.
 *
 * Conforme à l'article 17 du RGPD : les demandes de suppression doivent être
 * traitées « dans les meilleurs délais et au plus tard dans un délai d'un mois ».
 */
export async function processAccountDeletions() {
  const now = new Date();

  logger.info("[RGPD-JOB] Recherche des demandes de suppression à traiter...");

  const pendingRequests = await DeletionRequest.find({
    status: "pending",
    scheduledAt: { $lte: now },
  });

  if (pendingRequests.length === 0) {
    logger.info("[RGPD-JOB] Aucune demande de suppression à traiter.");
    return { processed: 0, failed: 0 };
  }

  logger.info(
    `[RGPD-JOB] ${pendingRequests.length} demande(s) de suppression à traiter.`
  );

  let processed = 0;
  let failed = 0;

  for (const request of pendingRequests) {
    try {
      logger.info(
        `[RGPD-JOB] Traitement de la suppression pour l'utilisateur ${request.userId} (demande ${request._id})`
      );

      const summary = await deleteUserAccount(
        request.userId.toString(),
        request.organizationId.toString()
      );

      // Mettre à jour la demande comme terminée
      request.status = "completed";
      request.completedAt = new Date();
      request.deletionSummary = summary;
      await request.save({ validateBeforeSave: false });

      processed++;
      logger.info(
        `[RGPD-JOB] Suppression réussie pour l'utilisateur ${request.userId}`
      );
    } catch (error) {
      failed++;
      logger.error(
        `[RGPD-JOB] Échec de la suppression pour l'utilisateur ${request.userId}:`,
        error
      );

      // Marquer la demande comme échouée (sera retentée au prochain passage)
      request.status = "failed";
      request.error = error.message;
      await request.save({ validateBeforeSave: false });
    }
  }

  logger.info(
    `[RGPD-JOB] Traitement terminé: ${processed} réussie(s), ${failed} échouée(s).`
  );

  return { processed, failed };
}
