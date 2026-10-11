#!/usr/bin/env node

/**
 * Réarchivage des factures modifiées après leur archivage (remise en état
 * octobre 2026).
 *
 * Contexte : jusqu'au correctif « archive Factur-X régénérée après
 * modification d'une facture émise », une facture en attente ou payée
 * modifiée gardait l'archive Factur-X de sa finalisation : l'aperçu, le
 * bouton PDF et les e-mails ou relances sans PDF joint servaient l'ancienne
 * version. Depuis, l'API réarchive après chaque modification
 * (triggerInvoiceFacturXArchive) ; ce script rattrape les factures modifiées
 * avant.
 *
 * Sélection : factures émises (hors brouillon) dont l'archive est générée par
 * Newbi (archivedPdfSource NEWBI) et dont la date de modification (updatedAt)
 * dépasse la date d'archivage (archivedPdfStoredAt) de plus de --marge
 * secondes (l'archivage lui-même touche updatedAt quelques millisecondes
 * après). La liste est plus large que nécessaire : un paiement, un envoi par
 * e-mail ou un rapprochement changent aussi updatedAt. Réarchiver une facture
 * inchangée régénère le même contenu : cela ne coûte qu'une génération PDF.
 *
 * Une facture transmise en facturation électronique (règle eInvoiceLock :
 * superPdpInvoiceId ou statut e-invoicing déposé) n'est JAMAIS réarchivée :
 * le document faisant foi est celui reçu par la plateforme. Elle est listée
 * à part. Note : scripts/regenerate-archived-pdfs.js ne fait pas cette
 * exclusion, il ne faut pas l'utiliser ici.
 *
 * Avec --apply, pour chaque facture : copie locale de l'ancien PDF (la
 * nouvelle archive du même mois a la même clé R2 et l'écrase), génération et
 * archivage par le service de l'API (archiveInvoiceFacturX, via NewbiV2),
 * puis remise de l'ancienne date de modification (le réarchivage n'est pas
 * une modification de la facture). Les champs d'archive d'avant et d'après
 * sont sauvegardés (backups/remise-en-etat/factures-rearchivage-<date>.json,
 * PDF dans le dossier -pdf du même nom). Idempotent : une facture réarchivée
 * a une date d'archivage postérieure à sa modification.
 *
 * Usage (depuis la racine de l'API) :
 *   NODE_ENV=production node scripts/rearchive-modified-invoices.js
 *   NODE_ENV=production node scripts/rearchive-modified-invoices.js --limit 3 --apply
 *   NODE_ENV=production node scripts/rearchive-modified-invoices.js --apply
 *   NODE_ENV=production node scripts/rearchive-modified-invoices.js --restore <sauvegarde.json> [--apply]
 *
 * Options :
 *   --apply              réarchive (sans cette option : aperçu, aucune écriture)
 *   --workspace <id>     limite à une organisation
 *   --limit <n>          limite le nombre de factures examinées (plus récemment modifiées d'abord)
 *   --marge <secondes>   écart minimal modification / archivage (défaut 60)
 *   --avant <date>       seulement les factures modifiées avant cette date (ISO)
 *   --depuis <date>      seulement les factures modifiées depuis cette date (ISO)
 *   --delay <ms>         pause entre deux factures (défaut 2000 : chaque
 *                        génération lance un Puppeteer côté NewbiV2)
 *   --restore <fichier>  remet les archives d'une sauvegarde (aperçu sans --apply)
 */

import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import Invoice from "../src/models/Invoice.js";
import { isEInvoiceTransmitted } from "../src/utils/eInvoiceLock.js";
import {
  connectFromEnv,
  createBackup,
  documentNumber,
  formatDate,
  isCliEntry,
  parseArgs,
  pickValues,
  restoreBackup,
  toObjectId,
} from "./lib/remise-en-etat.js";

