#!/usr/bin/env node

/**
 * Justificatifs de factures d'achat dont le fichier n'existe plus dans le
 * stockage (relevé le 19/11/2026 : 12 fichiers sur 7 factures).
 *
 * Contexte : un justificatif déposé sur une transaction et la facture d'achat
 * que l'OCR en tire partagent le même objet R2. Jusqu'au correctif du
 * 31/10/2026 (en prod le 11/11), retirer le justificatif de la transaction,
 * ou supprimer une autre facture d'achat du même fichier, effaçait l'objet
 * même si une facture l'utilisait encore. La facture garde alors un lien
 * mort : aperçu « Aucun fichier disponible », copie d'automatisation en
 * échec. Tous les cas relevés datent du 23 au 28/09/2026.
 *
 * Un fichier n'est retiré que s'il est introuvable des deux côtés : l'URL
 * publique répond 404 ET l'API R2 (identifiants serveur) répond « objet
 * absent ». Toute autre réponse (réseau, droits, URL non résoluble) le
 * classe « non vérifiable » : il n'est jamais touché. Les autres
 * justificatifs de la facture restent tels quels.
 *
 * Aperçu par défaut. Avec --apply, le tableau `files` complet de chaque
 * facture modifiée est sauvegardé
 * (backups/remise-en-etat/retirer-justificatifs-introuvables-<date>.json)
 * avant la première écriture ; --restore remet les liens retirés sur chaque
 * facture qui n'a pas changé depuis. `updatedAt` n'est pas modifié.
 *
 * Usage (depuis la racine de l'API) :
 *   NODE_ENV=production node scripts/retirer-justificatifs-introuvables.js
 *   NODE_ENV=production node scripts/retirer-justificatifs-introuvables.js --apply
 *   NODE_ENV=production node scripts/retirer-justificatifs-introuvables.js --restore <sauvegarde.json> [--apply]
 *
 * Options :
 *   --apply              retire les liens morts (sans : aperçu)
 *   --workspace <id>     limite à une organisation
 *   --restore <fichier>  remet l'état d'avant (aperçu sans --apply)
 */

import mongoose from "mongoose";
import {
  connectFromEnv,
  createBackup,
  formatDate,
  isCliEntry,
  parseArgs,
  restoreBackup,
  toObjectId,
} from "./lib/remise-en-etat.js";

const SCRIPT = "retirer-justificatifs-introuvables";
const CONCURRENCY = 8;

const isNotFound = (error) =>
  error?.name === "NotFound" ||
  error?.name === "NoSuchKey" ||
  error?.$metadata?.httpStatusCode === 404;

/**
 * Vérification réelle d'un fichier : URL publique puis API R2.
 * Chargé à la demande, après connectFromEnv : cloudflareService lit sa
 * configuration à l'import.
 * @returns {Promise<(url: string) => Promise<"present"|"missing"|"unknown">>}
 */
export async function makeStorageCheck() {
  const { default: cloudflareService } =
    await import("../src/services/cloudflareService.js");
  const { HeadObjectCommand } = await import("@aws-sdk/client-s3");

  return async function checkFile(url) {
    let status;
    try {
      status = (await fetch(url, { method: "HEAD" })).status;
    } catch {
      return "unknown";
    }
    if (status === 200) return "present";
    if (status !== 404) return "unknown";

    // Confirmation par l'API R2, comme la route d'aperçu de l'appli
    const resolved = cloudflareService.resolveBucketAndKeyFromUrl(url);
    if (!resolved) return "unknown";
    try {
      await cloudflareService.client.send(
        new HeadObjectCommand({ Bucket: resolved.bucket, Key: resolved.key }),
      );
      return "present";
    } catch (error) {
      return isNotFound(error) ? "missing" : "unknown";
    }
  };
}

/** Exécute `fn` sur chaque élément, `limit` à la fois. */
async function eachLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
}

const fileName = (file) =>
  file.originalFilename || file.filename || "(sans nom)";

const invoiceLabel = (invoice) =>
  `espace ${invoice.workspaceId} · facture d'achat ${invoice.supplierName || "(sans fournisseur)"} n°${invoice.invoiceNumber || "-"} (${invoice._id})`;

/**
 * Factures d'achat dont au moins un justificatif est introuvable, sans rien
 * écrire.
 * @param {Object} options
 * @param {Function} options.checkFile (url) => "present"|"missing"|"unknown"
 * @returns {Promise<{invoices: Array, checked: number, unknown: Array}>}
 *   invoices : { invoice, missing[] } ; unknown : { invoice, file }
 */
export async function findMissingFiles({
  workspaceId,
  checkFile,
  db = mongoose.connection.db,
} = {}) {
  const filter = { "files.url": { $exists: true } };
  if (workspaceId) filter.workspaceId = toObjectId(workspaceId);
  const invoices = await db
    .collection("purchaseinvoices")
    .find(filter, {
      projection: {
        workspaceId: 1,
        supplierName: 1,
        invoiceNumber: 1,
        files: 1,
      },
    })
    .toArray();

  const checks = [];
  for (const invoice of invoices) {
    for (const file of invoice.files || []) {
      if (file?.url) checks.push({ invoice, file });
    }
  }

  const missingByInvoice = new Map();
  const unknown = [];
  await eachLimit(checks, CONCURRENCY, async ({ invoice, file }) => {
    const state = await checkFile(file.url);
    if (state === "missing") {
      const id = String(invoice._id);
      if (!missingByInvoice.has(id)) {
        missingByInvoice.set(id, { invoice, missing: [] });
      }
      missingByInvoice.get(id).missing.push(file);
    } else if (state !== "present") {
      unknown.push({ invoice, file });
    }
  });

  // Ordre stable : par espace, puis par facture, fichiers dans leur ordre
  const found = [...missingByInvoice.values()].sort(
    (a, b) =>
      String(a.invoice.workspaceId).localeCompare(
        String(b.invoice.workspaceId),
      ) || String(a.invoice._id).localeCompare(String(b.invoice._id)),
  );
  for (const entry of found) {
    entry.missing.sort(
      (a, b) => entry.invoice.files.indexOf(a) - entry.invoice.files.indexOf(b),
    );
  }
  return { invoices: found, checked: checks.length, unknown };
}

