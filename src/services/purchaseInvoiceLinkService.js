/**
 * Liaison facture d'achat ↔ transactions bancaires (débits).
 *
 * Source unique des effets d'un rapprochement, partagée par la mutation
 * manuelle (reconcilePurchaseInvoice) et tout autre chemin de liaison :
 * liens N↔N des deux côtés, facture payée/rapprochée, catégorie propagée aux
 * transactions, signalement de paiement SuperPDP et automatisations
 * « facture payée ».
 */
import mongoose from "mongoose";
import Transaction from "../models/Transaction.js";
import { syncLinkedTransactionCategories } from "../utils/purchaseInvoiceCategorySync.js";
import { reportPurchaseInvoicePaymentIfNeeded } from "../utils/purchaseInvoiceEInvoiceHelper.js";
import documentAutomationService from "./documentAutomationService.js";
import logger from "../utils/logger.js";

const toObjectId = (id) =>
  id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id);

/**
 * Ajoute des transactions aux liens d'une facture d'achat (sémantique
 * additive : les liens existants sont conservés).
 *
 * @param {Object} params
 * @param {import("mongoose").Document} params.invoice facture d'achat (document Mongoose)
 * @param {Array<string|ObjectId>} params.transactionIds transactions à lier
 * @param {string|ObjectId} params.workspaceId
 * @param {string} [params.userId] pour les automatisations (facultatif)
 * @param {Date} [params.paymentDate] date de paiement à poser si la facture n'en a pas
 * @returns {Promise<{invoice: import("mongoose").Document, newTransactionIds: string[]}>}
 *   newTransactionIds vide si toutes les transactions étaient déjà liées
 */
export async function linkPurchaseInvoiceToTransactions({
  invoice,
  transactionIds,
  workspaceId,
  userId = null,
  paymentDate = null,
}) {
  const wsId = toObjectId(workspaceId);
  const alreadyLinked = new Set(
    (invoice.linkedTransactionIds || []).map(String),
  );
  const newTransactionIds = [
    ...new Set((transactionIds || []).map(String)),
  ].filter((id) => !alreadyLinked.has(id));
  if (newTransactionIds.length === 0) {
    return { invoice, newTransactionIds };
  }

  invoice.linkedTransactionIds = [
    ...(invoice.linkedTransactionIds || []),
    ...newTransactionIds.map((id) => new mongoose.Types.ObjectId(id)),
  ];
  invoice.isReconciled = true;
  invoice.status = "PAID";
  invoice.paymentDate = invoice.paymentDate || paymentDate || new Date();

  // Lien N↔N par référence : la transaction « porte » la facture d'achat
  // (linkedPurchaseInvoiceIds). Le justificatif reste sur la facture.
  await Transaction.updateMany(
    { _id: { $in: newTransactionIds }, workspaceId: wsId },
    {
      $set: { reconciliationStatus: "matched", reconciliationDate: new Date() },
      $addToSet: { linkedPurchaseInvoiceIds: invoice._id },
    },
  );

  // La facture fait foi : les transactions rapprochées prennent sa catégorie.
  await syncLinkedTransactionCategories({
    category: invoice.category,
    subcategory: invoice.subcategory,
    workspaceId: String(workspaceId),
    transactionIds: newTransactionIds,
  });

  // Signaler le paiement à SuperPDP si e-facture reçue (best-effort).
  await reportPurchaseInvoicePaymentIfNeeded(invoice, String(workspaceId));

  await invoice.save();

  // Automatisations documents partagés (fire-and-forget).
  documentAutomationService
    .executeAutomationsForExpense(
      "PURCHASE_INVOICE_PAID",
      String(workspaceId),
      {
        documentId: invoice._id.toString(),
        documentType: "purchaseInvoice",
        documentNumber: invoice.invoiceNumber || "",
        supplierName: invoice.supplierName || "",
        fileUrl: invoice.files?.[0]?.url || null,
        fileKey: invoice.files?.[0]?.path || null,
        fileName: invoice.files?.[0]?.originalFilename || null,
        mimeType: invoice.files?.[0]?.mimetype || "application/pdf",
        issueDate:
          invoice.invoiceDate || invoice.issueDate || invoice.createdAt,
        clientId: invoice.supplierId || null,
      },
      userId,
    )
    .catch((err) =>
      logger.error(
        `[PI LINK] automatisations facture payée ${invoice._id}: ${err.message}`,
      ),
    );

  return { invoice, newTransactionIds };
}

export default { linkPurchaseInvoiceToTransactions };
