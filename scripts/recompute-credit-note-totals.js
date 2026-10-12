#!/usr/bin/env node

/**
 * Recalcul des totaux enregistrés des avoirs (remise en état octobre 2026).
 *
 * Contexte : jusqu'au correctif « avoirs : totaux alignés sur l'aperçu »
 * (port de la facture, remise sur les articles), l'API enregistrait les
 * totaux d'un avoir sans les frais de port de la facture d'origine, et
 * appliquait la remise globale autrement que l'aperçu. Le PDF de l'avoir,
 * calculé depuis les lignes, était juste ; les montants enregistrés (listes,
 * statistiques, plafond « somme des avoirs ≤ facture », exports) ne
 * l'étaient pas.
 *
 * Le script recalcule chaque avoir avec la fonction de l'API
 * (calculateCreditNoteTotals de resolvers/creditNote.js, donc
 * computeDocumentTotals avec le port et l'auto-liquidation de la facture
 * d'origine) et ne réécrit que les avoirs dont un total diffère au centime.
 * Un avoir transmis en facturation électronique (règle eInvoiceLock) n'est
 * jamais modifié : il est listé à part. Le PDF archivé n'est pas régénéré :
 * il affichait déjà ces montants.
 *
 * Aperçu par défaut. Avec --apply, les valeurs d'avant sont sauvegardées
 * (backups/remise-en-etat/avoirs-totaux-<date>.json) avant toute écriture ;
 * `updatedAt` ne bouge pas. Idempotent : un avoir corrigé n'est plus listé.
 *
 * Usage (depuis la racine de l'API) :
 *   NODE_ENV=production node scripts/recompute-credit-note-totals.js
 *   NODE_ENV=production node scripts/recompute-credit-note-totals.js --apply
 *   NODE_ENV=production node scripts/recompute-credit-note-totals.js --restore <sauvegarde.json> [--apply]
 *
 * Options :
 *   --apply              écrit en base (sans cette option : aperçu, aucune écriture)
 *   --workspace <id>     limite à une organisation
 *   --limit <n>          limite le nombre d'avoirs examinés
 *   --restore <fichier>  remet les valeurs d'une sauvegarde (aperçu sans --apply)
 */

import mongoose from "mongoose";
import CreditNote from "../src/models/CreditNote.js";
import Invoice from "../src/models/Invoice.js";
import { isEInvoiceTransmitted } from "../src/utils/eInvoiceLock.js";
import {
  amountDiffers,
  applyEntry,
  connectFromEnv,
  createBackup,
  describeChanges,
  documentNumber,
  formatAmount,
  isCliEntry,
  parseArgs,
  pickValues,
  restoreBackup,
  toCents,
  toObjectId,
} from "./lib/remise-en-etat.js";

/** Totaux enregistrés sur un avoir (calculateCreditNoteTotals). */
export const CREDIT_NOTE_TOTAL_FIELDS = [
  "totalHT",
  "totalVAT",
  "totalTTC",
  "finalTotalHT",
  "finalTotalVAT",
  "finalTotalTTC",
];

const FIELD_LABELS = {
  totalHT: "HT avant remise",
  totalVAT: "TVA avant remise",
  totalTTC: "TTC avant remise",
  finalTotalHT: "HT",
  finalTotalVAT: "TVA",
  finalTotalTTC: "TTC",
};

/** Origine probable de l'écart, pour la relecture. */
function differenceReasons(creditNote, invoice) {
  const reasons = [];
  if (
    invoice.shipping?.billShipping &&
    invoice.shipping?.shippingAmountHT > 0
  ) {
    reasons.push("port facturé");
  }
  if (creditNote.discount > 0) reasons.push("remise globale");
  return reasons.length ? ` [${reasons.join(", ")}]` : "";
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.apply=false] écrire en base (sinon aperçu)
 * @param {string} [options.workspaceId] limiter à une organisation
 * @param {number} [options.limit] nombre maximal d'avoirs examinés
 * @param {string} [options.backupDir] dossier de la sauvegarde
 * @param {Function} [options.log] sortie des lignes de détail
 */
