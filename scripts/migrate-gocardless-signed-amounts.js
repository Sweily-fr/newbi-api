#!/usr/bin/env node

import mongoose from "mongoose";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

/**
 * Migration : montants GoCardless signés.
 *
 * Historiquement, GoCardlessProvider stockait les montants en valeur absolue
 * (Math.abs) : les débits (dépenses) avaient un montant positif en base, ce
 * qui cassait le rapprochement bancaire (suggestions d'achats filtrées sur
 * amount < 0, encaissements sur amount > 0) et faussait les statistiques.
 *
 * Le code est corrigé (montants signés au sync), et les transactions encore
 * dans la fenêtre de re-sync de la banque s'auto-corrigent au prochain sync.
 * Ce script corrige le RESTE : l'historique trop ancien pour être re-renvoyé.
 *
 * Ciblage : provider "gocardless" + type "debit" + amount > 0.
 * Le champ `type` a toujours été calculé depuis le signe ORIGINAL du montant
 * renvoyé par la banque (type = amount >= 0 ? "credit" : "debit"), AVANT le
 * Math.abs. Un débit à montant positif est donc, de façon certaine, une
 * transaction dont le signe a été perdu. Les crédits (déjà positifs à juste
 * titre) ne sont jamais touchés.
 *
 * Sécurité :
 * - DRY-RUN par défaut : liste ce qui serait modifié, ne touche à rien.
 *   Passer --apply pour exécuter réellement.
 * - --workspace <id> pour limiter à un seul workspace.
 * - Avant d'appliquer, un fichier de rollback JSON est écrit avec l'_id et le
 *   montant d'origine de chaque transaction modifiée.
 * - Chaque update est conditionnelle ({ _id, amount: montantSnapshot }) :
 *   une transaction modifiée entre-temps (par un sync par exemple) est
 *   ignorée et signalée, jamais écrasée.
 * - Idempotent : une fois le montant négatif, la transaction ne matche plus
 *   le filtre. Relancer le script est sans effet.
 *
 * Usage :
 *   node scripts/migrate-gocardless-signed-amounts.js               # dry-run
 *   node scripts/migrate-gocardless-signed-amounts.js --apply
 *   node scripts/migrate-gocardless-signed-amounts.js --apply --workspace <id>
 *   node scripts/migrate-gocardless-signed-amounts.js --rollback <fichier.json>
 */

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const workspaceArgIndex = args.indexOf("--workspace");
const WORKSPACE_FILTER =
  workspaceArgIndex >= 0 ? args[workspaceArgIndex + 1] : null;
const rollbackArgIndex = args.indexOf("--rollback");
const ROLLBACK_FILE = rollbackArgIndex >= 0 ? args[rollbackArgIndex + 1] : null;

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("MONGODB_URI environment variable is required");
    process.exit(1);
  }

  console.log("🔄 Connexion à MongoDB...");
  await mongoose.connect(mongoUri);
  console.log("✅ Connecté\n");

  const transactions = mongoose.connection.db.collection("transactions");

  // ─── Mode rollback : restaurer les montants depuis un fichier snapshot ───
  if (ROLLBACK_FILE) {
    const snapshot = JSON.parse(fs.readFileSync(ROLLBACK_FILE, "utf8"));
    console.log(
      `↩️  Rollback de ${snapshot.length} transactions depuis ${ROLLBACK_FILE}\n`,
    );
    let restored = 0;
    let skipped = 0;
    for (const entry of snapshot) {
      // Conditionnel : on ne restaure que si le montant est bien celui que la
      // migration avait écrit (-originalAmount)
      const res = await transactions.updateOne(
        {
          _id: new mongoose.Types.ObjectId(entry._id),
          amount: -entry.originalAmount,
        },
        { $set: { amount: entry.originalAmount } },
      );
      if (res.modifiedCount === 1) restored += 1;
      else skipped += 1;
    }
    console.log(
      `✅ ${restored} restaurées, ⚠️ ${skipped} ignorées (modifiées depuis)`,
    );
    await mongoose.disconnect();
    return;
  }

  // ─── Ciblage ───
  const filter = {
    provider: "gocardless",
    type: "debit",
    amount: { $gt: 0 },
  };
  if (WORKSPACE_FILTER) filter.workspaceId = WORKSPACE_FILTER;

  const targets = await transactions
    .find(filter)
    .project({ _id: 1, workspaceId: 1, amount: 1, date: 1, description: 1 })
    .toArray();

  console.log("═══════════════════════════════════════════════════");
  console.log(
    `🎯 ${targets.length} transaction(s) GoCardless débit à montant positif${
      WORKSPACE_FILTER ? ` (workspace ${WORKSPACE_FILTER})` : ""
    }`,
  );
  console.log("═══════════════════════════════════════════════════\n");

  if (targets.length === 0) {
    console.log("Rien à migrer.");
    await mongoose.disconnect();
    return;
  }

  // Répartition par workspace pour le rapport
  const byWorkspace = {};
  for (const tx of targets) {
    byWorkspace[tx.workspaceId] = (byWorkspace[tx.workspaceId] || 0) + 1;
  }
  for (const [ws, count] of Object.entries(byWorkspace)) {
    console.log(`  - workspace ${ws}: ${count} transaction(s)`);
  }

  console.log("\nAperçu (5 premières) :");
  for (const tx of targets.slice(0, 5)) {
    console.log(
      `  ${tx._id} | ${tx.date?.toISOString?.()?.slice(0, 10) || "?"} | ${
        tx.amount
      } → ${-tx.amount} | ${String(tx.description).slice(0, 50)}`,
    );
  }

  if (!APPLY) {
    console.log(
      "\n🔍 DRY-RUN : aucune modification effectuée. Relancer avec --apply pour appliquer.",
    );
    await mongoose.disconnect();
    return;
  }

  // ─── Snapshot de rollback AVANT toute écriture ───
  const rollbackPath = path.join(
    process.cwd(),
    `gocardless-amounts-rollback-${Date.now()}.json`,
  );
  fs.writeFileSync(
    rollbackPath,
    JSON.stringify(
      targets.map((tx) => ({
        _id: String(tx._id),
        workspaceId: tx.workspaceId,
        originalAmount: tx.amount,
      })),
      null,
      2,
    ),
  );
  console.log(`\n💾 Snapshot de rollback écrit : ${rollbackPath}`);

  // ─── Application : updates conditionnelles une par une ───
  let updated = 0;
  let skipped = 0;
  for (const tx of targets) {
    const res = await transactions.updateOne(
      { _id: tx._id, amount: tx.amount },
      { $set: { amount: -tx.amount } },
    );
    if (res.modifiedCount === 1) updated += 1;
    else {
      skipped += 1;
      console.log(
        `⚠️  ${tx._id} ignorée (montant modifié entre le snapshot et l'update, probablement par un sync)`,
      );
    }
  }

  console.log("\n═══════════════════════════════════════════════════");
  console.log(
    `✅ ${updated} transaction(s) corrigée(s), ⚠️ ${skipped} ignorée(s)`,
  );
  console.log(
    `💾 Rollback possible : node scripts/migrate-gocardless-signed-amounts.js --rollback ${rollbackPath}`,
  );
  console.log("═══════════════════════════════════════════════════");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("❌ Erreur migration:", err);
  process.exit(1);
});
