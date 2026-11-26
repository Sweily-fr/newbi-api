import mongoose from "mongoose";
import ProspectCreditUsage from "../../models/ProspectCreditUsage.js";
import ProspectCreditPurchase from "../../models/ProspectCreditPurchase.js";
import ProspectCreditAdjustment from "../../models/ProspectCreditAdjustment.js";
import { parisMonthBounds } from "../esignatureQuota.js";
import { AppError, ERROR_CODES } from "../../utils/errors.js";
import {
  PLAN_LABELS,
  PLAN_ORDER,
  canonicalPlanKey,
} from "../storage/storageConfig.js";

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
 * Les ajustements du back-office (ProspectCreditAdjustment) s'ajoutent aux
 * crédits sans expiration, ou retirent des crédits du mois en cours.
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

/** Offre payée parmi les abonnements d'un espace, null sinon. */
function paidPlanOf(subscriptions) {
  const now = new Date();
  const paid =
    subscriptions.find((s) => PAID_STATUSES.includes(s.status)) ||
    // Résilié mais encore dans la période payée : le plan reste acquis
    subscriptions.find(
      (s) =>
        s.status === "canceled" && s.periodEnd && new Date(s.periodEnd) > now,
    );
  // Anciennes clés (« pro », « enterprise ») lues comme l'offre actuelle
  const plan = canonicalPlanKey(paid?.plan);
  return Object.hasOwn(PROSPECT_MONTHLY_CREDITS, plan) ? plan : null;
}

/**
 * Abonnements des espaces, par id d'espace (référence en texte ou en
 * ObjectId, `referenceId` ou `organizationId`).
 */
async function subscriptionsByWorkspace(workspaceIds) {
  const byWorkspace = new Map(workspaceIds.map((id) => [id, []]));
  const db = mongoose.connection.db;
  if (!db || !workspaceIds.length) return byWorkspace;

  const refs = [
    ...workspaceIds,
    ...workspaceIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id)),
  ];
  const subscriptions = await db
    .collection("subscription")
    .find(
      {
        $or: [
          { referenceId: { $in: refs } },
          { organizationId: { $in: refs } },
        ],
      },
      {
        projection: {
          plan: 1,
          status: 1,
          periodEnd: 1,
          referenceId: 1,
          organizationId: 1,
        },
      },
    )
    .toArray();
  for (const subscription of subscriptions) {
    const owners = new Set(
      [subscription.referenceId, subscription.organizationId]
        .filter(Boolean)
        .map(String),
    );
    for (const owner of owners) byWorkspace.get(owner)?.push(subscription);
  }
  return byWorkspace;
}

/**
 * Plan de l'abonnement payé de l'espace, ou null (essai, pas d'abonnement,
 * abonnement terminé).
 */
export async function getPaidPlan(workspaceId) {
  if (!workspaceId) return null;
  const id = String(workspaceId);
  const subscriptions = await subscriptionsByWorkspace([id]);
  return paidPlanOf(subscriptions.get(id) || []);
}

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * Solde d'un espace à partir de ses totaux. Le solde n'est jamais stocké :
 * - crédits du mois = ceux de l'offre + ajustements du mois (retraits),
 *   moins ceux dépensés ce mois-ci ;
 * - crédits sans expiration = achats activés + ajustements, moins ceux
 *   dépensés depuis toujours.
 */
