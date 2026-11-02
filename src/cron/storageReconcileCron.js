/**
 * Réconciliation du compteur de stockage : toutes les 30 minutes, recalcule
 * les espaces dont le compteur est marqué périmé (suppression de taille
 * inconnue) ou date de plus de 24 h. Léger : 50 espaces au plus par passage.
 *
 * Câblé dans server.js derrière le garde `instanceId === 0` (une seule
 * instance PM2), comme les autres crons.
 */
import cron from "node-cron";
import logger from "../utils/logger.js";
import { reconcileWorkspaceStorage } from "../services/storage/storageService.js";

let running = false;

export async function runStorageReconcile() {
  if (running) return null;
  running = true;
  try {
    const result = await reconcileWorkspaceStorage({ limit: 50 });
    if (result.candidates > 0) {
      logger.info(
        `[storageReconcileCron] ${result.refreshed}/${result.candidates} espace(s) recalculé(s)`,
      );
    }
    return result;
  } catch (error) {
    logger.error(`[storageReconcileCron] erreur : ${error.message}`);
    return null;
  } finally {
    running = false;
  }
}

export function startStorageReconcileCron() {
  return cron.schedule("*/30 * * * *", runStorageReconcile, {
    scheduled: true,
    timezone: "Europe/Paris",
  });
}
