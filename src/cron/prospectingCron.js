/**
 * Prospection (voir services/prospecting/sending.js) : chaque minute, au
 * plus un message par boîte d'envoi dont l'envoi suivant est dû (plage
 * horaire de Paris, jours fériés exclus, limite du jour, espacement de 3 à
 * 8 minutes).
 *
 * Câblé dans server.js derrière le garde `instanceId === 0` et
 * l'interrupteur CRONS_DISABLED, comme les autres crons ; chaque boîte est
 * de toute façon verrouillée le temps de son envoi.
 */
import cron from "node-cron";
import logger from "../utils/logger.js";
import { runProspectingTick } from "../services/prospecting/sending.js";

export const PROSPECTING_CRON = "* * * * *";

/** Tâche sans chevauchement : un passage peut durer (appels aux fournisseurs). */
function exclusive(run) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } catch (error) {
      logger.error(`[prospectingCron] envoi : ${error.message}`);
    } finally {
      running = false;
    }
  };
}

export function startProspectingCron() {
  const task = cron.schedule(
    PROSPECTING_CRON,
    exclusive(() => runProspectingTick()),
    { scheduled: true, timezone: "Europe/Paris" },
  );
  logger.info(
    "[prospectingCron] envoi des prospections planifié chaque minute",
  );
  return { task };
}
