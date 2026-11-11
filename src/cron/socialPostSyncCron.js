import cron from "node-cron";
import { syncDueSocialPosts } from "../services/social/socialPostSync.js";
import { isZernioConfigured } from "../services/social/providers/zernioProvider.js";
import logger from "../utils/logger.js";

/**
 * Cron de suivi des posts programmés sur les réseaux sociaux (statut de
 * publication, adresse du post, notification de l'auteur). Réservé à
 * l'instance PM2 #0 comme les autres crons (server.js) ; arrêté par
 * gracefulShutdown avec les autres tâches node-cron.
 *
 * SOCIAL_POST_SYNC_CRON : défaut toutes les 2 minutes.
 */

let task = null;
// Garde anti-chevauchement : un tour lent n'est jamais doublé par le suivant
let running = false;

export async function runSocialPostSync() {
  if (running) {
    logger.debug("[SOCIAL-POST-SYNC] tour précédent encore en cours, ignoré");
    return null;
  }
  running = true;
  try {
    const stats = await syncDueSocialPosts();
    if (stats.due > 0) {
      logger.info(
        `[SOCIAL-POST-SYNC] ${stats.synced} post(s) synchronisé(s), ${stats.errors} en erreur, sur ${stats.due}`,
      );
    }
    return stats;
  } catch (error) {
    logger.error("[SOCIAL-POST-SYNC] erreur cron:", error);
    return null;
  } finally {
    running = false;
  }
}

export function startSocialPostSyncCron() {
  if (!isZernioConfigured()) {
    logger.info(
      "⏭️ [SOCIAL-POST-SYNC] ZERNIO_API_KEY absente, suivi des posts désactivé",
    );
    return null;
  }
  const cronExpression = process.env.SOCIAL_POST_SYNC_CRON || "*/2 * * * *";
  task = cron.schedule(cronExpression, runSocialPostSync, {
    scheduled: true,
    timezone: "Europe/Paris",
  });
  logger.info(
    `🕐 [SOCIAL-POST-SYNC] Cron de suivi des posts programmés configuré (${cronExpression})`,
  );
  return task;
}

export function stopSocialPostSyncCron() {
  if (task) {
    task.stop();
    task = null;
  }
}
