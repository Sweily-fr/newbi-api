#!/usr/bin/env node

/**
 * Recalcul des totaux enregistrés des devis et bons de commande (remise en
 * état octobre 2026).
 *
 * Contexte : jusqu'au correctif « totaux enregistrés alignés sur l'aperçu
 * PDF », le pre-save de Quote et PurchaseOrder ignorait les frais de port (et
 * écrasait le TTC calculé par le resolver), et ne plafonnait pas la remise
 * globale. Le pre-save corrige un document à son prochain enregistrement,
 * mais d'ici là les listes, statistiques et exports gardent les anciens
 * montants.
 *
 * Le script recalcule chaque document comme le pre-save actuel
 * (computeDocumentTotals arrondi au centime) et ne réécrit que ceux dont un
 * total diffère.
 *
 * Documents finalisés (tout statut autre que DRAFT : devis en attente,
 * accepté, refusé, importé ; BC confirmé, validé, en cours, livré, annulé) :
 * leur PDF est archivé. Ce PDF calcule ses totaux depuis les lignes, port
 * compris : il affiche déjà les montants justes, et corriger les totaux
 * enregistrés les aligne sur lui sans le régénérer. Par prudence ils sont
 * seulement listés par défaut ; --include-finalized les corrige aussi.
 *
 * Aperçu par défaut. Avec --apply, les valeurs d'avant sont sauvegardées
 * (backups/remise-en-etat/devis-bc-totaux-<date>.json) avant toute écriture ;
 * `updatedAt` ne bouge pas. Idempotent.
 *
 * Usage (depuis la racine de l'API) :
 *   NODE_ENV=production node scripts/recompute-quote-purchase-order-totals.js
 *   NODE_ENV=production node scripts/recompute-quote-purchase-order-totals.js --apply
 *   NODE_ENV=production node scripts/recompute-quote-purchase-order-totals.js --include-finalized --apply
 *   NODE_ENV=production node scripts/recompute-quote-purchase-order-totals.js --restore <sauvegarde.json> [--apply]
 *
 * Options :
 *   --apply               écrit en base (sans cette option : aperçu, aucune écriture)
 *   --include-finalized   corrige aussi les documents finalisés (PDF archivé)
 *   --type <t>            quote | purchaseOrder (défaut : les deux)
 *   --workspace <id>      limite à une organisation
 *   --limit <n>           limite le nombre de documents examinés, par type
 *   --restore <fichier>   remet les valeurs d'une sauvegarde (aperçu sans --apply)
 */

import mongoose from "mongoose";
import Quote from "../src/models/Quote.js";
import PurchaseOrder from "../src/models/PurchaseOrder.js";
import { computeDocumentTotals } from "../src/utils/documentTotals.js";
import {
  amountDiffers,
  applyEntry,
  connectFromEnv,
  createBackup,
  describeChanges,
  documentNumber,
  isCliEntry,
  parseArgs,
  pickValues,
  restoreBackup,
  toObjectId,
} from "./lib/remise-en-etat.js";

/** Totaux posés par le pre-save de Quote et PurchaseOrder. */
export const DOCUMENT_TOTAL_FIELDS = [
  "totalHT",
  "totalVAT",
  "totalTTC",
  "finalTotalHT",
  "finalTotalVAT",
  "finalTotalTTC",
  "discountAmount",
];

const FIELD_LABELS = {
  totalHT: "HT avant remise",
  totalVAT: "TVA avant remise",
  totalTTC: "TTC avant remise",
  finalTotalHT: "HT",
  finalTotalVAT: "TVA",
  finalTotalTTC: "TTC",
  discountAmount: "remise",
};

export const DOCUMENT_TYPES = {
  quote: { Model: Quote, label: "Devis" },
  purchaseOrder: { Model: PurchaseOrder, label: "Bon de commande" },
};

/**
 * Totaux du pre-save (models/Quote.js et models/PurchaseOrder.js) pour un
 * document Mongoose : computeDocumentTotals, puis arrondi au centime.
 */
export function presaveTotals(doc) {
  const totals = computeDocumentTotals({
    items: doc.items,
    discount: doc.discount,
    discountType: doc.discountType,
    shipping: doc.shipping,
    isReverseCharge: doc.isReverseCharge,
  });
  const round2 = (value) => parseFloat(value.toFixed(2));
  return Object.fromEntries(
    DOCUMENT_TOTAL_FIELDS.map((field) => [field, round2(totals[field])]),
  );
}

const emptyStats = () => ({
  scanned: 0,
  withoutItems: 0,
  unchanged: 0,
  toFix: 0,
  finalizedSkipped: 0,
  updated: 0,
  changedSince: 0,
});

/**
 * @param {Object} [options]
 * @param {boolean} [options.apply=false] écrire en base (sinon aperçu)
 * @param {boolean} [options.includeFinalized=false] corriger aussi les documents finalisés
 * @param {string[]} [options.types] types traités (quote, purchaseOrder)
 * @param {string} [options.workspaceId] limiter à une organisation
 * @param {number} [options.limit] nombre maximal de documents examinés par type
 * @param {string} [options.backupDir] dossier de la sauvegarde
 * @param {Function} [options.log] sortie des lignes de détail
 */
