#!/usr/bin/env node

/**
 * Rattrapage : justificatifs déposés sur une transaction qui n'ont jamais
 * donné de facture d'achat.
 *
 * La création automatique depuis un justificatif ne se déclenche qu'au dépôt
 * du fichier (ou à la modification de la transaction). Les justificatifs
 * déposés avant la mise en service de cette création, ou dont le traitement a
 * été interrompu (claim resté en l'air après un redémarrage), restent donc
 * sans facture indéfiniment : 38 cas constatés sur Sweily le 22/09/2026,
 * dont 37 déposés avant le 16/07/2026.
 *
 * Le script relance simplement `processReceiptsForTransaction` sur ces
 * transactions : même chemin que l'appli, donc mêmes règles (déduplication,
 * catégorie, rapprochement, devise).
 *
 * Usage :
 *   NODE_ENV=production node scripts/backfill-receipt-purchase-invoices.js \
 *     --workspace <id> [--ids <txId,txId>] [--limit <n>] [--apply]
 *   NODE_ENV=production node scripts/backfill-receipt-purchase-invoices.js \
 *     --restore <backup.json> --apply
 *
 *   Sans --apply : aperçu (aucun OCR lancé, aucune écriture).
 *   --restore : réinstalle l'état des transactions sauvegardé et supprime les
 *   factures d'achat créées par le lot correspondant.
 */

import "../src/config/env.js";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { EJSON } from "bson";
import Transaction from "../src/models/Transaction.js";
import PurchaseInvoice from "../src/models/PurchaseInvoice.js";
import transactionReceiptOcrService from "../src/services/transactionReceiptOcrService.js";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const APPLY = args.includes("--apply");
const WORKSPACE = argValue("--workspace");
const IDS = argValue("--ids");
const LIMIT = Number(argValue("--limit")) || 0;
const RESTORE_FILE = argValue("--restore");

const BACKUP_DIR = path.resolve(process.cwd(), "backups");
// Même règle que le service : fichier sans facture, jamais traité ou dont le
// claim a expiré sans rien produire.
const STALE_CLAIM_MS = 15 * 60 * 1000;

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "-");
const pad = (v, n) => String(v).padStart(n);

const pendingReceipts = (transaction) => {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
  return (transaction.receiptFiles || []).filter(
    (f) =>
      f.url &&
      !f.purchaseInvoiceId &&
      (!f.ocrProcessed || (f.ocrClaimedAt && f.ocrClaimedAt < staleBefore)),
  );
};

function writeBackup(workspaceId, transactions) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `backfill-receipts-${stamp}.json`);
  fs.writeFileSync(
    file,
    EJSON.stringify(
      { createdAt: new Date(), workspaceId: String(workspaceId), transactions },
      null,
      2,
    ),
  );
  return file;
}

async function selectTransactions() {
  if (!WORKSPACE) {
    console.error("--workspace <id> est requis");
    process.exit(1);
  }
  const wsId = new mongoose.Types.ObjectId(WORKSPACE);
  const query = {
    workspaceId: { $in: [WORKSPACE, wsId] },
    "receiptFiles.0": { $exists: true },
  };
  if (IDS) {
    query._id = {
      $in: IDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => new mongoose.Types.ObjectId(s)),
    };
  }
  const all = await Transaction.find(query).sort({ date: -1 }).lean();
  const withPending = all.filter((t) => pendingReceipts(t).length > 0);
  return LIMIT > 0 ? withPending.slice(0, LIMIT) : withPending;
}

