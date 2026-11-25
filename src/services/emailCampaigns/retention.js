/**
 * Durée de conservation du suivi des campagnes e-mail (recommandation CNIL
 * sur les pixels de suivi) : passé 13 mois après le lancement, le détail
 * par destinataire (dates et nombres d'ouvertures et de clics, chaque clic)
 * est effacé. Restent les totaux de la campagne (`stats`) et, par lien, les
 * clics et clics uniques (`linkStats`). Le pixel et les liens suivis
 * n'enregistrent plus rien pour ces destinataires (`trackingExpired`).
 *
 * Reprise sans perte après un arrêt : les totaux par lien sont écrits une
 * seule fois, avant tout effacement ; l'effacement se rejoue sans dommage ;
 * la campagne n'est marquée (`trackingPurgedAt`) qu'à la fin.
 *
 * Durée remplaçable sans release : EMAIL_CAMPAIGN_TRACKING_RETENTION_MONTHS.
 */
import EmailCampaign from "../../models/EmailCampaign.js";
import EmailCampaignClick from "../../models/EmailCampaignClick.js";
import EmailCampaignRecipient from "../../models/EmailCampaignRecipient.js";
import logger from "../../utils/logger.js";

export const DEFAULT_TRACKING_RETENTION_MONTHS = 13;
const CAMPAIGNS_PER_RUN = 20;

/** Durée de conservation en mois (variable d'environnement, sinon 13). */
export function trackingRetentionMonths() {
  const value = Number(process.env.EMAIL_CAMPAIGN_TRACKING_RETENTION_MONTHS);
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_TRACKING_RETENTION_MONTHS;
}

/** Campagnes lancées avant cette date : suivi à effacer. */
export function trackingRetentionCutoff(
  now = new Date(),
  months = trackingRetentionMonths(),
) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff;
}

/** Clics et clics uniques par lien, dans l'ordre de `links`. */
export async function aggregateLinkStats(campaignId, linkCount) {
  const rows = await EmailCampaignClick.aggregate([
    { $match: { campaignId } },
    {
      $group: {
        _id: { link: "$linkIndex", recipient: "$recipientId" },
        clicks: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: "$_id.link",
        clicks: { $sum: "$clicks" },
        uniqueClicks: { $sum: 1 },
      },
    },
  ]);
  const byIndex = new Map(rows.map((row) => [row._id, row]));
  return Array.from({ length: linkCount }, (_, index) => ({
    clicks: byIndex.get(index)?.clicks || 0,
    uniqueClicks: byIndex.get(index)?.uniqueClicks || 0,
  }));
}

async function purgeCampaignTracking(campaign, now) {
  if (!Array.isArray(campaign.linkStats)) {
    const linkStats = await aggregateLinkStats(
      campaign._id,
      (campaign.links || []).length,
    );
    // Jamais réécrits : après un effacement partiel, ils seraient faux
    await EmailCampaign.updateOne(
      { _id: campaign._id, linkStats: { $exists: false } },
      { $set: { linkStats } },
    );
  }
  await EmailCampaignRecipient.updateMany(
    { campaignId: campaign._id, trackingExpired: { $ne: true } },
    {
      $set: {
        trackingExpired: true,
        openedAt: null,
        openCount: 0,
        clickedAt: null,
        clickCount: 0,
      },
    },
  );
  await EmailCampaignClick.deleteMany({ campaignId: campaign._id });
  await EmailCampaign.updateOne(
    { _id: campaign._id },
    { $set: { trackingPurgedAt: now } },
  );
}

/**
 * Efface le suivi des campagnes lancées avant la limite, les plus anciennes
 * d'abord, par paquets de 20 (1 000 au plus par passage). Une campagne en
 * échec n'arrête pas les autres ; elle est reprise au passage suivant.
 *
 * @returns {Promise<number>} campagnes effacées
 */
export async function purgeExpiredCampaignTracking({
  now = new Date(),
  maxRounds = 50,
} = {}) {
  const cutoff = trackingRetentionCutoff(now);
  const failed = [];
  let purged = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const campaigns = await EmailCampaign.find({
      _id: { $nin: failed },
      trackingPurgedAt: null,
      startedAt: { $ne: null, $lte: cutoff },
    })
      .select("_id links linkStats")
      .sort({ startedAt: 1 })
      .limit(CAMPAIGNS_PER_RUN)
      .lean();
    for (const campaign of campaigns) {
      try {
        await purgeCampaignTracking(campaign, now);
        purged += 1;
      } catch (error) {
        failed.push(campaign._id);
        logger.error(
          `[campagnes] suivi de la campagne ${campaign._id} non effacé : ${error.message}`,
        );
      }
    }
    if (campaigns.length < CAMPAIGNS_PER_RUN) break;
  }
  if (purged) {
    logger.info(
      `[campagnes] suivi effacé après ${trackingRetentionMonths()} mois : ${purged} campagne(s)`,
    );
  }
  return purged;
}
