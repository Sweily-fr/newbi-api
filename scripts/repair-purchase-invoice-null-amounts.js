#!/usr/bin/env node

/**
 * Remise en état des factures d'achat enregistrées avec un montant null.
 *
 * Contexte (incident du 15/10/2026) : le dialogue de confirmation d'un
 * justificatif envoyait `amountTVA: null` quand le champ TVA était vidé, et
 * Mongoose n'applique la valeur par défaut qu'à un champ absent : null était
 * enregistré tel quel. Le schéma GraphQL déclare ces montants non-nullables
 * (Float!), si bien qu'une seule facture de ce genre faisait échouer toute la
 * liste des factures d'achat de son espace. L'API lit désormais ces champs
 * avec une valeur par défaut et ne les enregistre plus à null ; ce script
 * remet en état les factures déjà touchées.
 *
 * Valeurs retenues, seulement pour les champs null ou absents :
 *   - TVA : TTC - HT quand le HT est connu (> 0) et ne dépasse pas le TTC,
 *     sinon 0 ;
 *   - HT : TTC - TVA quand la TVA est connue et ne dépasse pas le TTC, 0
 *     sinon ;
 *   - taux : TVA / HT quand le HT est connu (> 0), sinon 20 % (défaut) ;
 *   - TTC : HT + TVA quand les deux sont connus, sinon laissé tel quel et
 *     signalé (⚠️), à corriger dans l'appli.
 *
 * Avec --apply, les anciennes valeurs sont sauvegardées
 * (backups/remise-en-etat/factures-achat-montants-null-<date>.json) avant
 * toute écriture ; --restore remet ces valeurs. Une facture modifiée dans
 * l'appli entre l'aperçu et l'écriture est laissée telle quelle. La date de
 * modification (`updatedAt`) ne change pas.
 *
 * Usage (depuis la racine de l'API) :
 *   NODE_ENV=production node scripts/repair-purchase-invoice-null-amounts.js
 *   NODE_ENV=production node scripts/repair-purchase-invoice-null-amounts.js --apply
 *   NODE_ENV=production node scripts/repair-purchase-invoice-null-amounts.js --restore <sauvegarde.json> [--apply]
 *
 * Options :
 *   --apply              écrit en base (sans cette option : aperçu, aucune écriture)
 *   --workspace <id>     limite à une organisation
 *   --limit <n>          limite le nombre de factures examinées
 *   --restore <fichier>  remet les valeurs d'une sauvegarde (aperçu sans --apply)
 */

import mongoose from "mongoose";
import PurchaseInvoice from "../src/models/PurchaseInvoice.js";
import {
  applyEntry,
  connectFromEnv,
  createBackup,
  describeChanges,
  formatDate,
  isCliEntry,
  parseArgs,
  pickValues,
  restoreBackup,
  toObjectId,
} from "./lib/remise-en-etat.js";

export const AMOUNT_FIELDS = ["amountHT", "amountTVA", "vatRate", "amountTTC"];

const LABELS = {
  amountHT: "HT",
  amountTVA: "TVA",
  vatRate: "taux",
  amountTTC: "TTC",
};

const round2 = (n) => Math.round(n * 100) / 100;

const isKnown = (value) =>
  value !== null && value !== undefined && Number.isFinite(Number(value));

/**
 * Valeurs à écrire pour les montants null ou absents d'une facture (les
 * autres ne sont jamais touchés). `fixes` est vide quand rien n'est
 * calculable ; `unresolved` liste les champs laissés tels quels.
 */
export function computeAmountFixes(invoice) {
  const value = (field) =>
    isKnown(invoice[field]) ? Number(invoice[field]) : null;
  let ht = value("amountHT");
  let tva = value("amountTVA");
  const ttc = value("amountTTC");
  const fixes = {};
  const unresolved = [];

  if (tva === null) {
    tva =
      ttc !== null && ht !== null && ht > 0 && ttc >= ht ? round2(ttc - ht) : 0;
    fixes.amountTVA = tva;
  }
  if (ht === null) {
    ht = ttc !== null && ttc >= tva ? round2(ttc - tva) : 0;
    fixes.amountHT = ht;
  }
  if (value("vatRate") === null) {
    fixes.vatRate = ht > 0 ? round2((tva / ht) * 100) : 20;
  }
  if (ttc === null) {
    // HT et TVA enregistrés tous les deux : le TTC s'en déduit. Sinon,
    // aucun montant fiable : la facture est à reprendre dans l'appli.
    if (!("amountHT" in fixes) && !("amountTVA" in fixes)) {
      fixes.amountTTC = round2(ht + tva);
    } else {
      unresolved.push("amountTTC");
    }
  }
  return { fixes, unresolved };
}

