/**
 * Lot 6 — Migration: mark existing organisations with `hasUsedTrial: true`.
 *
 * Why
 *   When ENABLE_APP_TRIAL becomes ON in production, the `databaseHooks.user
 *   .create.after` hook grants a 30-day app trial to every NEW user. Existing
 *   organisations created before the refonte have no trial fields at all
 *   (Stripe handled their trial). Without intervention, the org-creation
 *   logic could mistakenly re-grant an app trial to those cohorts if a
 *   resyncing process ever runs against them.
 *
 *   This script is the safety net: it stamps `hasUsedTrial: true` and
 *   `isTrialActive: false` on every existing organisation that lacks the
 *   field, so the anti-abuse guard in `org-creation.js` (Lot 3, decision
 *   #16 defensive block) is satisfied for both cohorts:
 *     - Cohort A: orgs with an `active` / `trialing` / `canceled+valid`
 *       Stripe sub → continue working unchanged
 *     - Cohort B: orgs with an expired / canceled / no sub → stay in
 *       read-only as today
 *
 *   Decision figée (REFONTE-TRIAL-SUIVI.md, F.3 Option 1): we do NOT
 *   re-grant a trial to cohorts A or B. The script is purely defensive.
 *
 * Idempotence
 *   The script only updates documents that *don't already have*
 *   `hasUsedTrial`. Relaunches are safe; the second run is a no-op.
 *
 * Usage
 *   Dry run (default):
 *     node src/scripts/migrate-trial-app.js
 *   Apply:
 *     node src/scripts/migrate-trial-app.js --apply
 *
 *   The script connects to MONGODB_URI from the env and exits when done.
 */
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGODB_URI not set");
    process.exit(1);
  }

  console.log(
    `🔗 [migrate-trial-app] connecting (${APPLY ? "APPLY" : "DRY-RUN"})...`,
  );
  await mongoose.connect(uri);

  const db = mongoose.connection.db;

  const counts = await db
    .collection("organization")
    .countDocuments({ hasUsedTrial: { $exists: false } });

  console.log(`📊 [migrate-trial-app] organisations to migrate: ${counts}`);

  if (counts === 0) {
    console.log("✅ [migrate-trial-app] nothing to do — exiting");
    await mongoose.disconnect();
    return;
  }

  // Show a small sample for confidence
  const sample = await db
    .collection("organization")
    .find(
      { hasUsedTrial: { $exists: false } },
      { projection: { _id: 1, name: 1, siret: 1, createdAt: 1 } },
    )
    .limit(5)
    .toArray();
  console.log("📝 [migrate-trial-app] sample:", sample);

  if (!APPLY) {
    console.log(
      "ℹ️ [migrate-trial-app] dry-run done — rerun with --apply to commit",
    );
    await mongoose.disconnect();
    return;
  }

  // Apply
  const now = new Date();
  const result = await db.collection("organization").updateMany(
    { hasUsedTrial: { $exists: false } },
    {
      $set: {
        hasUsedTrial: true,
        isTrialActive: false,
        // We do NOT touch trialStartDate/trialEndDate/stripeTrialActive —
        // those remain unset for legacy orgs. The gating layer interprets
        // their absence correctly via isTrialAppActive() returning false.
        migratedAt: now,
        migratedBy: "lot6-migrate-trial-app",
      },
    },
  );

  console.log(
    `✅ [migrate-trial-app] migration applied — matched=${result.matchedCount}, modified=${result.modifiedCount}`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ [migrate-trial-app] fatal:", err);
  process.exit(1);
});
