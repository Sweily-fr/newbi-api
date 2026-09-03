import QontoAccount from "../models/QontoAccount.js";
import qontoService from "./qontoService.js";
import logger from "../utils/logger.js";

/**
 * Helper fire-and-forget pour la sync automatique Qonto.
 * Même contrat que pennylaneSyncHelper : appelé après les changements de
 * statut dans les resolvers, ne lève jamais (loggue et échoue silencieusement).
 */

async function findConnectedAccount(workspaceId, flag) {
  const orgId = String(workspaceId);
  const account = await QontoAccount.findOne({
    organizationId: orgId,
    isConnected: true,
  });
  if (!account) {
    logger.debug(`[QONTO] Auto-sync: aucun compte Qonto pour org=${orgId}`);
    return null;
  }
  if (!account.autoSync?.[flag]) {
    logger.debug(
      `[QONTO] Auto-sync: autoSync.${flag} désactivé pour org=${orgId}`,
    );
    return null;
  }
  return account;
}

async function markSynced(Model, id, result) {
  await Model.updateOne(
    { _id: id },
    {
      $set: result.success
        ? { qontoSyncStatus: "SYNCED", qontoId: result.qontoId }
        : { qontoSyncStatus: "ERROR" },
    },
  );
}

/**
 * Sync automatique d'une facture vers Qonto si :
 * - Qonto est connecté pour cette org et autoSync.invoices est activé
 * - La facture n'a pas déjà été synchronisée
 * - Le statut est PENDING (envoyée), COMPLETED (payée) ou OVERDUE
 */
export async function syncInvoiceIfNeeded(invoice, workspaceId) {
  try {
    if (!invoice || !workspaceId) return;

    const syncableStatuses = ["PENDING", "COMPLETED", "OVERDUE"];
    if (!syncableStatuses.includes(invoice.status)) return;
    if (invoice.qontoSyncStatus === "SYNCED") return;

    const account = await findConnectedAccount(workspaceId, "invoices");
    if (!account) return;

    const label = `${invoice.prefix || ""}${invoice.number || invoice._id}`;
    logger.info(
      `[QONTO] Auto-sync facture ${label} (status=${invoice.status})...`,
    );

    const result = await qontoService.syncCustomerInvoice(
      account.getCredentials(),
      invoice,
      { iban: account.getInvoiceBankAccount()?.iban || null },
    );

    const Invoice = (await import("../models/Invoice.js")).default;
    await markSynced(Invoice, invoice._id, result);

    if (result.success) {
      account.stats.invoicesSynced += 1;
      account.lastSyncAt = new Date();
      await account.save();
      logger.info(`[QONTO] Auto-sync facture ${label} → OK`);
    } else {
      logger.warn(
        `[QONTO] Auto-sync facture ${label} → ERREUR: ${result.message}`,
      );
    }
  } catch (error) {
    logger.error(`[QONTO] Erreur auto-sync facture: ${error.message}`);
  }
}

/**
 * Sync automatique d'une facture d'achat (statut TO_PAY, PENDING, PAID ou OVERDUE)
 */
export async function syncPurchaseInvoiceIfNeeded(
  purchaseInvoice,
  workspaceId,
) {
  try {
    if (!purchaseInvoice || !workspaceId) return;

    const syncableStatuses = ["TO_PAY", "PENDING", "PAID", "OVERDUE"];
    if (!syncableStatuses.includes(purchaseInvoice.status)) return;
    if (purchaseInvoice.qontoSyncStatus === "SYNCED") return;

    const account = await findConnectedAccount(workspaceId, "supplierInvoices");
    if (!account) return;

    const label = purchaseInvoice.invoiceNumber || purchaseInvoice._id;
    logger.info(`[QONTO] Auto-sync facture d'achat ${label}...`);

    const result = await qontoService.syncPurchaseInvoice(
      account.getCredentials(),
      purchaseInvoice,
    );

    const PurchaseInvoice = (await import("../models/PurchaseInvoice.js"))
      .default;
    await markSynced(PurchaseInvoice, purchaseInvoice._id, result);

    if (result.success) {
      account.stats.expensesSynced += 1;
      account.lastSyncAt = new Date();
      await account.save();
      logger.info(`[QONTO] Auto-sync facture d'achat ${label} → OK`);
    } else {
      logger.warn(
        `[QONTO] Auto-sync facture d'achat ${label} → ERREUR: ${result.message}`,
      );
    }
  } catch (error) {
    logger.error(`[QONTO] Erreur auto-sync facture d'achat: ${error.message}`);
  }
}

/**
 * Sync automatique d'un devis vers Qonto (statut PENDING = envoyé, COMPLETED = accepté)
 */
export async function syncQuoteIfNeeded(quote, workspaceId) {
  try {
    if (!quote || !workspaceId) return;

    const syncableStatuses = ["PENDING", "COMPLETED"];
    if (!syncableStatuses.includes(quote.status)) return;
    if (quote.qontoSyncStatus === "SYNCED") return;

    const account = await findConnectedAccount(workspaceId, "quotes");
    if (!account) return;

    const label = `${quote.prefix || ""}${quote.number || quote._id}`;
    logger.info(`[QONTO] Auto-sync devis ${label} (status=${quote.status})...`);

    const result = await qontoService.syncQuote(
      account.getCredentials(),
      quote,
    );

    const Quote = (await import("../models/Quote.js")).default;
    await markSynced(Quote, quote._id, result);

    if (result.success) {
      account.stats.quotesSynced += 1;
      account.lastSyncAt = new Date();
      await account.save();
      logger.info(`[QONTO] Auto-sync devis ${label} → OK`);
    } else {
      logger.warn(
        `[QONTO] Auto-sync devis ${label} → ERREUR: ${result.message}`,
      );
    }
  } catch (error) {
    logger.error(`[QONTO] Erreur auto-sync devis: ${error.message}`);
  }
}

/**
 * Paiement saisi dans Newbi sur une facture d'achat connue de Qonto
 * (déposée par Newbi ou importée depuis Qonto) → marquée payée dans Qonto.
 */
export async function syncPurchaseInvoicePaidToQonto(
  purchaseInvoice,
  workspaceId,
) {
  try {
    if (!purchaseInvoice || !workspaceId) return;
    if (purchaseInvoice.status !== "PAID" || !purchaseInvoice.qontoId) return;
    if (purchaseInvoice.qontoId === "imported") return; // dépôt sans id retourné

    const account = await findConnectedAccount(workspaceId, "supplierInvoices");
    if (!account) return;

    const result = await qontoService.markSupplierInvoicePaid(
      account.getCredentials(),
      purchaseInvoice.qontoId,
      purchaseInvoice.paymentDate || new Date(),
    );
    const label = purchaseInvoice.invoiceNumber || purchaseInvoice._id;
    if (result.success) {
      logger.info(`[QONTO] Paiement facture d'achat ${label} → Qonto OK`);
    } else {
      logger.warn(
        `[QONTO] Paiement facture d'achat ${label} → Qonto refusé: ${result.message}`,
      );
    }
  } catch (error) {
    logger.error(
      "[QONTO] Erreur sync paiement facture d'achat:",
      error.message,
    );
  }
}
