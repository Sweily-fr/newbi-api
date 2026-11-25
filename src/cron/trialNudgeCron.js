/**
 * Relances de l'essai gratuit. Le mode (off / simulation / live) se règle
 * dans newbi-admin et se relit à chaque passage : rien à redémarrer.
 *
 * Toutes les 10 minutes, tous les jours :
 *   - bienvenue des essais sans carte (sous ENABLE_APP_TRIAL) ;
 *   - inscriptions à finaliser (entreprise, offre ou carte).
 * Aucune relance pour les essais avec carte (décision du 25/11/2026).
 * Du lundi au vendredi à 10:00 Europe/Paris (sous ENABLE_APP_TRIAL) : J+7
 * inactif et J+14 suggestions des essais sans carte.
 * La relance de fin d'essai sans carte part avec l'expiration
 * (trialCleanupCron).
 *
 * Câblé dans server.js derrière le garde `instanceId === 0` (une seule
 * instance PM2). Depuis le 18/11/2026, seules les relances des essais sans
 * carte dépendent d'ENABLE_APP_TRIAL.
 */
import cron from "node-cron";
import logger from "../utils/logger.js";
import { isAppTrialEnabled } from "../utils/featureFlags.js";
import {
  DAILY_RUN_HOUR,
  SIGNUP_STEP,
  runTrialNudges,
} from "../services/trialNudgeService.js";

export function startTrialNudgeCron() {
  const appTrial = isAppTrialEnabled();
  cron.schedule(
    "*/10 * * * *",
    async () => {
      if (appTrial) {
        try {
          await runTrialNudges({ steps: ["welcome"] });
        } catch (error) {
          logger.error(`[trialNudgeCron] bienvenue, erreur : ${error.message}`);
        }
      }
      try {
        await runTrialNudges({ steps: [SIGNUP_STEP] });
      } catch (error) {
        logger.error(
          `[trialNudgeCron] inscriptions à finaliser, erreur : ${error.message}`,
        );
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );
  if (!appTrial) {
    logger.info(
      "[trialNudgeCron] ENABLE_APP_TRIAL est OFF : relances des essais sans carte non planifiées (inscriptions à finaliser toutes les 10 min)",
    );
    return null;
  }
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
    `[trialNudgeCron] planifié du lundi au vendredi à ${DAILY_RUN_HOUR}:00 Europe/Paris (bienvenue et inscriptions à finaliser toutes les 10 min)`,
  );
  return task;
}