/** Champs de l'archive d'une facture, sauvegardés avant et après. */
export const ARCHIVE_FIELDS = [
  "archivedPdfKey",
  "archivedPdfUrl",
  "archivedPdfStoredAt",
  "archivedPdfSource",
  "facturXData",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseDate = (value, option) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Date ${option} invalide : ${value}`);
  }
  return date;
};

/**
 * Filtre des factures dont l'archive date d'avant la dernière modification.
 * Les factures transmises sont sélectionnées aussi, pour être listées à part.
 */
export function modifiedAfterArchiveFilter({
  workspaceId = null,
  marginSeconds = 60,
  before = null,
  since = null,
} = {}) {
  const filter = {
    status: { $ne: "DRAFT" },
    archivedPdfSource: "NEWBI",
    archivedPdfKey: { $nin: [null, ""] },
    archivedPdfStoredAt: { $type: "date" },
    $expr: {
      $gt: [
        "$updatedAt",
        { $add: ["$archivedPdfStoredAt", marginSeconds * 1000] },
      ],
    },
  };
  if (workspaceId) filter.workspaceId = toObjectId(workspaceId);
  if (before || since) {
    filter.updatedAt = {
      ...(before ? { $lt: before } : {}),
      ...(since ? { $gte: since } : {}),
    };
  }
  return filter;
}

/**
 * Réarchive une facture relue en base (`current`), avec les précautions
 * communes aux scripts de remise en état :
 *  1. copie locale de l'ancien PDF dans le dossier -pdf de la sauvegarde
 *     (une fois par facture : la nouvelle archive du même mois a la même clé
 *     R2 et l'écrase) ;
 *  2. génération et archivage par `archive` (service de l'API) ;
 *  3. contrôle que l'archive a bien changé ;
 *  4. remise de la date de modification `updatedAt` (le réarchivage n'est
 *     pas une modification de la facture).
 * @param {Object} current - facture lue dans la collection
 * @param {Object} entry - entrée de la sauvegarde (reçoit `oldPdfFile`)
 * @param {Object} options
 * @param {Object} options.backup - sauvegarde en cours (createBackup)
 * @param {Date} options.updatedAt - date de modification à remettre
 * @param {Function} options.archive - (invoice, workspaceId) => Promise
 * @param {Function} [options.fetchArchivedPdf] - (key) => Promise<Buffer>
 * @param {Function} [options.log]
 * @returns {Promise<{fresh?: Object, error?: string}>} la facture relue après
 *   archivage, ou la raison de l'échec
 */
export async function rearchiveInvoice(
  current,
  entry,
  { backup, updatedAt, archive, fetchArchivedPdf, log = console.log },
) {
  const pdfDirName = path.basename(backup.file, ".json") + "-pdf";
  const pdfDir = path.join(path.dirname(backup.file), pdfDirName);

  // Copie locale de l'ancien PDF : la nouvelle archive peut avoir la même
  // clé R2 (même mois) et l'écraser. Gardée telle quelle à une relance.
  if (fetchArchivedPdf && !entry.oldPdfFile) {
    try {
      const buffer = await fetchArchivedPdf(current.archivedPdfKey);
      fs.mkdirSync(pdfDir, { recursive: true });
      fs.writeFileSync(path.join(pdfDir, `${entry._id}.pdf`), buffer);
      entry.oldPdfFile = path.join(pdfDirName, `${entry._id}.pdf`);
      backup.save();
    } catch (error) {
      log(`    ⚠️ ancien PDF non copié : ${error.message}`);
    }
  }

  try {
    await archive(current, String(current.workspaceId));
  } catch (error) {
    return { error: error.message };
  }

  const fresh = await Invoice.collection.findOne({ _id: current._id });
  if (
    !fresh?.archivedPdfStoredAt ||
    fresh.archivedPdfStoredAt.getTime() ===
      current.archivedPdfStoredAt?.getTime()
  ) {
    return {
      error: "archive non régénérée (INTERNAL_API_SECRET, FRONTEND_URL ?)",
    };
  }

  // Date de modification d'avant : le réarchivage n'en est pas une
  await Invoice.collection.updateOne(
    { _id: current._id, archivedPdfStoredAt: fresh.archivedPdfStoredAt },
    { $set: { updatedAt } },
  );
  return { fresh };
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.apply=false] réarchiver (sinon aperçu)
 * @param {string} [options.workspaceId] limiter à une organisation
 * @param {number} [options.limit] nombre maximal de factures examinées
 * @param {number} [options.marginSeconds=60] écart minimal modification / archivage
 * @param {Date} [options.before] factures modifiées avant cette date
 * @param {Date} [options.since] factures modifiées depuis cette date
 * @param {number} [options.delayMs=2000] pause entre deux factures
 * @param {Function} [options.archive] (invoice, workspaceId) => Promise, archivage Factur-X
 * @param {Function} [options.fetchArchivedPdf] (key) => Promise<Buffer>, lecture de l'ancien PDF
 * @param {string} [options.backupDir] dossier de la sauvegarde
 * @param {Function} [options.log] sortie des lignes de détail
 */
export async function rearchiveModifiedInvoices({
  apply = false,
  workspaceId = null,
  limit = 0,
  marginSeconds = 60,
  before = null,
  since = null,
  delayMs = 2000,
  archive,
  fetchArchivedPdf,
  backupDir,
  log = console.log,
} = {}) {
  if (apply && typeof archive !== "function") {
    throw new Error("Fonction d'archivage manquante");
  }

  let query = Invoice.find(
    modifiedAfterArchiveFilter({ workspaceId, marginSeconds, before, since }),
  )
    .select(
      `_id workspaceId prefix number status superPdpInvoiceId eInvoiceStatus updatedAt ${ARCHIVE_FIELDS.join(" ")}`,
    )
    .sort({ updatedAt: -1, _id: 1 })
    .lean();
  if (limit > 0) query = query.limit(limit);

  const stats = {
    scanned: 0,
    candidates: 0,
    transmitted: 0,
    rearchived: 0,
    changedSince: 0,
    failed: 0,
    backupFile: null,
  };
  const candidates = [];

  for await (const raw of query.cursor()) {
    stats.scanned += 1;
    const label = `Facture ${documentNumber(raw)}`;
    const dates = `archivée le ${formatDate(raw.archivedPdfStoredAt)}, modifiée le ${formatDate(raw.updatedAt)}`;

    if (isEInvoiceTransmitted(raw)) {
      stats.transmitted += 1;
      log(
        `  🔒 ${label} (${raw._id}, ${raw.status}) : transmise en e-facturation, jamais réarchivée (${dates})`,
      );
      continue;
    }

    stats.candidates += 1;
    candidates.push(raw);
    log(
      `  · ${label} (${raw._id}, ${raw.status}, espace ${raw.workspaceId}) : ${dates}`,
    );
  }

  if (!apply || candidates.length === 0) return stats;

  const backup = createBackup({
    name: "factures-rearchivage",
    dir: backupDir,
    meta: { marginSeconds, before, since },
  });
  for (const raw of candidates) {
    backup.entries.push({
      collection: Invoice.collection.collectionName,
      _id: raw._id,
      label: `Facture ${documentNumber(raw)}`,
      workspaceId: raw.workspaceId,
      updatedAt: raw.updatedAt,
      before: pickValues(raw, ARCHIVE_FIELDS),
      after: null,
      oldPdfFile: null,
    });
  }
  // Sauvegarde AVANT la première écriture, réécrite après chaque facture
  stats.backupFile = backup.save();

  for (const [index, entry] of backup.entries.entries()) {
    const progress = `(${index + 1}/${backup.entries.length})`;
    const previous = entry.before;

    // Relecture : la facture a pu être transmise, modifiée ou réarchivée
    // depuis l'aperçu
    const current = await Invoice.collection.findOne({ _id: entry._id });
    if (
      !current ||
      current.status === "DRAFT" ||
      isEInvoiceTransmitted(current) ||
      current.archivedPdfKey !== previous.archivedPdfKey ||
      current.archivedPdfStoredAt?.getTime() !==
        previous.archivedPdfStoredAt?.getTime()
    ) {
      stats.changedSince += 1;
      log(
        `  - ${entry.label} : changée depuis l'aperçu, laissée telle quelle ${progress}`,
      );
      continue;
    }

    const { fresh, error } = await rearchiveInvoice(current, entry, {
      backup,
      updatedAt: entry.updatedAt,
      archive,
      fetchArchivedPdf,
      log,
    });
    if (error) {
      stats.failed += 1;
      log(`  ❌ ${entry.label} : ${error} ${progress}`);
      await sleep(delayMs);
      continue;
    }

    entry.after = pickValues(fresh, ARCHIVE_FIELDS);
    // Retour arrière : seulement si l'archive est toujours celle posée ici
    entry.restoreMatch = {
      archivedPdfKey: fresh.archivedPdfKey,
      archivedPdfStoredAt: fresh.archivedPdfStoredAt,
    };
    backup.save();
    stats.rearchived += 1;
    log(`  ✓ ${entry.label} réarchivée ${progress}`);
    await sleep(delayMs);
  }

  return stats;
}

