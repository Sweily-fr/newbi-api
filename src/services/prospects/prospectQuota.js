import mongoose from "mongoose";
import ProspectCreditUsage from "../../models/ProspectCreditUsage.js";
import ProspectCreditPurchase from "../../models/ProspectCreditPurchase.js";
import { parisMonthBounds } from "../esignatureQuota.js";
import { AppError, ERROR_CODES } from "../../utils/errors.js";
import { PLAN_LABELS, PLAN_ORDER } from "../storage/storageConfig.js";

/**
 * Crédits de prospection d'un espace. 1 crédit = 1 page de 25 entreprises
 * lue ou 1 prospect ajouté, le décompte même du fournisseur : le coût pour
 * Newbi ne dépasse jamais les crédits offerts plus les crédits vendus.
 *
 * - Standard (« freelance ») : rien, la génération commence à l'offre Premium.
 * - Premium (« pme ») : 30 crédits par mois ; pour plus, passer à Entreprise.
 * - Entreprise : 100 crédits par mois ; pour plus, crédits achetés à l'unité.
 * Rien pendant l'essai : seul un abonnement payé ouvre des crédits, pour
 * qu'on ne puisse pas enchaîner les comptes d'essai.
 * Les crédits du mois repartent le 1er (heure de Paris), sans report, et
 * passent avant les crédits achetés, qui n'expirent pas.
 */
export const PROSPECT_MONTHLY_CREDITS = {
  freelance: 0,
  pme: 30,
  entreprise: 100,
};

// Seule l'offre la plus haute achète des crédits : avant, on monte d'offre
export const PURCHASE_PLAN = "entreprise";

/** Offre au-dessus qui donne plus de crédits, null pour la plus haute. */
export function nextProspectPlan(plan) {
  const from = plan ? PLAN_ORDER.indexOf(plan) : -1;
  return (
    PLAN_ORDER.slice(from + 1).find(
      (p) =>
        PROSPECT_MONTHLY_CREDITS[p] > (PROSPECT_MONTHLY_CREDITS[plan] || 0),
    ) || null
  );
}

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
  return plan in PROSPECT_MONTHLY_CREDITS ? plan : null;
}

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * Solde de crédits de l'espace : offerts ce mois-ci (selon l'offre payée)
 * plus achetés et pas encore dépensés.
 */
export async function getProspectBalance(workspaceId, now = new Date()) {
  const plan = await getPaidPlan(workspaceId);
  const { start, end } = parisMonthBounds(now);
  const wid = toObjectId(workspaceId);

  const [usage, purchases] = await Promise.all([
    // Crédits du mois (tout sauf achetés) et crédits achetés déjà dépensés
    ProspectCreditUsage.aggregate([
      {
        $match: {
          workspaceId: wid,
          $or: [
            { source: "purchased" },
            { createdAt: { $gte: start, $lt: end } },
          ],
        },
      },
      {
        $group: {
          _id: {
            $cond: [{ $eq: ["$source", "purchased"] }, "purchased", "plan"],
          },
          credits: { $sum: "$credits" },
        },
      },
    ]),
    // Achats disponibles (« paid ») et commandés pas encore activés
    // (« pending » : en attente du stock du fournisseur, prospectOrders.js)
    ProspectCreditPurchase.aggregate([
      { $match: { workspaceId: wid, status: { $in: ["paid", "pending"] } } },
      { $group: { _id: "$status", credits: { $sum: "$credits" } } },
    ]),
  ]);
  const spent = Object.fromEntries(usage.map((row) => [row._id, row.credits]));
  const bought = Object.fromEntries(
    purchases.map((row) => [row._id, row.credits]),
  );

  const monthlyCredits = plan ? PROSPECT_MONTHLY_CREDITS[plan] : 0;
  const monthlyUsed = spent.plan || 0;
  const monthlyRemaining = Math.max(0, monthlyCredits - monthlyUsed);
  const purchasedTotal = bought.paid || 0;
  const purchasedPending = bought.pending || 0;
  const purchasedUsed = spent.purchased || 0;
  const purchasedRemaining = Math.max(0, purchasedTotal - purchasedUsed);
  const available = monthlyRemaining + purchasedRemaining;
  const nextPlan = nextProspectPlan(plan);

  return {
    plan,
    monthlyCredits,
    monthlyUsed,
    monthlyRemaining,
    purchasedRemaining,
    purchasedPending,
    available,
    // Par solde : deux dépenses simultanées ont pris le même dernier crédit
    overdrawn: {
      plan: monthlyUsed > monthlyCredits,
      purchased: purchasedUsed > purchasedTotal,
    },
    resetsAt: plan ? end : null,
    nextPlan,
    nextPlanCredits: nextPlan ? PROSPECT_MONTHLY_CREDITS[nextPlan] : null,
    canPurchase: plan === PURCHASE_PLAN,
    // Champs du quota d'avant, lus par les versions du site déjà en ligne
    bucket: plan ? "monthly" : null,
    quota: monthlyCredits,
    used: monthlyUsed,
    remaining: available,
  };
}