/** Un des montants null ou absent (`champ: null` couvre les deux). */
const withNullAmount = () => ({
  $or: AMOUNT_FIELDS.map((field) => ({ [field]: null })),
});

const describeInvoice = (invoice) =>
  `${invoice._id} (${invoice.supplierName || "?"}${
    invoice.invoiceNumber ? ` ${invoice.invoiceNumber}` : ""
  }, espace ${invoice.workspaceId}, créée ${formatDate(invoice.createdAt)})`;

/**
 * @param {Object} [options]
 * @param {boolean} [options.apply=false] écrire en base (sinon aperçu)
 * @param {string} [options.workspaceId] limiter à une organisation
 * @param {number} [options.limit] nombre maximal de factures examinées
 * @param {string} [options.backupDir] dossier de la sauvegarde
 * @param {Function} [options.log] sortie des lignes de détail
 * @returns {Promise<{scanned: number, fixable: number, updated: number, unresolved: number, backupFile: string|null}>}
 */
export async function repairPurchaseInvoiceNullAmounts({
  apply = false,
  workspaceId = null,
  limit = 0,
  backupDir,
  log = console.log,
} = {}) {
  const filter = withNullAmount();
  if (workspaceId) filter.workspaceId = toObjectId(workspaceId);

  let query = PurchaseInvoice.find(filter)
    .select(
      `_id workspaceId supplierName invoiceNumber createdAt ${AMOUNT_FIELDS.join(" ")}`,
    )
    .sort({ _id: 1 })
    .lean();
  if (limit > 0) query = query.limit(limit);

  const stats = {
    scanned: 0,
    fixable: 0,
    updated: 0,
    unresolved: 0,
    backupFile: null,
  };
  const entries = [];

  for await (const invoice of query.cursor()) {
    stats.scanned += 1;
    const { fixes, unresolved } = computeAmountFixes(invoice);
    const fields = Object.keys(fixes);

    if (unresolved.length) {
      stats.unresolved += 1;
      log(
        `  ⚠️ ${describeInvoice(invoice)} : TTC absent, à corriger dans l'appli`,
      );
    }
    if (fields.length === 0) continue;

    stats.fixable += 1;
    const before = pickValues(invoice, fields);
    log(
      `  ${apply ? "✓" : "·"} ${describeInvoice(invoice)} : ${describeChanges(
        before,
        fixes,
        fields,
        LABELS,
      )}`,
    );
    entries.push({
      collection: PurchaseInvoice.collection.collectionName,
      _id: invoice._id,
      label: `Facture d'achat ${describeInvoice(invoice)}`,
      before,
      after: fixes,
    });
  }

  if (!apply || entries.length === 0) return stats;

  // Sauvegarde des anciennes valeurs AVANT la première écriture
  const backup = createBackup({
    name: "factures-achat-montants-null",
    dir: backupDir,
  });
  backup.entries.push(...entries);
  stats.backupFile = backup.save();

  for (const entry of backup.entries) {
    // Écrit seulement si la facture porte encore ses montants null
    if (await applyEntry(entry)) {
      stats.updated += 1;
    } else {
      log(`  - ${entry.label} : modifiée entre-temps, laissée telle quelle`);
      entry.after = null;
    }
  }
  backup.save();

  return stats;
}

async function main() {
  const { apply, workspaceId, limit, restore } = parseArgs();
  const dbName = await connectFromEnv();
  console.log(
    `✅ Connecté à la base ${dbName} (${apply ? "écriture" : "aperçu, aucune écriture : --apply pour écrire"})`,
  );

  try {
    if (restore) {
      const restored = await restoreBackup(restore, { apply });
      console.log(
        `\n${restored.entries} facture(s) dans la sauvegarde : ${apply ? `${restored.restored} remise(s) à l'état d'avant` : `${restored.restorable} à remettre`}, ${restored.skipped} laissée(s) telle(s) quelle(s).`,
      );
      return;
    }

    const stats = await repairPurchaseInvoiceNullAmounts({
      apply,
      workspaceId,
      limit,
    });
    console.log(
      `\n${stats.scanned} facture(s) avec un montant null, ` +
        `${stats.fixable} à corriger, ${stats.unresolved} à reprendre dans l'appli, ` +
        `${stats.updated} mise(s) à jour.` +
        (stats.backupFile ? `\n💾 Sauvegarde : ${stats.backupFile}` : ""),
    );
  } finally {
    await mongoose.disconnect();
  }
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    console.error("❌ Erreur:", error);
    process.exit(1);
  });
}
