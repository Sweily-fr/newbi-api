import cron from "node-cron";
import { refreshExpiringTokens } from "../services/social/socialAccountCredentials.js";
import { publishDueDirectTargets } from "../services/social/socialDirectPublisher.js";
import { isAnyDirectNetworkReady } from "../services/social/socialProviders.js";
import { maintainSocialVideos } from "../services/social/socialVideoProcessing.js";
import logger from "../utils/logger.js";

/**
 * Cron de publication des posts réseaux sociaux par nos propres applis
 * (cibles « direct ») : publie les cibles dont l'heure est passée, suit les
 * publications en deux temps (TikTok, vidéos), rattrape les statuts, et
 * rafraîchit à l'avance les jetons Instagram. Reprend aussi les
 * préparations de vidéos interrompues et annule les envois de vidéos
 * abandonnés. Réservé à l'instance PM2 #0 comme les autres crons
 * (server.js) ; chaque cible et chaque vidéo sont de toute façon réservées
 * par un bail.
 *
 * SOCIAL_DIRECT_PUBLISH_CRON : défaut chaque minute.
 */

let task = null;
// Garde anti-chevauchement : un tour lent n'est jamais doublé par le suivant
let running = false;

export async function runSocialDirectPublish({ now = new Date() } = {}) {
  if (running) {
    logger.debug("[SOCIAL-DIRECT] tour précédent encore en cours, ignoré");
    return null;
  }
  running = true;
  try {
    // Vidéos : préparations reprises en arrière-plan (non attendues)
    const videos = await maintainSocialVideos({ now }).catch((error) => {
      logger.error("[SOCIAL-DIRECT] maintenance des vidéos:", error);
      return null;
    });
    if (videos && (videos.resumed || videos.failed || videos.abandoned)) {
      logger.info(
        `[SOCIAL-DIRECT] Vidéos : ${videos.resumed} préparation(s) reprise(s), ${videos.failed} en échec, ${videos.abandoned} envoi(s) abandonné(s)`,
      );
    }
    const stats = await publishDueDirectTargets({ now });
    if (stats.posts > 0) {
      logger.info(
        `[SOCIAL-DIRECT] ${stats.posts} post(s) traité(s) : ${stats.published} publication(s), ${stats.failed} échec(s), ${stats.retried} nouvel(s) essai(s) prévu(s)`,
      );
    }
    await refreshExpiringTokens({ now });
    return stats;
  } catch (error) {
    logger.error("[SOCIAL-DIRECT] erreur cron:", error);
    return null;
  } finally {
    running = false;
  }
}

export function startSocialDirectPublishCron() {
  if (!isAnyDirectNetworkReady()) {
    logger.info(
      "⏭️ [SOCIAL-DIRECT] aucune appli de réseau configurée, publication directe désactivée",
    );
    return null;
  }
  const cronExpression = process.env.SOCIAL_DIRECT_PUBLISH_CRON || "* * * * *";
  task = cron.schedule(cronExpression, () => runSocialDirectPublish(), {
    scheduled: true,
    timezone: "Europe/Paris",
  });
  logger.info(
    `🕐 [SOCIAL-DIRECT] Cron de publication directe configuré (${cronExpression})`,
  );
  return task;
}

export function stopSocialDirectPublishCron() {
  if (task) {
    task.stop();
    task = null;
  }
}
