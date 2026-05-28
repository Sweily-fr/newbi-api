/**
 * Trial cleanup cron — app-managed trial lifecycle.
 *
 * Two responsibilities, both gated by ENABLE_APP_TRIAL:
 *
 *   1. J-3 reminder: organizations whose trial ends in 1-3 days (and that
 *      haven't already received the reminder) get a "your trial is ending"
 *      email. Anti-doublon via `trialEndingEmailSentAt` on the org document.
 *
 *   2. J0 expiration: organizations whose trial just expired (or that the
 *      cron is catching up on) get `isTrialActive: false` set, the rbac
 *      cache invalidated, and one final email "your trial is over, data is
 *      safe, choose a plan". Anti-doublon via `trialEndedEmailSentAt`.
 *
 * Decision #16 / vigilance point: organizations with `stripeTrialActive: true`
 * are LEGACY Stripe trials and must be left alone — this cron only manages
 * the new app-managed trial.
 *
 * The cron is wired in server.js behind the `instanceId === 0` guard (PM2
 * only — single executor) AND behind `isAppTrialEnabled()`. Cron expression:
 * '5 9 * * *' = every day at 09:05 Europe/Paris (offset from the existing
 * 09:00 cron to spread out work).
 */
import cron from "node-cron";
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import { isAppTrialEnabled } from "../utils/featureFlags.js";
import { invalidateTrialCache } from "../middlewares/rbac.js";
import {
  sendTrialEndingEmail,
  sendTrialEndedEmail,
} from "../utils/trialEmails.js";

