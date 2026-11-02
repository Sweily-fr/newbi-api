import cron from "node-cron";
import Invoice from "../models/Invoice.js";
import CreditNote from "../models/CreditNote.js";
import superPdpService from "../services/superPdpService.js";
import logger from "../utils/logger.js";

/**
 * Cron de suivi du cycle de vie des documents électroniques émis via SuperPDP
 * (factures ET avoirs — un avoir transmis suit le même cycle de vie fr:*).
 *
 * L'API SuperPDP n'expose PAS de webhook : le statut d'une facture est un tableau
 * d'événements (api:* / fr:* / ppf:*) qu'on doit aller relire. Ce cron interroge
 * périodiquement SuperPDP pour les documents non terminaux et met à jour
 * eInvoiceStatus / eInvoiceLastCode / eInvoiceEvents.
 */

// Statuts terminaux : inutile de continuer à poller.
const TERMINAL_STATUSES = ["PAID", "REJECTED", "REFUSED", "ERROR"];

// Nombre max de documents traités par exécution (borne la charge).
const BATCH_LIMIT = parseInt(process.env.EINVOICE_SYNC_BATCH || "200", 10);

let task = null;

/**
 * Synchronise les statuts SuperPDP des documents non terminaux d'un modèle.
 * @param {Object} Model - Invoice ou CreditNote
 * @param {string} label - libellé de log ("facture" / "avoir")
 * @returns {Promise<{checked: number, updated: number}>}
 */
async function syncModelStatuses(Model, label) {
  const docs = await Model.find({
    superPdpInvoiceId: { $exists: true, $ne: null },
    eInvoiceStatus: { $nin: TERMINAL_STATUSES },
  })
    .select(
      "_id workspaceId superPdpInvoiceId eInvoiceStatus eInvoiceLastCode prefix number",
    )
    .sort({ eInvoiceSentAt: 1 })
    .limit(BATCH_LIMIT);

  let updated = 0;

  for (const doc of docs) {
    try {
      const result = await superPdpService.getInvoiceStatus(
        doc.workspaceId.toString(),
        doc.superPdpInvoiceId,
      );

      if (!result.success) continue;

      // Mettre à jour uniquement si le dernier code a changé
      if (result.lastCode && result.lastCode !== doc.eInvoiceLastCode) {
        doc.eInvoiceStatus = result.status;
        doc.eInvoiceLastCode = result.lastCode;
        doc.eInvoiceEvents = result.events;
        await doc.save();
        updated++;
        logger.info(
          `[einvoice-sync] ${label} ${doc.prefix || ""}${doc.number} → ${doc.eInvoiceStatus} (${result.lastCode})`,
        );
      }
    } catch (error) {
      logger.warn(
        `[einvoice-sync] échec ${label} ${doc._id}: ${error.message}`,
      );
    }
  }

  return { checked: docs.length, updated };
}

/**
 * Synchronise les statuts des factures et avoirs e-invoicing en cours.
 * @returns {Promise<{checked: number, updated: number}>}
 */
async function syncEInvoiceStatuses() {
  const invoices = await syncModelStatuses(Invoice, "facture");
  const creditNotes = await syncModelStatuses(CreditNote, "avoir");

  return {
    checked: invoices.checked + creditNotes.checked,
    updated: invoices.updated + creditNotes.updated,
  };
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
