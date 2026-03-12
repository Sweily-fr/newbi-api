import PennylaneAccount from "../models/PennylaneAccount.js";
import pennylaneService from "./pennylaneService.js";
import logger from "../utils/logger.js";

/**
 * Helper fire-and-forget pour la sync automatique Pennylane.
 * Appelé après les changements de statut dans les resolvers.
 * Ne lève jamais d'erreur — loggue et silencieusement échoue.
 */

/**
 * Sync automatique d'une facture vers Pennylane si :
 * - Pennylane est connecté pour cette org
 * - autoSync.invoices est activé
 * - La facture n'a pas déjà été synchronisée
 * - Le nouveau statut est PENDING (envoyée) ou COMPLETED (payée)
 */
export async function syncInvoiceIfNeeded(invoice, workspaceId) {
  try {
    if (!invoice || !workspaceId) return;

    // Ne sync que les statuts pertinents
    const syncableStatuses = ["PENDING", "COMPLETED"];
    if (!syncableStatuses.includes(invoice.status)) return;

    // Déjà synchronisée ?
    if (invoice.pennylaneSyncStatus === "SYNCED") return;

    const account = await PennylaneAccount.findOne({
      organizationId: workspaceId,
      isConnected: true,
    });

    if (!account || !account.autoSync?.invoices) return;

    const result = await pennylaneService.syncCustomerInvoice(
      account.apiToken,
      invoice
    );

    if (result.success) {
      // Mise à jour directe sans passer par save() pour éviter les effets de bord
      const Invoice = (await import("../models/Invoice.js")).default;
      await Invoice.updateOne(
        { _id: invoice._id },
        {
          $set: {
            pennylaneSyncStatus: "SYNCED",
            pennylaneId: result.pennylaneId,
          },
        }
      );

      account.stats.invoicesSynced += 1;
      account.lastSyncAt = new Date();
      await account.save();

      logger.info(
        `[PENNYLANE] Auto-sync facture ${invoice.prefix || ""}${invoice.number || invoice._id} → OK`
      );
    } else {
      const Invoice = (await import("../models/Invoice.js")).default;
      await Invoice.updateOne(
        { _id: invoice._id },
        { $set: { pennylaneSyncStatus: "ERROR" } }
      );

      logger.warn(
        `[PENNYLANE] Auto-sync facture ${invoice.prefix || ""}${invoice.number || invoice._id} → ERREUR: ${result.message}`
      );
    }
  } catch (error) {
    logger.error("[PENNYLANE] Erreur auto-sync facture:", error.message);
  }
}

/**
 * Sync automatique d'une dépense vers Pennylane si :
 * - Pennylane est connecté pour cette org
 * - autoSync.expenses est activé
 * - La dépense n'a pas déjà été synchronisée
 * - Le nouveau statut est APPROVED ou PAID
 */
export async function syncExpenseIfNeeded(expense, workspaceId) {
  try {
    if (!expense || !workspaceId) return;

    // Ne sync que les statuts pertinents
    const syncableStatuses = ["APPROVED", "PAID"];
    if (!syncableStatuses.includes(expense.status)) return;

    // Déjà synchronisée ?
    if (expense.pennylaneSyncStatus === "SYNCED") return;

    const account = await PennylaneAccount.findOne({
      organizationId: workspaceId,
      isConnected: true,
    });

    if (!account || !account.autoSync?.expenses) return;

    const result = await pennylaneService.syncSupplierInvoice(
      account.apiToken,
      expense
    );

    if (result.success) {
      const Expense = (await import("../models/Expense.js")).default;
      await Expense.updateOne(
        { _id: expense._id },
        {
          $set: {
            pennylaneSyncStatus: "SYNCED",
            pennylaneId: result.pennylaneId,
          },
        }
      );

      account.stats.expensesSynced += 1;
      account.lastSyncAt = new Date();
      await account.save();

      logger.info(
        `[PENNYLANE] Auto-sync dépense ${expense.title || expense._id} → OK`
      );
    } else {
      const Expense = (await import("../models/Expense.js")).default;
      await Expense.updateOne(
        { _id: expense._id },
        { $set: { pennylaneSyncStatus: "ERROR" } }
      );

      logger.warn(
        `[PENNYLANE] Auto-sync dépense ${expense.title || expense._id} → ERREUR: ${result.message}`
      );
    }
  } catch (error) {
    logger.error("[PENNYLANE] Erreur auto-sync dépense:", error.message);
  }
}
