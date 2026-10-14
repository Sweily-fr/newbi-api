/**
 * Relances de l'essai gratuit (J+7 inactif, J+14 suggestions), tous les
 * jours à 10:00 Europe/Paris. Le mode (off / simulation / live) se règle
 * dans newbi-admin et se relit à chaque passage : rien à redémarrer.
 *
 * Câblé dans server.js derrière le garde `instanceId === 0` (une seule
 * instance PM2) et derrière ENABLE_APP_TRIAL, comme trialCleanupCron.
 * La relance de fin d'essai part avec l'expiration (trialCleanupCron).
 */
import cron from "node-cron";
import logger from "../utils/logger.js";
import { isAppTrialEnabled } from "../utils/featureFlags.js";
import { runTrialNudges } from "../services/trialNudgeService.js";

export function startTrialNudgeCron() {
  if (!isAppTrialEnabled()) {
    logger.info("[trialNudgeCron] ENABLE_APP_TRIAL est OFF, cron non planifié");
    return null;
  }
  const task = cron.schedule(
    "0 10 * * *",
    async () => {
      try {
        await runTrialNudges();
      } catch (error) {
        logger.error(`[trialNudgeCron] erreur : ${error.message}`);
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );
  logger.info("[trialNudgeCron] planifié tous les jours à 10:00 Europe/Paris");
  return task;
}
