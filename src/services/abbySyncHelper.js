import AbbyAccount from "../models/AbbyAccount.js";
import abbyService from "./abbyService.js";
import logger from "../utils/logger.js";

/**
 * Helper fire-and-forget pour la sync automatique Abby.
 * Même contrat que qontoSyncHelper : appelé après les changements de statut
 * dans les resolvers, ne lève jamais (loggue et échoue silencieusement).
 *
 * Une facture n'est enregistrée dans Abby (livre des recettes) qu'une fois
 * encaissée (COMPLETED) ; un devis est créé dans Abby dès son envoi (PENDING)
 * et signé quand il est accepté (COMPLETED).
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
 * Devis envoyé ou accepté → devis Abby. Un devis déjà créé dans Abby qui
 * devient accepté dans Newbi est marqué signé dans Abby.
 */
export async function syncQuoteIfNeeded(quote, workspaceId) {
  try {
    if (!quote || !workspaceId) return;
    if (!["PENDING", "COMPLETED"].includes(quote.status)) return;

    const account = await findConnectedAccount(workspaceId, "quotes");
    if (!account) return;

    const label = `${quote.prefix || ""}${quote.number || quote._id}`;
    const apiKey = account.getDecryptedApiKey();

    if (quote.abbySyncStatus === "SYNCED") {
      if (quote.status === "COMPLETED" && quote.abbyId) {
        const signed = await abbyService.signEstimate(apiKey, quote.abbyId);
        logger.info(
          `[ABBY] Devis ${label} accepté → signature Abby ${signed.success ? "OK" : `refusée: ${signed.message}`}`,
        );
      }
      return;
    }

    logger.info(`[ABBY] Auto-sync devis ${label} (status=${quote.status})...`);
    const result = await abbyService.syncQuote(apiKey, quote);

    const Quote = (await import("../models/Quote.js")).default;
    await markSynced(Quote, quote._id, result);

    if (result.success) {
      account.stats.quotesSynced += 1;
      account.lastSyncAt = new Date();
      await account.save();
      logger.info(`[ABBY] Auto-sync devis ${label} → OK`);
    } else {
      logger.warn(
        `[ABBY] Auto-sync devis ${label} → ERREUR: ${result.message}`,
      );
    }
  } catch (error) {
    logger.error(`[ABBY] Erreur auto-sync devis: ${error.message}`);
  }
}
