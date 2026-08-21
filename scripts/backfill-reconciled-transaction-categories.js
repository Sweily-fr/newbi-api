#!/usr/bin/env node

/**
 * Backfill : aligne la catégorie des transactions déjà rapprochées sur celle
 * de leur facture d'achat liée (la facture fait foi — même règle que la
 * propagation au rapprochement dans purchaseInvoiceCategorySync.js).
 *
 * Cible : les factures d'achat avec linkedTransactionIds non vide et une
 * catégorie renseignée ≠ OTHER (OTHER est le fallback OCR, il n'écrase pas
 * une catégorie Bridge correcte).
 *
 * Une transaction liée à plusieurs factures prend la catégorie de la dernière
 * facture parcourue (cas marginal, même comportement qu'un re-rapprochement).
 *
 * Usage: node scripts/backfill-reconciled-transaction-categories.js [--apply]
 *   Sans --apply: mode preview (aucune modification)
 *   Avec --apply: applique les modifications
 */

import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import { PI_TO_EXPENSE_CATEGORY } from "../src/utils/purchaseInvoiceCategorySync.js";

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}
const DB_NAME = "newbi";
const APPLY = process.argv.includes("--apply");

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  const invoices = await db
    .collection("purchaseinvoices")
    .find({
      "linkedTransactionIds.0": { $exists: true },
      category: { $nin: [null, "OTHER"] },
    })
    .project({ workspaceId: 1, category: 1, linkedTransactionIds: 1 })
    .toArray();

  console.log(
    `${invoices.length} facture(s) d'achat rapprochée(s) avec catégorie exploitable`,
  );

  const ops = [];
  let alreadyAligned = 0;

  for (const inv of invoices) {
    const expenseCategory = PI_TO_EXPENSE_CATEGORY[inv.category] || "OTHER";
    const txs = await db
      .collection("transactions")
      .find({
        _id: { $in: inv.linkedTransactionIds },
        workspaceId: String(inv.workspaceId),
      })
      .project({ category: 1, expenseCategory: 1, description: 1 })
      .toArray();

    for (const tx of txs) {
      if (
        tx.category === inv.category &&
        tx.expenseCategory === expenseCategory
      ) {
        alreadyAligned++;
        continue;
      }
      if (!APPLY) {
        console.log(
          `  ${tx._id} "${(tx.description || "").slice(0, 40)}" : ${tx.category || "∅"}/${tx.expenseCategory || "∅"} -> ${inv.category}/${expenseCategory}`,
        );
      }
      ops.push({
        updateOne: {
          filter: { _id: tx._id },
          update: {
            $set: {
              category: inv.category,
              expenseCategory,
              categoryIsManual: true,
            },
          },
        },
      });
    }
  }

  console.log(
    `${ops.length} transaction(s) à aligner, ${alreadyAligned} déjà alignée(s)`,
  );

  if (APPLY && ops.length > 0) {
    const result = await db.collection("transactions").bulkWrite(ops);
    console.log(`✅ ${result.modifiedCount} transaction(s) mise(s) à jour`);
  } else if (!APPLY) {
    console.log("Mode preview — relancer avec --apply pour appliquer");
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
