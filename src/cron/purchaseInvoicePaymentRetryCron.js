import cron from "node-cron";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import { reportPurchaseInvoicePaymentIfNeeded } from "../utils/purchaseInvoiceEInvoiceHelper.js";
import logger from "../utils/logger.js";

/**
 * Cron de relance du signalement de paiement des factures d'achat reçues.
 *
 * Symétrique du cron e-reporting côté émission : quand on paie une facture
 * reçue électroniquement, on émet un événement de cycle de vie (fr:211) à
 * SuperPDP. Cet appel est best-effort (ne bloque pas le marquage « payé »
 * local) ; en cas d'échec, la facture est marquée eInvoicePaymentReportStatus
 * = ERROR. Ce cron réessaie périodiquement ces signalements.
 */

const BATCH_LIMIT = parseInt(
  process.env.PURCHASE_PAYMENT_RETRY_BATCH || "100",
  10,
);

let task = null;

/**
 * Réessaie les signalements de paiement en erreur.
 * @returns {Promise<{checked: number, updated: number}>}
 */
async function retryPurchaseInvoicePayments() {
  const invoices = await PurchaseInvoice.find({
    source: "SUPERPDP",
    superPdpInvoiceId: { $exists: true, $ne: null },
    eInvoicePaymentReportStatus: "ERROR",
  })
    .sort({ updatedAt: 1 })
    .limit(BATCH_LIMIT);

  if (invoices.length === 0) {
    return { checked: 0, updated: 0 };
  }

  let updated = 0;

  for (const invoice of invoices) {
    try {
      const reported = await reportPurchaseInvoicePaymentIfNeeded(
        invoice,
        invoice.workspaceId.toString(),
      );
      await invoice.save();
      if (reported) {
        updated++;
        logger.info(
          `[purchase-payment-retry] paiement signalé pour ${invoice.invoiceNumber || invoice._id}`,
        );
      }
    } catch (error) {
      logger.warn(
        `[purchase-payment-retry] échec facture ${invoice._id}: ${error.message}`,
      );
    }
  }

  return { checked: invoices.length, updated };
}

/**
 * Démarre le cron de relance.
 */
function startPurchaseInvoicePaymentRetryCron() {
  const cronExpression =
    process.env.PURCHASE_PAYMENT_RETRY_CRON || "*/30 * * * *";

  task = cron.schedule(
    cronExpression,
    async () => {
      try {
        const { checked, updated } = await retryPurchaseInvoicePayments();
        if (checked > 0) {
          logger.info(
            `[purchase-payment-retry] ${checked} signalement(s) en erreur, ${updated} relancé(s) avec succès`,
          );
        }
      } catch (error) {
        logger.error(
          "[purchase-payment-retry] erreur lors de la relance:",
          error,
        );
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );

  logger.info(
    `🕐 [purchase-payment-retry] Cron de relance signalement paiement configuré (${cronExpression})`,
  );

  return task;
}

/**
 * Arrête le cron (tests / shutdown).
 */
function stopPurchaseInvoicePaymentRetryCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

export {
  startPurchaseInvoicePaymentRetryCron,
  stopPurchaseInvoicePaymentRetryCron,
  retryPurchaseInvoicePayments,
};
