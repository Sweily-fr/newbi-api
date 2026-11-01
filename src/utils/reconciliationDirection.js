import Transaction from "../models/Transaction.js";
import { transactionHasNoLinks } from "./transactionLinks.js";

/**
 * Sens d'un rapprochement : une facture de vente est payée par une entrée
 * d'argent, une facture d'achat par une sortie. Les transactions saisies à
 * la main (provider « manual ») gardent leur propre convention de signe et ne
 * sont pas contrôlées ici.
 */
export const DEBIT_ON_SALES_INVOICE_MESSAGE =
  "Une sortie d'argent ne peut pas être rapprochée d'une facture de vente.";
export const CREDIT_ON_PURCHASE_INVOICE_MESSAGE =
  "Une entrée d'argent ne peut pas être rapprochée d'une facture d'achat.";
export const IGNORE_LINKED_TRANSACTION_MESSAGE =
  "Cette transaction est rattachée à une facture : déliez-la avant de l'ignorer.";

const isBankTransaction = (transaction) => transaction?.provider !== "manual";

export const isBankDebit = (transaction) =>
  isBankTransaction(transaction) && Number(transaction?.amount) < 0;

export const isBankCredit = (transaction) =>
  isBankTransaction(transaction) && Number(transaction?.amount) > 0;

/** Vrai si l'une des transactions de l'espace est une entrée d'argent bancaire. */
export async function hasBankCredit(transactionIds, workspaceId) {
  const transactions = await Transaction.find({
    _id: { $in: transactionIds },
    workspaceId: String(workspaceId),
  })
    .select("amount provider")
    .lean();
  return transactions.some(isBankCredit);
}

/** Vrai si la transaction de l'espace est une sortie d'argent bancaire. */
export async function isBankDebitTransaction(transactionId, workspaceId) {
  const transaction = await Transaction.findOne({
    _id: transactionId,
    workspaceId: String(workspaceId),
  })
    .select("amount provider")
    .lean();
  return isBankDebit(transaction);
}

/** Vrai si la transaction de l'espace porte encore un document rattaché. */
export async function transactionHasLinkedDocuments(
  transactionId,
  workspaceId,
) {
  const transaction = await Transaction.findOne({
    _id: transactionId,
    workspaceId: String(workspaceId),
  })
    .select(
      "linkedInvoiceIds linkedPurchaseInvoiceIds linkedImportedInvoiceIds",
    )
    .lean();
  return Boolean(transaction) && !transactionHasNoLinks(transaction);
}
