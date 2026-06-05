import cron from "node-cron";
import Invoice from "../models/Invoice.js";
import superPdpService from "../services/superPdpService.js";
import logger from "../utils/logger.js";

/**
 * Cron de suivi du cycle de vie des factures électroniques émises via SuperPDP.
 *
 * L'API SuperPDP n'expose PAS de webhook : le statut d'une facture est un tableau
 * d'événements (api:* / fr:* / ppf:*) qu'on doit aller relire. Ce cron interroge
 * périodiquement SuperPDP pour les factures non terminales et met à jour
 * eInvoiceStatus / eInvoiceLastCode / eInvoiceEvents.
 */

// Statuts terminaux : inutile de continuer à poller.
const TERMINAL_STATUSES = ["PAID", "REJECTED", "REFUSED", "ERROR"];

// Nombre max de factures traitées par exécution (borne la charge).
const BATCH_LIMIT = parseInt(process.env.EINVOICE_SYNC_BATCH || "200", 10);

let task = null;

/**
 * Synchronise les statuts des factures e-invoicing en cours.
 * @returns {Promise<{checked: number, updated: number}>}
 */
async function syncEInvoiceStatuses() {
  const invoices = await Invoice.find({
    superPdpInvoiceId: { $exists: true, $ne: null },
    eInvoiceStatus: { $nin: TERMINAL_STATUSES },
  })
    .select(
      "_id workspaceId superPdpInvoiceId eInvoiceStatus eInvoiceLastCode prefix number",
    )
    .sort({ eInvoiceSentAt: 1 })
    .limit(BATCH_LIMIT);

  if (invoices.length === 0) {
    return { checked: 0, updated: 0 };
  }

  let updated = 0;

  for (const invoice of invoices) {
    try {
      const result = await superPdpService.getInvoiceStatus(
        invoice.workspaceId.toString(),
        invoice.superPdpInvoiceId,
      );

      if (!result.success) continue;

      // Mettre à jour uniquement si le dernier code a changé
      if (result.lastCode && result.lastCode !== invoice.eInvoiceLastCode) {
        invoice.eInvoiceStatus = result.status;
        invoice.eInvoiceLastCode = result.lastCode;
        invoice.eInvoiceEvents = result.events;
        await invoice.save();
        updated++;
        logger.info(
          `[einvoice-sync] ${invoice.prefix || ""}${invoice.number} → ${invoice.eInvoiceStatus} (${result.lastCode})`,
        );
      }
    } catch (error) {
      logger.warn(
        `[einvoice-sync] échec facture ${invoice._id}: ${error.message}`,
      );
    }
  }

  return { checked: invoices.length, updated };
}

/**
 * Démarre le cron de synchronisation des statuts e-invoicing.
 */
function startEInvoiceStatusSyncCron() {
  // Toutes les 30 minutes par défaut
  const cronExpression = process.env.EINVOICE_SYNC_CRON || "*/30 * * * *";

  task = cron.schedule(
    cronExpression,
    async () => {
      try {
        const { checked, updated } = await syncEInvoiceStatuses();
        if (checked > 0) {
          logger.info(
            `[einvoice-sync] ${checked} facture(s) vérifiée(s), ${updated} mise(s) à jour`,
          );
        }
      } catch (error) {
        logger.error(
          "[einvoice-sync] erreur lors de la synchronisation:",
          error,
        );
      }
    },
    {
      scheduled: true,
      timezone: "Europe/Paris",
    },
  );

  logger.info(
    `🕐 [einvoice-sync] Cron de suivi des statuts e-invoicing configuré (${cronExpression})`,
  );

  return task;
}

/**
 * Arrête le cron (tests / shutdown).
 */
function stopEInvoiceStatusSyncCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

export {
  startEInvoiceStatusSyncCron,
  stopEInvoiceStatusSyncCron,
  syncEInvoiceStatuses,
};