/**
 * Aperçu, ou retrait des liens morts avec --apply (sauvegarde avant
 * écriture).
 */
export async function removeMissingFiles({
  apply = false,
  workspaceId,
  checkFile,
  backupDir,
  db = mongoose.connection.db,
  log = console.log,
} = {}) {
  const { invoices, checked, unknown } = await findMissingFiles({
    workspaceId,
    checkFile,
    db,
  });
  const stats = {
    checked,
    invoices: invoices.length,
    missing: invoices.reduce((n, entry) => n + entry.missing.length, 0),
    unknown: unknown.length,
    left: 0,
    removed: 0,
    unchanged: 0,
    backupFile: null,
  };

  for (const { invoice, missing } of invoices) {
    const remaining = invoice.files.length - missing.length;
    log(
      `\n${invoiceLabel(invoice)} : ${missing.length} sur ${invoice.files.length} introuvable(s)` +
        (remaining === 0 ? ", n'aura plus aucun justificatif" : ""),
    );
    for (const file of missing) {
      log(
        `  ✗ ${fileName(file)} (déposé le ${formatDate(file.createdAt)})  ${file.url}`,
      );
    }
  }
  for (const { invoice, file } of unknown) {
    log(
      `  ? non vérifiable, laissé tel quel : ${invoiceLabel(invoice)} « ${fileName(file)} »  ${file.url}`,
    );
  }

  if (!apply || invoices.length === 0) return stats;

  const backup = createBackup({
    name: SCRIPT,
    ...(backupDir ? { dir: backupDir } : {}),
    meta: { workspaceId: workspaceId || null },
  });
  stats.backupFile = backup.file;

  for (const { invoice, missing } of invoices) {
    const deadUrls = missing.map((file) => file.url);
    const remaining = invoice.files.length - missing.length;
    const entry = {
      collection: "purchaseinvoices",
      _id: invoice._id,
      label: `${invoiceLabel(invoice)} : ${missing.map(fileName).join(", ")}`,
      before: { files: invoice.files },
      after: null,
      // Retour arrière seulement si les liens n'ont pas été remis entre-temps
      // et que la facture n'a ni gagné ni perdu de justificatif depuis
      restoreMatch: {
        "files.url": { $nin: deadUrls },
        files: { $size: remaining },
      },
    };
    backup.entries.push(entry);
    backup.save();

    // Écrit seulement si la facture porte encore les mêmes justificatifs
    const result = await db.collection("purchaseinvoices").updateOne(
      {
        _id: invoice._id,
        files: { $size: invoice.files.length },
        "files.url": { $all: deadUrls },
      },
      { $pull: { files: { url: { $in: deadUrls } } } },
    );
    if (result.modifiedCount === 1) {
      const current = await db
        .collection("purchaseinvoices")
        .findOne({ _id: invoice._id }, { projection: { files: 1 } });
      entry.after = { files: current?.files || [] };
      backup.save();
      stats.removed += missing.length;
      if (remaining === 0) stats.left += 1;
    } else {
      stats.unchanged += 1;
      log(`  - ${invoiceLabel(invoice)} : modifiée entre-temps, laissée`);
    }
  }
  return stats;
}

async function main() {
  const args = parseArgs();
  const database = await connectFromEnv();
  console.log(
    `Base : ${database}${args.apply ? " (ÉCRITURE)" : " (aperçu, aucune écriture)"}`,
  );

  try {
    if (args.restore) {
      const stats = await restoreBackup(args.restore, { apply: args.apply });
      console.log(
        `\n${stats.entries} facture(s) : ${args.apply ? `${stats.restored} remise(s) en état` : `${stats.restorable} à remettre`}, ${stats.skipped} laissée(s) telle(s) quelle(s).`,
      );
      return;
    }

    const stats = await removeMissingFiles({
      apply: args.apply,
      workspaceId: args.workspaceId,
      checkFile: await makeStorageCheck(),
    });
    console.log(
      `\n${stats.checked} justificatif(s) vérifié(s) : ${stats.missing} introuvable(s) sur ${stats.invoices} facture(s), ` +
        `${stats.unknown} non vérifiable(s) (jamais touchés).`,
    );
    if (args.apply) {
      console.log(
        `${stats.removed} lien(s) retiré(s), ${stats.left} facture(s) désormais sans justificatif, ` +
          `${stats.unchanged} facture(s) modifiée(s) entre-temps et laissée(s).` +
          (stats.backupFile ? `\nSauvegarde : ${stats.backupFile}` : ""),
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (isCliEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Erreur :", error);
      process.exit(1);
    });
}
