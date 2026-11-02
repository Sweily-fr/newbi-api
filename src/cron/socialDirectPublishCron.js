import cron from "node-cron";
import { refreshExpiringTokens } from "../services/social/socialAccountCredentials.js";
import { refreshAccountProfiles } from "../services/social/socialAccountProfiles.js";
import { publishDueDirectTargets } from "../services/social/socialDirectPublisher.js";
import {
  purgeDeletedPostsMedia,
  purgeOrphanMedia,
  scheduleForgottenPostsPurge,
} from "../services/social/socialMediaCleanup.js";
import storage from "../services/social/socialMediaStorage.js";
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
 * Stockage des images configuré : supprime aussi les images et vidéos des
 * posts supprimés (à chaque tour), et une fois par heure les médias jamais
 * utilisés depuis 7 jours. Une fois par heure : nom et photo des comptes
 * relus au-delà de 28 jours.
 *
 * SOCIAL_DIRECT_PUBLISH_CRON : défaut chaque minute.
 */

let task = null;
// Garde anti-chevauchement : un tour lent n'est jamais doublé par le suivant
let running = false;
// Tâches peu pressées (profils des comptes, médias orphelins) : une fois
// par heure au plus
const HOURLY_MS = 60 * 60 * 1000;
let lastHourlyAt = null;

const isHourlyDue = (now) =>
  lastHourlyAt === null || now.getTime() - lastHourlyAt >= HOURLY_MS;

async function cleanupMedia(now, hourly) {
  if (hourly) {
    const forgotten = await scheduleForgottenPostsPurge({ now });
    if (forgotten > 0) {
      logger.info(
        `[SOCIAL-DIRECT] ${forgotten} post(s) supprimé(s) sans nettoyage prévu, médias à supprimer`,
      );
    }
  }
  const posts = await purgeDeletedPostsMedia({ now });
  if (posts.purged || posts.failed) {
    logger.info(
      `[SOCIAL-DIRECT] Médias des posts supprimés : ${posts.purged} post(s) nettoyé(s), ${posts.deferred} reporté(s), ${posts.failed} en échec`,
    );
  }
  if (!hourly) return;
  const orphans = await purgeOrphanMedia({ now });
  if (orphans.deleted || orphans.failed) {
    logger.info(
      `[SOCIAL-DIRECT] Médias jamais utilisés : ${orphans.deleted} supprimé(s), ${orphans.failed} en échec`,
    );
  }
}

export async function runSocialDirectPublish({ now = new Date() } = {}) {
  if (running) {
    logger.debug("[SOCIAL-DIRECT] tour précédent encore en cours, ignoré");
    return null;
  }
  running = true;
  try {
    const hourly = isHourlyDue(now);
    if (hourly) lastHourlyAt = now.getTime();
    let stats = { posts: 0, published: 0, failed: 0, retried: 0 };
    const direct = isAnyDirectNetworkReady();
    if (direct) {
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
      stats = await publishDueDirectTargets({ now });
      if (stats.posts > 0) {
        logger.info(
          `[SOCIAL-DIRECT] ${stats.posts} post(s) traité(s) : ${stats.published} publication(s), ${stats.failed} échec(s), ${stats.retried} nouvel(s) essai(s) prévu(s)`,
        );
      }
      await refreshExpiringTokens({ now });
    }
    if (storage.isConfigured()) {
      await cleanupMedia(now, hourly).catch((error) =>
        logger.error("[SOCIAL-DIRECT] nettoyage des médias:", error),
      );
    }
    if (direct && hourly) {
      const profiles = await refreshAccountProfiles({ now }).catch((error) => {
        logger.error("[SOCIAL-DIRECT] relecture des profils:", error);
        return null;
      });
      if (profiles && (profiles.refreshed || profiles.failed)) {
        logger.info(
          `[SOCIAL-DIRECT] Profils des comptes : ${profiles.refreshed} relu(s), ${profiles.failed} en échec`,
        );
      }
    }
    return stats;
  } catch (error) {
    logger.error("[SOCIAL-DIRECT] erreur cron:", error);
    return null;
  } finally {
    running = false;
  }
}

export function startSocialDirectPublishCron() {
  if (!isAnyDirectNetworkReady() && !storage.isConfigured()) {
    logger.info(
      "⏭️ [SOCIAL-DIRECT] aucune appli de réseau ni stockage des images configurés, publication directe désactivée",
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
