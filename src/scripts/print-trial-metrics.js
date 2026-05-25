/**
 * Lot 7 — Trial metrics CLI.
 *
 * Prints a snapshot of the app-managed trial system, intended for ops during
 * the rollout window. Reads MongoDB directly — no auth, no http endpoint —
 * so it can be run from a shell on a server that has MONGODB_URI in its env.
 *
 * Metrics emitted:
 *   - Cron heartbeat: lastRunAt, lastSummary, runCount
 *   - Trials currently active (isTrialActive + future trialEndDate + not Stripe)
 *   - Trials expiring in the next 3 days (J-3 candidates)
 *   - Trials expired today (trialEndedEmailSentAt today)
 *   - Total orgs with hasUsedTrial
 *   - Orgs that converted: hasUsedTrial=true AND a Stripe sub exists
 *   - Conversion rate (very rough, computed on hasUsedTrial population)
 *
 * Usage
 *   node src/scripts/print-trial-metrics.js
 *   node src/scripts/print-trial-metrics.js --json   # one-line JSON for scrape
 */
import mongoose from "mongoose";

const JSON_MODE = process.argv.includes("--json");

function logHuman(label, value) {
  process.stdout.write(`${label.padEnd(48, " ")} ${value}\n`);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGODB_URI not set");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const in3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  const [
    heartbeat,
    activeTrials,
    j3Candidates,
    expiredToday,
    hasUsedTrial,
    convertedFromTrial,
    j3EmailsToday,
    j0EmailsToday,
  ] = await Promise.all([
    db.collection("_health").findOne({ key: "trialCleanupCron" }),
    db.collection("organization").countDocuments({
      isTrialActive: true,
      stripeTrialActive: { $ne: true },
      trialEndDate: { $gt: now.toISOString() },
    }),
    db.collection("organization").countDocuments({
      isTrialActive: true,
      stripeTrialActive: { $ne: true },
      trialEndDate: { $gt: now.toISOString(), $lte: in3Days.toISOString() },
    }),
    db.collection("organization").countDocuments({
      trialEndedEmailSentAt: { $gte: startOfDay },
    }),
    db.collection("organization").countDocuments({ hasUsedTrial: true }),
    // Trial users who eventually got a Stripe sub (any status). Joining via
    // a $lookup keeps the script self-contained — fine for ops-grade counts.
    db
      .collection("organization")
      .aggregate([
        { $match: { hasUsedTrial: true } },
        {
          $lookup: {
            from: "subscription",
            let: { orgIdStr: { $toString: "$_id" } },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ["$referenceId", "$$orgIdStr"] },
                  stripeSubscriptionId: { $exists: true, $ne: null },
                },
              },
              { $limit: 1 },
            ],
            as: "sub",
          },
        },
        { $match: { "sub.0": { $exists: true } } },
        { $count: "n" },
      ])
      .toArray()
      .then((rows) => rows[0]?.n || 0),
    db.collection("organization").countDocuments({
      trialEndingEmailSentAt: { $gte: startOfDay },
    }),
    db.collection("organization").countDocuments({
      trialEndedEmailSentAt: { $gte: startOfDay },
    }),
  ]);

  const conversionRate =
    hasUsedTrial > 0
      ? Math.round((convertedFromTrial / hasUsedTrial) * 1000) / 10
      : null;

  const metrics = {
    timestamp: now.toISOString(),
    cron: heartbeat
      ? {
          lastRunAt: heartbeat.lastRunAt,
          lastRunDurationMs: heartbeat.lastRunDurationMs,
          lastSummary: heartbeat.lastSummary,
          runCount: heartbeat.runCount,
        }
      : null,
    activeTrials,
    j3Candidates,
    expiredToday,
    hasUsedTrial,
    convertedFromTrial,
    conversionRatePct: conversionRate,
    j3EmailsToday,
    j0EmailsToday,
  };

  if (JSON_MODE) {
    process.stdout.write(`${JSON.stringify(metrics)}\n`);
  } else {
    process.stdout.write("\n— trial metrics ——————————————————————————————\n");
    logHuman("Timestamp", metrics.timestamp);
    if (metrics.cron) {
      logHuman("Cron last run", metrics.cron.lastRunAt);
      logHuman(
        "Cron last summary",
        JSON.stringify(metrics.cron.lastSummary || {}),
      );
      logHuman("Cron run count", metrics.cron.runCount ?? "n/a");
    } else {
      logHuman("Cron heartbeat", "NEVER WRITTEN — cron may not be running");
    }
    process.stdout.write("\n");
    logHuman("Active app trials", metrics.activeTrials);
    logHuman("Active trials expiring in next 3 days", metrics.j3Candidates);
    logHuman("Trials expired today (J0 emails sent)", metrics.expiredToday);
    process.stdout.write("\n");
    logHuman("Total orgs with hasUsedTrial", metrics.hasUsedTrial);
    logHuman("Of which converted to Stripe sub", metrics.convertedFromTrial);
    logHuman(
      "Conversion rate (%)",
      metrics.conversionRatePct === null ? "n/a" : metrics.conversionRatePct,
    );
    process.stdout.write("\n");
    logHuman("J-3 emails sent today", metrics.j3EmailsToday);
    logHuman("J0 emails sent today", metrics.j0EmailsToday);
    process.stdout.write(
      "────────────────────────────────────────────────\n\n",
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ [print-trial-metrics] fatal:", err);
  process.exit(1);
});
