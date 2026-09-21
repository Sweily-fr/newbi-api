#!/usr/bin/env node

/**
 * Retraitement OCR en lot de factures d'achat créées « au rabais » (moteur IA
 * indisponible : champs de secours depuis la transaction, fournisseur
 * approximatif, sans numéro). Même travail que « Relancer l'OCR » + accepter
 * dans l'appli, facture par facture, mais en lot et avec sauvegarde.
 *
 * Pour chaque facture : analyse des justificatifs (analyzePurchaseInvoiceFiles),
 * et application des valeurs lues SEULEMENT si l'extraction est fiable
 * (moteur IA, qualité « full ») et cohérente avec la facture (même devise,
 * TTC identique à 1 % près). Sinon la facture est laissée telle quelle et
 * listée. Les champs appliqués : fournisseur (nom + fiche Supplier),
 * numéro, date d'émission, échéance, HT/TVA/taux, métadonnées OCR. Le TTC, la
 * catégorie, le statut et les liens ne bougent pas. Les fiches fournisseur
 * approximatives devenues orphelines sont supprimées.
 *
 * Usage :
 *   NODE_ENV=production node scripts/reocr-purchase-invoices.js --ids <id,id,...> [--apply]
 *   NODE_ENV=production node scripts/reocr-purchase-invoices.js \
 *     --workspace <id> --created-after <ISO> [--supplier <regex>] [--apply]
 *   NODE_ENV=production node scripts/reocr-purchase-invoices.js --restore <backup.json> --apply
 *
 *   Sans --apply : aperçu (analyse OCR réelle, aucune écriture).
 */

import "../src/config/env.js";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { EJSON } from "bson";
import PurchaseInvoice from "../src/models/PurchaseInvoice.js";
import Supplier from "../src/models/Supplier.js";
import cloudflareService from "../src/services/cloudflareService.js";
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
const IDS = argValue("--ids");
const WORKSPACE = argValue("--workspace");
const CREATED_AFTER = argValue("--created-after");
const SUPPLIER = argValue("--supplier");
const RESTORE_FILE = argValue("--restore");

const BACKUP_DIR = path.resolve(process.cwd(), "backups");
const RELIABLE_PROVIDERS = new Set(["claude-vision", "mistral"]);
const TTC_TOLERANCE_RATIO = 0.01;

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "-");

function writeBackup(invoices, suppliers) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `reocr-invoices-${stamp}.json`);
  fs.writeFileSync(
    file,
    EJSON.stringify({ createdAt: new Date(), invoices, suppliers }, null, 2),
  );
  return file;
}

async function selectInvoices() {
  if (IDS) {
    const ids = IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => new mongoose.Types.ObjectId(s));
    return PurchaseInvoice.find({ _id: { $in: ids } }).lean();
  }
  if (!WORKSPACE || !CREATED_AFTER) {
    console.error(
      "--ids <id,...> ou --workspace <id> --created-after <ISO> requis",
    );
    process.exit(1);
  }
  const query = {
    workspaceId: new mongoose.Types.ObjectId(WORKSPACE),
    createdAt: { $gte: new Date(CREATED_AFTER) },
  };
  if (SUPPLIER) query.supplierName = { $regex: SUPPLIER, $options: "i" };
  return PurchaseInvoice.find(query).sort({ issueDate: 1 }).lean();
}

async function analyze(invoice) {
  const files = (invoice.files || []).filter((f) => f.url);
  if (files.length === 0) return { ok: false, reason: "aucun fichier" };
  const inputs = await Promise.all(
    files.map(async (file) => {
      let object = null;
      try {
        object = await cloudflareService.getObjectByUrl(file.url);
      } catch {
        object = null;
      }
      const filename = file.originalFilename || file.filename || "facture.pdf";
      return {
        fileId: String(file._id),
        filename,
        receiptFile: {
          url: file.url,
          filename,
          mimetype: file.mimetype || object?.contentType || "application/pdf",
        },
        fileBuffer: object?.buffer || null,
      };
    }),
  );
  const result = await transactionReceiptOcrService.analyzePurchaseInvoiceFiles(
    {
      files: inputs,
      workspaceId: String(invoice.workspaceId),
      targetCurrency: invoice.currency || "EUR",
      defaultCurrency: invoice.ocrMetadata?.currency || null,
    },
  );
  const c = result.combined || {};
  if (!RELIABLE_PROVIDERS.has(c.provider) || c.extractionQuality !== "full") {
    return {
      ok: false,
      reason: `extraction non fiable (${c.provider || "?"} / ${c.extractionQuality || "?"})`,
      combined: c,
    };
  }
  if (!c.supplierName || !c.invoiceDate) {
    return { ok: false, reason: "fournisseur ou date manquants", combined: c };
  }
  const currency = (c.currency || invoice.currency || "EUR").toUpperCase();
  if (currency !== (invoice.currency || "EUR").toUpperCase()) {
    return {
      ok: false,
      reason: `devise lue ${currency} ≠ facture ${invoice.currency}`,
      combined: c,
    };
  }
  const ttc = Number(c.amountTTC);
  const ref = Number(invoice.amountTTC);
  if (
    ttc > 0 &&
    ref > 0 &&
    Math.abs(ttc - ref) > Math.max(ref * TTC_TOLERANCE_RATIO, 0.01)
  ) {
    return { ok: false, reason: `TTC lu ${ttc} ≠ facture ${ref}`, combined: c };
  }
  return { ok: true, combined: c };
}

