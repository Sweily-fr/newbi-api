/**
 * Campagnes e-mail (voir services/emailCampaigns/campaignService.js) :
 * chaque minute, lance les campagnes programmées arrivées à échéance puis
 * envoie les lots des campagnes en cours (plafond par minute, 1,2 s entre
 * deux appels à Resend).
 *
 * Toutes les 10 minutes : domaines d'envoi connectés par les espaces (voir
 * services/emailCampaigns/sendingDomains.js) relus chez Resend, retirés au
 * bout de 7 jours sans validation.
 *
 * Câblé dans server.js derrière le garde `instanceId === 0` (une seule
 * instance PM2) ; chaque campagne est de toute façon verrouillée le temps
 * de son lot.
 */
import cron from "node-cron";
import logger from "../utils/logger.js";
import { runEmailCampaignTick } from "../services/emailCampaigns/campaignService.js";
import { refreshSendingDomains } from "../services/emailCampaigns/sendingDomains.js";

export const EMAIL_CAMPAIGN_CRON = "* * * * *";
export const EMAIL_SENDING_DOMAIN_CRON = "*/10 * * * *";

/** Tâche sans chevauchement : un passage peut durer (lots, appels espacés). */
function exclusive(name, run) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } catch (error) {
      logger.error(`[emailCampaignCron] ${name} : ${error.message}`);
    } finally {
      running = false;
    }
  };
}

export function startEmailCampaignCron() {
  const task = cron.schedule(
    EMAIL_CAMPAIGN_CRON,
    exclusive("envoi", () => runEmailCampaignTick()),
    { scheduled: true, timezone: "Europe/Paris" },
  );
  const domainsTask = cron.schedule(
    EMAIL_SENDING_DOMAIN_CRON,
    exclusive("domaines d'envoi", () => refreshSendingDomains()),
    { scheduled: true, timezone: "Europe/Paris" },
  );
  logger.info(
    "[emailCampaignCron] envoi des campagnes e-mail planifié chaque minute, domaines d'envoi toutes les 10 minutes",
  );
  return { task, domainsTask };
}
