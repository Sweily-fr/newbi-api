#!/usr/bin/env node

/**
 * Réparation : une facture d'achat sur laquelle la déduplication OCR a empilé
 * les justificatifs et les débits d'autres mois (incident Canva du
 * 21/09/2026 : facture d'août 2026 avec 24 fichiers et 24 transactions).
 *
 * Pour chaque transaction liée autre que celle à conserver :
 *   1. retire le lien facture ↔ transaction (les deux côtés, même logique que
 *      la mutation unlinkPurchaseInvoiceFromTransaction) ;
 *   2. retire de la facture le fichier venu du justificatif de cette
 *      transaction et remet ce justificatif « à traiter » ;
 *   3. relance le traitement du justificatif (processReceiptsForTransaction),
 *      qui crée la facture du bon mois avec la déduplication corrigée.
 *
 * Une sauvegarde JSON de la facture et de toutes ses transactions liées est
 * écrite AVANT toute modification (restauration : voir restoreFromBackup en
 * bas de ce fichier, `--restore <fichier>`).
 *
 * Usage :
 *   NODE_ENV=production node scripts/split-overlinked-purchase-invoice.js \
 *     --invoice <purchaseInvoiceId> --keep <transactionId> [--apply] [--no-reprocess]
 *   NODE_ENV=production node scripts/split-overlinked-purchase-invoice.js --restore <backup.json>
 *
 *   Sans --apply : aperçu (sauvegarde écrite quand même, aucune modification).
 *   --no-reprocess : délie seulement, sans relancer l'OCR (les justificatifs
 *   restent « à traiter » sur leurs transactions, relançables depuis l'appli).
 */

import "../src/config/env.js";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { EJSON } from "bson";
import PurchaseInvoice from "../src/models/PurchaseInvoice.js";
import Transaction from "../src/models/Transaction.js";
import { reconciliationLinkPull } from "../src/utils/reconciliationLinkOrigin.js";
import { NO_LINKED_DOCUMENTS_CLAUSES } from "../src/utils/transactionLinks.js";
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
const REPROCESS = !args.includes("--no-reprocess");
const INVOICE_ID = argValue("--invoice");
const KEEP_TX_ID = argValue("--keep");
const RESTORE_FILE = argValue("--restore");

const BACKUP_DIR = path.resolve(process.cwd(), "backups");

const sameFile = (invoiceFile, receiptFile) =>
  (invoiceFile.path && invoiceFile.path === receiptFile.key) ||
  (invoiceFile.url && invoiceFile.url === receiptFile.url);

async function writeBackup(invoiceId, rawInvoice, rawTransactions) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(
    BACKUP_DIR,
    `split-invoice-${invoiceId}-${stamp}.json`,
  );
  // EJSON : ObjectId, dates et chaînes restent distinguables à la restauration
  // (Transaction.workspaceId est une chaîne, PurchaseInvoice.workspaceId un ObjectId).
  fs.writeFileSync(
    file,
    EJSON.stringify(
      {
        createdAt: new Date(),
        invoice: rawInvoice,
        transactions: rawTransactions,
      },
      null,
      2,
    ),
  );
  return file;
}