async function applyProposal(invoice, c) {
  const wsId = new mongoose.Types.ObjectId(String(invoice.workspaceId));
  let supplier = await Supplier.findOne({
    workspaceId: wsId,
    name: { $regex: `^${escapeRegex(c.supplierName)}$`, $options: "i" },
  });
  if (!supplier) {
    supplier = await Supplier.create({
      name: c.supplierName,
      workspaceId: wsId,
      createdBy: invoice.createdBy,
      defaultCategory: invoice.category || "OTHER",
    });
  }
  const set = {
    supplierName: c.supplierName,
    supplierId: supplier._id,
    issueDate: new Date(c.invoiceDate),
    extractionQuality: "full",
    "ocrMetadata.supplierName": c.supplierName,
    "ocrMetadata.invoiceNumber": c.invoiceNumber || undefined,
    "ocrMetadata.invoiceDate": new Date(c.invoiceDate),
    "ocrMetadata.provider": c.provider,
    "ocrMetadata.extractionQuality": "full",
    "files.$[].ocrProcessed": true,
  };
  if (c.invoiceNumber) set.invoiceNumber = c.invoiceNumber;
  if (c.dueDate) {
    set.dueDate = new Date(c.dueDate);
    set["ocrMetadata.dueDate"] = new Date(c.dueDate);
  }
  if (c.amountHT != null) set.amountHT = c.amountHT;
  if (c.amountTVA != null) set.amountTVA = c.amountTVA;
  if (c.vatRate != null) set.vatRate = c.vatRate;
  if (typeof c.confidence === "number") {
    set["ocrMetadata.confidenceScore"] = c.confidence;
  }
  for (const k of Object.keys(set)) if (set[k] === undefined) delete set[k];
  await PurchaseInvoice.updateOne({ _id: invoice._id }, { $set: set });
  return supplier;
}

async function reocr() {
  const invoices = await selectInvoices();
  if (invoices.length === 0) {
    console.log("Aucune facture sélectionnée.");
    return;
  }
  const previousSupplierIds = [
    ...new Set(
      invoices.map((i) => i.supplierId && String(i.supplierId)).filter(Boolean),
    ),
  ];
  const suppliers = await Supplier.find({
    _id: {
      $in: previousSupplierIds.map((id) => new mongoose.Types.ObjectId(id)),
    },
  }).lean();
  const backupFile = writeBackup(invoices, suppliers);
  console.log(`${invoices.length} facture(s) sélectionnée(s)`);
  console.log(`💾 Sauvegarde écrite : ${backupFile}`);

  const plan = [];
  for (const invoice of invoices) {
    process.stdout.write(
      `  analyse ${invoice._id} ${day(invoice.issueDate)} « ${invoice.supplierName} » ... `,
    );
    try {
      const a = await analyze(invoice);
      plan.push({ invoice, ...a });
      if (a.ok) {
        const c = a.combined;
        console.log(
          `→ « ${c.supplierName} » n°${c.invoiceNumber || "-"} ${day(c.invoiceDate)} ${c.amountTTC} ${c.currency || ""} (${c.provider})`,
        );
      } else {
        console.log(`✗ laissée telle quelle : ${a.reason}`);
      }
    } catch (err) {
      plan.push({ invoice, ok: false, reason: err.message });
      console.log(`✗ erreur : ${err.message}`);
    }
  }

  const applicable = plan.filter((p) => p.ok);
  console.log(
    `\n${applicable.length}/${plan.length} facture(s) avec une lecture fiable.`,
  );
  if (!APPLY) {
    console.log("Aperçu seulement. Relancer avec --apply pour appliquer.");
    return;
  }

  console.log("\nApplication...");
  for (const p of applicable) {
    await applyProposal(p.invoice, p.combined);
    console.log(
      `  ✓ ${p.invoice._id} → « ${p.combined.supplierName} » n°${p.combined.invoiceNumber || "-"} ${day(p.combined.invoiceDate)}`,
    );
  }

  // Fiches fournisseur approximatives devenues orphelines.
  for (const id of previousSupplierIds) {
    const stillUsed = await PurchaseInvoice.countDocuments({
      supplierId: new mongoose.Types.ObjectId(id),
    });
    if (stillUsed > 0) continue;
    const s = suppliers.find((x) => String(x._id) === id);
    await Supplier.deleteOne({ _id: new mongoose.Types.ObjectId(id) });
    console.log(`  🗑 fournisseur orphelin supprimé : « ${s?.name} » (${id})`);
  }
  console.log(`\nTerminé. Sauvegarde : ${backupFile}`);
}

async function restoreFromBackup(file) {
  const data = EJSON.parse(fs.readFileSync(file, "utf8"));
  const db = mongoose.connection.db;
  if (!APPLY) {
    console.log(
      `Aperçu : restaurerait ${data.invoices.length} facture(s) et ${data.suppliers.length} fournisseur(s) depuis ${file}. Relancer avec --apply.`,
    );
    return;
  }
  for (const inv of data.invoices) {
    const { _id, ...body } = inv;
    await db
      .collection("purchaseinvoices")
      .replaceOne({ _id }, body, { upsert: true });
  }
  for (const s of data.suppliers) {
    const { _id, ...body } = s;
    await db
      .collection("suppliers")
      .replaceOne({ _id }, body, { upsert: true });
  }
  console.log(
    `✓ ${data.invoices.length} facture(s) et ${data.suppliers.length} fournisseur(s) restaurés. Les fiches fournisseur créées par le retraitement ne sont pas supprimées.`,
  );
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  try {
    if (RESTORE_FILE) await restoreFromBackup(RESTORE_FILE);
    else await reocr();
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
