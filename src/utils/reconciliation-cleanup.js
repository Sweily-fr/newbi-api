import mongoose from "mongoose";
import logger from "./logger.js";
import { NO_LINKED_DOCUMENTS_CLAUSES } from "./transactionLinks.js";

/**
 * Nettoyage des liens de rapprochement bancaire (N↔N) lors des suppressions.
 *
 * Deux directions :
 * - suppression de factures d'achat → détacher côté transactions
 * - suppression de transactions → détacher côté factures/dépenses/factures
 *   d'achat
 *
 * Sans ce nettoyage, les documents restants gardent des ids orphelins et un
 * statut "matched"/"isReconciled" fantôme (l'UI affiche "rapproché" sans
 * contrepartie, les compteurs "à rapprocher" sont faux, et l'OCR ne retraite
 * jamais les justificatifs concernés).
 */

/**
 * Détache des factures d'achat (sur le point d'être supprimées) de toutes les
 * transactions du workspace : retire les ids de linkedPurchaseInvoiceIds,
 * nettoie receiptFiles[].purchaseInvoiceId, puis repasse en "unmatched" les
 * transactions qui n'ont plus aucun lien (ni vente ni achat).
 *
 * Note : receiptFiles[].ocrProcessed reste à true volontairement — la
 * suppression d'une facture est un choix de l'utilisateur, on ne recrée pas
 * automatiquement une facture depuis le même justificatif.
 */
export async function detachPurchaseInvoicesFromTransactions(
  invoiceIds,
  workspaceId,
) {
  if (!invoiceIds || invoiceIds.length === 0) return;

  const { default: Transaction } = await import("../models/Transaction.js");
  const ids = invoiceIds.map((id) =>
    typeof id === "string" ? new mongoose.Types.ObjectId(id) : id,
  );
  const wsId = String(workspaceId);

  try {
    // Transactions concernées (avant $pull, pour recalculer leur statut après)
    const affected = await Transaction.find({
      workspaceId: wsId,
      linkedPurchaseInvoiceIds: { $in: ids },
    }).select("_id");
    const affectedIds = affected.map((t) => t._id);

    await Transaction.updateMany(
      { workspaceId: wsId, linkedPurchaseInvoiceIds: { $in: ids } },
      { $pull: { linkedPurchaseInvoiceIds: { $in: ids } } },
    );

    // Nettoyer les pointeurs des justificatifs (créés par l'OCR auto)
    await Transaction.updateMany(
      { workspaceId: wsId, "receiptFiles.purchaseInvoiceId": { $in: ids } },
      { $set: { "receiptFiles.$[elem].purchaseInvoiceId": null } },
      { arrayFilters: [{ "elem.purchaseInvoiceId": { $in: ids } }] },
    );

    // Repasse "unmatched" les transactions qui n'ont plus aucun lien
    if (affectedIds.length > 0) {
      await Transaction.updateMany(
        {
          _id: { $in: affectedIds },
          $and: NO_LINKED_DOCUMENTS_CLAUSES,
        },
        {
          $set: { reconciliationStatus: "unmatched", reconciliationDate: null },
        },
      );
    }
  } catch (err) {
    logger.error(
      `detachPurchaseInvoicesFromTransactions: échec nettoyage (${err.message})`,
    );
  }
}

/**
 * Détache des factures clients importées (sur le point d'être supprimées) des
 * transactions qui les référencent, puis repasse "unmatched" celles qui n'ont
 * plus aucun lien. Symétrique de detachPurchaseInvoicesFromTransactions.
 */
export async function detachImportedInvoicesFromTransactions(
  invoiceIds,
  workspaceId,
) {
  if (!invoiceIds || invoiceIds.length === 0) return;

  const { default: Transaction } = await import("../models/Transaction.js");
  const ids = invoiceIds.map((id) =>
    typeof id === "string" ? new mongoose.Types.ObjectId(id) : id,
  );
  const wsId = String(workspaceId);

  try {
    const affected = await Transaction.find({
      workspaceId: wsId,
      linkedImportedInvoiceIds: { $in: ids },
    }).select("_id");
    const affectedIds = affected.map((t) => t._id);
    if (affectedIds.length === 0) return;

    await Transaction.updateMany(
      { _id: { $in: affectedIds } },
      { $pull: { linkedImportedInvoiceIds: { $in: ids } } },
    );
    await Transaction.updateMany(
      { _id: { $in: affectedIds }, $and: NO_LINKED_DOCUMENTS_CLAUSES },
      { $set: { reconciliationStatus: "unmatched", reconciliationDate: null } },
    );
  } catch (err) {
    logger.error(
      `detachImportedInvoicesFromTransactions: échec nettoyage (${err.message})`,
    );
  }
}