/**
 * Après le retour arrière d'une facture : si l'ancienne archive avait la même
 * clé R2 que la nouvelle, elle a été écrasée ; on y remet la copie locale.
 * Rien à faire si la facture n'a pas été réarchivée (pas de clé d'archive
 * dans l'état d'avant).
 */
export function restoreOldPdf(uploadArchivedPdf, log = console.log) {
  return async (entry, backupFile) => {
    if (
      !entry.oldPdfFile ||
      !entry.before?.archivedPdfKey ||
      entry.before.archivedPdfKey !== entry.after?.archivedPdfKey
    ) {
      return;
    }
    const file = path.join(path.dirname(backupFile), entry.oldPdfFile);
    if (!fs.existsSync(file)) {
      log(`    ⚠️ copie de l'ancien PDF introuvable : ${file}`);
      return;
    }
    await uploadArchivedPdf(entry.before.archivedPdfKey, fs.readFileSync(file));
    log(`    ↩︎ ancien PDF remis sur R2 (${entry.before.archivedPdfKey})`);
  };
}

/** Services R2 et Factur-X de l'API, chargés après .env.production. */
export async function loadServices() {
  const { default: cloudflareService } =
    await import("../src/services/cloudflareService.js");
  const { archiveInvoiceFacturX } =
    await import("../src/services/invoiceFacturXArchiveService.js");
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  return {
    archive: archiveInvoiceFacturX,
    fetchArchivedPdf: (key) => cloudflareService.getInvoiceObjectBuffer(key),
    uploadArchivedPdf: (key, buffer) =>
      cloudflareService.client.send(
        new PutObjectCommand({
          Bucket: cloudflareService.invoicesBucketName,
          Key: key,
          Body: buffer,
          ContentType: "application/pdf",
        }),
      ),
  };
}

