import cron from "node-cron";
import { processDueRecurrences } from "../services/invoiceRecurrenceService.js";
import logger from "../utils/logger.js";

/**
 * Cron des factures récurrentes : génère et envoie les factures dont
 * l'échéance est arrivée. Toutes les heures en journée (heure de Paris) :
 * le premier passage envoie les factures du jour à 8 h, les suivants
 * reprennent les récurrences programmées dans la journée et réessaient
 * celles en échec (suspendues après plusieurs échecs).
 */

let task = null;

function startInvoiceRecurrenceCron() {
  const cronExpression = process.env.INVOICE_RECURRENCE_CRON || "5 8-20 * * *";

  task = cron.schedule(
    cronExpression,
    async () => {
      try {
        const { due, generated, failed } = await processDueRecurrences();
        if (due > 0) {
          logger.info(
            `[invoice-recurrence] ${due} échéance(s) : ${generated} facture(s) générée(s), ${failed} échec(s)`,
          );
        }
      } catch (error) {
        logger.error("[invoice-recurrence] erreur du cron:", error);
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );

  logger.info(
    `🕐 [invoice-recurrence] Cron des factures récurrentes configuré (${cronExpression})`,
  );

  return task;
}

function stopInvoiceRecurrenceCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

export { startInvoiceRecurrenceCron, stopInvoiceRecurrenceCron };
