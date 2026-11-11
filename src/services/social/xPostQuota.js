import mongoose from "mongoose";
import SocialPost from "../../models/SocialPost.js";
import { getWorkspacePlan, parisMonthBounds } from "../esignatureQuota.js";
import { userError } from "./socialPostMessages.js";

export const X_PLATFORM = "twitter";

/**
 * Posts X par mois et par offre. Chaque envoi à X est facturé à Sweily
 * (0,015 $, 0,20 $ si le texte contient un lien) : plafonds calculés pour
 * garder au moins 80 % de marge sur l'abonnement annuel HT même si tous les
 * posts ont un lien (Freelance 13,49 € HT, TPE 36,74 €, Entreprise 71,24 €,
 * en comptant 1 $ = 1 €).
 */
export const X_MONTHLY_POST_QUOTAS = {
  freelance: 10,
  pme: 30,
  entreprise: 60,
};

const toWorkspaceObjectId = (workspaceId) =>
  new mongoose.Types.ObjectId(String(workspaceId));

const sumOf = async (pipeline) => {
  const [row] = await SocialPost.aggregate([
    ...pipeline,
    { $group: { _id: null, n: { $sum: "$n" } } },
  ]);
  return row?.n || 0;
};

/**
 * Envois à X du mois (heure de Paris) : cibles X non annulées des posts
 * prévus dans le mois, publiés ou en échec compris, plus les nouveaux essais
 * faits dans le mois. `excludePostId` : post en cours de modification, dont
 * les cibles sont recomptées par l'appelant.
 */
export async function countXPostsInMonth(
  workspaceId,
  { start, end },
  { excludePostId = null } = {},
) {
  const wsId = toWorkspaceObjectId(workspaceId);
  const match = {
    workspaceId: wsId,
    status: { $ne: "cancelled" },
    scheduledFor: { $gte: start, $lt: end },
    "targets.platform": X_PLATFORM,
  };
  if (excludePostId) match._id = { $ne: excludePostId };

  const targets = await sumOf([
    { $match: match },
    {
      $project: {
        n: {
          $size: {
            $filter: {
              input: "$targets",
              as: "t",
              cond: {
                $and: [
                  { $eq: ["$$t.platform", X_PLATFORM] },
                  { $ne: ["$$t.status", "cancelled"] },
                ],
              },
            },
          },
        },
      },
    },
  ]);

  const retries = await sumOf([
    {
      $match: {
        workspaceId: wsId,
        xRetriedAt: { $elemMatch: { $gte: start, $lt: end } },
      },
    },
    {
      $project: {
        n: {
          $size: {
            $filter: {
              input: "$xRetriedAt",
              as: "d",
              cond: {
                $and: [{ $gte: ["$$d", start] }, { $lt: ["$$d", end] }],
              },
            },
          },
        },
      },
    },
  ]);

  return targets + retries;
}

/**
 * Limite et consommation du mois qui contient `at` (par défaut, le mois en
 * cours).
 */
export async function getXPostQuota(
  workspaceId,
  { at = new Date(), excludePostId = null } = {},
) {
  const plan = await getWorkspacePlan(workspaceId);
  const monthlyQuota =
    X_MONTHLY_POST_QUOTAS[plan] ?? X_MONTHLY_POST_QUOTAS.freelance;
  const bounds = parisMonthBounds(at);
  const used = await countXPostsInMonth(workspaceId, bounds, {
    excludePostId,
  });
  return {
    plan,
    monthlyQuota,
    used,
    remaining: Math.max(0, monthlyQuota - used),
    resetsAt: bounds.end,
  };
}

export const sameParisMonth = (a, b) =>
  parisMonthBounds(new Date(a)).start.getTime() ===
  parisMonthBounds(new Date(b)).start.getTime();

const monthLabel = (at, now) => {
  if (sameParisMonth(at, now)) return "ce mois-ci";
  const name = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    month: "long",
    year: "numeric",
  }).format(at);
  return `en ${name}`;
};

export const countXTargets = (items = []) =>
  items.filter(
    (item) => item?.platform === X_PLATFORM && item?.status !== "cancelled",
  ).length;

/**
 * Refuse un envoi à X au-delà de la limite du mois visé. `xCount` : envois
 * demandés (un par compte X). Sans compte X : aucune requête.
 */
export async function assertXPostQuota(
  workspaceId,
  { xCount, at, excludePostId = null, now = new Date() },
) {
  if (!xCount || xCount <= 0) return null;
  const quota = await getXPostQuota(workspaceId, { at, excludePostId });
  if (quota.used + xCount <= quota.monthlyQuota) return quota;

  const when = monthLabel(at, now);
  if (quota.remaining === 0) {
    throw userError(
      `Limite de posts X atteinte ${when} : ${quota.monthlyQuota} avec votre offre. ` +
        "Le compteur repart à zéro le 1er du mois suivant, ou passez à une offre supérieure pour en publier davantage.",
    );
  }
  throw userError(
    `Il reste ${quota.remaining} post${quota.remaining > 1 ? "s" : ""} X ${when} ` +
      `(${quota.monthlyQuota} avec votre offre), et ce post en demande ${xCount}.`,
  );
}