export function computeProspectBalance({
  plan = null,
  spent = {},
  bought = {},
  adjusted = {},
  resetsAt = null,
}) {
  const planCredits = plan ? PROSPECT_MONTHLY_CREDITS[plan] : 0;
  const monthlyAdjustment = adjusted.plan || 0;
  const monthlyCredits = Math.max(0, planCredits + monthlyAdjustment);
  const monthlyUsed = spent.plan || 0;
  const monthlyRemaining = Math.max(0, monthlyCredits - monthlyUsed);
  const purchasedTotal = (bought.paid || 0) + (adjusted.purchased || 0);
  const purchasedPending = bought.pending || 0;
  const purchasedUsed = spent.purchased || 0;
  const purchasedRemaining = Math.max(0, purchasedTotal - purchasedUsed);
  // Dont offerts par Newbi (ajustements nets de l'admin), dépensés avant les
  // crédits achetés : seul l'affichage les distingue, le solde est le même
  const offeredRemaining = Math.min(
    purchasedRemaining,
    Math.max(0, (adjusted.purchased || 0) - purchasedUsed),
  );
  const available = monthlyRemaining + purchasedRemaining;
  const nextPlan = nextProspectPlan(plan);

  return {
    plan,
    // Crédits de l'offre, avant les retraits du mois faits par l'admin
    planCredits,
    monthlyAdjustment,
    monthlyCredits,
    monthlyUsed,
    monthlyRemaining,
    // Crédits sans expiration : achats activés + ajustements de l'admin
    purchasedTotal,
    purchasedUsed,
    purchasedRemaining,
    offeredRemaining,
    purchasedPending,
    available,
    // Par solde : deux dépenses simultanées ont pris le même dernier crédit
    overdrawn: {
      plan: monthlyUsed > monthlyCredits,
      purchased: purchasedUsed > purchasedTotal,
    },
    resetsAt: plan ? resetsAt : null,
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

/**
 * Soldes de plusieurs espaces (Map id → solde, voir computeProspectBalance),
 * en quatre requêtes quel que soit leur nombre.
 */
export async function getProspectBalances(workspaceIds, now = new Date()) {
  const ids = [...new Set(workspaceIds.map(String))];
  if (!ids.length) return new Map();
  const oids = ids.map(toObjectId);
  const { start, end } = parisMonthBounds(now);
  const inMonth = {
    $and: [{ $gte: ["$createdAt", start] }, { $lt: ["$createdAt", end] }],
  };

  const [subscriptions, usage, purchases, adjustments] = await Promise.all([
    subscriptionsByWorkspace(ids),
    // Crédits du mois (tout sauf achetés) et crédits achetés déjà dépensés
    ProspectCreditUsage.aggregate([
      {
        $match: {
          workspaceId: { $in: oids },
          $or: [
            { source: "purchased" },
            { createdAt: { $gte: start, $lt: end } },
          ],
        },
      },
      {
        $group: {
          _id: {
            workspaceId: "$workspaceId",
            source: {
              $cond: [{ $eq: ["$source", "purchased"] }, "purchased", "plan"],
            },
          },
          credits: { $sum: "$credits" },
        },
      },
    ]),
    // Achats disponibles (« paid ») et commandés pas encore activés
    // (« pending » : en attente du stock du fournisseur, prospectOrders.js)
    ProspectCreditPurchase.aggregate([
      {
        $match: {
          workspaceId: { $in: oids },
          status: { $in: ["paid", "pending"] },
        },
      },
      {
        $group: {
          _id: { workspaceId: "$workspaceId", status: "$status" },
          credits: { $sum: "$credits" },
        },
      },
    ]),
    // Ajustements de l'admin : sans expiration depuis toujours, retraits de
    // crédits du mois pour ce mois-ci seulement
    ProspectCreditAdjustment.aggregate([
      { $match: { workspaceId: { $in: oids } } },
      {
        $group: {
          _id: "$workspaceId",
          purchased: { $sum: "$purchasedCredits" },
          plan: { $sum: { $cond: [inMonth, "$planCredits", 0] } },
        },
      },
    ]),
  ]);

  const totals = new Map(
    ids.map((id) => [id, { spent: {}, bought: {}, adjusted: {} }]),
  );
  for (const row of usage) {
    totals.get(String(row._id.workspaceId)).spent[row._id.source] = row.credits;
  }
  for (const row of purchases) {
    totals.get(String(row._id.workspaceId)).bought[row._id.status] =
      row.credits;
  }
  for (const row of adjustments) {
    totals.get(String(row._id)).adjusted = {
      purchased: row.purchased || 0,
      plan: row.plan || 0,
    };
  }

  return new Map(
    ids.map((id) => [
      id,
      computeProspectBalance({
        plan: paidPlanOf(subscriptions.get(id) || []),
        ...totals.get(id),
        resetsAt: end,
      }),
    ]),
  );
}

/**
 * Solde de crédits de l'espace : offerts ce mois-ci (selon l'offre payée)
 * plus achetés et pas encore dépensés, ajustements de l'admin compris.
 */
export async function getProspectBalance(workspaceId, now = new Date()) {
  const balances = await getProspectBalances([workspaceId], now);
  return balances.get(String(workspaceId));
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
  // Crédits de l'offre elle-même : un retrait du mois fait par l'admin ne
  // doit pas faire croire que l'offre n'en donne pas
  const planCredits = balance.planCredits ?? monthlyCredits;
  let message;
  let reason = "QUOTA_EXCEEDED";
  if (!plan && available === 0) {
    message = "La génération de prospects est réservée aux abonnements payés.";
    reason = "PAID_PLAN_REQUIRED";
  } else if (available === 0 && planCredits === 0 && nextPlan) {
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
