import eInvoiceRoutingService from "../services/eInvoiceRoutingService.js";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";
import superPdpService from "../services/superPdpService.js";
import logger from "./logger.js";

/**
 * Évalue le routage e-invoicing d'une facture et l'envoie à SuperPDP si E_INVOICING.
 *
 * - Vérifie si e-invoicing est activé pour le workspace
 * - Détermine le flowType (E_INVOICING, NONE, etc.)
 * - Stocke le résultat sur la facture
 * - Si E_INVOICING → envoie à SuperPDP
 *
 * NOTE: Le caller est responsable du save() final de la facture.
 *
 * @param {Object} invoice - Document Mongoose Invoice
 * @param {string} workspaceId - ID du workspace
 * @returns {Object|null} Le routingResult, ou null si e-invoicing non activé
 */
export async function evaluateAndRouteInvoice(invoice, workspaceId) {
  // Vérifier si e-invoicing est activé
  const isEnabled =
    await EInvoicingSettingsService.isEInvoicingEnabled(workspaceId);

  if (!isEnabled) {
    return null;
  }

  // Récupérer l'organisation pour le routing
  const organization =
    await EInvoicingSettingsService.getOrganizationById(workspaceId);

  if (!organization) {
    logger.warn(
      `[E-INVOICE-ROUTING] Organisation non trouvée pour workspace ${workspaceId}`
    );
    return null;
  }

  // Déterminer le flow type
  const routingResult = eInvoiceRoutingService.determineFlowType(
    invoice,
    organization
  );

  // Stocker le résultat sur la facture
  invoice.eInvoiceFlowType = routingResult.flowType;
  invoice.eInvoiceFlowReason = routingResult.reason;
  invoice.eInvoiceRoutingDetails = routingResult.details;

  // Si E_INVOICING → envoyer à SuperPDP
  if (routingResult.flowType === "E_INVOICING") {
    try {
      logger.info(
        `[E-INVOICE-ROUTING] Envoi e-invoicing: ${invoice.prefix}${invoice.number} → SuperPDP`
      );

      const superPdpResult = await superPdpService.sendInvoice(
        workspaceId,
        invoice
      );

      if (superPdpResult.success) {
        invoice.superPdpInvoiceId = superPdpResult.superPdpInvoiceId;
        invoice.eInvoiceStatus = superPdpService.mapStatusToNewbi(
          superPdpResult.status
        );
        invoice.eInvoiceSentAt = new Date();
        invoice.facturXData = {
          xmlGenerated: true,
          profile: "EN16931",
          generatedAt: new Date(),
        };

        logger.info(
          `[E-INVOICE-ROUTING] Facture envoyée à SuperPDP: ${superPdpResult.superPdpInvoiceId}`
        );
      } else {
        invoice.eInvoiceStatus = "ERROR";
        invoice.eInvoiceError = superPdpResult.error;
        logger.error(
          `[E-INVOICE-ROUTING] Erreur envoi SuperPDP: ${superPdpResult.error}`
        );
      }
    } catch (sendError) {
      invoice.eInvoiceStatus = "ERROR";
      invoice.eInvoiceError = sendError.message;
      logger.error(
        "[E-INVOICE-ROUTING] Erreur lors de l'envoi à SuperPDP:",
        sendError
      );
    }
  } else {
    // Pas e-invoicing → statut NOT_SENT
    invoice.eInvoiceStatus = "NOT_SENT";
  }

  return routingResult;
}

// TODO E-REPORTING: Décommenter quand l'API SuperPDP e-reporting sera disponible
//
// /**
//  * Évalue si un paiement reçu déclenche un e-reporting de paiement.
//  *
//  * Conditions :
//  * 1. La facture relève du e-reporting transaction (pas du e-invoicing)
//  * 2. La TVA est sur les encaissements
//  * 3. Un paiement est effectivement reçu
//  *
//  * @param {Object} invoice - Document Mongoose Invoice
//  * @param {Date} paymentDate - Date du paiement
//  * @returns {boolean} true si le e-reporting payment doit être déclenché
//  */
// export function evaluatePaymentReporting(invoice, paymentDate) {
//   // Condition 1: la facture relève du e-reporting transaction
//   if (invoice.eInvoiceFlowType !== 'E_REPORTING_TRANSACTION') return false;
//
//   // Condition 2: TVA sur les encaissements
//   if (invoice.companyInfo?.vatPaymentCondition !== 'ENCAISSEMENTS') return false;
//
//   // Condition 3: un paiement est reçu (la date est fournie)
//   if (!paymentDate) return false;
//
//   // Marquer pour e-reporting payment
//   invoice.eInvoiceFlowType = 'E_REPORTING_PAYMENT';
//   invoice.eInvoiceFlowReason = 'Paiement reçu sur facture e-reporting avec TVA sur encaissements';
//   if (invoice.eInvoiceRoutingDetails) {
//     invoice.eInvoiceRoutingDetails.evaluatedAt = new Date();
//   }
//
//   // TODO: Envoyer à SuperPDP via l'API e-reporting AFNOR
//   // invoice.eReportingPaymentStatus = 'PENDING_REPORT';
//   // invoice.eReportingPaymentDate = paymentDate;
//
//   logger.info(
//     `[E-INVOICE-ROUTING] E-reporting payment déclenché pour facture ${invoice._id} (paiement: ${paymentDate})`
//   );
//
//   return true;
// }
