/**
 * Campagnes e-mail (voir services/emailCampaigns/campaignService.js) :
 * chaque minute, lance les campagnes programmées arrivées à échéance puis
 * envoie les lots des campagnes en cours (plafond par minute, 1,2 s entre
 * deux appels à Resend).
 *
 * Câblé dans server.js derrière le garde `instanceId === 0` (une seule
 * instance PM2) ; chaque campagne est de toute façon verrouillée le temps
 * de son lot.
 */
import cron from "node-cron";
import logger from "../utils/logger.js";
import { runEmailCampaignTick } from "../services/emailCampaigns/campaignService.js";

export const EMAIL_CAMPAIGN_CRON = "* * * * *";

let running = false;

export function startEmailCampaignCron() {
  const task = cron.schedule(
    EMAIL_CAMPAIGN_CRON,
    async () => {
      // Un passage peut durer (lots espacés) : pas de chevauchement
      if (running) return;
      running = true;
      try {
        await runEmailCampaignTick();
      } catch (error) {
        logger.error(`[emailCampaignCron] erreur : ${error.message}`);
      } finally {
        running = false;
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );
  logger.info(
    "[emailCampaignCron] envoi des campagnes e-mail planifié chaque minute",
  );
  return task;
}
