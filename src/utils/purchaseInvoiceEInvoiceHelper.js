import superPdpService from "../services/superPdpService.js";
import logger from "./logger.js";

/**
 * Helpers e-invoicing pour les factures d'achat (factures reçues via SuperPDP).
 *
 * Côté destinataire, payer une facture reçue électroniquement implique d'émettre
 * un événement de cycle de vie à la plateforme. fr:211 = « paiement transmis »
 * (émis par l'acheteur ; fr:212 « encaissement » est émis par le vendeur).
 * Surchargeable via PURCHASE_PAYMENT_STATUS_CODE.
 */
const PAYMENT_STATUS_CODE =
  process.env.PURCHASE_PAYMENT_STATUS_CODE || "fr:211";

// Statuts e-invoice à partir desquels un paiement peut être signalé.
export const PAYABLE_EINVOICE_STATUSES = ["RECEIVED", "VALIDATED", "ACCEPTED"];

/**
 * Signale à SuperPDP le paiement d'une facture d'achat reçue électroniquement.
 *
 * Best-effort : n'interrompt jamais le marquage « payé » local. Mute
 * `invoice.eInvoiceStatus = "PAID"` en cas de succès — le CALLER est responsable
 * du save().
 *
 * @param {Object} invoice - Document PurchaseInvoice (déjà passé en status PAID)
 * @param {string} workspaceId
 * @returns {Promise<boolean>} true si un événement a été émis avec succès
 */
export async function reportPurchaseInvoicePaymentIfNeeded(
  invoice,
  workspaceId,
) {
  if (
    invoice.source !== "SUPERPDP" ||
    !invoice.superPdpInvoiceId ||
    !PAYABLE_EINVOICE_STATUSES.includes(invoice.eInvoiceStatus)
  ) {
    return false;
  }

  try {
    const result = await superPdpService.submitInvoiceEvent(
      workspaceId,
      invoice.superPdpInvoiceId,
      PAYMENT_STATUS_CODE,
    );
    if (result.success) {
      invoice.eInvoiceStatus = "PAID";
      invoice.eInvoicePaymentReportStatus = "REPORTED";
      logger.info(
        `[purchase-einvoice] paiement signalé à SuperPDP (${PAYMENT_STATUS_CODE}) pour ${invoice.invoiceNumber || invoice._id}`,
      );
      return true;
    }
    // Échec : marquer pour relance par le cron + alerte (best-effort)
    invoice.eInvoicePaymentReportStatus = "ERROR";
    logger.warn(
      `[purchase-einvoice] échec signalement paiement SuperPDP (${invoice._id}): ${result.error}`,
    );
  } catch (error) {
    invoice.eInvoicePaymentReportStatus = "ERROR";
    logger.warn(
      `[purchase-einvoice] erreur signalement paiement SuperPDP (${invoice._id}): ${error.message}`,
    );
  }
  return false;
}
