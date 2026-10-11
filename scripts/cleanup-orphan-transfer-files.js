#!/usr/bin/env node

/**
 * Nettoyage manuel des fichiers de transfert orphelins sur R2 (même règle
 * que le job planifié src/jobs/cleanupOrphanTransferFiles.js, qui tourne
 * toutes les 6 h sur l'instance PM2 #0).
 *
 * Usage :
 *   NODE_ENV=production node scripts/cleanup-orphan-transfer-files.js \
 *     [--days <n>] [--min-age-hours <n>] [--apply]
 *
 *   Sans --apply : simulation, liste les fichiers qui seraient supprimés.
 *   --days : jours de préfixes datés parcourus (7 par défaut ; plus pour
 *   rattraper l'arriéré antérieur au job).
 */

import "../src/config/env.js";
import mongoose from "mongoose";
import { initializeRedis, closeRedis } from "../src/config/redis.js";
import { cleanupOrphanTransferFiles } from "../src/jobs/cleanupOrphanTransferFiles.js";

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const APPLY = args.includes("--apply");
const DAYS = Number(argValue("--days")) || undefined;
const MIN_AGE_HOURS = Number(argValue("--min-age-hours")) || undefined;

if (MIN_AGE_HOURS !== undefined && MIN_AGE_HOURS < 24) {
  console.error("--min-age-hours doit valoir au moins 24");
  process.exit(1);
}

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI requis");
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  await initializeRedis();
  try {
    const stats = await cleanupOrphanTransferFiles({
      dryRun: !APPLY,
      lookbackDays: DAYS,
      minAgeHours: MIN_AGE_HOURS,
    });
    if (!APPLY) {
      for (const key of stats.keys) console.log(`  à supprimer : ${key}`);
    }
    const { keys, ...summary } = stats;
    console.log(
      `${APPLY ? "Suppression" : "Simulation"} : ${JSON.stringify(summary)} (${keys.length} clé(s) listée(s))`,
    );
  } finally {
    await closeRedis().catch(() => {});
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
