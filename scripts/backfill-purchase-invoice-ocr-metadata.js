#!/usr/bin/env node

/**
 * Rétro-remplissage de `ocrMetadata` des factures d'achat existantes.
 *
 * Contexte : jusqu'au correctif « ocrMetadata lu depuis le JSON OCR brut du
 * justificatif », addPurchaseInvoiceFile ne lisait que des clés à plat en
 * camelCase alors que le desktop envoie le JSON brut de l'analyse
 * (transaction_data, extracted_fields…). Les factures concernées gardent
 * leurs justificatifs avec `files[].ocrData` renseigné mais un `ocrMetadata`
 * vide : pas de ligne « Montant sur le justificatif » (montant et devise
 * d'origine) dans le tiroir.
 *
 * Le script relit `files[].ocrData` avec la même fonction que l'API
 * (utils/purchaseInvoiceOcrMetadata.js), dans l'ordre des justificatifs (un
 * justificatif ajouté plus tard l'emporte, comme le faisait l'ajout un par
 * un). Il ne touche QUE les factures sans aucun champ OCR lu dans
 * `ocrMetadata` ; les autres champs (provider, extractionQuality…) sont
 * conservés. Idempotent : une facture remplie n'est plus sélectionnée.
 *
 * Avec --apply, l'ancien `ocrMetadata` de chaque facture est sauvegardé
 * (backups/remise-en-etat/factures-achat-ocr-metadata-<date>.json) avant
 * toute écriture ; --restore remet ces valeurs.
 *
 * Usage (depuis la racine de l'API) :
 *   NODE_ENV=production node scripts/backfill-purchase-invoice-ocr-metadata.js
 *   NODE_ENV=production node scripts/backfill-purchase-invoice-ocr-metadata.js --apply
 *   NODE_ENV=production node scripts/backfill-purchase-invoice-ocr-metadata.js --restore <sauvegarde.json> [--apply]
 *
 * Options :
 *   --apply              écrit en base (sans cette option : aperçu, aucune écriture)
 *   --workspace <id>     limite à une organisation
 *   --limit <n>          limite le nombre de factures examinées
 *   --restore <fichier>  remet les valeurs d'une sauvegarde (aperçu sans --apply)
 */

import path from "path";
import { pathToFileURL } from "url";
import mongoose from "mongoose";
import PurchaseInvoice from "../src/models/PurchaseInvoice.js";
import { ocrMetadataFromOcrData } from "../src/utils/purchaseInvoiceOcrMetadata.js";
import { createBackup, restoreBackup } from "./lib/remise-en-etat.js";

/**
 * Champs que ocrMetadataFromOcrData peut lire sur un justificatif. Une
 * facture dont `ocrMetadata` n'en porte aucun est considérée sans
 * métadonnées OCR.
 */
export const OCR_METADATA_FIELDS = [
  "supplierName",
  "supplierAddress",
  "supplierVatNumber",
  "supplierSiret",
  "invoiceNumber",
  "invoiceDate",
  "dueDate",
  "amountHT",
  "amountTVA",
  "vatRate",
  "amountTTC",
  "currency",
  "iban",
  "bic",
  "confidenceScore",
];

/**
 * `ocrMetadata` absent, nul, vide, ou sans aucun champ lu (`champ: null`
 * couvre aussi le champ absent et l'objet parent absent).
 */
const withoutOcrMetadata = () =>
  Object.fromEntries(
    OCR_METADATA_FIELDS.map((field) => [`ocrMetadata.${field}`, null]),
  );

/**
 * Métadonnées lues dans les justificatifs, dans leur ordre d'ajout : un
 * champ lu sur un justificatif plus récent remplace le précédent.
 */
export function ocrMetadataFromFiles(files = []) {
  return (Array.isArray(files) ? files : []).reduce(
    (metadata, file) => ({
      ...metadata,
      ...ocrMetadataFromOcrData(file?.ocrData),
    }),
    {},
  );
}

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {Object} [options]
 * @param {boolean} [options.apply=false] écrire en base (sinon aperçu)
 * @param {string} [options.workspaceId] limiter à une organisation
 * @param {number} [options.limit] nombre maximal de factures examinées
 * @param {string} [options.backupDir] dossier de la sauvegarde
 * @param {Function} [options.log] sortie des lignes de détail
 * @returns {Promise<{scanned: number, fillable: number, updated: number, unreadable: number, backupFile: string|null}>}
 */
