import { assertPermissionAction } from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "./errors.js";

/**
 * Statut demandé à la création d'un document (devis, bon de commande).
 *
 * Brouillon et document émis (`issuedStatus` : devis en attente, bon de
 * commande confirmé) relèvent de « Créer ». Tout autre statut (accepté,
 * validé, livré, annulé…) revient à un changement de statut : il exige
 * l'action « status » de la page, comme la mutation de changement de statut.
 * `reserved` : statuts jamais choisis à la création (devis importé, réservé
 * à l'import).
 *
 * @param {object} context - contexte enrichi par le RBAC
 * @param {string} resource - page (quotes, purchaseOrders)
 * @param {string|undefined} status - statut demandé
 * @param {{ issuedStatus: string, reserved?: Record<string, string> }} options
 *   `reserved` : statut → libellé
 */
export function assertCreationStatusAllowed(
  context,
  resource,
  status,
  { issuedStatus, reserved = {} },
) {
  if (!status || status === "DRAFT" || status === issuedStatus) return;
  if (reserved[status]) {
    throw new AppError(
      `Le statut « ${reserved[status]} » n'est pas autorisé à la création : il est réservé aux documents importés.`,
      ERROR_CODES.VALIDATION_ERROR,
      { status },
    );
  }
  assertPermissionAction(context, resource, "status");
}

/**
 * Préfixe saisi : espaces (insécables compris) retirés. Vide = pas de
 * préfixe fourni, le préfixe par défaut s'applique : un préfixe vide est
 * réservé aux devis importés (référence d'origine gardée dans le numéro).
 */
export function normalizeInputPrefix(input) {
  if (input && typeof input.prefix === "string") {
    const prefix = input.prefix.trim();
    input.prefix = prefix || undefined;
  }
}
