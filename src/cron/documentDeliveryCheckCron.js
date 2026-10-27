import cron from "node-cron";
import { checkPendingDeliveries } from "../services/documentDeliveryService.js";
import logger from "../utils/logger.js";

/**
 * Cron de vérification de la remise des e-mails de documents.
 *
 * Filet du webhook Resend : relit chez Resend les e-mails restés « envoyés »
 * sans nouvelle (événement non abonné ou perdu), pour que le reçu ou l'alerte
 * de rejet parte quand même à l'émetteur.
 */

let task = null;
let running = false;

/**
 * Démarre le cron de vérification de la remise.
 */
function startDocumentDeliveryCheckCron() {
  // Toutes les 5 minutes par défaut
  const cronExpression =
    process.env.DOCUMENT_DELIVERY_CHECK_CRON || "*/5 * * * *";

  task = cron.schedule(
    cronExpression,
    async () => {
      // Un passage peut durer (appels espacés) : pas de chevauchement
      if (running) return;
      running = true;
      try {
        const { checked, updated } = await checkPendingDeliveries();
        if (checked > 0) {
          logger.info(
            `[document-delivery] ${checked} e-mail(s) vérifié(s), ${updated} mis à jour`,
          );
        }
      } catch (error) {
        logger.error(
          "[document-delivery] erreur lors de la vérification:",
          error,
        );
      } finally {
        running = false;
      }
    },
    {
      scheduled: true,
      timezone: "Europe/Paris",
    },
  );

  logger.info(
    `🕐 [document-delivery] Cron de vérification de la remise des e-mails configuré (${cronExpression})`,
  );

  return task;
}

/**
 * Arrête le cron (tests / shutdown).
 */
function stopDocumentDeliveryCheckCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

export { startDocumentDeliveryCheckCron, stopDocumentDeliveryCheckCron };
