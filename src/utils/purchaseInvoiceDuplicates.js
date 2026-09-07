/**
 * Détection de doublons de factures d'achat.
 *
 * Source unique pour :
 * - l'OCR des justificatifs de transaction (transactionReceiptOcrService) :
 *   avant de créer une facture d'achat depuis un justificatif, on cherche une
 *   facture existante pour y rattacher la transaction à la place ;
 * - la création manuelle (query purchaseInvoiceDuplicates) : le front avertit
 *   l'utilisateur avant d'enregistrer une facture qui semble déjà exister.
 *
 * Deux règles, dans cet ordre :
 * 1. Même numéro de facture (insensible à la casse), confirmé par le
 *    fournisseur OU le montant (un numéro court type "2026-001" peut exister
 *    chez deux fournisseurs différents).
 * 2. Sans numéro exploitable : même fournisseur, même montant TTC (±0,5 %) et
 *    date d'émission à moins de 7 jours (une dépense récurrente au même
 *    montant chaque mois n'est PAS un doublon).
 */
import mongoose from "mongoose";
import PurchaseInvoice from "../models/PurchaseInvoice.js";

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const normalizeSupplierName = (s) =>
  (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// "Qonto" ~ "QONTO SAS" : égalité ou inclusion, sur une base d'au moins
// 3 caractères pour éviter les correspondances triviales.
export const supplierNamesMatch = (a, b) => {
  const na = normalizeSupplierName(a);
  const nb = normalizeSupplierName(b);
  if (na.length < 3 || nb.length < 3) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
};

const amountsMatch = (a, b, ratio) => {
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) <= Math.max(a * ratio, 0.01);
};

const DUPLICATE_DATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const datesClose = (a, b) => {
  if (!a || !b) return true; // donnée manquante : on ne tranche pas sur la date
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return true;
  return Math.abs(ta - tb) <= DUPLICATE_DATE_WINDOW_MS;
};

/**
 * Factures d'achat existantes qui ressemblent à celle décrite.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.workspaceId
 * @param {string} [params.supplierName]
 * @param {string} [params.invoiceNumber]
 * @param {number} [params.amountTTC]
 * @param {Date|string} [params.issueDate]
 * @param {string|ObjectId} [params.excludeId] facture à ignorer (édition)
 * @param {Array<string|ObjectId>} [params.preferIds] factures à servir en
 *   premier si elles matchent (ex. celles déjà liées à la transaction)
 * @param {number} [params.limit=5]
 * @returns {Promise<Array>} documents Mongoose, les plus récents d'abord
 */
export async function findPurchaseInvoiceDuplicates({
  workspaceId,
  supplierName,
  invoiceNumber,
  amountTTC,
  issueDate,
  excludeId,
  preferIds = [],
  limit = 5,
}) {
  const wsId =
    typeof workspaceId === "string"
      ? new mongoose.Types.ObjectId(workspaceId)
      : workspaceId;

  const base = { workspaceId: wsId, status: { $ne: "ARCHIVED" } };
  if (excludeId) base._id = { $ne: excludeId };

  const number = (invoiceNumber || "").toString().trim();
  const amount = Number(amountTTC) || 0;
  const hasSupplier = normalizeSupplierName(supplierName).length >= 3;

  const found = new Map();
  const add = (doc) => {
    const key = doc._id.toString();
    if (!found.has(key)) found.set(key, doc);
  };

  // Règle 1 : même numéro, confirmé par fournisseur ou montant.
  if (number.length >= 3) {
    const byNumber = await PurchaseInvoice.find({
      ...base,
      invoiceNumber: { $regex: `^${escapeRegex(number)}$`, $options: "i" },
    })
      .sort({ issueDate: -1 })
      .limit(20);

    for (const doc of byNumber) {
      const supplierOk = hasSupplier
        ? supplierNamesMatch(supplierName, doc.supplierName)
        : false;
      const amountOk = amountsMatch(amount, doc.amountTTC, 0.01);
      // Ni fournisseur ni montant fournis : le numéro seul suffit.
      if (supplierOk || amountOk || (!hasSupplier && !(amount > 0))) {
        add(doc);
      }
    }
  }

  // Règle 2 : même fournisseur + même montant + dates proches.
  if (hasSupplier && amount > 0) {
    const tolerance = Math.max(amount * 0.005, 0.01);
    const bySupplierAmount = await PurchaseInvoice.find({
      ...base,
      amountTTC: { $gte: amount - tolerance, $lte: amount + tolerance },
    })
      .sort({ issueDate: -1 })
      .limit(50);

    for (const doc of bySupplierAmount) {
      if (!supplierNamesMatch(supplierName, doc.supplierName)) continue;
      if (!datesClose(issueDate, doc.issueDate)) continue;
      add(doc);
    }
  }

  const preferred = new Set((preferIds || []).map(String));
  const results = [...found.values()].sort((a, b) => {
    const pa = preferred.has(a._id.toString()) ? 1 : 0;
    const pb = preferred.has(b._id.toString()) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return new Date(b.issueDate || 0) - new Date(a.issueDate || 0);
  });

  return results.slice(0, limit);
}
