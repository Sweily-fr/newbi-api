import cron from "node-cron";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";
import { importReceivedInvoices } from "../services/purchaseInvoiceReceptionService.js";
import logger from "../utils/logger.js";

/**
 * Cron d'import automatique des factures fournisseurs reçues via SuperPDP.
 *
 * Itère les organisations ayant activé l'e-invoicing, résout un utilisateur
 * propriétaire/admin (pour le champ createdBy requis), et importe les factures
 * entrantes (idempotent via superPdpInvoiceId).
 */

let task = null;

/**
 * Résoudre un utilisateur (owner > admin > premier membre) d'une organisation.
 */
async function resolveOwnerUserId(organizationId) {
  const memberCollection = EInvoicingSettingsService.getMemberCollection();
  const member =
    (await memberCollection.findOne({ organizationId, role: "owner" })) ||
    (await memberCollection.findOne({ organizationId, role: "admin" })) ||
    (await memberCollection.findOne({ organizationId }));
  return member?.userId ? String(member.userId) : null;
}

async function syncAllReceivedInvoices() {
  const orgCollection = EInvoicingSettingsService.getOrganizationCollection();
  const orgs = await orgCollection
    .find({ eInvoicingEnabled: true })
    .project({ _id: 1 })
    .toArray();

  let totalImported = 0;
  for (const org of orgs) {
    const workspaceId = String(org._id);
    try {
      const userId = await resolveOwnerUserId(org._id);
      if (!userId) {
        logger.warn(
          `[reception-sync] aucun utilisateur pour l'org ${workspaceId}, ignorée`,
        );
        continue;
      }
      const { imported, skipped, errors } = await importReceivedInvoices(
        workspaceId,
        userId,
      );
      totalImported += imported;
      if (imported > 0 || errors > 0) {
        logger.info(
          `[reception-sync] org ${workspaceId}: ${imported} importée(s), ${skipped} ignorée(s), ${errors} erreur(s)`,
        );
      }
    } catch (error) {
      logger.error(
        `[reception-sync] échec org ${workspaceId}: ${error.message}`,
      );
    }
  }
  return { orgs: orgs.length, totalImported };
}

function startPurchaseInvoiceReceptionCron() {
  const cronExpression = process.env.RECEPTION_SYNC_CRON || "0 * * * *";

  task = cron.schedule(
    cronExpression,
    async () => {
      try {
        const { orgs, totalImported } = await syncAllReceivedInvoices();
        if (totalImported > 0) {
          logger.info(
            `[reception-sync] ${totalImported} facture(s) importée(s) sur ${orgs} organisation(s)`,
          );
        }
      } catch (error) {
        logger.error("[reception-sync] erreur cron:", error);
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );

  logger.info(
    `🕐 [reception-sync] Cron d'import des factures reçues configuré (${cronExpression})`,
  );
  return task;
}

function stopPurchaseInvoiceReceptionCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

export {
  startPurchaseInvoiceReceptionCron,
  stopPurchaseInvoiceReceptionCron,
  syncAllReceivedInvoices,
};
