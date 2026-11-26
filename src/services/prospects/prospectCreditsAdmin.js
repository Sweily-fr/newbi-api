import mongoose from "mongoose";
import ProspectCreditAdjustment from "../../models/ProspectCreditAdjustment.js";
import ProspectCreditPurchase from "../../models/ProspectCreditPurchase.js";
import ProspectCreditUsage from "../../models/ProspectCreditUsage.js";
import {
  PROSPECT_MONTHLY_CREDITS,
  getProspectBalance,
  getProspectBalances,
} from "./prospectQuota.js";
import {
  getPlanCreditsReserve,
  getPurchasedCreditsOwed,
  readProviderStock,
} from "./prospectOrders.js";
import { isProspectGenerationEnabled } from "./prospectService.js";
import { isSocieteinfoConfigured } from "./societeinfoClient.js";
import { canonicalPlanKey } from "../storage/storageConfig.js";
import logger from "../../utils/logger.js";

/**
 * Crédits de prospection vus et ajustés depuis le back-office newbi-admin
 * (page « Crédits de prospection », routes /api/admin-service/prospect-credits).
 *
 * Le solde d'un espace n'est jamais écrasé : l'admin saisit le nouveau solde
 * voulu et on enregistre la différence comme un ajustement tracé (e-mail de
 * l'admin, date, motif ; modèle ProspectCreditAdjustment). Le solde reste
 * calculé par prospectQuota.js, le même calcul que pour le client.
 */

// Garde-fou contre une faute de frappe (5000 au lieu de 500) : au plus
// autant qu'un achat maximum du site
export const MAX_ADJUSTMENT_INCREASE = 1000;
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 500;

export class ProspectCreditsAdminError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const isObjectId = (id) => typeof id === "string" && /^[0-9a-f]{24}$/i.test(id);
const formatCredits = (n) =>
  `${n.toLocaleString("fr-FR")} crédit${Math.abs(n) > 1 ? "s" : ""}`;

/**
 * Répartit le passage du solde actuel au nouveau solde sur les deux soldes
 * de l'espace (voir ProspectCreditAdjustment) :
 * - un ajout va aux crédits sans expiration ;
 * - un retrait prend d'abord les crédits sans expiration, puis ceux du mois.
 * Les parts sont calculées sur les totaux bruts, pour arriver exactement au
 * nouveau solde même quand un solde était dépassé.
 */
export function splitAdjustment(balance, target) {
  const before = balance.available;
  const monthly = balance.monthlyRemaining;
  const purchased = balance.purchasedRemaining;
  let monthlyAfter = monthly;
  let purchasedAfter = purchased;

  if (target > before) {
    purchasedAfter = purchased + (target - before);
  } else if (target < before) {
    const removal = before - target;
    const fromPurchased = Math.min(purchased, removal);
    purchasedAfter = purchased - fromPurchased;
    monthlyAfter = monthly - (removal - fromPurchased);
  }

  const purchasedRaw = balance.purchasedTotal - balance.purchasedUsed;
  return {
    credits: target - before,
    purchasedCredits:
      purchasedAfter === purchased ? 0 : purchasedAfter - purchasedRaw,
    planCredits: monthlyAfter === monthly ? 0 : monthlyAfter - monthly,
  };
}

/** Nouveau solde saisi : un nombre entier de crédits, jamais négatif. */
function readTarget(value) {
  const raw = typeof value === "string" ? value.trim() : value;
  const target =
    typeof raw === "number" || (typeof raw === "string" && raw !== "")
      ? Number(raw)
      : NaN;
  if (!Number.isFinite(target) || !Number.isInteger(target)) {
    throw new ProspectCreditsAdminError(
      "Le nouveau solde doit être un nombre entier de crédits.",
    );
  }
  if (target < 0) {
    throw new ProspectCreditsAdminError(
      "Le nouveau solde ne peut pas être négatif.",
    );
  }
  return target;
}

function readReason(value) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < MIN_REASON_LENGTH) {
    throw new ProspectCreditsAdminError(
      "Le motif est obligatoire : il explique l'ajustement dans l'historique.",
    );
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new ProspectCreditsAdminError(
      `Le motif est trop long (${MAX_REASON_LENGTH} caractères au plus).`,
    );
  }
  return reason;
}

function adjustmentDto(adjustment) {
  return {
    id: String(adjustment._id),
    workspaceId: String(adjustment.workspaceId),
    credits: adjustment.credits,
    purchasedCredits: adjustment.purchasedCredits,
    planCredits: adjustment.planCredits,
    balanceBefore: adjustment.balanceBefore,
    balanceAfter: adjustment.balanceAfter,
    reason: adjustment.reason,
    adminEmail: adjustment.adminEmail,
    createdAt: adjustment.createdAt,
  };
}