/** Solde à débiter pour le prochain crédit, null s'il n'en reste aucun. */
export function spendSource(balance) {
  if (balance.monthlyRemaining > 0) return "plan";
  if (balance.purchasedRemaining > 0) return "purchased";
  return null;
}

const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

/**
 * Refus quand le solde ne couvre pas la dépense, avec la marche suivante :
 * offre Premium pour un Standard, offre Entreprise pour un Premium, achat
 * de crédits pour une Entreprise.
 */
export function insufficientCreditsError(balance, needed, detail = "") {
  const { plan, available, monthlyCredits, nextPlan, nextPlanCredits } =
    balance;
  let message;
  let reason = "QUOTA_EXCEEDED";
  if (!plan && available === 0) {
    message = "La génération de prospects est réservée aux abonnements payés.";
    reason = "PAID_PLAN_REQUIRED";
  } else if (available === 0 && monthlyCredits === 0 && nextPlan) {
    message = `La génération de prospects est incluse à partir de l'offre ${PLAN_LABELS[nextPlan]} (${nextPlanCredits} crédits par mois).`;
    reason = "PLAN_UPGRADE_REQUIRED";
  } else if (available === 0) {
    message = nextPlan
      ? `Vos ${monthlyCredits} crédits du mois sont utilisés. Passez à l'offre ${PLAN_LABELS[nextPlan]} pour en avoir ${nextPlanCredits} par mois.`
      : `Vos ${monthlyCredits} crédits du mois sont utilisés. Achetez des crédits pour continuer.`;
  } else {
    message = `Il vous reste ${plural(available, "crédit")}${detail ? ` : ${detail}` : ""}.`;
  }
  return new AppError(message, ERROR_CODES.VALIDATION_ERROR, {
    reason,
    remaining: available,
    needed,
    nextPlan: nextPlan || null,
    canPurchase: balance.canPurchase,
  });
}

/**
 * Crédits offerts (crédits du mois des offres) consommés ce mois-ci, tous
 * espaces confondus. Les crédits achetés, payés par le client, n'entrent pas
 * dans ce budget : un client qui en a acheté peut toujours les dépenser.
 */
export async function getMonthlyPlanCreditsUsed(now = new Date()) {
  const { start, end } = parisMonthBounds(now);
  const [row] = await ProspectCreditUsage.aggregate([
    {
      $match: {
        createdAt: { $gte: start, $lt: end },
        source: { $ne: "purchased" },
      },
    },
    { $group: { _id: null, credits: { $sum: "$credits" } } },
  ]);
  return row?.credits || 0;
}

/**
 * Refuse une dépense de crédits offerts qui ferait dépasser le budget
 * mensuel de Newbi. Seule compte la part prise sur les crédits du mois de
 * l'espace (dépensés avant les crédits achetés) : `balance` = son solde.
 */
export async function assertGlobalBudget(creditsNeeded, balance = null) {
  const fromPlan = balance
    ? Math.min(creditsNeeded, balance.monthlyRemaining ?? creditsNeeded)
    : creditsNeeded;
  if (fromPlan <= 0) return;
  const used = await getMonthlyPlanCreditsUsed();
  if (used + fromPlan > monthlyCreditCap()) {
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
