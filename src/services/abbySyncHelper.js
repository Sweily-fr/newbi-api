import AbbyAccount from "../models/AbbyAccount.js";
import abbyService from "./abbyService.js";
import logger from "../utils/logger.js";

/**
 * Helper fire-and-forget pour la sync automatique Abby.
 * Même contrat que qontoSyncHelper : appelé après les changements de statut
 * dans les resolvers, ne lève jamais (loggue et échoue silencieusement).
 *
 * Abby tient des livres comptables : une facture n'y est enregistrée qu'une
 * fois encaissée (COMPLETED), une facture d'achat qu'une fois payée (PAID).
 */

async function findConnectedAccount(workspaceId, flag) {
  const orgId = String(workspaceId);
  const account = await AbbyAccount.findOne({
    organizationId: orgId,
    isConnected: true,
  });
  if (!account) {
    logger.debug(`[ABBY] Auto-sync: aucun compte Abby pour org=${orgId}`);
    return null;
  }
  if (!account.autoSync?.[flag]) {
    logger.debug(
      `[ABBY] Auto-sync: autoSync.${flag} désactivé pour org=${orgId}`,
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
        ? { abbySyncStatus: "SYNCED", abbyId: result.abbyId }
        : { abbySyncStatus: "ERROR" },
    },
  );
}

/**
 * Facture encaissée → livre des recettes Abby si :
 * - Abby est connecté pour cette org et autoSync.invoices est activé
 * - La facture n'a pas déjà été enregistrée
 * - Le statut est COMPLETED (payée)
 */
export async function syncInvoiceIfNeeded(invoice, workspaceId) {
  try {
    if (!invoice || !workspaceId) return;
    if (invoice.status !== "COMPLETED") return;
    if (invoice.abbySyncStatus === "SYNCED") return;

    const account = await findConnectedAccount(workspaceId, "invoices");
    if (!account) return;

    const label = `${invoice.prefix || ""}${invoice.number || invoice._id}`;
    logger.info(`[ABBY] Auto-sync facture ${label} (livre des recettes)...`);

    const result = await abbyService.syncCustomerInvoice(
      account.getDecryptedApiKey(),
      invoice,
      { productType: account.incomeProductType },
    );

    const Invoice = (await import("../models/Invoice.js")).default;
    await markSynced(Invoice, invoice._id, result);

    if (result.success) {
      account.stats.invoicesSynced += 1;
      account.lastSyncAt = new Date();
      await account.save();
      logger.info(`[ABBY] Auto-sync facture ${label} → OK`);
    } else {
      logger.warn(
        `[ABBY] Auto-sync facture ${label} → ERREUR: ${result.message}`,
      );
    }
  } catch (error) {
    logger.error(`[ABBY] Erreur auto-sync facture: ${error.message}`);
  }
}

/**
 * Facture d'achat payée → livre des achats Abby
 */
export async function syncPurchaseInvoiceIfNeeded(
  purchaseInvoice,
  workspaceId,
) {
  try {
    if (!purchaseInvoice || !workspaceId) return;
    if (purchaseInvoice.status !== "PAID") return;
    if (purchaseInvoice.abbySyncStatus === "SYNCED") return;

    const account = await findConnectedAccount(workspaceId, "supplierInvoices");
    if (!account) return;

    const label = purchaseInvoice.invoiceNumber || purchaseInvoice._id;
    logger.info(
      `[ABBY] Auto-sync facture d'achat ${label} (livre des achats)...`,
    );

    const result = await abbyService.syncPurchaseInvoice(
      account.getDecryptedApiKey(),
      purchaseInvoice,
    );

    const PurchaseInvoice = (await import("../models/PurchaseInvoice.js"))
      .default;
    await markSynced(PurchaseInvoice, purchaseInvoice._id, result);

    if (result.success) {
      account.stats.expensesSynced += 1;
      account.lastSyncAt = new Date();
      await account.save();
      logger.info(`[ABBY] Auto-sync facture d'achat ${label} → OK`);
    } else {
      logger.warn(
        `[ABBY] Auto-sync facture d'achat ${label} → ERREUR: ${result.message}`,
      );
    }
  } catch (error) {
    logger.error(`[ABBY] Erreur auto-sync facture d'achat: ${error.message}`);
  }
}