async function main() {
  const args = parseArgs();
  const options = {
    marginSeconds: Number(args.value("--marge") ?? 60),
    before: parseDate(args.value("--avant"), "--avant"),
    since: parseDate(args.value("--depuis"), "--depuis"),
    delayMs: Number(args.value("--delay") ?? 2000),
  };
  if (!Number.isFinite(options.marginSeconds) || options.marginSeconds < 0) {
    throw new Error("--marge doit être un nombre de secondes positif");
  }

  const database = await connectFromEnv();
  console.log(
    `✅ Connecté à la base ${database} (${args.apply ? "réarchivage" : "aperçu, aucune écriture : --apply pour réarchiver"})`,
  );

  try {
    if (args.restore) {
      const services = args.apply ? await loadServices() : null;
      const stats = await restoreBackup(args.restore, {
        apply: args.apply,
        afterRestore: services
          ? restoreOldPdf(services.uploadArchivedPdf)
          : undefined,
      });
      console.log(
        `\n${stats.entries} facture(s) dans la sauvegarde : ${args.apply ? `${stats.restored} remise(s) sur l'ancienne archive` : `${stats.restorable} à remettre`}, ${stats.skipped} laissée(s) telle(s) quelle(s).`,
      );
      return;
    }

    let services = {};
    if (args.apply) {
      if (!process.env.INTERNAL_API_SECRET) {
        throw new Error(
          "INTERNAL_API_SECRET manquant : génération PDF impossible",
        );
      }
      console.log(
        `   Génération des PDF par ${process.env.FRONTEND_URL || "http://localhost:3000"}`,
      );
      services = await loadServices();
    }

    const stats = await rearchiveModifiedInvoices({
      ...options,
      apply: args.apply,
      workspaceId: args.workspaceId,
      limit: args.limit,
      archive: services.archive,
      fetchArchivedPdf: services.fetchArchivedPdf,
    });
    console.log(
      `\n${stats.scanned} facture(s) modifiée(s) après leur archivage : ` +
        `${stats.candidates} à réarchiver, ${stats.transmitted} transmise(s) en e-facturation (jamais réarchivées).`,
    );
    if (args.apply) {
      console.log(
        `${stats.rearchived} réarchivée(s), ${stats.failed} échec(s), ${stats.changedSince} changée(s) entre-temps.` +
          (stats.backupFile ? `\n💾 Sauvegarde : ${stats.backupFile}` : ""),
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (isCliEntry(import.meta.url)) {
  // Sortie explicite : les clients R2 et HTTP gardent la boucle ouverte
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Erreur:", error);
      process.exit(1);
    });
}
