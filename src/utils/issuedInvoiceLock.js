import { AppError, ERROR_CODES } from "./errors.js";

/**
 * Verrou des factures émises (et des avoirs).
 *
 * Une facture émise (en attente, payée ou annulée) a reçu son numéro dans
 * la séquence : la supprimer laisserait un trou dans la numérotation, et
 * changer ses articles, ses montants ou son client la ferait diverger du
 * document déjà remis au client. Elle se corrige par un avoir. Le site ne
 * propose déjà « Modifier » et « Supprimer » que sur les brouillons et
 * l'application mobile traite la facture émise comme immuable : l'API
 * l'impose aussi aux appels directs.
 *
 * Les autres champs d'une facture émise (notes, conditions, apparence…)
 * suivent les règles existantes de updateInvoice.
 */

/**
 * Champs de UpdateInvoiceInput qui changent les articles, les montants ou
 * le client : refusés sur une facture émise.
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
];

const isDraft = (doc) => !doc?.status || doc.status === "DRAFT";

/**
 * Refuse la modification des articles, des montants ou du client d'une
 * facture émise. Un brouillon (finalisation DRAFT → PENDING comprise) n'est
 * pas concerné.
 * @param {Object} invoice - facture enregistrée (document Mongoose ou objet lean)
 * @param {Object} input - UpdateInvoiceInput reçu
 */
export function assertIssuedInvoiceContentUnchanged(invoice, input = {}) {
  if (isDraft(invoice)) return;
  const fields = ISSUED_INVOICE_LOCKED_FIELDS.filter(
    (key) => input?.[key] !== undefined,
  );
  if (fields.length === 0) return;
  throw new AppError(
    "Une facture émise ne se modifie plus : ses articles, ses montants et son client sont figés. Corrigez-la par un avoir.",
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
