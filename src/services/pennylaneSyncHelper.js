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
 * - Le nouveau statut est PENDING (envoyée) ou COMPLETED (payée) ou OVERDUE
 */
export async function syncInvoiceIfNeeded(invoice, workspaceId) {
  try {
    logger.info(
      `[PENNYLANE] syncInvoiceIfNeeded appelé — invoice=${invoice?._id}, status=${invoice?.status}, pennylaneSyncStatus=${invoice?.pennylaneSyncStatus}, workspaceId=${workspaceId}`,
    );

    if (!invoice || !workspaceId) {
      logger.warn(
        "[PENNYLANE] syncInvoiceIfNeeded: invoice ou workspaceId manquant",
      );
      return;
    }

    // Ne sync que les statuts pertinents (envoyée, payée, en retard)
    const syncableStatuses = ["PENDING", "COMPLETED", "OVERDUE"];
    if (!syncableStatuses.includes(invoice.status)) {
      logger.debug(
        `[PENNYLANE] syncInvoiceIfNeeded: statut ${invoice.status} non syncable, skip`,
      );
      return;
    }

    // Déjà synchronisée ?
    if (invoice.pennylaneSyncStatus === "SYNCED") {
      logger.debug("[PENNYLANE] syncInvoiceIfNeeded: déjà SYNCED, skip");
      return;
    }

    // workspaceId peut être un ObjectId ou un string selon le contexte d'appel
    // On cherche avec le string pour matcher le PennylaneAccount.organizationId
    const orgId = String(workspaceId);

    const account = await PennylaneAccount.findOne({
      organizationId: orgId,
      isConnected: true,
    });

    if (!account) {
      logger.debug(
        `[PENNYLANE] Auto-sync facture: aucun compte Pennylane trouvé pour org=${orgId}`,
      );
      return;
    }
    if (!account.autoSync?.invoices) {
      logger.debug(
        `[PENNYLANE] Auto-sync facture: autoSync.invoices désactivé pour org=${orgId}`,
      );
      return;
    }

    logger.info(
      `[PENNYLANE] Auto-sync facture ${invoice.prefix || ""}${invoice.number || invoice._id} (status=${invoice.status})...`,
    );

    const result = await pennylaneService.syncCustomerInvoice(
      account.apiToken,
      invoice,
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
        },
      );

      account.stats.invoicesSynced += 1;
      account.lastSyncAt = new Date();
      await account.save();

      logger.info(
        `[PENNYLANE] Auto-sync facture ${invoice.prefix || ""}${invoice.number || invoice._id} → OK`,
      );
    } else {
      const Invoice = (await import("../models/Invoice.js")).default;
      await Invoice.updateOne(
        { _id: invoice._id },
        { $set: { pennylaneSyncStatus: "ERROR" } },
      );

      logger.warn(
        `[PENNYLANE] Auto-sync facture ${invoice.prefix || ""}${invoice.number || invoice._id} → ERREUR: ${result.message}`,
      );
    }
  } catch (error) {
    logger.error("[PENNYLANE] Erreur auto-sync facture:", error.message);
  }
}

/**
 * Sync automatique d'une dépense vers Pennylane si :
 * - Pennylane est connecté pour cette org
 * - autoSync.supplierInvoices est activé
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

    // workspaceId peut être un ObjectId ou un string selon le contexte d'appel
    const orgId = String(workspaceId);

    const account = await PennylaneAccount.findOne({
      organizationId: orgId,
      isConnected: true,
    });

    if (!account) {
      logger.debug(
        `[PENNYLANE] Auto-sync dépense: aucun compte Pennylane trouvé pour org=${orgId}`,
      );
      return;
    }
    if (!account.autoSync?.supplierInvoices) {
      logger.debug(
        `[PENNYLANE] Auto-sync dépense: autoSync.supplierInvoices désactivé pour org=${orgId}`,
      );
      return;
    }

    logger.info(
      `[PENNYLANE] Auto-sync dépense ${expense.title || expense._id} (status=${expense.status})...`,
    );

    const result = await pennylaneService.syncSupplierInvoice(
      account.apiToken,
      expense,
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
        },
      );

      account.stats.expensesSynced += 1;
      account.lastSyncAt = new Date();
      await account.save();

      logger.info(
        `[PENNYLANE] Auto-sync dépense ${expense.title || expense._id} → OK`,
      );
    } else {
      const Expense = (await import("../models/Expense.js")).default;
      await Expense.updateOne(
        { _id: expense._id },
        { $set: { pennylaneSyncStatus: "ERROR" } },
      );

      logger.warn(
        `[PENNYLANE] Auto-sync dépense ${expense.title || expense._id} → ERREUR: ${result.message}`,
      );
    }
  } catch (error) {
    logger.error("[PENNYLANE] Erreur auto-sync dépense:", error.message);
  }
}

/**
 * Sync automatique d'un devis accepté vers Pennylane
 * Déclenché quand le statut passe à COMPLETED (accepté)
 */
export async function syncQuoteIfNeeded(quote, workspaceId) {
  try {
    logger.info(
      `[PENNYLANE] syncQuoteIfNeeded appelé — quote=${quote?._id}, status=${quote?.status}, workspaceId=${workspaceId}`,
    );

    if (!quote || !workspaceId) return;

    // Ne sync que les devis acceptés
    if (quote.status !== "COMPLETED") return;

    // Déjà synchronisé ?
    if (quote.pennylaneSyncStatus === "SYNCED") return;

    const orgId = String(workspaceId);

    const account = await PennylaneAccount.findOne({
      organizationId: orgId,
      isConnected: true,
    });

    if (!account) {
      logger.debug(
        `[PENNYLANE] syncQuoteIfNeeded: aucun compte Pennylane pour org=${orgId}`,
      );
      return;
    }
    if (!account.autoSync?.quotes) {
      logger.debug(
        `[PENNYLANE] syncQuoteIfNeeded: autoSync.quotes désactivé pour org=${orgId}`,
      );
      return;
    }

    logger.info(
      `[PENNYLANE] Auto-sync devis ${quote.prefix || ""}${quote.number || quote._id}...`,
    );

    const result = await pennylaneService.syncQuote(account.apiToken, quote);

    if (result.success) {
      const Quote = (await import("../models/Quote.js")).default;
      await Quote.updateOne(
        { _id: quote._id },
        {
          $set: {
            pennylaneSyncStatus: "SYNCED",
            pennylaneId: result.pennylaneId,
          },
        },
      );

      account.lastSyncAt = new Date();
      await account.save();

      logger.info(
        `[PENNYLANE] Auto-sync devis ${quote.prefix || ""}${quote.number || quote._id} → OK`,
      );
    } else {
      const Quote = (await import("../models/Quote.js")).default;
      await Quote.updateOne(
        { _id: quote._id },
        { $set: { pennylaneSyncStatus: "ERROR" } },
      );

      logger.warn(
        `[PENNYLANE] Auto-sync devis ${quote.prefix || ""}${quote.number || quote._id} → ERREUR: ${result.message}`,
      );
    }
  } catch (error) {
    logger.error("[PENNYLANE] Erreur auto-sync devis:", error.message);
  }
}
