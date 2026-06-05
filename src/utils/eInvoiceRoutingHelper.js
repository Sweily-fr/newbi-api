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
      `[E-INVOICE-ROUTING] Organisation non trouvée pour workspace ${workspaceId}`,
    );
    return null;
  }

  // Déterminer le flow type
  const routingResult = eInvoiceRoutingService.determineFlowType(
    invoice,
    organization,
  );

  // Stocker le résultat sur la facture
  invoice.eInvoiceFlowType = routingResult.flowType;
  invoice.eInvoiceFlowReason = routingResult.reason;
  invoice.eInvoiceRoutingDetails = routingResult.details;

  // Si E_INVOICING → envoyer à SuperPDP
  if (routingResult.flowType === "E_INVOICING") {
    try {
      logger.info(
        `[E-INVOICE-ROUTING] Envoi e-invoicing: ${invoice.prefix}${invoice.number} → SuperPDP`,
      );

      const superPdpResult = await superPdpService.sendInvoice(
        workspaceId,
        invoice,
      );

      if (superPdpResult.success) {
        invoice.superPdpInvoiceId = superPdpResult.superPdpInvoiceId;
        // Statut d'affichage dérivé + historique brut des événements SuperPDP
        invoice.eInvoiceStatus = superPdpResult.status;
        invoice.eInvoiceLastCode = superPdpResult.lastCode || null;
        invoice.eInvoiceEvents = superPdpResult.events || [];
        invoice.eInvoiceSentAt = new Date();
        invoice.facturXData = {
          xmlGenerated: true,
          profile: "EN16931",
          generatedAt: new Date(),
        };

        logger.info(
          `[E-INVOICE-ROUTING] Facture envoyée à SuperPDP: ${superPdpResult.superPdpInvoiceId}`,
        );
      } else {
        invoice.eInvoiceStatus = "ERROR";
        invoice.eInvoiceError = superPdpResult.error;
        logger.error(
          `[E-INVOICE-ROUTING] Erreur envoi SuperPDP: ${superPdpResult.error}`,
        );
      }
    } catch (sendError) {
      invoice.eInvoiceStatus = "ERROR";
      invoice.eInvoiceError = sendError.message;
      logger.error(
        "[E-INVOICE-ROUTING] Erreur lors de l'envoi à SuperPDP:",
        sendError,
      );
    }
  } else if (routingResult.flowType === "E_REPORTING_TRANSACTION") {
    // Flux e-reporting (B2C / international / exonéré) → soumettre la transaction
    try {
      logger.info(
        `[E-INVOICE-ROUTING] E-reporting transaction: ${invoice.prefix}${invoice.number} → SuperPDP`,
      );
      const result = await superPdpService.submitB2cTransaction(
        workspaceId,
        invoice,
      );
      if (result.success) {
        invoice.eReportingStatus = "REPORTED";
        invoice.eReportingTransactionId = result.id ? String(result.id) : null;
        invoice.eReportingError = null;
      } else {
        invoice.eReportingStatus = "ERROR";
        invoice.eReportingError = result.error;
      }
      // Si TVA sur encaissements : le paiement devra aussi être déclaré
      if (invoice.companyInfo?.vatPaymentCondition === "ENCAISSEMENTS") {
        invoice.eReportingPaymentStatus = "PENDING_REPORT";
      }
    } catch (reportError) {
      invoice.eReportingStatus = "ERROR";
      invoice.eReportingError = reportError.message;
      logger.error(
        "[E-INVOICE-ROUTING] Erreur e-reporting transaction:",
        reportError,
      );
    }
    invoice.eInvoiceStatus = "NOT_SENT"; // pas d'envoi e-invoicing pour ce flux
  } else {
    // Pas e-invoicing → statut NOT_SENT
    invoice.eInvoiceStatus = "NOT_SENT";
  }

  return routingResult;
}

/**
 * Déclare le paiement d'une facture e-reporting (TVA sur encaissements) à SuperPDP.
 *
 * Conditions : la facture relève du e-reporting transaction, la TVA est sur les
 * encaissements, et une date de paiement est fournie. Non bloquant.
 *
 * @param {Object} invoice - Document Mongoose Invoice
 * @param {string} workspaceId
 * @param {Date} paymentDate
 * @returns {Promise<boolean>} true si une déclaration a été tentée
 */
export async function reportPaymentIfNeeded(invoice, workspaceId, paymentDate) {
  if (invoice.eInvoiceFlowType !== "E_REPORTING_TRANSACTION") return false;
  if (invoice.companyInfo?.vatPaymentCondition !== "ENCAISSEMENTS")
    return false;
  if (!paymentDate) return false;

  try {
    const result = await superPdpService.submitB2cPayment(
      workspaceId,
      invoice,
      paymentDate,
    );
    if (result.success) {
      invoice.eReportingPaymentStatus = "REPORTED";
      invoice.eReportingPaymentId = result.id ? String(result.id) : null;
      invoice.eReportingPaymentDate = new Date(paymentDate);
    } else {
      invoice.eReportingPaymentStatus = "ERROR";
      invoice.eReportingError = result.error;
    }
  } catch (error) {
    invoice.eReportingPaymentStatus = "ERROR";
    invoice.eReportingError = error.message;
    logger.error("[E-INVOICE-ROUTING] Erreur e-reporting paiement:", error);
  }
  return true;
}
