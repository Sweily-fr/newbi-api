/**
 * Origine des liens de rapprochement bancaire : « comment le lien a été fait ».
 *
 * Chaque lien transaction ↔ document (facture client, facture d'achat,
 * facture client importée) est doublé d'une entrée dans
 * Transaction.reconciliationLinks, clé (documentType, documentId), qui
 * mémorise le geste à l'origine du lien, la date et l'utilisateur. Sert à
 * l'étiquette « Rapproché depuis la facture », « Justificatif déposé »,
 * « Suggestion confirmée »… des deux côtés du lien.
 *
 * Les liens créés avant cette mémoire n'ont pas d'entrée : l'UI n'affiche
 * alors rien. Un lien sans origine connue (client legacy, route REST) n'est
 * pas enregistré non plus.
 *
 * Tout chemin qui crée un lien doit appeler forgetReconciliationLink puis
 * pousser buildReconciliationLinkEntry ; tout chemin qui retire un lien doit
 * $pull l'entrée (reconciliationLinkPull).
 */
import mongoose from "mongoose";
import Transaction from "../models/Transaction.js";

export const RECONCILIATION_DOCUMENT_TYPES = [
  "INVOICE",
  "PURCHASE_INVOICE",
  "IMPORTED_INVOICE",
];

// DOCUMENT : depuis la fiche du document (facture client, d'achat, importée)
// TRANSACTION : depuis le tiroir de la transaction
// RECEIPT : justificatif déposé sur la transaction (facture créée/reconnue par l'OCR)
// SUGGESTION : suggestion automatique confirmée (bandeau, fiche, « Transaction trouvée »)
export const RECONCILIATION_LINK_ORIGINS = [
  "DOCUMENT",
  "TRANSACTION",
  "RECEIPT",
  "SUGGESTION",
];

const toObjectId = (id) =>
  id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id);

/**
 * Entrée à pousser dans Transaction.reconciliationLinks, ou null si l'origine
 * n'est pas connue (le lien est alors créé sans mémoire).
 */
export function buildReconciliationLinkEntry({
  documentType,
  documentId,
  origin,
  userId = null,
}) {
  if (!RECONCILIATION_DOCUMENT_TYPES.includes(documentType)) return null;
  if (!RECONCILIATION_LINK_ORIGINS.includes(origin)) return null;
  if (!documentId) return null;
  return {
    documentType,
    documentId: toObjectId(documentId),
    origin,
    linkedAt: new Date(),
    linkedBy: userId ? String(userId) : null,
  };
}

/**
 * Clause $pull retirant les entrées d'un ou plusieurs documents :
 *   { $pull: { linkedInvoiceIds: id, ...reconciliationLinkPull("INVOICE", [id]) } }
 */
export function reconciliationLinkPull(documentType, documentIds) {
  return {
    reconciliationLinks: {
      documentType,
      documentId: { $in: (documentIds || []).map(toObjectId) },
    },
  };
}

/**
 * Retire l'entrée existante avant d'en pousser une nouvelle (un lien refait
 * après déliaison garde une seule origine, la dernière).
 */
export async function forgetReconciliationLink(
  transactionFilter,
  documentType,
  documentIds,
) {
  await Transaction.updateMany(transactionFilter, {
    $pull: reconciliationLinkPull(documentType, documentIds),
  });
}
