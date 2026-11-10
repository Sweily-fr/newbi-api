import mongoose from "mongoose";
import ProspectCreditUsage from "../../models/ProspectCreditUsage.js";
import { parisMonthBounds } from "../esignatureQuota.js";
import { AppError, ERROR_CODES } from "../../utils/errors.js";

/**
 * Prospects offerts par plan.
 * - Freelance : 10 une seule fois (cadeau de bienvenue), pas de quota mensuel.
 * - TPE (« pme ») : 20 par mois. Entreprise : 50 par mois.
 * Rien pendant l'essai : seul un abonnement payé ouvre le quota, pour qu'on
 * ne puisse pas enchaîner les comptes d'essai pour récupérer des prospects.
 * Le quota mensuel repart à zéro le 1er (heure de Paris), sans report.
 */
export const PROSPECT_QUOTAS = {
  freelance: { bucket: "welcome", amount: 10 },
  pme: { bucket: "monthly", amount: 20 },
  entreprise: { bucket: "monthly", amount: 50 },
};

// Statuts d'un abonnement réellement payé (« trialing » exclu)
const PAID_STATUSES = ["active", "past_due"];

/** Plafond de crédits Societeinfo consommés par Newbi sur le mois, tous espaces. */
export function monthlyCreditCap() {
  const cap = Number(process.env.PROSPECT_MONTHLY_CREDIT_CAP);
  return Number.isFinite(cap) && cap > 0 ? cap : 1000;
}

/** Pages de recherche par espace et par jour (chaque page coûte 1 crédit à Newbi). */
export function dailySearchLimit() {
  const limit = Number(process.env.PROSPECT_DAILY_SEARCH_LIMIT);
  return Number.isFinite(limit) && limit > 0 ? limit : 20;
}

/**
 * Plan de l'abonnement payé de l'espace, ou null (essai, pas d'abonnement,
 * abonnement terminé).
 */
export async function getPaidPlan(workspaceId) {
  const db = mongoose.connection.db;
  if (!db || !workspaceId) return null;

  const id = String(workspaceId);
  const refs = [{ referenceId: id }, { organizationId: id }];
  if (mongoose.Types.ObjectId.isValid(id)) {
    const oid = new mongoose.Types.ObjectId(id);
    refs.push({ referenceId: oid }, { organizationId: oid });
  }
  const subscriptions = await db
    .collection("subscription")
    .find({ $or: refs }, { projection: { plan: 1, status: 1, periodEnd: 1 } })
    .toArray();

  const now = new Date();
  const paid =
    subscriptions.find((s) => PAID_STATUSES.includes(s.status)) ||
    // Résilié mais encore dans la période payée : le plan reste acquis
    subscriptions.find(
      (s) =>
        s.status === "canceled" && s.periodEnd && new Date(s.periodEnd) > now,
    );
  const plan = paid?.plan?.toLowerCase();
  return plan in PROSPECT_QUOTAS ? plan : null;
}

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

export async function getProspectQuota(workspaceId, now = new Date()) {
  const plan = await getPaidPlan(workspaceId);
  const { start, end } = parisMonthBounds(now);
  if (!plan) {
    return {
      plan: null,
      bucket: null,
      quota: 0,
      used: 0,
      remaining: 0,
      resetsAt: null,
    };
  }

  const { bucket, amount } = PROSPECT_QUOTAS[plan];
  const used = await ProspectCreditUsage.countDocuments({
    workspaceId: toObjectId(workspaceId),
    kind: "unlock",
    bucket,
    ...(bucket === "monthly" ? { createdAt: { $gte: start, $lt: end } } : {}),
  });
  return {
    plan,
    bucket,
    quota: amount,
    used,
    remaining: Math.max(0, amount - used),
    resetsAt: bucket === "monthly" ? end : null,
  };
}

/** Crédits consommés par Newbi ce mois-ci, tous espaces confondus. */
export async function getMonthlyCreditsUsed(now = new Date()) {
  const { start, end } = parisMonthBounds(now);
  const [row] = await ProspectCreditUsage.aggregate([
    { $match: { createdAt: { $gte: start, $lt: end } } },
    { $group: { _id: null, credits: { $sum: "$credits" } } },
  ]);
  return row?.credits || 0;
}

/** Refuse toute dépense qui ferait dépasser le budget mensuel de Newbi. */
export async function assertGlobalBudget(creditsNeeded) {
  const used = await getMonthlyCreditsUsed();
  if (used + creditsNeeded > monthlyCreditCap()) {
    throw new AppError(
      "La génération de prospects est momentanément indisponible. Réessayez le mois prochain ou contactez le support.",
      ERROR_CODES.VALIDATION_ERROR,
      { reason: "GLOBAL_BUDGET_REACHED" },
    );
  }
}

/** Limite les pages de recherche par espace sur 24 h glissantes. */
export async function assertSearchAllowed(workspaceId) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await ProspectCreditUsage.countDocuments({
    workspaceId: toObjectId(workspaceId),
    kind: "search",
    createdAt: { $gte: since },
  });
  if (count >= dailySearchLimit()) {
    throw new AppError(
      `Vous avez fait ${dailySearchLimit()} recherches de prospects en 24 h. Réessayez demain.`,
      ERROR_CODES.VALIDATION_ERROR,
      { reason: "DAILY_SEARCH_LIMIT" },
    );
  }
}
