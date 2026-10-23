import mongoose from "mongoose";
import logger from "./logger.js";
import {
  EXPENSE_CATEGORIES,
  PI_TO_EXPENSE_CATEGORY,
  PURCHASE_INVOICE_CATEGORIES,
  isIncomeSubcategory,
  isSubcategory,
  resolvePurchaseInvoiceCategoryInput,
  toExpenseCategory,
} from "./categoryTaxonomy.js";

export { PI_TO_EXPENSE_CATEGORY };

/**
 * Propagation de catégorie facture d'achat → transactions rapprochées.
 *
 * Règle métier : la facture d'achat (document comptable) fait foi. Au
 * rapprochement — et à chaque changement de catégorie d'une facture déjà
 * rapprochée — les transactions liées prennent la catégorie de la facture,
 * pour que les pages Factures d'achat et Transactions affichent le même
 * libellé. Dans l'autre sens, un choix manuel de catégorie sur une
 * transaction est répercuté sur ses factures d'achat liées (voir
 * syncCategoryFromTransaction).
 */

/**
 * Aligne la catégorie des transactions liées sur celle de la facture d'achat.
 *
 * - `category` OTHER ou absente : no-op. OTHER est le fallback OCR par défaut,
 *   il ne doit pas écraser une catégorie Bridge correcte (ex. "parking").
 * - `categoryIsManual` passe à true : la catégorie vient désormais du document
 *   rapproché, les syncs Bridge ne doivent plus l'écraser.
 * - updateMany ciblé (pas de save()) : ne revalide pas les documents legacy.
 * - Best-effort : une erreur est loguée mais ne fait pas échouer le
 *   rapprochement ou la mise à jour de la facture appelante.
 *
 * - `subcategory` (sous-catégorie fine, même référentiel que la page
 *   Transactions) : propagée telle quelle dans Transaction.category, la
 *   catégorie large expenseCategory en est dérivée (categoryTaxonomy).
 *
 * @param {object} params
 * @param {string} params.category - catégorie de la facture (enum PurchaseInvoice)
 * @param {string} [params.subcategory] - sous-catégorie fine de la facture
 * @param {string|object} params.workspaceId
 * @param {Array<string|object>} params.transactionIds - transactions liées
 */
export async function syncLinkedTransactionCategories({
  category,
  subcategory,
  workspaceId,
  transactionIds,
}) {
  if (!subcategory && (!category || category === "OTHER")) return;
  if (!transactionIds || transactionIds.length === 0) return;
  const fineCategory = subcategory || category;

  const Transaction = mongoose.model("Transaction");
  const ids = transactionIds.map((id) =>
    typeof id === "string" ? new mongoose.Types.ObjectId(id) : id,
  );

  try {
    await Transaction.updateMany(
      { _id: { $in: ids }, workspaceId: String(workspaceId) },
      {
        $set: {
          category: fineCategory,
          expenseCategory: toExpenseCategory(fineCategory),
          categoryIsManual: true,
        },
      },
    );
  } catch (error) {
    logger.error(
      `[CATEGORY-SYNC] Échec propagation catégorie ${fineCategory} vers ${ids.length} transaction(s):`,
      error,
    );
  }
}

/**
 * Répercute la catégorie choisie à la main sur une transaction vers ses
 * factures d'achat rapprochées, puis vers les autres transactions de ces
 * factures (paiement en plusieurs fois) : une même dépense garde une seule
 * catégorie partout.
 *
 * - Catégorie hors référentiel (code Bridge brut) ou de revenu : no-op, la
 *   facture garde sa catégorie plutôt que de tomber en OTHER.
 * - Liens lus des deux côtés (Transaction.linkedPurchaseInvoiceIds et
 *   PurchaseInvoice.linkedTransactionIds) pour couvrir les liens legacy.
 * - Best-effort : une erreur est loguée mais ne fait pas échouer la mise à
 *   jour de la transaction appelante.
 *
 * @param {object} params
 * @param {object} params.transaction - transaction déjà mise à jour
 * @param {string} params.category - catégorie choisie (fine ou large)
 * @param {string|object} params.workspaceId
 */
export async function syncCategoryFromTransaction({
  transaction,
  category,
  workspaceId,
}) {
  const inReferential =
    (isSubcategory(category) && !isIncomeSubcategory(category)) ||
    PURCHASE_INVOICE_CATEGORIES.includes(category) ||
    EXPENSE_CATEGORIES.includes(category);
  if (!inReferential) return;

  const PurchaseInvoice = mongoose.model("PurchaseInvoice");
  const wsId = new mongoose.Types.ObjectId(String(workspaceId));

  try {
    const invoices = await PurchaseInvoice.find({
      workspaceId: wsId,
      $or: [
        { _id: { $in: transaction.linkedPurchaseInvoiceIds || [] } },
        { linkedTransactionIds: transaction._id },
      ],
    }).select("_id linkedTransactionIds");
    if (invoices.length === 0) return;

    const resolved = resolvePurchaseInvoiceCategoryInput({
      subcategory: category,
    });
    await PurchaseInvoice.updateMany(
      { _id: { $in: invoices.map((inv) => inv._id) }, workspaceId: wsId },
      { $set: resolved },
    );

    const otherTransactionIds = invoices
      .flatMap((inv) => inv.linkedTransactionIds || [])
      .filter((id) => String(id) !== String(transaction._id));
    await syncLinkedTransactionCategories({
      ...resolved,
      // Même valeur exacte que la transaction modifiée
      subcategory: category,
      workspaceId,
      transactionIds: otherTransactionIds,
    });
  } catch (error) {
    logger.error(
      `[CATEGORY-SYNC] Échec propagation catégorie ${category} depuis la transaction ${transaction._id}:`,
      error,
    );
  }
}
