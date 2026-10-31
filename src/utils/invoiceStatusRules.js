import { AppError, ERROR_CODES } from "./errors.js";

/**
 * Statuts d'une facture : ceux qu'on peut lui donner à la création et les
 * changements de statut possibles par changeInvoiceStatus.
 *
 * - Une facture naît brouillon (DRAFT) ou émise (PENDING). « Payée »
 *   (COMPLETED) passe par l'encaissement (droit dédié, date de paiement,
 *   déclarations), « annulée » (CANCELED) par l'annulation d'une facture
 *   émise, et « en retard » (OVERDUE) est calculé d'après l'échéance.
 * - Un brouillon n'a pas de numéro dans la séquence ni d'émetteur figé : il
 *   se valide (PENDING) ou se supprime, il ne passe ni payé ni annulé.
 */

const CREATION_STATUSES = ["DRAFT", "PENDING"];

/**
 * Refuse la création d'une facture avec un statut autre que brouillon ou
 * en attente.
 * @param {string} [status] - statut demandé (brouillon par défaut)
 */
export function assertInvoiceCreationStatus(status) {
  if (!status || CREATION_STATUSES.includes(status)) return;
  throw new AppError(
    "Une facture se crée en brouillon ou en attente de paiement. Pour l'encaisser, utilisez « Marquer comme payée » ; pour l'annuler, annulez la facture émise.",
    ERROR_CODES.VALIDATION_ERROR,
    { field: "status", status, allowed: CREATION_STATUSES },
  );
}

/**
 * Refuse les changements de statut impossibles (en plus des transitions
 * depuis une facture payée ou annulée et du retour en brouillon, refusés
 * par changeInvoiceStatus).
 * @param {Object} invoice - facture enregistrée
 * @param {string} status - statut demandé
 */
export function assertInvoiceStatusChange(invoice, status) {
  if (invoice?.status === "DRAFT" && status !== "PENDING") {
    throw new AppError(
      "Un brouillon doit d'abord être validé : il ne peut être ni marqué comme payé ni annulé. Supprimez-le s'il n'a plus lieu d'être.",
      ERROR_CODES.INVALID_STATUS_TRANSITION,
      { resource: "Facture", currentStatus: invoice.status, newStatus: status },
    );
  }
}