/** Champs du solde utiles à l'admin. */
function balanceDto(balance) {
  return {
    plan: balance.plan,
    planCredits: balance.planCredits,
    monthlyAdjustment: balance.monthlyAdjustment,
    monthlyCredits: balance.monthlyCredits,
    monthlyUsed: balance.monthlyUsed,
    monthlyRemaining: balance.monthlyRemaining,
    purchasedRemaining: balance.purchasedRemaining,
    offeredRemaining: balance.offeredRemaining,
    purchasedPending: balance.purchasedPending,
    available: balance.available,
    resetsAt: balance.resetsAt,
  };
}

async function audit(entry) {
  try {
    await mongoose.connection.db
      .collection("backoffice_audit_log")
      .insertOne({ ...entry, createdAt: new Date() });
  } catch (error) {
    // Le journal ne doit pas faire échouer l'ajustement déjà enregistré
    logger.error(
      `[ADMIN-SERVICE] Journal d'audit impossible : ${error.message}`,
    );
  }
}

// Abonnement qui décrit le mieux l'espace : payé, puis essai, puis le reste
const STATUS_ORDER = ["active", "past_due", "trialing", "incomplete"];
const statusRank = (status) => {
  const rank = STATUS_ORDER.indexOf(status);
  return rank === -1 ? STATUS_ORDER.length : rank;
};

function mainSubscription(subscriptions) {
  const [first] = [...subscriptions].sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      new Date(b.periodEnd || 0) - new Date(a.periodEnd || 0),
  );
  return first
    ? {
        plan: canonicalPlanKey(first.plan) || null,
        status: first.status || null,
        periodEnd: first.periodEnd || null,
      }
    : null;
}

/** Stock du fournisseur et ce qu'il doit couvrir (voir prospectOrders.js). */
async function providerSummary(pendingCredits) {
  const configured = isSocieteinfoConfigured();
  const [stock, owed, reserve] = await Promise.all([
    configured ? readProviderStock() : null,
    getPurchasedCreditsOwed(),
    getPlanCreditsReserve(),
  ]);
  const free = stock === null ? null : stock - owed - reserve;
  return {
    configured,
    stock,
    owed,
    reserve,
    pendingCredits,
    // Crédits à racheter chez Societeinfo pour activer toutes les commandes
    missing: free === null ? null : Math.max(0, pendingCredits - free),
  };
}

/**
 * Organisations à afficher : celles qui ont un abonnement (hors traces
 * d'abonnements remplacés lors d'un changement de payeur), plus celles qui
 * ont des crédits sans abonnement (achat, ajustement, dépense).
 */
async function workspaceIdsToList() {
  const db = mongoose.connection.db;
  const [subscriptions, purchased, adjusted, used] = await Promise.all([
    db
      .collection("subscription")
      .find(
        { replacedOrganizationId: { $exists: false } },
        {
          projection: {
            referenceId: 1,
            organizationId: 1,
            plan: 1,
            status: 1,
            periodEnd: 1,
          },
        },
      )
      .toArray(),
    ProspectCreditPurchase.distinct("workspaceId"),
    ProspectCreditAdjustment.distinct("workspaceId"),
    ProspectCreditUsage.distinct("workspaceId"),
  ]);

  const byWorkspace = new Map();
  for (const subscription of subscriptions) {
    const owner = String(
      subscription.referenceId || subscription.organizationId || "",
    );
    if (!isObjectId(owner)) continue;
    if (!byWorkspace.has(owner)) byWorkspace.set(owner, []);
    byWorkspace.get(owner).push(subscription);
  }
  for (const id of [...purchased, ...adjusted, ...used].map(String)) {
    if (isObjectId(id) && !byWorkspace.has(id)) byWorkspace.set(id, []);
  }
  return byWorkspace;
}

/**
 * Liste de la page « Crédits de prospection » : chaque organisation avec son
 * offre, son solde (crédits du mois offerts et utilisés, crédits sans
 * expiration restants) et ses commandes en attente, plus l'état du stock
 * chez le fournisseur.
 */
