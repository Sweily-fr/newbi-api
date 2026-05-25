/**
 * Lot 7 — Hard rollback prep script.
 *
 * Context
 *   The Lot 1 design gates BOTH creation and recognition of the
 *   app-managed trial behind the ENABLE_APP_TRIAL flag. As a result, simply
 *   flipping the flag to false LOCKS OUT existing trial-app users — their
 *   org is marked `isTrialActive: true` but `rbac.js / dashboard layout`
 *   stop honouring those fields when the flag is off.
 *
 *   This script is the safety valve for a HARD rollback scenario:
 *   it scans every org currently in app-managed trial state and:
 *     - leaves their data alone
 *     - sends them a one-shot "your trial is closing" email (CTA = subscribe)
 *     - flips `isTrialActive: false, stripeTrialActive: false, hasUsedTrial: true`
 *
 *   The result is that those users land in read-only as soon as the flag
 *   flips off, exactly like the legacy cohort B. They can subscribe via the
 *   legacy `/api/create-org-subscription` flow which is still active.
 *
 * Safety
 *   - dry-run by default; `--apply` to commit
 *   - does NOT delete or rewrite anything else
 *   - idempotent: once an org has `isTrialActive: false` it is skipped
 *   - email send is best-effort (does NOT block the flag flip)
 *   - `--no-email` skips emails (useful for a silent shutdown)
 *
 * Usage
 *   node src/scripts/rollback-trial-app.js                # dry-run
 *   node src/scripts/rollback-trial-app.js --apply        # commit (with email)
 *   node src/scripts/rollback-trial-app.js --apply --no-email
 */
import mongoose from "mongoose";
import logger from "../utils/logger.js";
import { sendTrialEndedEmail } from "../utils/trialEmails.js";

const APPLY = process.argv.includes("--apply");
const NO_EMAIL = process.argv.includes("--no-email");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGODB_URI not set");
    process.exit(1);
  }

  console.log(
    `🔗 [rollback-trial-app] connecting (${APPLY ? "APPLY" : "DRY-RUN"}${NO_EMAIL ? ", no email" : ""})...`,
  );
  await mongoose.connect(uri);

  const db = mongoose.connection.db;
  const now = new Date();

  const filter = {
    isTrialActive: true,
    stripeTrialActive: { $ne: true },
  };

  const total = await db.collection("organization").countDocuments(filter);
  console.log(
    `📊 [rollback-trial-app] orgs currently in app-managed trial: ${total}`,
  );
  if (total === 0) {
    console.log("✅ [rollback-trial-app] nothing to roll back — exiting");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    const sample = await db
      .collection("organization")
      .find(filter, {
        projection: {
          _id: 1,
          name: 1,
          companyName: 1,
          trialStartDate: 1,
          trialEndDate: 1,
        },
      })
      .limit(5)
      .toArray();
    console.log("📝 [rollback-trial-app] sample:", sample);
    console.log(
      "ℹ️ [rollback-trial-app] dry-run done — rerun with --apply to commit",
    );
    await mongoose.disconnect();
    return;
  }

  let touched = 0;
  let emailed = 0;
  let emailErrors = 0;

  const cursor = db.collection("organization").find(filter);
  // eslint-disable-next-line no-restricted-syntax
  for await (const org of cursor) {
    try {
      await db.collection("organization").updateOne(
        { _id: org._id },
        {
          $set: {
            isTrialActive: false,
            hasUsedTrial: true,
            stripeTrialActive: false,
            rolledBackAt: now,
            updatedAt: now,
          },
        },
      );
      touched++;

      if (NO_EMAIL) continue;

      // Best-effort email — same template as J0 to keep the message coherent.
      const ownerMember = await db
        .collection("member")
        .findOne({ organizationId: org._id, role: "owner" });
      if (!ownerMember) continue;
      const owner = await db
        .collection("user")
        .findOne(
          { _id: ownerMember.userId },
          { projection: { email: 1, name: 1 } },
        );
      if (!owner?.email) continue;
      try {
        await sendTrialEndedEmail({
          to: owner.email,
          orgName: org.companyName || org.name,
        });
        emailed++;
      } catch (mailErr) {
        emailErrors++;
        logger.warn(
          `[rollback-trial-app] email failed for org ${org._id}: ${mailErr.message}`,
        );
      }
    } catch (err) {
      logger.error(
        `[rollback-trial-app] failed for org ${org._id}: ${err.message}`,
      );
    }
  }

  console.log(
    `✅ [rollback-trial-app] applied — touched=${touched}, emailed=${emailed}, emailErrors=${emailErrors}`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ [rollback-trial-app] fatal:", err);
  process.exit(1);
});