export async function recomputeCreditNoteTotals({
  apply = false,
  workspaceId = null,
  limit = 0,
  backupDir,
  log = console.log,
} = {}) {
  // Import différé : le resolver charge des services qui lisent l'env à
  // l'import ; en ligne de commande, .env.production est chargé avant.
  let calculateCreditNoteTotals;
  try {
    ({ calculateCreditNoteTotals } =
      await import("../src/resolvers/creditNote.js"));
  } catch (error) {
    throw new Error(
      `Chargement du calcul des avoirs impossible (${error.message}) : lancer depuis la racine de l'API, avec son fichier d'environnement (NODE_ENV=production)`,
    );
  }

  const filter = workspaceId ? { workspaceId: toObjectId(workspaceId) } : {};
  let query = CreditNote.find(filter).sort({ _id: 1 }).lean();
  if (limit > 0) query = query.limit(limit);

  const stats = {
    scanned: 0,
    unchanged: 0,
    toFix: 0,
    updated: 0,
    changedSince: 0,
    locked: 0,
    missingInvoice: 0,
    overCredited: 0,
    backupFile: null,
  };
  // Factures d'origine déjà lues (lean), null si introuvable
  const invoices = new Map();
  const entries = [];

  for await (const raw of query.cursor()) {
    stats.scanned += 1;
    const label = `Avoir ${documentNumber(raw)}`;

    const invoiceId = String(raw.originalInvoice);
    if (!invoices.has(invoiceId)) {
      // Même recherche que updateCreditNote (facture du même espace)
      invoices.set(
        invoiceId,
        await Invoice.findOne({
          _id: raw.originalInvoice,
          workspaceId: raw.workspaceId,
        }).lean(),
      );
    }
    const invoiceRaw = invoices.get(invoiceId);
    if (!invoiceRaw) {
      stats.missingInvoice += 1;
      log(`  ? ${label} (${raw._id}) : facture d'origine introuvable, ignoré`);
      continue;
    }

    // Documents Mongoose (valeurs par défaut du schéma), comme l'avoir et la
    // facture chargés par updateCreditNote
    const creditNote = CreditNote.hydrate(raw);
    const invoice = Invoice.hydrate(invoiceRaw);
    const totals = calculateCreditNoteTotals(
      creditNote.items || [],
      creditNote.discount ?? 0,
      creditNote.discountType ?? "FIXED",
      invoice.isReverseCharge || false,
      invoice.shipping,
    );

    const changed = CREDIT_NOTE_TOTAL_FIELDS.filter((field) =>
      amountDiffers(raw[field], totals[field]),
    );
    if (changed.length === 0) {
      stats.unchanged += 1;
      continue;
    }

    const detail = `${describeChanges(raw, totals, changed, FIELD_LABELS)}${differenceReasons(creditNote, invoice)}`;
    const invoiceLabel = `facture ${documentNumber(invoiceRaw)}`;

    // Avoir déposé sur la plateforme : il fait foi tel que transmis
    if (isEInvoiceTransmitted(raw)) {
      stats.locked += 1;
      log(
        `  🔒 ${label} (${raw._id}), ${invoiceLabel} : transmis en e-facturation, laissé tel quel. Écart : ${detail}`,
      );
      continue;
    }

    stats.toFix += 1;
    entries.push({
      collection: CreditNote.collection.collectionName,
      _id: raw._id,
      label,
      workspaceId: raw.workspaceId,
      originalInvoice: raw.originalInvoice,
      before: pickValues(raw, CREDIT_NOTE_TOTAL_FIELDS),
      after: pickValues(totals, CREDIT_NOTE_TOTAL_FIELDS),
    });
    log(
      `  · ${label} (${raw._id}), ${invoiceLabel}, espace ${raw.workspaceId} : ${detail}`,
    );
  }

  // Plafond « somme des avoirs ≤ facture » avec les montants corrigés : signalé
  // seulement (la facture elle-même peut porter un total enregistré faux)
  const correctedTTC = new Map(
    entries.map((entry) => [String(entry._id), entry.after.finalTotalTTC]),
  );
  const invoiceIds = [
    ...new Set(entries.map((entry) => String(entry.originalInvoice))),
  ];
  for (const invoiceId of invoiceIds) {
    const invoiceRaw = invoices.get(invoiceId);
    const creditNotes = await CreditNote.find({
      originalInvoice: invoiceRaw._id,
      workspaceId: invoiceRaw.workspaceId,
    })
      .select("finalTotalTTC")
      .lean();
    const sum = creditNotes.reduce((total, creditNote) => {
      const ttc = correctedTTC.has(String(creditNote._id))
        ? correctedTTC.get(String(creditNote._id))
        : creditNote.finalTotalTTC;
      return total + Math.abs(ttc || 0);
    }, 0);
    if (toCents(sum) > toCents(Math.abs(invoiceRaw.finalTotalTTC || 0))) {
      stats.overCredited += 1;
      log(
        `  ⚠️ Facture ${documentNumber(invoiceRaw)} (${invoiceRaw._id}) : somme des avoirs corrigés ${sum.toFixed(2)} > TTC enregistré de la facture ${formatAmount(invoiceRaw.finalTotalTTC)}, à vérifier`,
      );
    }
  }

  if (!apply || entries.length === 0) return stats;

  // Sauvegarde AVANT la première écriture
  const backup = createBackup({ name: "avoirs-totaux", dir: backupDir });
  backup.entries.push(...entries);
  stats.backupFile = backup.save();

  for (const entry of entries) {
    if (await applyEntry(entry)) {
      stats.updated += 1;
    } else {
      stats.changedSince += 1;
      // Rien n'a été écrit : rien à remettre au retour arrière
      entry.after = null;
      log(`  - ${entry.label} : modifié depuis l'aperçu, laissé tel quel`);
    }
  }
  backup.save();

  return stats;
}

