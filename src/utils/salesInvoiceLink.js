import Transaction from "../models/Transaction.js";
import Invoice from "../models/Invoice.js";
import { transactionHasNoLinks } from "./transactionLinks.js";
import { reconciliationLinkPull } from "./reconciliationLinkOrigin.js";

const sameId = (a, b) => String(a) === String(b);

/**
 * Champs à poser sur la facture au rattachement d'une transaction. Au
 * premier rattachement, on note si c'est le rapprochement qui la fait passer
 * en « payée » (pour ne rétablir que ce statut à la déliaison).
 *
 * @param {{ status?: string, linkedTransactionIds?: Array, paidByReconciliation?: boolean }} invoice - état avant rattachement
 * @returns {Object} champs à ajouter au $set
 */
export function reconciliationPaymentMarker(invoice) {
  const isFirstLink = (invoice?.linkedTransactionIds || []).length === 0;
  if (!isFirstLink) return {};
  return { paidByReconciliation: invoice?.status !== "COMPLETED" };
}

/**
 * Délie une transaction d'une facture de vente de l'espace.
 *
 * - Refuse si les deux documents ne sont pas liés (rien n'est modifié).
 * - La transaction ne repasse « à rapprocher » que si un lien a été retiré
 *   et qu'elle n'en a plus aucun.
 * - La facture ne repasse « en attente » que si elle est payée, qu'elle n'a
 *   plus aucune transaction liée et que c'est le rapprochement qui l'avait
 *   passée en « payée ». Une facture brouillon ou annulée n'est jamais
 *   modifiée.
 *
 * @returns {Promise<{ success: boolean, message: string, transaction?: Object }>}
 */
export async function unlinkTransactionFromSalesInvoice({
  transactionId,
  invoiceId,
  workspaceId,
}) {
  const [transaction, invoice] = await Promise.all([
    Transaction.findOne({ _id: transactionId, workspaceId }).select(
      "linkedInvoiceIds",
    ),
    Invoice.findOne({ _id: invoiceId, workspaceId }).select(
      "linkedTransactionIds",
    ),
  ]);
  if (!transaction || !invoice) {
    return { success: false, message: "Transaction ou facture introuvable" };
  }

  const linkedOnTransaction = (transaction.linkedInvoiceIds || []).some((id) =>
    sameId(id, invoiceId),
  );
  const linkedOnInvoice = (invoice.linkedTransactionIds || []).some((id) =>
    sameId(id, transactionId),
  );
  if (!linkedOnTransaction && !linkedOnInvoice) {
    return {
      success: false,
      message: "Cette transaction n'est pas rattachée à cette facture",
    };
  }

  // Côté transaction : $pull, origine du lien comprise.
  const updatedTransaction = await Transaction.findOneAndUpdate(
    { _id: transactionId, workspaceId },
    {
      $pull: {
        linkedInvoiceIds: invoiceId,
        ...reconciliationLinkPull("INVOICE", [invoiceId]),
      },
    },
    { new: true },
  );
  if (
    linkedOnTransaction &&
    updatedTransaction &&
    transactionHasNoLinks(updatedTransaction) &&
    updatedTransaction.reconciliationStatus !== "ignored"
  ) {
    // updateOne ciblé plutôt que save() : ne revalide pas tout le document
    // (données legacy hors enum).
    await Transaction.updateOne(
      { _id: transactionId, workspaceId },
      { $set: { reconciliationStatus: "unmatched", reconciliationDate: null } },
    );
    updatedTransaction.reconciliationStatus = "unmatched";
    updatedTransaction.reconciliationDate = null;
  }

  // Côté facture : seulement si elle référence bien cette transaction.
  if (linkedOnInvoice) {
    const updatedInvoice = await Invoice.findOneAndUpdate(
      { _id: invoiceId, workspaceId, linkedTransactionIds: transactionId },
      { $pull: { linkedTransactionIds: transactionId } },
      { new: true },
    );
    if (
      updatedInvoice &&
      (updatedInvoice.linkedTransactionIds || []).length === 0
    ) {
      if (updatedInvoice.paidByReconciliation === false) {
        // Payée avant le rapprochement : le paiement reste acquis.
        await Invoice.updateOne(
          { _id: invoiceId, workspaceId },
          { $unset: { paidByReconciliation: "" } },
        );
      } else {
        // Mise à jour conditionnelle et atomique : seule une facture payée
        // sans plus aucune transaction liée repasse « en attente ».
        await Invoice.updateOne(
          {
            _id: invoiceId,
            workspaceId,
            status: "COMPLETED",
            linkedTransactionIds: { $size: 0 },
          },
          {
            $set: { status: "PENDING", paymentDate: null },
            $unset: { paidByReconciliation: "" },
          },
        );
      }
    }
  }

  return {
    success: true,
    message: "Déliaison effectuée avec succès",
    transaction: updatedTransaction || null,
  };
}
