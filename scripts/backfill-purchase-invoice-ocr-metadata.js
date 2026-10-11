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
 * Usage (depuis la racine de l'API) :
 *   NODE_ENV=production node scripts/backfill-purchase-invoice-ocr-metadata.js
 *   NODE_ENV=production node scripts/backfill-purchase-invoice-ocr-metadata.js --apply
 *
 * Options :
 *   --apply           écrit en base (sans cette option : aperçu, aucune écriture)
 *   --workspace <id>  limite à une organisation
 *   --limit <n>       limite le nombre de factures examinées
 */

import path from "path";
import { pathToFileURL } from "url";
import mongoose from "mongoose";
import PurchaseInvoice from "../src/models/PurchaseInvoice.js";
import { ocrMetadataFromOcrData } from "../src/utils/purchaseInvoiceOcrMetadata.js";

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
 * @param {Function} [options.log] sortie des lignes de détail
 * @returns {Promise<{scanned: number, fillable: number, updated: number, unreadable: number}>}
 */
export async function backfillPurchaseInvoiceOcrMetadata({
  apply = false,
  workspaceId = null,
  limit = 0,
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

  const stats = { scanned: 0, fillable: 0, updated: 0, unreadable: 0 };

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
    const amount =
      metadata.amountTTC !== undefined
        ? ` ${metadata.amountTTC} ${metadata.currency || ""}`.trimEnd()
        : "";
    log(
      `  ${apply ? "✓" : "·"} ${invoice._id} (${invoice.supplierName || "?"}${
        invoice.invoiceNumber ? ` ${invoice.invoiceNumber}` : ""
      })${amount} : ${fields.join(", ")}`,
    );

    if (!apply) continue;

    const result = await PurchaseInvoice.updateOne(
      // Même condition qu'à la sélection : rien n'est écrasé si la facture a
      // reçu des métadonnées entre-temps
      { _id: invoice._id, ...withoutOcrMetadata() },
      {
        $set: {
          ocrMetadata: {
            ...(isPlainObject(invoice.ocrMetadata) ? invoice.ocrMetadata : {}),
            ...metadata,
          },
        },
      },
      // Rattrapage technique : la date de modification de la facture ne bouge pas
      { timestamps: false },
    );
    stats.updated += result.modifiedCount || 0;
  }

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

  // Chargement du .env (selon NODE_ENV) seulement en ligne de commande
  await import("../src/config/env.js");
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error("MONGODB_URI environment variable is required");
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log(
    `✅ Connecté à MongoDB (${apply ? "écriture" : "aperçu, aucune écriture : --apply pour écrire"})`,
  );

  try {
    const stats = await backfillPurchaseInvoiceOcrMetadata({
      apply,
      workspaceId,
      limit,
    });
    console.log(
      `\n${stats.scanned} facture(s) sans ocrMetadata avec données OCR, ` +
        `${stats.fillable} remplissable(s), ${stats.unreadable} illisible(s), ` +
        `${stats.updated} mise(s) à jour.`,
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
