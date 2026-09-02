import cron from "node-cron";
import mongoose from "mongoose";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";
import { importAllFromQonto } from "../services/qontoImportService.js";
import logger from "../utils/logger.js";

/**
 * Cron d'import Qonto → Newbi (factures clients créées dans Qonto → factures
 * importées, factures fournisseurs déposées dans Qonto → factures d'achat).
 *
 * Qonto ne fournit des webhooks qu'aux applications OAuth : avec une clé API
 * on interroge l'API par curseur updated_at_from (voir qontoImportService).
 * Réservé à l'instance PM2 #0 comme les autres crons (server.js).
 */

let task = null;

async function resolveOwnerUserId(organizationId) {
  const memberCollection = EInvoicingSettingsService.getMemberCollection();
  // QontoAccount.organizationId est une string, la collection member stocke un ObjectId
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

async function syncAllQontoImports() {
  return importAllFromQonto(resolveOwnerUserId);
}

function startQontoImportCron() {
  const cronExpression = process.env.QONTO_IMPORT_CRON || "*/15 * * * *";

  task = cron.schedule(
    cronExpression,
    async () => {
      try {
        const { accounts, totalImported } = await syncAllQontoImports();
        if (totalImported > 0) {
          logger.info(
            `[QONTO-IMPORT] ${totalImported} document(s) importé(s) sur ${accounts} compte(s) Qonto`,
          );
        }
      } catch (error) {
        logger.error("[QONTO-IMPORT] erreur cron:", error);
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );

  logger.info(
    `🕐 [QONTO-IMPORT] Cron d'import Qonto → Newbi configuré (${cronExpression})`,
  );
  return task;
}

function stopQontoImportCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

export { startQontoImportCron, stopQontoImportCron, syncAllQontoImports };