async function main() {
  const args = parseArgs();
  const database = await connectFromEnv();
  console.log(
    `✅ Connecté à la base ${database} (${args.apply ? "écriture" : "aperçu, aucune écriture : --apply pour écrire"})`,
  );

  try {
    if (args.restore) {
      const stats = await restoreBackup(args.restore, { apply: args.apply });
      console.log(
        `\n${stats.entries} avoir(s) dans la sauvegarde : ${args.apply ? `${stats.restored} remis à l'état d'avant` : `${stats.restorable} à remettre`}, ${stats.skipped} laissé(s) tel(s) quel(s).`,
      );
      return;
    }

    const stats = await recomputeCreditNoteTotals({
      apply: args.apply,
      workspaceId: args.workspaceId,
      limit: args.limit,
    });
    console.log(
      `\n${stats.scanned} avoir(s) examiné(s) : ${stats.unchanged} déjà juste(s), ` +
        `${stats.toFix} à corriger, ${stats.locked} transmis en e-facturation (jamais modifiés), ` +
        `${stats.missingInvoice} sans facture d'origine, ` +
        `${stats.overCredited} facture(s) où la somme des avoirs dépasserait la facture.`,
    );
    if (args.apply) {
      console.log(
        `${stats.updated} avoir(s) mis à jour, ${stats.changedSince} modifié(s) entre-temps (non touchés).` +
          (stats.backupFile ? `\n💾 Sauvegarde : ${stats.backupFile}` : ""),
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (isCliEntry(import.meta.url)) {
  // Sortie explicite : les services chargés par le resolver gardent des
  // ressources ouvertes
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Erreur:", error);
      process.exit(1);
    });
}