/**
 * Repointe toutes les références documentaires d'une transaction vers une
 * autre (fusion "transaction manuelle → transaction bancaire" lors du premier
 * sync : la transaction manuelle est supprimée, les factures/dépenses qui la
 * référençaient doivent suivre la transaction bancaire qui la remplace).
 */
export async function repointTransactionReferences(oldTxId, newTxId) {
  try {
    const [
      { default: Invoice },
      { default: PurchaseInvoice },
      { default: Expense },
      { default: ImportedInvoice },
    ] = await Promise.all([
      import("../models/Invoice.js"),
      import("../models/PurchaseInvoice.js"),
      import("../models/Expense.js"),
      import("../models/ImportedInvoice.js"),
    ]);

    // $addToSet du nouvel id puis $pull de l'ancien (deux passes : Mongo
    // n'accepte pas les deux opérateurs sur le même champ en une update)
    await Invoice.updateMany(
      { linkedTransactionIds: oldTxId },
      { $addToSet: { linkedTransactionIds: newTxId } },
    );
    await Invoice.updateMany(
      { linkedTransactionIds: oldTxId },
      { $pull: { linkedTransactionIds: oldTxId } },
    );
    await PurchaseInvoice.updateMany(
      { linkedTransactionIds: oldTxId },
      { $addToSet: { linkedTransactionIds: newTxId } },
    );
    await PurchaseInvoice.updateMany(
      { linkedTransactionIds: oldTxId },
      { $pull: { linkedTransactionIds: oldTxId } },
    );
    await ImportedInvoice.updateMany(
      { linkedTransactionIds: oldTxId },
      { $addToSet: { linkedTransactionIds: newTxId } },
    );
    await ImportedInvoice.updateMany(
      { linkedTransactionIds: oldTxId },
      { $pull: { linkedTransactionIds: oldTxId } },
    );
    await Expense.updateMany(
      { linkedTransactionId: oldTxId },
      { $set: { linkedTransactionId: newTxId } },
    );
  } catch (err) {
    logger.error(
      `repointTransactionReferences: échec repointage (${err.message})`,
    );
  }
}

/**
 * Détache des transactions (sur le point d'être supprimées) de tous les
 * documents qui les référencent : Invoice.linkedTransactionIds,
 * PurchaseInvoice.linkedTransactionIds (avec recalcul d'isReconciled),
 * Expense.linkedTransactionId.
 *
 * Les statuts de paiement (COMPLETED/PAID) sont volontairement conservés :
 * supprimer une connexion bancaire n'annule pas les paiements réellement
 * effectués.
 */
export async function detachTransactionsFromDocuments(
  transactionIds,
  workspaceId,
) {
  if (!transactionIds || transactionIds.length === 0) return;

  const txIds = transactionIds.map((id) =>
    typeof id === "string" ? new mongoose.Types.ObjectId(id) : id,
  );

  try {
    const [
      { default: Invoice },
      { default: Expense },
      { default: PurchaseInvoice },
      { default: ImportedInvoice },
    ] = await Promise.all([
      import("../models/Invoice.js"),
      import("../models/Expense.js"),
      import("../models/PurchaseInvoice.js"),
      import("../models/ImportedInvoice.js"),
    ]);

    const docFilter = { linkedTransactionIds: { $in: txIds } };
    if (workspaceId) {
      docFilter.workspaceId = new mongoose.Types.ObjectId(String(workspaceId));
    }

    await Promise.all([
      Invoice.updateMany(docFilter, {
        $pull: { linkedTransactionIds: { $in: txIds } },
      }),
      Expense.updateMany(
        {
          linkedTransactionId: { $in: txIds },
          ...(workspaceId
            ? { workspaceId: new mongoose.Types.ObjectId(String(workspaceId)) }
            : {}),
        },
        { $set: { linkedTransactionId: null, isReconciled: false } },
      ),
      PurchaseInvoice.updateMany(docFilter, {
        $pull: { linkedTransactionIds: { $in: txIds } },
      }),
      ImportedInvoice.updateMany(docFilter, {
        $pull: { linkedTransactionIds: { $in: txIds } },
      }),
    ]);

    // isReconciled recalculé : false uniquement si plus AUCUNE transaction
    // liée (une facture liée à 2 transactions dont 1 supprimée reste
    // rapprochée)
    await PurchaseInvoice.updateMany(
      {
        ...(workspaceId
          ? { workspaceId: new mongoose.Types.ObjectId(String(workspaceId)) }
          : {}),
        isReconciled: true,
        $or: [
          { linkedTransactionIds: { $exists: false } },
          { linkedTransactionIds: { $size: 0 } },
        ],
      },
      { $set: { isReconciled: false } },
    );
  } catch (err) {
    logger.error(
      `detachTransactionsFromDocuments: échec nettoyage (${err.message})`,
    );
  }
}
