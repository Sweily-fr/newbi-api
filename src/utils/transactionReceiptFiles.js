import mongoose from "mongoose";

/**
 * Justificatifs de transaction (`receiptFiles`) : garde-fous autour des
 * sous-documents sans `_id`.
 *
 * Incident 21/09/2026 : 39 transactions portaient des justificatifs écrits
 * par une ancienne migration via le driver brut, donc sans `_id`. Le
 * résolveur GraphQL fabriquait alors un identifiant de repli
 * (`<transactionId>-receipt-<index>`) que ni la suppression ni l'aperçu ne
 * savaient retrouver : « Justificatif introuvable » et page blanche. Les
 * données ont été réparées par script ; ce module empêche le cas de revenir :
 *  - ensureReceiptFileIds : attribue et persiste un `_id` manquant à la
 *    lecture (auto-réparation, écriture ciblée par index et conditionnelle) ;
 *  - findTransactionReceiptFile : retrouve un justificatif par `_id`, ou par
 *    l'identifiant de repli si un ancien client le renvoie encore.
 */

const SYNTHETIC_RECEIPT_ID = /^([0-9a-f]{24})-receipt-(\d{1,3})$/i;

export const syntheticReceiptFileId = (transactionId, index) =>
  `${transactionId}-receipt-${index}`;

/**
 * Attribue un `_id` à chaque justificatif qui n'en a pas et le persiste.
 * L'écriture est ciblée sur l'index concerné et conditionnée à l'absence
 * d'`_id` à cet index au moment de l'écriture : un upload concurrent ne peut
 * ni être écrasé ni recevoir l'identifiant d'un autre fichier. Renvoie le
 * tableau (muté en mémoire pour que l'appelant serve les vrais ids).
 */
export async function ensureReceiptFileIds(transaction) {
  const files = transaction?.receiptFiles;
  if (!Array.isArray(files) || files.length === 0) return files || [];
  const missing = files
    .map((f, idx) => (f && !f._id ? idx : -1))
    .filter((idx) => idx >= 0);
  if (missing.length === 0) return files;

  const Transaction = mongoose.model("Transaction");
  for (const idx of missing) {
    const id = new mongoose.Types.ObjectId();
    const path = `receiptFiles.${idx}._id`;
    const result = await Transaction.updateOne(
      { _id: transaction._id, [path]: { $exists: false } },
      { $set: { [path]: id } },
    );
    if (result.modifiedCount === 1) {
      files[idx]._id = id;
    }
  }
  return files;
}

/**
 * Justificatif d'une transaction par identifiant. Accepte l'identifiant de
 * repli `<transactionId>-receipt-<index>` (ancien front / cache) tant que la
 * transaction correspond et que l'index existe.
 */
export function findTransactionReceiptFile(transaction, fileId) {
  const files = transaction?.receiptFiles;
  if (!Array.isArray(files) || !fileId) return null;
  const wanted = String(fileId);
  const byId = files.find((f) => f?._id && String(f._id) === wanted);
  if (byId) return byId;

  const match = SYNTHETIC_RECEIPT_ID.exec(wanted);
  if (!match) return null;
  const [, txId, index] = match;
  if (String(transaction._id) !== txId.toLowerCase()) return null;
  return files[Number(index)] || null;
}
