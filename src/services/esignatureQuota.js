import mongoose from "mongoose";
import SignatureRequest from "../models/SignatureRequest.js";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";

/**
 * Quota mensuel de demandes de signature électronique par plan (-1 = illimité).
 * Miroir de `esignatureMonthlyQuota` dans NewbiV2/src/lib/plan-limits.js :
 * les deux doivent bouger ensemble.
 */
export const ESIGNATURE_MONTHLY_QUOTAS = {
  freelance: 10,
  pme: 100,
  entreprise: -1,
};

// Sans abonnement (essai géré par l'app), on applique le plan d'entrée,
// comme le front (getPlanLimits retombe sur freelance).
const DEFAULT_PLAN = "freelance";

/**
 * Décalage (ms) entre l'heure de Paris et l'UTC à un instant donné.
 */
function parisOffsetMs(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Paris",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Début du mois civil en cours et du suivant, à minuit heure de Paris.
 * Le VPS tourne en UTC : sans ce calage, les envois du 1er entre minuit et
 * 1 h/2 h seraient décomptés sur le mois précédent.
 */
export function parisMonthBounds(now = new Date()) {
  const parisNow = new Date(now.getTime() + parisOffsetMs(now));
  const year = parisNow.getUTCFullYear();
  const month = parisNow.getUTCMonth();
  // Aucun changement d'heure ne tombe un 1er à minuit : le décalage mesuré
  // à cet instant est bien celui de minuit heure de Paris.
  const toParisMidnight = (y, m) => {
    const guess = new Date(Date.UTC(y, m, 1));
    return new Date(guess.getTime() - parisOffsetMs(guess));
  };
  return {
    start: toParisMidnight(year, month),
    end: toParisMidnight(year, month + 1),
  };
}

/**
 * Plan de l'abonnement de l'espace (freelance | pme | entreprise).
 */
export async function getWorkspacePlan(workspaceId) {
  const db = mongoose.connection.db;
  if (!db || !workspaceId) return DEFAULT_PLAN;

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
  const live =
    subscriptions.find((s) =>
      ACTIVE_SUBSCRIPTION_STATUSES.includes(s.status),
    ) ||
    // Résilié mais encore dans la période payée : le plan reste acquis
    subscriptions.find(
      (s) =>
        s.status === "canceled" && s.periodEnd && new Date(s.periodEnd) > now,
    );

  const plan = live?.plan?.toLowerCase();
  return plan in ESIGNATURE_MONTHLY_QUOTAS ? plan : DEFAULT_PLAN;
}

/**
 * Consommation du mois en cours. Compte toute demande réellement transmise au
 * prestataire (externalSignatureId posé), même annulée ensuite : l'invitation
 * est partie chez le client. Ne comptent pas : les envois tombés en erreur et
 * le cachet qualifié de l'entreprise (QES_automatic).
 */
export async function getEsignatureQuota(workspaceId, now = new Date()) {
  const plan = await getWorkspacePlan(workspaceId);
  const monthlyQuota = ESIGNATURE_MONTHLY_QUOTAS[plan];
  const { start, end } = parisMonthBounds(now);

  const used = await SignatureRequest.countDocuments({
    workspaceId,
    signatureType: { $ne: "QES_automatic" },
    externalSignatureId: { $nin: [null, ""] },
    status: { $ne: "ERROR" },
    createdAt: { $gte: start, $lt: end },
  });

  const unlimited = monthlyQuota < 0;
  return {
    plan,
    unlimited,
    monthlyQuota: unlimited ? null : monthlyQuota,
    used,
    remaining: unlimited ? null : Math.max(0, monthlyQuota - used),
    resetsAt: end,
  };
}

/**
 * Refuse l'envoi si le quota du mois est atteint.
 */
export async function assertEsignatureQuotaAvailable(workspaceId) {
  const quota = await getEsignatureQuota(workspaceId);
  if (!quota.unlimited && quota.remaining <= 0) {
    throw new AppError(
      `Vous avez utilisé vos ${quota.monthlyQuota} signatures électroniques de ce mois. ` +
        "Le compteur repart à zéro le 1er du mois prochain, ou passez à un plan supérieur pour en envoyer davantage.",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  return quota;
}
