import cron from "node-cron";
import mongoose from "mongoose";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";
import { importAllFromAbby } from "../services/abbyImportService.js";
import logger from "../utils/logger.js";

/**
 * Cron d'import Abby → Newbi (factures et devis finalisés dans Abby →
 * factures / devis importés).
 *
 * Abby n'expose pas de webhooks documentés : on interroge l'API par polling
 * sur une fenêtre de dates d'émission (voir abbyImportService).
 * Réservé à l'instance PM2 #0 comme les autres crons (server.js).
 */

let task = null;

async function resolveOwnerUserId(organizationId) {
  const memberCollection = EInvoicingSettingsService.getMemberCollection();
  // AbbyAccount.organizationId est une string, la collection member stocke un ObjectId
  const orgId = mongoose.Types.ObjectId.isValid(organizationId)
    ? new mongoose.Types.ObjectId(String(organizationId))
    : organizationId;
  const member =
    (await memberCollection.findOne({
      organizationId: orgId,
      role: "owner",
    })) ||
    (await memberCollection.findOne({
      organizationId: orgId,
      role: "admin",
    })) ||
    (await memberCollection.findOne({ organizationId: orgId }));
  return member?.userId ? String(member.userId) : null;
}

async function syncAllAbbyImports() {
  return importAllFromAbby(resolveOwnerUserId);
}

function startAbbyImportCron() {
  const cronExpression = process.env.ABBY_IMPORT_CRON || "*/15 * * * *";

  task = cron.schedule(
    cronExpression,
    async () => {
      try {
        const { accounts, totalImported } = await syncAllAbbyImports();
        if (totalImported > 0) {
          logger.info(
            `[ABBY-IMPORT] ${totalImported} document(s) importé(s) sur ${accounts} compte(s) Abby`,
          );
        }
      } catch (error) {
        logger.error("[ABBY-IMPORT] erreur cron:", error);
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );

  logger.info(
    `🕐 [ABBY-IMPORT] Cron d'import Abby → Newbi configuré (${cronExpression})`,
  );
  return task;
}

function stopAbbyImportCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

export { startAbbyImportCron, stopAbbyImportCron, syncAllAbbyImports };