async function split() {
  if (!INVOICE_ID || !KEEP_TX_ID) {
    console.error("--invoice <id> et --keep <transactionId> sont requis");
    process.exit(1);
  }
  const invoiceId = new mongoose.Types.ObjectId(INVOICE_ID);
  const db = mongoose.connection.db;

  const rawInvoice = await db
    .collection("purchaseinvoices")
    .findOne({ _id: invoiceId });
  if (!rawInvoice) {
    console.error(`Facture ${INVOICE_ID} introuvable`);
    process.exit(1);
  }
  const workspaceId = String(rawInvoice.workspaceId);

  // Transactions liées vues des deux côtés (le lien peut être asymétrique).
  const linkedFromInvoice = (rawInvoice.linkedTransactionIds || []).map(String);
  const rawTransactions = await db
    .collection("transactions")
    .find({
      $or: [
        {
          _id: {
            $in: linkedFromInvoice.map((id) => new mongoose.Types.ObjectId(id)),
          },
        },
        { linkedPurchaseInvoiceIds: invoiceId },
        { "receiptFiles.purchaseInvoiceId": invoiceId },
      ],
    })
    .toArray();

  console.log(
    `Facture ${INVOICE_ID} « ${rawInvoice.supplierName} » ${rawInvoice.amountTTC} ${rawInvoice.currency || "EUR"} du ${rawInvoice.issueDate?.toISOString?.().slice(0, 10)} : ${(rawInvoice.files || []).length} fichiers, ${rawTransactions.length} transactions liées`,
  );
  if (!rawTransactions.some((t) => String(t._id) === KEEP_TX_ID)) {
    console.error(
      `La transaction à conserver ${KEEP_TX_ID} n'est pas liée à cette facture`,
    );
    process.exit(1);
  }

  const backupFile = await writeBackup(INVOICE_ID, rawInvoice, rawTransactions);
  console.log(`💾 Sauvegarde écrite : ${backupFile}`);

  const toDetach = rawTransactions.filter((t) => String(t._id) !== KEEP_TX_ID);
  const plan = toDetach.map((tx) => {
    const receipts = (tx.receiptFiles || []).filter(
      (f) => String(f.purchaseInvoiceId) === INVOICE_ID,
    );
    const invoiceFiles = (rawInvoice.files || []).filter((f) =>
      receipts.some((r) => sameFile(f, r)),
    );
    return { tx, receipts, invoiceFiles };
  });

  console.log(
    `\nPlan : conserver ${KEEP_TX_ID}, délier ${toDetach.length} transactions`,
  );
  for (const { tx, receipts, invoiceFiles } of plan) {
    console.log(
      `  - ${tx._id} ${tx.date?.toISOString?.().slice(0, 10)} ${tx.amount} « ${tx.description} » : ${receipts.length} justificatif(s) à remettre à traiter, ${invoiceFiles.length} fichier(s) à retirer de la facture (${invoiceFiles.map((f) => f.originalFilename || f.filename).join(", ")})`,
    );
  }

  if (!APPLY) {
    console.log("\nAperçu seulement. Relancer avec --apply pour appliquer.");
    return;
  }

  console.log("\nApplication...");
  for (const { tx, receipts, invoiceFiles } of plan) {
    // Côté transaction : lien + origine retirés, justificatif remis à traiter.
    await Transaction.updateOne(
      { _id: tx._id },
      {
        $pull: {
          linkedPurchaseInvoiceIds: invoiceId,
          ...reconciliationLinkPull("PURCHASE_INVOICE", [invoiceId]),
        },
      },
    );
    if (receipts.length > 0) {
      await Transaction.updateOne(
        { _id: tx._id },
        {
          $set: {
            "receiptFiles.$[elem].purchaseInvoiceId": null,
            "receiptFiles.$[elem].ocrProcessed": false,
            "receiptFiles.$[elem].ocrClaimedAt": null,
          },
        },
        { arrayFilters: [{ "elem.purchaseInvoiceId": invoiceId }] },
      );
    }
    await Transaction.updateOne(
      { _id: tx._id, $and: NO_LINKED_DOCUMENTS_CLAUSES },
      { $set: { reconciliationStatus: "unmatched", reconciliationDate: null } },
    );

    // Côté facture : lien et fichiers retirés (update ciblé, pas de save()).
    const pull = { linkedTransactionIds: tx._id };
    if (invoiceFiles.length > 0) {
      pull.files = { path: { $in: invoiceFiles.map((f) => f.path) } };
    }
    await PurchaseInvoice.updateOne({ _id: invoiceId }, { $pull: pull });
    console.log(`  ✓ ${tx._id} délié`);
  }

  const afterUnlink = await PurchaseInvoice.findById(invoiceId).lean();
  console.log(
    `\nFacture après déliaison : ${(afterUnlink.files || []).length} fichier(s), ${(afterUnlink.linkedTransactionIds || []).length} transaction(s) liée(s)`,
  );

  if (!REPROCESS) {
    console.log(
      "--no-reprocess : justificatifs laissés « à traiter » sur leurs transactions.",
    );
    return;
  }

  console.log(
    "\nRelance du traitement des justificatifs (une transaction à la fois)...",
  );
  const userId = String(rawInvoice.createdBy);
  const created = [];
  for (const { tx, receipts } of plan) {
    if (receipts.length === 0) continue;
    try {
      const invoices =
        await transactionReceiptOcrService.processReceiptsForTransaction({
          transactionId: String(tx._id),
          workspaceId,
          userId,
        });
      for (const inv of invoices) {
        created.push(inv);
        console.log(
          `  ✓ ${tx._id} ${tx.date?.toISOString?.().slice(0, 10)} → facture ${inv._id} « ${inv.supplierName} » ${inv.amountTTC} du ${inv.issueDate?.toISOString?.().slice(0, 10)}${String(inv._id) === INVOICE_ID ? "  ⚠️ RATTACHÉE À LA FACTURE D'ORIGINE" : ""}`,
        );
      }
      if (invoices.length === 0) {
        console.log(
          `  ⚠️ ${tx._id} : aucune facture créée (voir les logs du service)`,
        );
      }
    } catch (err) {
      console.log(`  ✗ ${tx._id} : ${err.message}`);
    }
  }

  const final = await PurchaseInvoice.findById(invoiceId).lean();
  console.log(
    `\nTerminé : ${created.length} facture(s) créée(s). Facture d'origine : ${(final.files || []).length} fichier(s), ${(final.linkedTransactionIds || []).length} transaction(s) liée(s).`,
  );
  console.log(`Sauvegarde : ${backupFile}`);
}

