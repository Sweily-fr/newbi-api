#!/usr/bin/env node
/**
 * Migration — encrypt existing PennylaneAccount.apiToken at rest.
 *
 * Companion to the security fix that introduced applyFieldEncryption()
 * on PennylaneAccount. New accounts are encrypted automatically by the
 * pre('save') hook; this script handles the legacy data already in DB.
 *
 * Idempotent: re-runs are safe. Accounts whose apiToken already matches
 * the AES-256-GCM ciphertext format (`iv:authTag:data`, hex) are skipped.
 *
 * Usage:
 *   # Preview without modifying anything:
 *   MONGODB_URI=$URI DATA_ENCRYPTION_KEY=$KEY \
 *     node scripts/migrations/encrypt-pennylane-tokens.js --dry-run
 *
 *   # Actually encrypt:
 *   MONGODB_URI=$URI DATA_ENCRYPTION_KEY=$KEY \
 *     node scripts/migrations/encrypt-pennylane-tokens.js
 *
 * Exit codes:
 *   0  success (whether or not anything was encrypted)
 *   1  fatal error (bad config, connection failure, etc.)
 *   2  partial failure (some accounts errored — see logs above)
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { encrypt, isEncrypted } from "../../src/utils/encryption.js";
import PennylaneAccount from "../../src/models/PennylaneAccount.js";

dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function logError(msg) {
  // eslint-disable-next-line no-console
  console.error(msg);
}

async function main() {
  if (!process.env.MONGODB_URI) {
    logError("FATAL: MONGODB_URI environment variable is required");
    process.exit(1);
  }
  if (!process.env.DATA_ENCRYPTION_KEY) {
    logError("FATAL: DATA_ENCRYPTION_KEY environment variable is required");
    process.exit(1);
  }

  log(
    `[migration] encrypt-pennylane-tokens — ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE (will write)"}`,
  );
  log(`[migration] connecting to ${process.env.MONGODB_URI.split("@").pop()}`);

  await mongoose.connect(process.env.MONGODB_URI);

  let total = 0;
  let encrypted = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const cursor = PennylaneAccount.find({}).cursor();
    for await (const doc of cursor) {
      total++;
      const id = doc._id.toString();
      const orgId = doc.organizationId;

      if (!doc.apiToken) {
        log(`[${id}] org=${orgId}: no apiToken, skipping`);
        skipped++;
        continue;
      }

      if (isEncrypted(doc.apiToken)) {
        log(`[${id}] org=${orgId}: skipping (already encrypted)`);
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        log(`[${id}] org=${orgId}: DRY-RUN would encrypt apiToken`);
        encrypted++;
        continue;
      }

      try {
        // Use the raw MongoDB driver (collection.updateOne) to bypass
        // Mongoose hooks. This avoids triggering applyFieldEncryption's
        // pre('save') guard logic — we encrypt explicitly and persist.
        const ciphertext = encrypt(doc.apiToken);
        await PennylaneAccount.collection.updateOne(
          { _id: doc._id },
          { $set: { apiToken: ciphertext } },
        );
        log(`[${id}] org=${orgId}: encrypted`);
        encrypted++;
      } catch (e) {
        logError(`[${id}] org=${orgId}: ERROR ${e.message}`);
        errors++;
      }
    }
  } finally {
    await mongoose.disconnect();
  }

  log("");
  log(
    `[migration] Done: ${encrypted} encrypted, ${skipped} skipped, ${errors} errors (total scanned: ${total})`,
  );

  if (errors > 0) {
    log(`[migration] ⚠ ${errors} accounts failed — check logs above`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  logError(`[migration] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
