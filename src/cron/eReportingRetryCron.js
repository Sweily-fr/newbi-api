import cron from "node-cron";
import Invoice from "../models/Invoice.js";
import superPdpService from "../services/superPdpService.js";
import logger from "../utils/logger.js";

/**
 * Cron de relance des déclarations e-reporting en erreur (SuperPDP).
 *
 * Contrairement à l'e-invoicing (flux B2B domestique, où la PDP est le canal de
 * livraison → la validation est bloquée si la transmission échoue), l'e-reporting
 * (B2C / international / exonéré) est une obligation DÉCLARATIVE et DIFFÉRÉE : la
 * facture est délivrée directement au client, et seules les données de transaction
 * sont reportées à l'administration. Un échec ne doit donc pas bloquer la
 * facturation — mais il doit finir par passer. Ce cron réessaie périodiquement les
 * déclarations en `ERROR`.
 *
 * On ne relance QUE les statuts `ERROR` :
 * - `eReportingStatus = ERROR`            → re-soumission de la transaction B2C
 * - `eReportingPaymentStatus = ERROR`     → re-soumission du paiement B2C
 * Le `PENDING_REPORT` du paiement est un état d'attente légitime (paiement à
 * déclarer une fois la facture encaissée) géré par le flux markInvoiceAsPaid.
 */

const BATCH_LIMIT = parseInt(process.env.EREPORTING_RETRY_BATCH || "100", 10);

let task = null;

/**
 * Réessaie les déclarations e-reporting en erreur.
 * @returns {Promise<{checked: number, updated: number}>}
 */
async function retryEReportings() {
  const invoices = await Invoice.find({
    eInvoiceFlowType: "E_REPORTING_TRANSACTION",
    $or: [{ eReportingStatus: "ERROR" }, { eReportingPaymentStatus: "ERROR" }],
  })
    .sort({ updatedAt: 1 })
    .limit(BATCH_LIMIT);

  if (invoices.length === 0) {
    return { checked: 0, updated: 0 };
  }

  let updated = 0;

  for (const invoice of invoices) {
    let changed = false;
    const workspaceId = invoice.workspaceId.toString();

    try {
      // 1. Relance de la transaction e-reporting
      if (invoice.eReportingStatus === "ERROR") {
        const result = await superPdpService.submitB2cTransaction(
          workspaceId,
          invoice,
        );
        if (result.success) {
          invoice.eReportingStatus = "REPORTED";
          invoice.eReportingTransactionId = result.id
            ? String(result.id)
            : invoice.eReportingTransactionId;
          invoice.eReportingError = null;
          changed = true;
          logger.info(
            `[ereporting-retry] transaction ${invoice.prefix || ""}${invoice.number} → REPORTED`,
          );
        } else {
          invoice.eReportingError = result.error;
        }
      }

      // 2. Relance du paiement e-reporting (TVA sur encaissements)
      if (invoice.eReportingPaymentStatus === "ERROR") {
        const paymentDate =
          invoice.eReportingPaymentDate || invoice.paymentDate || null;
        if (paymentDate) {
          const result = await superPdpService.submitB2cPayment(
            workspaceId,
            invoice,
            paymentDate,
          );
          if (result.success) {
            invoice.eReportingPaymentStatus = "REPORTED";
            invoice.eReportingPaymentId = result.id
              ? String(result.id)
              : invoice.eReportingPaymentId;
            invoice.eReportingPaymentDate = new Date(paymentDate);
            changed = true;
            logger.info(
              `[ereporting-retry] paiement ${invoice.prefix || ""}${invoice.number} → REPORTED`,
            );
          } else {
            invoice.eReportingError = result.error;
          }
        }
      }

      if (changed) {
        await invoice.save();
        updated++;
      } else {
        // Persister la dernière erreur sans compter comme "mis à jour"
        await invoice.save();
      }
    } catch (error) {
      logger.warn(
        `[ereporting-retry] échec facture ${invoice._id}: ${error.message}`,
      );
    }
  }

  return { checked: invoices.length, updated };
}

/**
 * Démarre le cron de relance e-reporting.
 */
function startEReportingRetryCron() {
  // Toutes les 30 minutes par défaut
  const cronExpression = process.env.EREPORTING_RETRY_CRON || "*/30 * * * *";

  task = cron.schedule(
    cronExpression,
    async () => {
      try {
        const { checked, updated } = await retryEReportings();
        if (checked > 0) {
          logger.info(
            `[ereporting-retry] ${checked} facture(s) en erreur, ${updated} déclarée(s) avec succès`,
          );
        }
      } catch (error) {
        logger.error("[ereporting-retry] erreur lors de la relance:", error);
      }
    },
    {
      scheduled: true,
      timezone: "Europe/Paris",
    },
  );

  logger.info(
    `🕐 [ereporting-retry] Cron de relance e-reporting configuré (${cronExpression})`,
  );

  return task;
}

/**
 * Arrête le cron (tests / shutdown).
 */
function stopEReportingRetryCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

export { startEReportingRetryCron, stopEReportingRetryCron, retryEReportings };
