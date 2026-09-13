import mongoose from "mongoose";
import logger from "./logger.js";
import {
  PI_TO_EXPENSE_CATEGORY,
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
 * libellé. Propagation à sens unique : une édition manuelle ultérieure de la
 * catégorie côté transaction n'est pas répercutée sur la facture.
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
