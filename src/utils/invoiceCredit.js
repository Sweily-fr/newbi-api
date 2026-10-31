import mongoose from "mongoose";
import CreditNote from "../models/CreditNote.js";

/**
 * Avoirs rattachés à une facture : montant crédité et facture soldée par
 * avoir. Même calcul que le plafond de createCreditNote (somme des
 * |finalTotalTTC| des avoirs de la facture, dans son espace), comparé en
 * centimes arrondis.
 *
 * Une facture dont les avoirs couvrent tout le montant n'est plus due : elle
 * n'est plus payable en ligne ni relancée.
 */

const toObjectId = (id) =>
  id instanceof mongoose.Types.ObjectId
    ? id
    : new mongoose.Types.ObjectId(String(id));

const cents = (amount) => Math.round((Number(amount) || 0) * 100);

/**
 * Montant TTC crédité par avoirs sur chacune des factures données.
 * @param {Array<string|ObjectId>} invoiceIds
 * @param {string|ObjectId} workspaceId
 * @returns {Promise<Map<string, number>>} id facture → montant crédité
 */
export async function creditedTTCByInvoice(invoiceIds, workspaceId) {
  const ids = (invoiceIds || []).filter(Boolean).map(toObjectId);
  if (!ids.length || !workspaceId) return new Map();
  return sumCredits({
    workspaceId: toObjectId(workspaceId),
    originalInvoice: { $in: ids },
  });
}

/**
 * Montant TTC crédité par avoirs pour toutes les factures d'un espace (une
 * lecture par requête pour une liste de factures).
 * @param {string|ObjectId} workspaceId
 * @returns {Promise<Map<string, number>>}
 */
export async function creditedTTCForWorkspace(workspaceId) {
  if (!workspaceId) return new Map();
  return sumCredits({ workspaceId: toObjectId(workspaceId) });
}

async function sumCredits(match) {
  const result = new Map();
  const rows = await CreditNote.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$originalInvoice",
        total: { $sum: { $abs: { $ifNull: ["$finalTotalTTC", 0] } } },
      },
    },
  ]);
  for (const row of rows) result.set(String(row._id), row.total || 0);
  return result;
}

/**
 * Montant TTC crédité par avoirs sur une facture.
 * @param {{ _id: any, workspaceId: any }} invoice
 * @returns {Promise<number>}
 */
export async function creditedTTC(invoice) {
  if (!invoice?._id || !invoice.workspaceId) return 0;
  const map = await creditedTTCByInvoice([invoice._id], invoice.workspaceId);
  return map.get(String(invoice._id)) || 0;
}

/**
 * Vrai si les avoirs couvrent tout le montant TTC de la facture.
 * @param {{ finalTotalTTC?: number }} invoice
 * @param {number} credited - montant crédité (creditedTTC)
 */
export function isCoveredByCredit(invoice, credited) {
  const total = cents(invoice?.finalTotalTTC);
  return total > 0 && cents(credited) >= total;
}

/**
 * Vrai si la facture est entièrement soldée par ses avoirs.
 * @param {{ _id: any, workspaceId: any, finalTotalTTC?: number }} invoice
 */
export async function isInvoiceFullyCredited(invoice) {
  return isCoveredByCredit(invoice, await creditedTTC(invoice));
}

/**
 * Ids (chaînes) des factures entièrement soldées par avoir parmi celles
 * données (lecture groupée, pour les traitements par lot).
 * @param {Array<{ _id: any, finalTotalTTC?: number }>} invoices
 * @param {string|ObjectId} workspaceId
 * @returns {Promise<Set<string>>}
 */
export async function fullyCreditedInvoiceIds(invoices, workspaceId) {
  const credited = await creditedTTCByInvoice(
    (invoices || []).map((inv) => inv._id),
    workspaceId,
  );
  const ids = new Set();
  for (const invoice of invoices || []) {
    if (isCoveredByCredit(invoice, credited.get(String(invoice._id)))) {
      ids.add(String(invoice._id));
    }
  }
  return ids;
}
