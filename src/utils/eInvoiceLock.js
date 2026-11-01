import { AppError, ERROR_CODES } from "./errors.js";

/**
 * Verrou des documents transmis en facturation électronique.
 *
 * Une facture (ou un avoir) déposée sur la plateforme (SuperPDP) fait foi
 * telle qu'elle a été transmise : la modifier dans Newbi ferait diverger
 * les données, l'archive et les envois du document reçu par le client. On
 * la corrige par un avoir.
 *
 * Seules la modification de contenu (updateInvoice, updateCreditNote) et la
 * suppression (deleteInvoice, deleteCreditNote) sont refusées : paiement,
 * rapprochement et statuts e-invoicing posés par les crons et webhooks
 * SuperPDP passent par d'autres chemins.
 */

// Statuts e-invoicing qui n'impliquent pas de dépôt sur la plateforme :
// jamais envoyée, ou envoi refusé avant dépôt (pas d'identifiant SuperPDP)
const NOT_TRANSMITTED_STATUSES = new Set(["NOT_SENT", "ERROR"]);

/** Vrai si le document a été déposé sur la plateforme d'e-facturation. */
export function isEInvoiceTransmitted(doc) {
  if (!doc) return false;
  if (doc.superPdpInvoiceId) return true;
  const status = doc.eInvoiceStatus;
  return !!status && !NOT_TRANSMITTED_STATUSES.has(status);
}

const LOCK_MESSAGES = {
  invoice: {
    update:
      "Cette facture a été transmise en facturation électronique : elle ne peut plus être modifiée. Créez un avoir pour la corriger.",
    delete:
      "Cette facture a été transmise en facturation électronique : elle ne peut pas être supprimée. Créez un avoir pour l'annuler.",
  },
  creditNote: {
    update:
      "Cet avoir a été transmis en facturation électronique : il ne peut plus être modifié.",
    delete:
      "Cet avoir a été transmis en facturation électronique : il ne peut pas être supprimé.",
  },
};

/**
 * Refuse la modification ou la suppression d'un document transmis.
 * @param {Object} doc - facture ou avoir (document Mongoose ou objet lean)
 * @param {"invoice"|"creditNote"} type
 * @param {"update"|"delete"} [action="update"]
 */
export function assertNotEInvoiceTransmitted(
  doc,
  type = "invoice",
  action = "update",
) {
  if (!isEInvoiceTransmitted(doc)) return;
  const messages = LOCK_MESSAGES[type] || LOCK_MESSAGES.invoice;
  throw new AppError(
    messages[action] || messages.update,
    ERROR_CODES.RESOURCE_LOCKED,
    {
      resource: type,
      action,
      reason: "E_INVOICE_TRANSMITTED",
      superPdpInvoiceId: doc.superPdpInvoiceId || null,
      eInvoiceStatus: doc.eInvoiceStatus || null,
    },
  );
}

// Après ces statuts, un nouveau dépôt est possible : dépôt refusé avant
// enregistrement (irrecevable) ou rejeté par la plateforme.
const REDEPOSIT_STATUSES = new Set(["ERROR", "REJECTED"]);

/**
 * Refuse le renvoi à la plateforme d'une facture qui n'a pas à y être
 * déposée de nouveau : annulée, relevant de l'e-reporting (déclaration à
 * l'administration, pas de dépôt), ou déjà déposée (le renvoi créerait un
 * doublon sur la plateforme et remplacerait l'identifiant du premier dépôt).
 * @param {Object} invoice - facture enregistrée
 */
export function assertInvoiceResendable(invoice) {
  if (invoice?.status === "CANCELED") {
    throw new AppError(
      "Une facture annulée ne se transmet pas en facturation électronique.",
      ERROR_CODES.VALIDATION_ERROR,
      { resource: "invoice", action: "resend", reason: "INVOICE_CANCELED" },
    );
  }
  if (
    ["E_REPORTING_TRANSACTION", "E_REPORTING_PAYMENT"].includes(
      invoice?.eInvoiceFlowType,
    )
  ) {
    throw new AppError(
      "Cette facture relève de l'e-reporting (déclaration à l'administration) : elle ne se dépose pas sur la plateforme de facturation électronique.",
      ERROR_CODES.VALIDATION_ERROR,
      { resource: "invoice", action: "resend", reason: "E_REPORTING_FLOW" },
    );
  }
  if (
    isEInvoiceTransmitted(invoice) &&
    !REDEPOSIT_STATUSES.has(invoice.eInvoiceStatus)
  ) {
    throw new AppError(
      "Cette facture a déjà été déposée sur la plateforme de facturation électronique : elle ne se renvoie pas. Créez un avoir pour la corriger.",
      ERROR_CODES.RESOURCE_LOCKED,
      {
        resource: "invoice",
        action: "resend",
        reason: "E_INVOICE_TRANSMITTED",
        superPdpInvoiceId: invoice.superPdpInvoiceId || null,
        eInvoiceStatus: invoice.eInvoiceStatus || null,
      },
    );
  }
}
