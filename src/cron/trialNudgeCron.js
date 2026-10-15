/**
 * Relances de l'essai gratuit : J+7 inactif et J+14 suggestions du lundi au
 * vendredi à 10:00 Europe/Paris (un samedi ou un dimanche, le lundi), bienvenue
 * toutes les 10 minutes, tous les jours (elle doit arriver juste après
 * l'onboarding). Le mode (off / simulation / live) se
 * règle dans newbi-admin et se relit à chaque passage : rien à redémarrer.
 *
 * Câblé dans server.js derrière le garde `instanceId === 0` (une seule
 * instance PM2) et derrière ENABLE_APP_TRIAL, comme trialCleanupCron.
 * La relance de fin d'essai part avec l'expiration (trialCleanupCron).
 */
import cron from "node-cron";
import logger from "../utils/logger.js";
import { isAppTrialEnabled } from "../utils/featureFlags.js";
import {
  DAILY_RUN_HOUR,
  runTrialNudges,
} from "../services/trialNudgeService.js";

export function startTrialNudgeCron() {
  if (!isAppTrialEnabled()) {
    logger.info("[trialNudgeCron] ENABLE_APP_TRIAL est OFF, cron non planifié");
    return null;
  }
  cron.schedule(
    "*/10 * * * *",
    async () => {
      try {
        await runTrialNudges({ steps: ["welcome"] });
      } catch (error) {
        logger.error(`[trialNudgeCron] bienvenue, erreur : ${error.message}`);
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );
  const task = cron.schedule(
    `0 ${DAILY_RUN_HOUR} * * 1-5`,
    async () => {
      try {
        await runTrialNudges();
      } catch (error) {
        logger.error(`[trialNudgeCron] erreur : ${error.message}`);
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );
  logger.info(
    `[trialNudgeCron] planifié du lundi au vendredi à ${DAILY_RUN_HOUR}:00 Europe/Paris (bienvenue toutes les 10 min)`,
  );
  return task;
}