async function backfill() {
  const transactions = await selectTransactions();
  if (transactions.length === 0) {
    console.log("Aucun justificatif en attente de facture d'achat.");
    return;
  }
  const fileCount = transactions.reduce(
    (n, t) => n + pendingReceipts(t).length,
    0,
  );
  console.log(
    `${transactions.length} transaction(s), ${fileCount} justificatif(s) sans facture d'achat :`,
  );
  for (const t of transactions) {
    for (const f of pendingReceipts(t)) {
      console.log(
        `  ${day(t.date)} ${pad(t.amount, 9)} « ${t.description} » | ${f.filename || f.originalFilename}`,
      );
    }
  }

  if (!APPLY) {
    console.log(
      "\nAperçu seulement (aucun OCR lancé). Relancer avec --apply pour traiter.",
    );
    return;
  }

  const backupFile = writeBackup(WORKSPACE, transactions);
  console.log(`\n💾 Sauvegarde écrite : ${backupFile}`);
  console.log("Traitement (OCR réel, une transaction à la fois)...\n");

  const created = [];
  const failed = [];
  for (const t of transactions) {
    const userId = String(
      t.receiptFiles?.find((f) => f.uploadedBy)?.uploadedBy || t.userId || "",
    );
    if (!userId) {
      failed.push({ t, reason: "aucun utilisateur connu sur la transaction" });
      console.log(`  ✗ ${t._id} ${day(t.date)} : aucun utilisateur connu`);
      continue;
    }
    try {
      const invoices =
        await transactionReceiptOcrService.processReceiptsForTransaction({
          transactionId: String(t._id),
          workspaceId: String(t.workspaceId),
          userId,
        });
      if (invoices.length === 0) {
        failed.push({ t, reason: "aucune facture produite" });
        console.log(
          `  ⚠️ ${day(t.date)} « ${t.description} » : aucune facture produite`,
        );
        continue;
      }
      for (const inv of invoices) {
        created.push(inv);
        console.log(
          `  ✓ ${day(t.date)} « ${t.description} » → ${inv._id} « ${inv.supplierName} » n°${inv.invoiceNumber || "-"} ${day(inv.issueDate)} ${inv.amountTTC} ${inv.currency || "EUR"} [${inv.ocrMetadata?.extractionQuality || "?"}]`,
        );
      }
    } catch (err) {
      failed.push({ t, reason: err.message });
      console.log(`  ✗ ${day(t.date)} « ${t.description} » : ${err.message}`);
    }
  }

  console.log(
    `\nTerminé : ${created.length} facture(s) créée(s), ${failed.length} transaction(s) sans résultat.`,
  );
  const toReview = created.filter(
    (inv) => inv.ocrMetadata?.extractionQuality !== "full",
  );
  if (toReview.length > 0) {
    console.log(
      `${toReview.length} facture(s) « À compléter » (lecture partielle) : à vérifier dans l'appli.`,
    );
  }
  console.log(`Sauvegarde : ${backupFile}`);
}

/**
 * Restauration : remet les transactions dans leur état d'avant et supprime
 * les factures d'achat créées depuis la sauvegarde pour ce workspace et ces
 * transactions (source OCR uniquement, jamais une facture saisie à la main).
 */
async function restoreFromBackup(file) {
  const data = EJSON.parse(fs.readFileSync(file, "utf8"));
  const txIds = data.transactions.map((t) => t._id);
  const since = new Date(data.createdAt);
  const wsId = new mongoose.Types.ObjectId(data.workspaceId);

  const candidates = await PurchaseInvoice.find({
    workspaceId: wsId,
    source: "OCR",
    createdAt: { $gte: since },
    linkedTransactionIds: { $in: txIds },
  })
    .select("_id supplierName amountTTC issueDate")
    .lean();

  if (!APPLY) {
    console.log(
      `Aperçu : restaurerait ${data.transactions.length} transaction(s) et supprimerait ${candidates.length} facture(s) créée(s) après ${since.toISOString()}. Relancer avec --apply.`,
    );
    for (const inv of candidates) {
      console.log(
        `  ${inv._id} « ${inv.supplierName} » ${inv.amountTTC} ${day(inv.issueDate)}`,
      );
    }
    return;
  }

  const db = mongoose.connection.db;
  for (const t of data.transactions) {
    const { _id, ...body } = t;
    await db
      .collection("transactions")
      .replaceOne({ _id }, body, { upsert: true });
  }
  if (candidates.length > 0) {
    await PurchaseInvoice.deleteMany({
      _id: { $in: candidates.map((c) => c._id) },
    });
  }
  console.log(
    `✓ ${data.transactions.length} transaction(s) restaurée(s), ${candidates.length} facture(s) supprimée(s).`,
  );
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  try {
    if (RESTORE_FILE) await restoreFromBackup(RESTORE_FILE);
    else await backfill();
  } finally {
    await mongoose.disconnect();
  }
}

// Sortie explicite : les singletons du service OCR gardent la boucle ouverte.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Erreur:", err);
    process.exit(1);
  });
