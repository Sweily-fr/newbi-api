import { AppError, ERROR_CODES } from "./errors.js";

/**
 * Verrou des factures émises (et des avoirs).
 *
 * Une facture émise (en attente, payée ou annulée) a reçu son numéro dans
 * la séquence : la supprimer laisserait un trou dans la numérotation, et
 * changer son contenu, ses montants, son client, ses coordonnées de
 * paiement ou ses mentions la ferait diverger du document déjà remis au
 * client. Elle se corrige par un avoir. Le site ne propose déjà « Modifier »
 * et « Supprimer » que sur les brouillons et l'application mobile traite la
 * facture émise comme immuable : l'API l'impose aussi aux appels directs.
 */

/**
 * Seuls champs de UpdateInvoiceInput encore modifiables sur une facture
 * émise : notes, conditions, présentation et échéance. `status`, `number`
 * et `prefix` ont leurs propres contrôles dans updateInvoice (transition
 * DRAFT → PENDING seulement, numéro et préfixe inchangés).
 */
export const ISSUED_INVOICE_EDITABLE_FIELDS = [
  "headerNotes",
  "footerNotes",
  "termsAndConditions",
  "termsAndConditionsLinkTitle",
  "termsAndConditionsLink",
  "appearance",
  "clientPositionRight",
  "dueDate",
  "status",
  "number",
  "prefix",
];

/**
 * Champs connus de UpdateInvoiceInput refusés sur une facture émise
 * (articles, montants, client, coordonnées de paiement, mentions). Tout
 * champ absent de ISSUED_INVOICE_EDITABLE_FIELDS est refusé, y compris un
 * champ ajouté plus tard au schéma.
 */
export const ISSUED_INVOICE_LOCKED_FIELDS = [
  "items",
  "client",
  "discount",
  "discountType",
  "shipping",
  "retenueGarantie",
  "escompte",
  "isReverseCharge",
  "isVatExempt",
  "isDeposit",
  "invoiceType",
  "situationNumber",
  "progressMode",
  "globalProgressPercentage",
  "contractTotal",
  "bankDetails",
  "showBankDetails",
  "issueDate",
  "operationType",
  "purchaseOrderNumber",
  "situationReference",
  "customFields",
  "annex",
  "companyInfo",
];

const isDraft = (doc) => !doc?.status || doc.status === "DRAFT";

/**
 * Refuse sur une facture émise toute modification hors notes, conditions,
 * présentation et échéance. Un brouillon (finalisation DRAFT → PENDING
 * comprise) n'est pas concerné.
 * @param {Object} invoice - facture enregistrée (document Mongoose ou objet lean)
 * @param {Object} input - UpdateInvoiceInput reçu
 */
export function assertIssuedInvoiceContentUnchanged(invoice, input = {}) {
  if (isDraft(invoice)) return;
  const fields = Object.keys(input || {}).filter(
    (key) =>
      input[key] !== undefined && !ISSUED_INVOICE_EDITABLE_FIELDS.includes(key),
  );
  if (fields.length === 0) return;
  throw new AppError(
    "Une facture émise ne se modifie plus : ses articles, ses montants, son client, ses coordonnées bancaires et ses mentions sont figés. Corrigez-la par un avoir.",
    ERROR_CODES.RESOURCE_LOCKED,
    {
      resource: "invoice",
      action: "update",
      reason: "INVOICE_ISSUED",
      status: invoice.status,
      fields,
    },
  );
}

/**
 * Refuse la suppression d'une facture qui n'est pas un brouillon (annulée
 * comprise) : elle garde sa place dans la numérotation.
 * @param {Object} invoice - facture enregistrée
 */
export function assertInvoiceDeletable(invoice) {
  if (isDraft(invoice)) return;
  throw new AppError(
    "Seul un brouillon peut être supprimé : une facture émise, même annulée, garde sa place dans la numérotation. Corrigez-la par un avoir.",
    ERROR_CODES.RESOURCE_LOCKED,
    {
      resource: "invoice",
      action: "delete",
      reason: "INVOICE_ISSUED",
      status: invoice.status,
    },
  );
}

/**
 * Un avoir n'a pas de brouillon : émis dès sa création, il ne se supprime
 * jamais (trou dans la numérotation des avoirs). Il se corrige en le
 * modifiant. Renvoie l'erreur à lever.
 * @param {Object} creditNote - avoir enregistré
 */
export function creditNoteDeletionRefused(creditNote) {
  return new AppError(
    "Un avoir émis ne peut pas être supprimé : il garde sa place dans la numérotation des avoirs. Modifiez-le pour le corriger.",
    ERROR_CODES.RESOURCE_LOCKED,
    {
      resource: "creditNote",
      action: "delete",
      reason: "CREDIT_NOTE_ISSUED",
      status: creditNote?.status ?? null,
    },
  );
}
