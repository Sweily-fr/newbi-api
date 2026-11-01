import mongoose from "mongoose";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import ImportedInvoice from "../models/ImportedInvoice.js";
import Transaction from "../models/Transaction.js";

/**
 * Un même objet R2 peut servir à plusieurs documents de l'espace : facture
 * d'achat créée depuis un justificatif de transaction ou convertie depuis une
 * facture importée, justificatif délié de sa facture… Avant de supprimer
 * l'objet avec l'un d'eux, on vérifie qu'aucun autre ne le référence encore
 * (par sa clé ou par son URL).
 *
 * @param {Object} params
 * @param {string|ObjectId} params.workspaceId
 * @param {string} [params.key] clé de l'objet dans son bucket
 * @param {string} [params.url] URL publique de l'objet
 * @param {Array<string|ObjectId>} [params.excludePurchaseInvoiceIds] factures d'achat qu'on supprime
 * @param {Array<string|ObjectId>} [params.excludeImportedInvoiceIds] factures importées qu'on supprime
 * @returns {Promise<boolean>}
 */
export async function isStoredFileReferenced({
  workspaceId,
  key,
  url,
  excludePurchaseInvoiceIds = [],
  excludeImportedInvoiceIds = [],
}) {
  const values = [...new Set([key, url].filter(Boolean).map(String))];
  if (values.length === 0 || !workspaceId) return false;

  const ws = String(workspaceId);
  if (!mongoose.isValidObjectId(ws)) return false;
  const wsObjectId = new mongoose.Types.ObjectId(ws);

  const [purchaseInvoice, importedInvoice, transaction] = await Promise.all([
    PurchaseInvoice.exists({
      workspaceId: wsObjectId,
      _id: { $nin: excludePurchaseInvoiceIds },
      $or: [
        { "files.path": { $in: values } },
        { "files.url": { $in: values } },
        { "files.filename": { $in: values } },
      ],
    }),
    ImportedInvoice.exists({
      workspaceId: wsObjectId,
      _id: { $nin: excludeImportedInvoiceIds },
      $or: [
        { "file.cloudflareKey": { $in: values } },
        { "file.url": { $in: values } },
      ],
    }),
    Transaction.exists({
      workspaceId: ws,
      $or: [
        { "receiptFiles.key": { $in: values } },
        { "receiptFiles.url": { $in: values } },
      ],
    }),
  ]);
  return Boolean(purchaseInvoice || importedInvoice || transaction);
}
