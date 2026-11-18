/**
 * Quota mensuel des campagnes e-mail par offre (anti-abus, coût d'envoi) :
 * e-mails par mois civil, heure de Paris.
 *
 *   essai sans abonnement (trial) 100, Freelance 500, TPE (pme) 2 500,
 *   Entreprise 10 000
 *
 * EMAIL_CAMPAIGN_MONTHLY_QUOTAS (JSON, ex. {"pme":3000}) remplace tout ou
 * partie de ces valeurs sans nouvelle version.
 *
 * Consommation du mois = destinataires envoyés ce mois-ci (réels ou simulés,
 * quel que soit leur sort ensuite) + destinataires encore en attente dans
 * une campagne lancée : deux lancements rapprochés ne peuvent pas dépasser
 * le quota à eux deux. Les e-mails de test ne comptent pas.
 */
import EmailCampaignRecipient from "../../models/EmailCampaignRecipient.js";
import {
  getLiveSubscriptionPlan,
  parisMonthBounds,
} from "../esignatureQuota.js";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import logger from "../../utils/logger.js";

export const DEFAULT_MONTHLY_QUOTAS = Object.freeze({
  trial: 100,
  freelance: 500,
  pme: 2500,
  entreprise: 10000,
});

let warnedQuotaEnv = null;

export function monthlyQuotas(env = process.env) {
  const raw = env.EMAIL_CAMPAIGN_MONTHLY_QUOTAS;
  if (!raw) return { ...DEFAULT_MONTHLY_QUOTAS };
  try {
    const parsed = JSON.parse(raw);
    const quotas = { ...DEFAULT_MONTHLY_QUOTAS };
    for (const plan of Object.keys(DEFAULT_MONTHLY_QUOTAS)) {
      const value = Number(parsed?.[plan]);
      if (Number.isInteger(value) && value >= 0) quotas[plan] = value;
    }
    return quotas;
  } catch {
    if (warnedQuotaEnv !== raw) {
      warnedQuotaEnv = raw;
      logger.warn(
        "[campagnes] EMAIL_CAMPAIGN_MONTHLY_QUOTAS illisible (JSON attendu) : quotas par défaut",
      );
    }
    return { ...DEFAULT_MONTHLY_QUOTAS };
  }
}

/** Offre qui fixe le quota : celle de l'abonnement, « trial » sans abonnement. */
export async function getCampaignPlan(workspaceId) {
  const plan = await getLiveSubscriptionPlan(workspaceId);
  if (plan === null) return "trial";
  // Abonnement à l'offre inconnue ou absente : offre d'entrée
  return Object.hasOwn(DEFAULT_MONTHLY_QUOTAS, plan) && plan !== "trial"
    ? plan
    : "freelance";
}

/**
 * @returns {Promise<{ plan: string, monthlyLimit: number,
 *   usedThisMonth: number, remaining: number, sent: number, pending: number }>}
 */
export async function getCampaignQuota(workspaceId, now = new Date()) {
  const plan = await getCampaignPlan(workspaceId);
  const monthlyLimit = monthlyQuotas()[plan];
  const id = toObjectIdOrNull(String(workspaceId));
  if (!id) {
    return {
      plan,
      monthlyLimit,
      usedThisMonth: 0,
      remaining: monthlyLimit,
      sent: 0,
      pending: 0,
    };
  }
  const { start, end } = parisMonthBounds(now);
  const [sent, pending] = await Promise.all([
    EmailCampaignRecipient.countDocuments({
      workspaceId: id,
      sentAt: { $gte: start, $lt: end },
    }),
    EmailCampaignRecipient.countDocuments({
      workspaceId: id,
      status: "PENDING",
    }),
  ]);
  const usedThisMonth = sent + pending;
  return {
    plan,
    monthlyLimit,
    usedThisMonth,
    remaining: Math.max(0, monthlyLimit - usedThisMonth),
    sent,
    pending,
  };
}
