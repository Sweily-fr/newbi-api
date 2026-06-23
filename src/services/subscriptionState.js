import mongoose from "mongoose";
import { AppError, ERROR_CODES, createDatabaseError } from "../utils/errors.js";
import { isAppTrialEnabled } from "../utils/featureFlags.js";
import { isTrialAppActive } from "../utils/trialApp.js";
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../middlewares/rbac.js";
import logger from "../utils/logger.js";

// Read-only resolver of the subscription state for an organization.
// Mirrors checkSubscriptionActive (middlewares/rbac.js) so the mobile sees
// the same notion of "active" as the server enforces at write time.
//
// Invariant maintained by construction:
//   isReadOnly === !isActive
//
// Throws createDatabaseError on Mongo failure — the mobile must treat that
// as "unknown" and keep its last known cached state, not flip to read-only.

function toIsoString(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function resolveSubscriptionState({ workspaceId }) {
  if (!workspaceId) {
    throw new AppError("Aucune organisation active", ERROR_CODES.FORBIDDEN);
  }

  const db = mongoose.connection.db;
  if (!db) {
    throw createDatabaseError("Base de données indisponible");
  }

  const appTrialEnabled = isAppTrialEnabled();
  const orgObjectId = mongoose.Types.ObjectId.isValid(workspaceId)
    ? new mongoose.Types.ObjectId(workspaceId)
    : null;

  let subscription = null;
  let orgDoc = null;

  try {
    [subscription, orgDoc] = await Promise.all([
      db.collection("subscription").findOne({
        $or: [
          { referenceId: workspaceId },
          ...(orgObjectId ? [{ organizationId: orgObjectId }] : []),
        ],
      }),
      orgObjectId
        ? db.collection("organization").findOne(
            { _id: orgObjectId },
            {
              projection: {
                isTrialActive: 1,
                trialEndDate: 1,
                trialStartDate: 1,
                stripeTrialActive: 1,
                hasUsedTrial: 1,
              },
            },
          )
        : null,
    ]);
  } catch (err) {
    logger.error(
      `[mySubscription] DB lookup failed orgId=${workspaceId}: ${err.message}`,
    );
    throw createDatabaseError("Impossible de récupérer le statut d'abonnement");
  }

  const trial = {
    appTrialEnabled,
    isTrialActive: orgDoc?.isTrialActive ?? false,
    trialStartDate: toIsoString(orgDoc?.trialStartDate),
    trialEndDate: toIsoString(orgDoc?.trialEndDate),
    stripeTrialActive: orgDoc?.stripeTrialActive ?? false,
    hasUsedTrial: orgDoc?.hasUsedTrial ?? false,
  };

  const trialActive = appTrialEnabled && isTrialAppActive(orgDoc);

  if (!subscription) {
    const isActive = trialActive;
    return {
      status: null,
      plan: null,
      periodEnd: null,
      cancelAtPeriodEnd: null,
      ...trial,
      isActive,
      isReadOnly: !isActive,
    };
  }

  const periodEndDate = subscription.periodEnd
    ? new Date(subscription.periodEnd)
    : null;
  const validPeriodEnd =
    periodEndDate && !Number.isNaN(periodEndDate.getTime())
      ? periodEndDate
      : null;

  const now = new Date();

  // Normalize a canceled subscription whose paid period has elapsed to "expired".
  //
  // NOTE — web/mobile divergence at the exact periodEnd === now boundary:
  //   * newbiv2/app/api/organizations/[id]/subscription/route.js uses `<` (strict).
  //   * checkSubscriptionActive (middlewares/rbac.js) uses `>` (strict) for the
  //     active gate. At periodEnd === now (millisecond match), the web REST
  //     reports status="canceled" while the gate refuses writes — a pre-existing
  //     micro-inconsistency in the web stack.
  //
  // Here we use `<=` deliberately, so that `isReadOnly === !isActive` holds at
  // that exact boundary. The mobile sees status="expired" exactly when writes
  // are blocked. TODO: align the web REST route to `<=` in a follow-up PR so
  // mobile and web agree at the millisecond; not done now to avoid touching
  // production behaviour outside this chantier.
  const isExpiredCanceled =
    subscription.status === "canceled" &&
    validPeriodEnd &&
    validPeriodEnd <= now;
  const normalizedStatus = isExpiredCanceled
    ? "expired"
    : (subscription.status ?? null);

  const isStripeActive =
    ACTIVE_SUBSCRIPTION_STATUSES.includes(subscription.status) ||
    (subscription.status === "canceled" &&
      validPeriodEnd &&
      validPeriodEnd > now);

  const isActive = trialActive || isStripeActive;

  return {
    status: normalizedStatus,
    plan: subscription.plan ?? null,
    periodEnd: validPeriodEnd ? validPeriodEnd.toISOString() : null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? null,
    ...trial,
    isActive,
    isReadOnly: !isActive,
  };
}
