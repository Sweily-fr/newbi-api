import mongoose from "mongoose";
import logger from "./logger.js";

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

// category (PurchaseInvoice) -> expenseCategory (Transaction).
// Inverse de EXPENSE_TO_PI_CATEGORY (transactionReceiptOcrService) : les
// valeurs communes aux deux enums se mappent 1:1, celles sans équivalent
// (TRANSPORT, TELECOMMUNICATIONS, ENERGY) vont vers la plus proche.
export const PI_TO_EXPENSE_CATEGORY = {
  RENT: "RENT",
  SUBSCRIPTIONS: "SUBSCRIPTIONS",
  OFFICE_SUPPLIES: "OFFICE_SUPPLIES",
  SERVICES: "SERVICES",
  TRANSPORT: "TRAVEL",
  MEALS: "MEALS",
  TELECOMMUNICATIONS: "UTILITIES",
  INSURANCE: "INSURANCE",
  ENERGY: "UTILITIES",
  SOFTWARE: "SOFTWARE",
  HARDWARE: "HARDWARE",
  MARKETING: "MARKETING",
  TRAINING: "TRAINING",
  MAINTENANCE: "MAINTENANCE",
  TAXES: "TAXES",
  UTILITIES: "UTILITIES",
  OTHER: "OTHER",
};

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
 * @param {object} params
 * @param {string} params.category - catégorie de la facture (enum PurchaseInvoice)
 * @param {string|object} params.workspaceId
 * @param {Array<string|object>} params.transactionIds - transactions liées
 */
export async function syncLinkedTransactionCategories({
  category,
  workspaceId,
  transactionIds,
}) {
  if (!category || category === "OTHER") return;
  if (!transactionIds || transactionIds.length === 0) return;

  const Transaction = mongoose.model("Transaction");
  const ids = transactionIds.map((id) =>
    typeof id === "string" ? new mongoose.Types.ObjectId(id) : id,
  );

  try {
    await Transaction.updateMany(
      { _id: { $in: ids }, workspaceId: String(workspaceId) },
      {
        $set: {
          category,
          expenseCategory: PI_TO_EXPENSE_CATEGORY[category] || "OTHER",
          categoryIsManual: true,
        },
      },
    );
  } catch (error) {
    logger.error(
      `[CATEGORY-SYNC] Échec propagation catégorie ${category} vers ${ids.length} transaction(s):`,
      error,
    );
  }
}