/**
 * Restauration : remet la facture et les transactions telles qu'elles étaient
 * dans la sauvegarde. Les factures créées par la relance OCR après la
 * sauvegarde ne sont PAS supprimées automatiquement (elles sont listées pour
 * suppression à la main, par prudence).
 */
async function restoreFromBackup(file) {
  const data = EJSON.parse(fs.readFileSync(file, "utf8"));
  const db = mongoose.connection.db;

  if (!APPLY) {
    console.log(
      `Aperçu : restaurerait la facture ${data.invoice._id} et ${data.transactions.length} transactions depuis ${file}. Relancer avec --apply.`,
    );
    return;
  }
  const { _id: invoiceId, ...invoiceBody } = data.invoice;
  await db
    .collection("purchaseinvoices")
    .replaceOne({ _id: invoiceId }, invoiceBody, { upsert: true });
  for (const tx of data.transactions) {
    const { _id: txId, ...body } = tx;
    await db
      .collection("transactions")
      .replaceOne({ _id: txId }, body, { upsert: true });
  }
  const since = new Date(data.createdAt);
  const createdAfter = await db
    .collection("purchaseinvoices")
    .find({
      workspaceId: invoiceBody.workspaceId,
      createdAt: { $gte: since },
      supplierName: invoiceBody.supplierName,
    })
    .project({ supplierName: 1, issueDate: 1, amountTTC: 1 })
    .toArray();
  console.log(
    `✓ Facture et ${data.transactions.length} transactions restaurées.`,
  );
  if (createdAfter.length) {
    console.log(
      `⚠️ ${createdAfter.length} facture(s) créée(s) après la sauvegarde, à supprimer à la main si besoin :`,
    );
    for (const inv of createdAfter)
      console.log(
        `   ${inv._id} ${inv.supplierName} ${inv.issueDate?.toISOString?.().slice(0, 10)} ${inv.amountTTC}`,
      );
  }
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  try {
    if (RESTORE_FILE) await restoreFromBackup(RESTORE_FILE);
    else await split();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("❌ Erreur:", err);
  process.exit(1);
});