const J3_REMINDER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * Look up the owner email + display name for an organization.
 * Returns `null` if no owner found (shouldn't happen, but defensive).
 */
async function lookupOrgOwner(db, organizationId) {
  const ownerMember = await db.collection("member").findOne({
    organizationId,
    role: "owner",
  });
  if (!ownerMember) return null;
  const owner = await db
    .collection("user")
    .findOne(
      { _id: ownerMember.userId },
      { projection: { email: 1, name: 1 } },
    );
  if (!owner?.email) return null;
  return { email: owner.email, name: owner.name || "" };
}

/**
 * Persists a heartbeat document describing the last cron run. Used by the
 * Lot 7 metrics script to detect whether the cron is actually running in
 * production. The `_health` collection is generic; we identify our doc by
 * `{ key: "trialCleanupCron" }`.
 *
 * Best-effort: a heartbeat write failure must not break the cron itself.
 */
async function writeHeartbeat(db, summary, startedAt) {
  try {
    await db.collection("_health").updateOne(
      { key: "trialCleanupCron" },
      {
        $set: {
          key: "trialCleanupCron",
          lastRunAt: startedAt,
          lastRunDurationMs: Date.now() - startedAt.getTime(),
          lastSummary: summary,
        },
        $inc: { runCount: 1 },
      },
      { upsert: true },
    );
  } catch (err) {
    logger.warn(`[trialCleanupCron] heartbeat write failed: ${err.message}`);
  }
}

/**
 * One pass of the trial cleanup pipeline. Exported so tests and ops can run
 * it on demand. Returns a summary for logging / observability.
 */
export async function runTrialCleanup() {
  if (!isAppTrialEnabled()) {
    logger.debug("[trialCleanupCron] flag OFF — skipping run");
    return { skipped: true, expired: 0, reminded: 0 };
  }

  const db = mongoose.connection?.db;
  if (!db) {
    logger.warn("[trialCleanupCron] MongoDB not ready — skipping run");
    return { skipped: true, reason: "no-db", expired: 0, reminded: 0 };
  }

  const startedAt = new Date();
  const now = startedAt;
  const remindWindow = new Date(now.getTime() + J3_REMINDER_WINDOW_MS);

  const summary = { expired: 0, reminded: 0, errors: 0 };

  // ─── 1. Expirations (J0) ─────────────────────────────────────────────
  // App-managed trials only — Stripe-origin trials (stripeTrialActive: true)
  // are managed by the Stripe webhook and must NOT be touched.
  const expiredCursor = db.collection("organization").find({
    isTrialActive: true,
    stripeTrialActive: { $ne: true },
    trialEndDate: { $lte: now.toISOString() },
  });

  // eslint-disable-next-line no-restricted-syntax
  for await (const org of expiredCursor) {
    try {
      const update = {
        $set: { isTrialActive: false, updatedAt: now },
      };
      // Anti-doublon : mark the J0 email send timestamp BEFORE actually sending
      // so a crash mid-loop doesn't cause re-sends on the next run.
      const alreadyEmailed = !!org.trialEndedEmailSentAt;
      if (!alreadyEmailed) {
        update.$set.trialEndedEmailSentAt = now;
      }
      await db.collection("organization").updateOne({ _id: org._id }, update);

      // Invalidate rbac cache so the user falls into read-only immediately
      // on next protected mutation rather than waiting for the 30s TTL.
      invalidateTrialCache(org._id.toString());

      if (!alreadyEmailed) {
        const owner = await lookupOrgOwner(db, org._id);
        if (owner) {
          try {
            await sendTrialEndedEmail({
              to: owner.email,
              orgName: org.companyName || org.name,
            });
          } catch (mailErr) {
            // Don't roll back the expiration flip — the user is correctly
            // moved to read-only even if the email fails. Just log.
            logger.error(
              `[trialCleanupCron] J0 email failed for org ${org._id}: ${mailErr.message}`,
            );
            summary.errors++;
          }
        }
      }
      summary.expired++;
    } catch (err) {
      summary.errors++;
      logger.error(
        `[trialCleanupCron] expiration handling failed for org ${org?._id}: ${err.message}`,
      );
    }
  }

  // ─── 2. J-3 reminders ────────────────────────────────────────────────
  // Match orgs whose trial ends in (0, 3] days from now AND that haven't
  // received the reminder yet. Active app trial only.
  const reminderCursor = db.collection("organization").find({
    isTrialActive: true,
    stripeTrialActive: { $ne: true },
    trialEndDate: {
      $gt: now.toISOString(),
      $lte: remindWindow.toISOString(),
    },
    trialEndingEmailSentAt: { $exists: false },
  });

  // eslint-disable-next-line no-restricted-syntax
  for await (const org of reminderCursor) {
    try {
      // Mark first, send second — same anti-doublon principle as above.
      await db
        .collection("organization")
        .updateOne(
          { _id: org._id },
          { $set: { trialEndingEmailSentAt: now, updatedAt: now } },
        );
      const owner = await lookupOrgOwner(db, org._id);
      if (owner) {
        const daysRemaining = Math.max(
          1,
          Math.ceil((new Date(org.trialEndDate) - now) / (24 * 60 * 60 * 1000)),
        );
        try {
          await sendTrialEndingEmail({
            to: owner.email,
            orgName: org.companyName || org.name,
            daysRemaining,
          });
        } catch (mailErr) {
          logger.error(
            `[trialCleanupCron] J-3 email failed for org ${org._id}: ${mailErr.message}`,
          );
          summary.errors++;
        }
      }
      summary.reminded++;
    } catch (err) {
      summary.errors++;
      logger.error(
        `[trialCleanupCron] reminder handling failed for org ${org?._id}: ${err.message}`,
      );
    }
  }

  logger.info(
    `[trialCleanupCron] done — expired=${summary.expired} reminded=${summary.reminded} errors=${summary.errors}`,
  );

  // Heartbeat / metrics persistence (Lot 7 — monitoring & rollout)
  await writeHeartbeat(db, summary, startedAt);

  return summary;
}

/**
 * Boot helper: schedules the daily cron if and only if the feature flag is
 * ON at boot time. Returns the cron task (for tests / clean shutdown) or
 * `null` when disabled.
 */
export function startTrialCleanupCron() {
  if (!isAppTrialEnabled()) {
    logger.info(
      "[trialCleanupCron] ENABLE_APP_TRIAL is OFF — cron not scheduled",
    );
    return null;
  }
  const task = cron.schedule(
    "5 9 * * *",
    async () => {
      try {
        await runTrialCleanup();
      } catch (err) {
        logger.error(`[trialCleanupCron] unhandled error: ${err.message}`);
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );
  logger.info("[trialCleanupCron] scheduled daily at 09:05 Europe/Paris");
  return task;
}