export async function recomputeQuotePurchaseOrderTotals({
  apply = false,
  includeFinalized = false,
  types = Object.keys(DOCUMENT_TYPES),
  workspaceId = null,
  limit = 0,
  backupDir,
  log = console.log,
} = {}) {
  const result = { backupFile: null };
  const entries = [];

  for (const type of types) {
    const spec = DOCUMENT_TYPES[type];
    if (!spec) throw new Error(`Type inconnu : ${type}`);
    const stats = emptyStats();
    result[type] = stats;

    const filter = workspaceId ? { workspaceId: toObjectId(workspaceId) } : {};
    let query = spec.Model.find(filter).sort({ _id: 1 }).lean();
    if (limit > 0) query = query.limit(limit);

    for await (const raw of query.cursor()) {
      stats.scanned += 1;
      // Le pre-save ne calcule rien sans articles : rien à aligner
      if (!Array.isArray(raw.items) || raw.items.length === 0) {
        stats.withoutItems += 1;
        continue;
      }

      // Document Mongoose : mêmes valeurs par défaut que dans le pre-save
      const totals = presaveTotals(spec.Model.hydrate(raw));
      const changed = DOCUMENT_TOTAL_FIELDS.filter((field) =>
        amountDiffers(raw[field], totals[field]),
      );
      if (changed.length === 0) {
        stats.unchanged += 1;
        continue;
      }

      const label = `${spec.label} ${documentNumber(raw)}`;
      const shipping =
        raw.shipping?.billShipping && raw.shipping?.shippingAmountHT > 0
          ? " [port facturé]"
          : "";
      const finalized = raw.status !== "DRAFT";
      const context = `${raw._id}, ${raw.status || "sans statut"}${
        finalized
          ? raw.archivedPdfKey
            ? ", PDF archivé"
            : ", sans PDF archivé"
          : ""
      }, espace ${raw.workspaceId}`;
      const detail = `${describeChanges(raw, totals, changed, FIELD_LABELS)}${shipping}`;

      if (finalized && !includeFinalized) {
        stats.finalizedSkipped += 1;
        log(
          `  ⏸ ${label} (${context}) : finalisé, ignoré sans --include-finalized. Écart : ${detail}`,
        );
        continue;
      }

      stats.toFix += 1;
      entries.push({
        collection: spec.Model.collection.collectionName,
        type,
        _id: raw._id,
        label,
        workspaceId: raw.workspaceId,
        before: pickValues(raw, DOCUMENT_TOTAL_FIELDS),
        after: totals,
      });
      log(`  · ${label} (${context}) : ${detail}`);
    }
  }

  if (!apply || entries.length === 0) return result;

  // Sauvegarde AVANT la première écriture
  const backup = createBackup({
    name: "devis-bc-totaux",
    dir: backupDir,
    meta: { includeFinalized },
  });
  backup.entries.push(...entries);
  result.backupFile = backup.save();

  for (const entry of entries) {
    if (await applyEntry(entry)) {
      result[entry.type].updated += 1;
    } else {
      result[entry.type].changedSince += 1;
      // Rien n'a été écrit : rien à remettre au retour arrière
      entry.after = null;
      log(`  - ${entry.label} : modifié depuis l'aperçu, laissé tel quel`);
    }
  }
  backup.save();

  return result;
}

async function main() {
  const args = parseArgs();
  const type = args.value("--type");
  const includeFinalized = args.flag("--include-finalized");
  const database = await connectFromEnv();
  console.log(
    `✅ Connecté à la base ${database} (${args.apply ? "écriture" : "aperçu, aucune écriture : --apply pour écrire"}${includeFinalized ? ", documents finalisés inclus" : ""})`,
  );

  try {
    if (args.restore) {
      const stats = await restoreBackup(args.restore, { apply: args.apply });
      console.log(
        `\n${stats.entries} document(s) dans la sauvegarde : ${args.apply ? `${stats.restored} remis à l'état d'avant` : `${stats.restorable} à remettre`}, ${stats.skipped} laissé(s) tel(s) quel(s).`,
      );
      return;
    }

    const result = await recomputeQuotePurchaseOrderTotals({
      apply: args.apply,
      includeFinalized,
      types: type ? [type] : undefined,
      workspaceId: args.workspaceId,
      limit: args.limit,
    });

    console.log("");
    for (const [key, spec] of Object.entries(DOCUMENT_TYPES)) {
      const stats = result[key];
      if (!stats) continue;
      console.log(
        `${spec.label} : ${stats.scanned} examiné(s), ${stats.unchanged} déjà juste(s), ` +
          `${stats.toFix} à corriger, ${stats.finalizedSkipped} finalisé(s) ignoré(s)` +
          `${stats.finalizedSkipped ? " (--include-finalized pour les corriger)" : ""}, ` +
          `${stats.withoutItems} sans article` +
          (args.apply
            ? `, ${stats.updated} mis à jour, ${stats.changedSince} modifié(s) entre-temps.`
            : "."),
      );
    }
    if (result.backupFile) console.log(`💾 Sauvegarde : ${result.backupFile}`);
  } finally {
    await mongoose.disconnect();
  }
}

if (isCliEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Erreur:", error);
      process.exit(1);
    });
}
