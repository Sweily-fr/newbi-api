/**
 * Lot 6 — Cleanup: drain the `pending_org_data` collection.
 *
 * Why
 *   In the legacy flow (`/api/create-org-subscription`), large blobs (logo,
 *   invited members list) were stashed in `pending_org_data` between the
 *   Stripe Checkout creation and the webhook that built the organisation.
 *   Records carry a 24h TTL via `expiresAt`.
 *
 *   With the new flow (ENABLE_APP_TRIAL=true), the signup path no longer
 *   creates these documents — only `/create-workspace` for additional orgs
 *   still does (decision #16). At rollout, leftover docs from the legacy
 *   flow should be cleared. Decision #15: prepared but executed manually,
 *   during a low-traffic window.
 *
 * Safety
 *   - Only deletes documents OLDER than the configurable safety window
 *     (default 24h via --age=<hours>) to avoid wiping in-flight checkouts
 *   - --apply required to actually delete; default is dry-run
 *
 * Usage
 *   Dry run:   node src/scripts/cleanup-pending-org-data.js
 *   Apply 24h: node src/scripts/cleanup-pending-org-data.js --apply
 *   Apply 1h:  node src/scripts/cleanup-pending-org-data.js --apply --age=1
 */
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const ageArg = process.argv.find((a) => a.startsWith("--age="));
const SAFETY_HOURS = ageArg ? parseFloat(ageArg.split("=")[1]) : 24;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGODB_URI not set");
    process.exit(1);
  }
  if (!Number.isFinite(SAFETY_HOURS) || SAFETY_HOURS < 0) {
    console.error(`❌ Invalid --age value: ${ageArg}`);
    process.exit(1);
  }

  console.log(
    `🔗 [cleanup-pending-org-data] connecting (${APPLY ? "APPLY" : "DRY-RUN"}) — safety window ${SAFETY_HOURS}h...`,
  );
  await mongoose.connect(uri);

  const db = mongoose.connection.db;
  const cutoff = new Date(Date.now() - SAFETY_HOURS * 60 * 60 * 1000);

  const filter = { createdAt: { $lt: cutoff } };

  const total = await db.collection("pending_org_data").countDocuments(filter);

  console.log(
    `📊 [cleanup-pending-org-data] candidates older than ${cutoff.toISOString()}: ${total}`,
  );

  if (total === 0) {
    console.log("✅ [cleanup-pending-org-data] nothing to delete — exiting");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log(
      "ℹ️ [cleanup-pending-org-data] dry-run done — rerun with --apply to delete",
    );
    await mongoose.disconnect();
    return;
  }

  const result = await db.collection("pending_org_data").deleteMany(filter);

  console.log(
    `✅ [cleanup-pending-org-data] deleted ${result.deletedCount} document(s)`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ [cleanup-pending-org-data] fatal:", err);
  process.exit(1);
});