export async function listProspectCredits() {
  const subscriptionsByWorkspace = await workspaceIdsToList();
  const ids = [...subscriptionsByWorkspace.keys()];
  const [balances, pending] = await Promise.all([
    getProspectBalances(ids),
    ProspectCreditPurchase.find(
      { status: "pending" },
      { workspaceId: 1, credits: 1, amountTotal: 1, createdAt: 1 },
    )
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
  ]);

  const pendingByWorkspace = new Map();
  for (const order of pending) {
    const id = String(order.workspaceId);
    if (!pendingByWorkspace.has(id)) pendingByWorkspace.set(id, []);
    pendingByWorkspace.get(id).push({
      id: String(order._id),
      credits: order.credits,
      amountTotal: order.amountTotal ?? null,
      createdAt: order.createdAt,
    });
  }
  const pendingCredits = pending.reduce((sum, o) => sum + o.credits, 0);

  const workspaces = ids.map((id) => ({
    workspaceId: id,
    subscription: mainSubscription(subscriptionsByWorkspace.get(id)),
    generationOpen: isProspectGenerationEnabled(id),
    balance: balanceDto(balances.get(id)),
    pendingOrders: pendingByWorkspace.get(id) || [],
  }));

  return {
    generatedAt: new Date(),
    limits: {
      // Crédits offerts chaque mois par offre (clés freelance, pme, entreprise)
      monthlyCreditsByPlan: PROSPECT_MONTHLY_CREDITS,
      maxIncrease: MAX_ADJUSTMENT_INCREASE,
      minReasonLength: MIN_REASON_LENGTH,
      maxReasonLength: MAX_REASON_LENGTH,
    },
    provider: await providerSummary(pendingCredits),
    workspaces,
  };
}

/**
 * Ajuste le solde d'un espace au nouveau solde demandé.
 * @param {string} workspaceId organisation (= espace)
 * @param {{ balance: number, reason: string, expectedBalance?: number }} input
 *   `expectedBalance` : solde affiché à l'admin ; s'il a changé depuis
 *   (dépense du client, autre ajustement, double envoi), rien n'est fait
 * @param {string} adminEmail admin newbi-admin à l'origine de l'ajustement
 */
export async function adjustProspectCredits(workspaceId, input, adminEmail) {
  const id = String(workspaceId || "");
  if (!isObjectId(id)) {
    throw new ProspectCreditsAdminError("Organisation introuvable.", 404);
  }
  const oid = new mongoose.Types.ObjectId(id);
  const organization = await mongoose.connection.db
    .collection("organization")
    .findOne({ _id: oid }, { projection: { _id: 1 } });
  if (!organization) {
    throw new ProspectCreditsAdminError("Organisation introuvable.", 404);
  }

  const target = readTarget(input?.balance);
  const reason = readReason(input?.reason);

  // Numéro lu AVANT le solde : un ajustement enregistré entre les deux est
  // vu dans le solde, un ajustement enregistré après prend le même numéro et
  // fait échouer celui-ci (index unique) au lieu de s'appliquer deux fois
  const last = await ProspectCreditAdjustment.findOne(
    { workspaceId: oid },
    { sequence: 1 },
  )
    .sort({ sequence: -1 })
    .lean();
  const before = await getProspectBalance(id);

  const expected = input?.expectedBalance;
  if (expected !== undefined && expected !== null) {
    if (Number(expected) !== before.available) {
      throw new ProspectCreditsAdminError(
        `Le solde a changé depuis l'affichage de la page : il est maintenant de ${formatCredits(before.available)}. Vérifiez-le avant de recommencer.`,
        409,
      );
    }
  }
  if (target === before.available) {
    throw new ProspectCreditsAdminError(
      "Le nouveau solde est égal au solde actuel : rien à enregistrer.",
    );
  }
  if (target - before.available > MAX_ADJUSTMENT_INCREASE) {
    throw new ProspectCreditsAdminError(
      `Un ajustement ajoute ${formatCredits(MAX_ADJUSTMENT_INCREASE)} au plus (ici ${formatCredits(target - before.available)}). Vérifiez le nombre saisi.`,
    );
  }

  const split = splitAdjustment(before, target);
  let adjustment;
  try {
    adjustment = await ProspectCreditAdjustment.create({
      workspaceId: oid,
      ...split,
      balanceBefore: before.available,
      balanceAfter: target,
      reason,
      adminEmail,
      sequence: (last?.sequence || 0) + 1,
    });
  } catch (error) {
    if (error?.code === 11000) {
      throw new ProspectCreditsAdminError(
        "Un autre ajustement vient d'être enregistré pour cette organisation. Vérifiez le nouveau solde avant de recommencer.",
        409,
      );
    }
    throw error;
  }

  const after = await getProspectBalance(id);
  logger.info(
    `[ADMIN-SERVICE] Crédits de prospection de ${id} : ${before.available} → ${target} (${split.credits > 0 ? "+" : ""}${split.credits}) par ${adminEmail}`,
  );
  await audit({
    action: "prospect_credits.adjust",
    adminEmail,
    workspaceId: oid,
    adjustmentId: adjustment._id,
    credits: split.credits,
    balanceBefore: before.available,
    balanceAfter: target,
    reason,
  });

  return { adjustment: adjustmentDto(adjustment), balance: balanceDto(after) };
}