export async function backfillPurchaseInvoiceOcrMetadata({
  apply = false,
  workspaceId = null,
  limit = 0,
  backupDir,
  log = console.log,
} = {}) {
  const filter = {
    ...withoutOcrMetadata(),
    // Au moins un justificatif porteur de données OCR. $elemMatch : un
    // `files.ocrData: { $ne: null }` exigerait qu'AUCUN fichier n'en soit
    // dépourvu (piège des tableaux).
    files: { $elemMatch: { ocrData: { $ne: null } } },
  };
  if (workspaceId) {
    filter.workspaceId = new mongoose.Types.ObjectId(String(workspaceId));
  }

  let query = PurchaseInvoice.find(filter)
    .select("_id workspaceId supplierName invoiceNumber ocrMetadata files")
    .sort({ _id: 1 })
    .lean();
  if (limit > 0) query = query.limit(limit);

  const stats = {
    scanned: 0,
    fillable: 0,
    updated: 0,
    unreadable: 0,
    backupFile: null,
  };
  const fillable = [];

  for await (const invoice of query.cursor()) {
    stats.scanned += 1;
    const metadata = ocrMetadataFromFiles(invoice.files);
    const fields = Object.keys(metadata);

    if (fields.length === 0) {
      stats.unreadable += 1;
      log(`  - ${invoice._id} : données OCR illisibles, ignorée`);
      continue;
    }

    stats.fillable += 1;
    fillable.push({ invoice, metadata });
    const amount =
      metadata.amountTTC !== undefined
        ? ` ${metadata.amountTTC} ${metadata.currency || ""}`.trimEnd()
        : "";
    log(
      `  ${apply ? "✓" : "·"} ${invoice._id} (${invoice.supplierName || "?"}${
        invoice.invoiceNumber ? ` ${invoice.invoiceNumber}` : ""
      })${amount} : ${fields.join(", ")}`,
    );
  }

  if (!apply || fillable.length === 0) return stats;

  // Sauvegarde de l'ancien ocrMetadata AVANT la première écriture
  const backup = createBackup({
    name: "factures-achat-ocr-metadata",
    dir: backupDir,
  });
  for (const { invoice, metadata } of fillable) {
    const ocrMetadata = {
      ...(isPlainObject(invoice.ocrMetadata) ? invoice.ocrMetadata : {}),
      ...metadata,
    };
    backup.entries.push({
      collection: PurchaseInvoice.collection.collectionName,
      _id: invoice._id,
      label: `Facture d'achat ${invoice.supplierName || "?"}${
        invoice.invoiceNumber ? ` ${invoice.invoiceNumber}` : ""
      } (${invoice._id})`,
      before: { ocrMetadata: invoice.ocrMetadata ?? null },
      after: { ocrMetadata },
      // Retour arrière seulement si les champs remplis par le script n'ont
      // pas changé depuis
      restoreMatch: Object.fromEntries(
        Object.entries(metadata).map(([field, value]) => [
          `ocrMetadata.${field}`,
          value,
        ]),
      ),
    });
  }
  stats.backupFile = backup.save();

  for (const entry of backup.entries) {
    const result = await PurchaseInvoice.updateOne(
      // Même condition qu'à la sélection : rien n'est écrasé si la facture a
      // reçu des métadonnées entre-temps
      { _id: entry._id, ...withoutOcrMetadata() },
      { $set: { ocrMetadata: entry.after.ocrMetadata } },
      // Rattrapage technique : la date de modification de la facture ne bouge pas
      { timestamps: false },
    );
    stats.updated += result.modifiedCount || 0;
    // Facture remplie entre-temps : rien à remettre au retour arrière
    if (!result.modifiedCount) entry.after = null;
  }
  backup.save();

  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const argValue = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const apply = args.includes("--apply");
  const workspaceId = argValue("--workspace");
  const limit = Number(argValue("--limit")) || 0;
  const restoreFile = argValue("--restore");

  // Chargement du .env (selon NODE_ENV) seulement en ligne de commande
  await import("../src/config/env.js");
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error("MONGODB_URI environment variable is required");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log(
    `✅ Connecté à la base ${mongoose.connection.db.databaseName} (${apply ? "écriture" : "aperçu, aucune écriture : --apply pour écrire"})`,
  );

  try {
    if (restoreFile) {
      const restored = await restoreBackup(restoreFile, { apply });
      console.log(
        `\n${restored.entries} facture(s) dans la sauvegarde : ${apply ? `${restored.restored} remise(s) à l'état d'avant` : `${restored.restorable} à remettre`}, ${restored.skipped} laissée(s) telle(s) quelle(s).`,
      );
      return;
    }

    const stats = await backfillPurchaseInvoiceOcrMetadata({
      apply,
      workspaceId,
      limit,
    });
    console.log(
      `\n${stats.scanned} facture(s) sans ocrMetadata avec données OCR, ` +
        `${stats.fillable} remplissable(s), ${stats.unreadable} illisible(s), ` +
        `${stats.updated} mise(s) à jour.` +
        (stats.backupFile ? `\n💾 Sauvegarde : ${stats.backupFile}` : ""),
    );
  } finally {
    await mongoose.disconnect();
  }
}

const isCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  main().catch((error) => {
    console.error("❌ Erreur:", error);
    process.exit(1);
  });
}
