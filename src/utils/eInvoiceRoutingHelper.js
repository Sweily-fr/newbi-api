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
 * @returns {Object|null} Le routingResult ({ flowType, reason, details, sendFailed?,
 *   error? }), ou null si e-invoicing non activé. `sendFailed` est `true` quand le
 *   flux est E_INVOICING et que la transmission à SuperPDP a échoué.
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
        // Signaler l'échec au caller pour qu'il puisse bloquer la validation
        routingResult.sendFailed = true;
        routingResult.error = superPdpResult.error;
        logger.error(
          `[E-INVOICE-ROUTING] Erreur envoi SuperPDP: ${superPdpResult.error}`,
        );
      }
    } catch (sendError) {
      invoice.eInvoiceStatus = "ERROR";
      invoice.eInvoiceError = sendError.message;
      // Signaler l'échec au caller pour qu'il puisse bloquer la validation
      routingResult.sendFailed = true;
      routingResult.error = sendError.message;
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
 * Évalue le routage e-invoicing d'un AVOIR et l'envoie à SuperPDP si E_INVOICING.
 *
 * Un avoir est une facture au sens de la réforme (UNTDID 381) : il suit les mêmes
 * critères de routage que sa facture (B2B domestique → e-invoicing, B2C/international/
 * exonéré → e-reporting en négatif). L'avoir porte les mêmes snapshots companyInfo/
 * client que les factures, donc determineFlowType s'applique tel quel.
 *
 * NOTE: Le caller est responsable du save() final de l'avoir (ou de son rollback
 * si sendFailed est true — un avoir E_INVOICING non transmis ne doit pas exister).
 *
 * @param {Object} creditNote - Document Mongoose CreditNote
 * @param {string} workspaceId - ID du workspace
 * @returns {Object|null} Le routingResult ({ flowType, reason, details, sendFailed?,
 *   error? }), ou null si e-invoicing non activé.
 */
export async function evaluateAndRouteCreditNote(creditNote, workspaceId) {
  const isEnabled =
    await EInvoicingSettingsService.isEInvoicingEnabled(workspaceId);

  if (!isEnabled) {
    return null;
  }

  const organization =
    await EInvoicingSettingsService.getOrganizationById(workspaceId);

  if (!organization) {
    logger.warn(
      `[E-INVOICE-ROUTING] Organisation non trouvée pour workspace ${workspaceId}`,
    );
    return null;
  }

  const routingResult = eInvoiceRoutingService.determineFlowType(
    creditNote,
    organization,
  );

  creditNote.eInvoiceFlowType = routingResult.flowType;
  creditNote.eInvoiceFlowReason = routingResult.reason;
  creditNote.eInvoiceRoutingDetails = routingResult.details;

  if (routingResult.flowType === "E_INVOICING") {
    try {
      logger.info(
        `[E-INVOICE-ROUTING] Envoi e-invoicing (avoir): ${creditNote.prefix}${creditNote.number} → SuperPDP`,
      );

      const superPdpResult = await superPdpService.sendCreditNote(
        workspaceId,
        creditNote,
      );

      if (superPdpResult.success) {
        creditNote.superPdpInvoiceId = superPdpResult.superPdpInvoiceId;
        creditNote.eInvoiceStatus = superPdpResult.status;
        creditNote.eInvoiceLastCode = superPdpResult.lastCode || null;
        creditNote.eInvoiceEvents = superPdpResult.events || [];
        creditNote.eInvoiceSentAt = new Date();

        logger.info(
          `[E-INVOICE-ROUTING] Avoir envoyé à SuperPDP: ${superPdpResult.superPdpInvoiceId}`,
        );
      } else {
        creditNote.eInvoiceStatus = "ERROR";
        creditNote.eInvoiceError = superPdpResult.error;
        routingResult.sendFailed = true;
        routingResult.error = superPdpResult.error;
        logger.error(
          `[E-INVOICE-ROUTING] Erreur envoi avoir SuperPDP: ${superPdpResult.error}`,
        );
      }
    } catch (sendError) {
      creditNote.eInvoiceStatus = "ERROR";
      creditNote.eInvoiceError = sendError.message;
      routingResult.sendFailed = true;
      routingResult.error = sendError.message;
      logger.error(
        "[E-INVOICE-ROUTING] Erreur lors de l'envoi de l'avoir à SuperPDP:",
        sendError,
      );
    }
  } else if (routingResult.flowType === "E_REPORTING_TRANSACTION") {
    // Avoir B2C/international/exonéré → déclaration e-reporting en NÉGATIF
    // (correction des montants déjà déclarés pour la facture d'origine).
    // Comme pour les factures, l'e-reporting est déclaratif et non bloquant :
    // un échec est relancé par le cron ereporting-retry.
    try {
      logger.info(
        `[E-INVOICE-ROUTING] E-reporting transaction (avoir): ${creditNote.prefix}${creditNote.number} → SuperPDP`,
      );
      const result = await superPdpService.submitB2cTransaction(
        workspaceId,
        creditNote,
        { sign: -1 },
      );
      if (result.success) {
        creditNote.eReportingStatus = "REPORTED";
        creditNote.eReportingTransactionId = result.id
          ? String(result.id)
          : null;
        creditNote.eReportingError = null;
      } else {
        creditNote.eReportingStatus = "ERROR";
        creditNote.eReportingError = result.error;
      }
    } catch (reportError) {
      creditNote.eReportingStatus = "ERROR";
      creditNote.eReportingError = reportError.message;
      logger.error(
        "[E-INVOICE-ROUTING] Erreur e-reporting transaction (avoir):",
        reportError,
      );
    }
    creditNote.eInvoiceStatus = "NOT_SENT";
  } else {
    creditNote.eInvoiceStatus = "NOT_SENT";
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
  // Encaissement déjà déclaré : jamais de seconde déclaration
  if (invoice.eReportingPaymentStatus === "REPORTED") return false;

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
