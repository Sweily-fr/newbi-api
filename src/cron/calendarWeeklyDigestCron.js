/**
 * Récap du lundi par e-mail (voir services/calendar/weeklyDigestService.js).
 *
 * Lundi à 8 h Europe/Paris, puis un passage par heure jusqu'à 11 h pour
 * rattraper un envoi manqué (redémarrage, mise en production) : le journal
 * des envois empêche tout doublon. Câblé dans server.js derrière le garde
 * `instanceId === 0` (une seule instance PM2), et seulement si
 * CALENDAR_WEEKLY_DIGEST_MODE vaut « simulation » ou « live » : absent
 * (postes de dev, staging), rien n'est planifié.
 */
import cron from "node-cron";
import logger from "../utils/logger.js";
import {
  digestMode,
  runWeeklyDigest,
} from "../services/calendar/weeklyDigestService.js";

export const WEEKLY_DIGEST_CRON = "0 8-11 * * 1";

let running = false;

export function startCalendarWeeklyDigestCron() {
  const mode = digestMode();
  if (mode === "off") {
    logger.info(
      "[calendarDigestCron] CALENDAR_WEEKLY_DIGEST_MODE absent ou « off » : récap du lundi non planifié",
    );
    return null;
  }
  const task = cron.schedule(
    WEEKLY_DIGEST_CRON,
    async () => {
      // Un passage peut durer (envois espacés) : pas de chevauchement
      if (running) return;
      running = true;
      try {
        await runWeeklyDigest();
      } catch (error) {
        logger.error(`[calendarDigestCron] erreur : ${error.message}`);
      } finally {
        running = false;
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );
  logger.info(
    `[calendarDigestCron] récap du lundi planifié à 8 h Europe/Paris, rattrapage jusqu'à 11 h (mode ${mode})`,
  );
  return task;
}
