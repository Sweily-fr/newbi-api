#!/usr/bin/env node

/**
 * Recalcul des totaux enregistrés des factures (remise en état octobre 2026).
 *
 * Contexte : jusqu'au correctif du 10/10/2026 « totaux enregistrés alignés
 * sur l'aperçu PDF » (utils/documentTotals.js), une facture avec frais de
 * port et remise globale en pourcentage était enregistrée avec une remise
 * appliquée aussi au port. Le PDF, calculé depuis les lignes, était juste ;
 * les totaux enregistrés ne l'étaient pas. Or ce sont eux que lisent le XML
 * Factur-X (généré par NewbiV2 depuis la facture enregistrée), le paiement
 * en ligne, le rapprochement, le plafond des avoirs et les statistiques.
 *
 * Le script recalcule chaque facture avec la fonction de l'API
 * (calculateInvoiceTotals de resolvers/invoice.js, celle de createInvoice et
 * updateInvoice : computeDocumentTotals, enregistré sans arrondi) et ne
 * réécrit que les factures dont un total diffère au centime.
 *
 * Brouillons compris : le pre-save du modèle Invoice ne recalcule pas les
 * totaux (seul le resolver le fait, quand l'éditeur renvoie les lignes), et
 * « Créer la facture » depuis le panneau latéral finalise un brouillon par
 * changeInvoiceStatus, sans recalcul. Un brouillon laissé tel quel pourrait
 * donc devenir une facture émise aux totaux faux.
 *
 * Une facture transmise en facturation électronique (règle eInvoiceLock)
 * n'est JAMAIS modifiée : elle est listée à part avec son écart, elle se
 * corrige par un avoir.
 *
 * Pour chaque facture à corriger, l'aperçu donne aussi ce qui dépend de son
 * total : paiements (transactions rapprochées, paiement carte Stripe),
 * avoirs liés (plafond « somme des avoirs ≤ facture ») et archive PDF
 * Factur-X. Paiements, rapprochements et avoirs ne sont jamais modifiés :
 * un statut de paiement ou une couverture par les avoirs qui deviendrait
 * incohérent avec le nouveau total est signalé (⚠️).
 *
 * Archive Factur-X : son XML reprend les totaux enregistrés, celle des
 * factures émises corrigées est donc à régénérer. Avec --rearchive, le
 * script le fait juste après la correction, par le même mécanisme que
 * rearchive-modified-invoices.js (copie locale de l'ancien PDF, archivage
 * par le service de l'API via NewbiV2, date de modification remise). Sans
 * --rearchive, il liste les archives à régénérer ; --reprendre <sauvegarde>
 * les régénère plus tard (et relance les échecs). Le script de réarchivage
 * général ne les retrouverait pas : la correction ne change pas la date de
 * modification.
 *
 * Aperçu par défaut. Avec --apply, les valeurs d'avant sont sauvegardées
 * (backups/remise-en-etat/factures-totaux-<date>.json, anciens PDF dans le
 * dossier -pdf du même nom) avant toute écriture ; `updatedAt` ne bouge pas.
 * Idempotent : une facture corrigée n'est plus listée.
 *
 * Usage (depuis la racine de l'API) :
 *   NODE_ENV=production node scripts/recompute-invoice-totals.js
 *   NODE_ENV=production node scripts/recompute-invoice-totals.js --apply --rearchive
 *   NODE_ENV=production node scripts/recompute-invoice-totals.js --reprendre <sauvegarde.json> [--apply]
 *   NODE_ENV=production node scripts/recompute-invoice-totals.js --restore <sauvegarde.json> [--apply]
 *
 * Options :
 *   --apply                écrit en base (sans cette option : aperçu, aucune écriture)
 *   --rearchive            régénère l'archive Factur-X des factures émises corrigées
 *   --port-remise          seulement les factures avec port et remise globale en %
 *   --workspace <id>       limite à une organisation
 *   --limit <n>            limite le nombre de factures examinées
 *   --delay <ms>           pause entre deux réarchivages (défaut 2000)
 *   --reprendre <fichier>  régénère les archives restées à faire d'une sauvegarde
 *                          (oubli de --rearchive, échecs), aperçu sans --apply
 *   --restore <fichier>    remet les totaux, et l'archive si elle a été régénérée,
 *                          d'une sauvegarde (aperçu sans --apply)
 */

import mongoose from "mongoose";
import CreditNote from "../src/models/CreditNote.js";
import Invoice from "../src/models/Invoice.js";
import Transaction from "../src/models/Transaction.js";
import { isPercentageDiscount } from "../src/utils/documentTotals.js";
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
  openBackup,
  parseArgs,
  pickValues,
  readBackup,
  restoreBackup,
  toCents,
  toObjectId,
} from "./lib/remise-en-etat.js";
import {
  ARCHIVE_FIELDS,
  loadServices,
  rearchiveInvoice,
  restoreOldPdf,
} from "./rearchive-modified-invoices.js";

/**
 * Totaux enregistrés sur une facture (calculateInvoiceTotals). Le
 * discountAmount qu'il renvoie aussi n'est pas un champ du modèle Invoice :
 * il n'est jamais enregistré.
 */
export const INVOICE_TOTAL_FIELDS = [
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

/** Cause corrigée le 10/10/2026 : la remise en % s'appliquait aussi au port. */
export const REASON_SHIPPING_DISCOUNT = "port + remise globale en %";

export const PAYMENT_STATES = {
  NONE: "non payée",
  PARTIAL: "partiellement payée",
  PAID: "payée",
  OVER: "payée avec trop-perçu",
};

export const CREDIT_NOTE_STATES = {
  NONE: "sans avoir",
  PARTIAL: "partiellement couverte par ses avoirs",
  FULL: "entièrement couverte par ses avoirs",
  OVER: "avoirs supérieurs à la facture",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** « +1.20 » : écart en euros, calculé au centime. */
const signedCents = (cents) =>
  `${cents < 0 ? "-" : "+"}${(Math.abs(cents) / 100).toFixed(2)}`;

/** Origine probable de l'écart, pour la relecture. */
export function differenceReasons(invoice, raw) {
  const reasons = [];
  if (INVOICE_TOTAL_FIELDS.some((field) => raw[field] == null)) {
    reasons.push("totaux absents");
  }
  if (
    invoice.shipping?.billShipping &&
    invoice.shipping?.shippingAmountHT > 0 &&
    invoice.discount > 0 &&
    isPercentageDiscount(invoice.discountType)
  ) {
    reasons.push(REASON_SHIPPING_DISCOUNT);
  }
  return reasons.length > 0 ? reasons : ["autre"];
}

/** État de paiement d'un montant encaissé face à un total TTC. */
export function paymentState(paid, total) {
  const paidCents = toCents(paid);
  const totalCents = toCents(total);
  if (paidCents <= 0) return PAYMENT_STATES.NONE;
  if (paidCents < totalCents) return PAYMENT_STATES.PARTIAL;
  return paidCents === totalCents ? PAYMENT_STATES.PAID : PAYMENT_STATES.OVER;
}

/** Couverture d'une facture par la somme de ses avoirs (valeur absolue). */
export function creditNoteState(sum, total) {
  const sumCents = toCents(sum);
  const totalCents = toCents(Math.abs(total || 0));
  if (sumCents <= 0) return CREDIT_NOTE_STATES.NONE;
  if (sumCents < totalCents) return CREDIT_NOTE_STATES.PARTIAL;
  return sumCents === totalCents
    ? CREDIT_NOTE_STATES.FULL
    : CREDIT_NOTE_STATES.OVER;
}

/** Calcul de l'API, chargé après l'environnement (services importés). */
async function loadCalculateInvoiceTotals() {
  try {
    const { calculateInvoiceTotals } =
      await import("../src/resolvers/invoice.js");
    return calculateInvoiceTotals;
  } catch (error) {
    throw new Error(
      `Chargement du calcul des factures impossible (${error.message}) : lancer depuis la racine de l'API, avec son fichier d'environnement (NODE_ENV=production)`,
    );
  }
}

/**
 * Totaux de l'API pour une facture lue en base. Document Mongoose (valeurs
 * par défaut du schéma) comme la facture chargée par updateInvoice ; pas
 * d'arrondi, l'API enregistre le résultat tel quel.
 */
function computeTotals(calculateInvoiceTotals, raw) {
  const invoice = Invoice.hydrate(raw);
  const totals = calculateInvoiceTotals(
    invoice.items || [],
    invoice.discount,
    invoice.discountType,
    invoice.shipping,
    invoice.isReverseCharge,
  );
  return { invoice, totals: pickValues(totals, INVOICE_TOTAL_FIELDS) };
}

/**
 * Paiements enregistrés : transactions rapprochées (montants connus), sinon
 * paiement carte Stripe (débité du total enregistré au moment du paiement),
 * sinon marquage « payée » sans montant. Alerte quand le nouveau total
 * rendrait le paiement partiel ou en trop-perçu.
 */
async function reviewPayments(raw, before, after) {
  const transactions = await Transaction.find({
    deletedAt: null,
    $or: [
      { _id: { $in: raw.linkedTransactionIds || [] } },
      { linkedInvoiceIds: raw._id },
    ],
  })
    .select("amount linkedInvoiceIds")
    .lean();

  let paid = null;
  let source;
  if (transactions.length > 0) {
    paid = transactions.reduce(
      (sum, transaction) => sum + (Number(transaction.amount) || 0),
      0,
    );
    const grouped = transactions.filter(
      (transaction) => (transaction.linkedInvoiceIds || []).length > 1,
    ).length;
    source =
      `${transactions.length} transaction(s) rapprochée(s), ${paid.toFixed(2)} au total` +
      (grouped
        ? ` (dont ${grouped} paiement(s) groupé(s) avec d'autres factures : comparaison indicative)`
        : "");
  } else if (raw.stripePaymentStatus === "paid") {
    paid = before.finalTotalTTC || 0;
    source = `paiement carte Stripe du total enregistré alors (${formatAmount(paid)})`;
  } else if (raw.status === "COMPLETED") {
    source =
      "marquée payée sans montant enregistré, considérée payée en entier";
  } else {
    source = "aucun paiement enregistré";
  }

  if (paid === null) return { line: `paiement : ${source}`, warning: null };

  const stateBefore = paymentState(paid, before.finalTotalTTC);
  const stateAfter = paymentState(paid, after.finalTotalTTC);
  const line = `paiement : ${source} ; ancien total : ${stateBefore}, nouveau total : ${stateAfter}`;
  const incoherent =
    stateAfter !== stateBefore &&
    [PAYMENT_STATES.PARTIAL, PAYMENT_STATES.OVER].includes(stateAfter);
  if (!incoherent) return { line, warning: null };

  const gap = toCents(after.finalTotalTTC) - toCents(paid);
  return {
    line,
    warning:
      `paiement : « ${stateBefore} » → « ${stateAfter} » ` +
      `(${gap > 0 ? `reste ${(gap / 100).toFixed(2)} à encaisser` : `trop-perçu ${(-gap / 100).toFixed(2)}`}), ` +
      `statut de la facture ${raw.status}`,
  };
}

/**
 * Avoirs liés et plafond « somme des avoirs ≤ facture » (même calcul que
 * createCreditNote). Alerte quand le plafond serait dépassé, ou qu'une
 * facture entièrement couverte par ses avoirs ne le serait plus.
 */
async function reviewCreditNotes(raw, before, after) {
  const creditNotes = await CreditNote.find({
    originalInvoice: raw._id,
    workspaceId: raw.workspaceId,
  })
    .select("prefix number finalTotalTTC")
    .sort({ _id: 1 })
    .lean();
  if (creditNotes.length === 0) {
    return { line: "avoirs : aucun", warning: null };
  }

  const sum = creditNotes.reduce(
    (total, creditNote) => total + Math.abs(creditNote.finalTotalTTC || 0),
    0,
  );
  const list = creditNotes
    .map(
      (creditNote) =>
        `${documentNumber(creditNote)} (${formatAmount(creditNote.finalTotalTTC)})`,
    )
    .join(", ");
  const stateBefore = creditNoteState(sum, before.finalTotalTTC);
  const stateAfter = creditNoteState(sum, after.finalTotalTTC);
  const line = `avoirs : ${list}, somme ${sum.toFixed(2)} ; ancien total : ${stateBefore}, nouveau total : ${stateAfter}`;

  if (stateAfter === CREDIT_NOTE_STATES.OVER) {
    return {
      line,
      warning: `avoirs : somme ${sum.toFixed(2)} > nouveau TTC ${formatAmount(after.finalTotalTTC)}, le plafond « somme des avoirs ≤ facture » ne serait plus respecté`,
    };
  }
  if (stateAfter !== stateBefore && stateAfter === CREDIT_NOTE_STATES.PARTIAL) {
    const rest = toCents(Math.abs(after.finalTotalTTC || 0)) - toCents(sum);
    return {
      line,
      warning: `avoirs : « ${stateBefore} » → « ${stateAfter} » (reste ${(rest / 100).toFixed(2)} non couvert)`,
    };
  }
  return { line, warning: null };
}

/** Archive à régénérer : facture émise avec une archive générée par Newbi. */
function reviewArchive(raw) {
  if (raw.status === "DRAFT") {
    return { rearchive: false, text: "aucune (brouillon)" };
  }
  if (raw.archivedPdfSource === "NEWBI" && raw.archivedPdfKey) {
    return {
      rearchive: true,
      text: "PDF Factur-X archivé, à régénérer (son XML porte les anciens totaux)",
    };
  }
  if (raw.archivedPdfKey || raw.archivedPdfUrl) {
    return {
      rearchive: false,
      text: `PDF archivé (origine ${raw.archivedPdfSource || "inconnue"}), non régénéré par le script`,
    };
  }
  return { rearchive: false, text: "pas de PDF archivé" };
}

/**
 * Régénère l'archive Factur-X des factures corrigées d'une sauvegarde qui ne
 * l'ont pas encore été. Chaque facture doit porter encore les totaux écrits
 * par le script et l'archive d'avant la correction : modifiée ou réarchivée
 * depuis (l'API réarchive après chaque modification), elle est laissée telle
 * quelle. En cas de succès, l'archive d'avant et d'après rejoint l'entrée de
 * la sauvegarde : le retour arrière remet alors les totaux ET l'archive.
 * @param {Object} backup - sauvegarde (createBackup ou openBackup)
 * @param {Object} [options]
 * @param {boolean} [options.apply=false] réarchiver (sinon aperçu)
 * @param {Function} [options.archive] (invoice, workspaceId) => Promise
 * @param {Function} [options.fetchArchivedPdf] (key) => Promise<Buffer>
 * @param {number} [options.delayMs=2000] pause entre deux factures
 * @param {Function} [options.log]
 */
export async function rearchiveCorrectedInvoices(
  backup,
  {
    apply = false,
    archive,
    fetchArchivedPdf,
    delayMs = 2000,
    log = console.log,
  } = {},
) {
  if (apply && typeof archive !== "function") {
    throw new Error("Fonction d'archivage manquante");
  }

  const pending = backup.entries.filter(
    (entry) => entry.rearchive && entry.after && !entry.after.archivedPdfKey,
  );
  const stats = {
    pending: pending.length,
    ready: 0,
    rearchived: 0,
    failed: 0,
    changedSince: 0,
  };

  for (const [index, entry] of pending.entries()) {
    const progress = `(${index + 1}/${pending.length})`;
    const previous = entry.archiveBefore || {};

    const current = await Invoice.collection.findOne({ _id: entry._id });
    if (
      !current ||
      current.status === "DRAFT" ||
      isEInvoiceTransmitted(current) ||
      INVOICE_TOTAL_FIELDS.some(
        (field) => current[field] !== entry.after[field],
      ) ||
      current.archivedPdfKey !== previous.archivedPdfKey ||
      current.archivedPdfStoredAt?.getTime() !==
        previous.archivedPdfStoredAt?.getTime()
    ) {
      stats.changedSince += 1;
      log(
        `  - ${entry.label} : changée depuis la correction, archive laissée telle quelle ${progress}`,
      );
      continue;
    }

    stats.ready += 1;
    if (!apply) {
      log(`  · ${entry.label} (${entry._id}) : archive à régénérer`);
      continue;
    }

    const { fresh, error } = await rearchiveInvoice(current, entry, {
      backup,
      updatedAt: current.updatedAt,
      archive,
      fetchArchivedPdf,
      log,
    });
    if (error) {
      stats.failed += 1;
      log(`  ❌ ${entry.label} : ${error} ${progress}`);
      backup.save();
      await sleep(delayMs);
      continue;
    }

    // Retour arrière : totaux et archive d'avant, seulement si la facture
    // porte encore les deux posés par le script
    entry.before = { ...entry.before, ...previous };
    entry.after = { ...entry.after, ...pickValues(fresh, ARCHIVE_FIELDS) };
    backup.save();
    stats.rearchived += 1;
    log(`  ✓ ${entry.label} réarchivée ${progress}`);
    await sleep(delayMs);
  }

  return stats;
}

/**
 * Reprise du réarchivage d'une exécution précédente (sauvegarde
 * factures-totaux) : archives jamais régénérées (--rearchive oublié) ou en
 * échec. La sauvegarde est complétée sur place.
 */
export async function resumeRearchive(file, options = {}) {
  const backup = openBackup(file);
  if (backup.content.script !== "factures-totaux") {
    throw new Error(
      `Sauvegarde d'un autre script (${backup.content.script}) : attendu factures-totaux`,
    );
  }
  return rearchiveCorrectedInvoices(backup, options);
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.apply=false] écrire en base (sinon aperçu)
 * @param {boolean} [options.rearchive=false] régénérer l'archive des factures émises corrigées
 * @param {boolean} [options.shippingDiscountOnly=false] seulement port + remise globale en %
 * @param {string} [options.workspaceId] limiter à une organisation
 * @param {number} [options.limit] nombre maximal de factures examinées
 * @param {number} [options.delayMs=2000] pause entre deux réarchivages
 * @param {Function} [options.archive] (invoice, workspaceId) => Promise, archivage Factur-X
 * @param {Function} [options.fetchArchivedPdf] (key) => Promise<Buffer>, lecture de l'ancien PDF
 * @param {string} [options.backupDir] dossier de la sauvegarde
 * @param {Function} [options.log] sortie des lignes de détail
 */
export async function recomputeInvoiceTotals({
  apply = false,
  rearchive = false,
  shippingDiscountOnly = false,
  workspaceId = null,
  limit = 0,
  delayMs = 2000,
  archive,
  fetchArchivedPdf,
  backupDir,
  log = console.log,
} = {}) {
  if (apply && rearchive && typeof archive !== "function") {
    throw new Error("Fonction d'archivage manquante");
  }
  const calculateInvoiceTotals = await loadCalculateInvoiceTotals();

  const filter = workspaceId ? { workspaceId: toObjectId(workspaceId) } : {};
  let query = Invoice.find(filter).sort({ _id: 1 }).lean();
  if (limit > 0) query = query.limit(limit);

  const stats = {
    scanned: 0,
    withoutItems: 0,
    invalid: 0,
    unchanged: 0,
    toFix: 0,
    drafts: 0,
    otherSkipped: 0,
    locked: 0,
    paymentWarnings: 0,
    creditNoteWarnings: 0,
    toRearchive: 0,
    updated: 0,
    changedSince: 0,
    rearchived: 0,
    rearchiveFailed: 0,
    rearchiveChangedSince: 0,
    backupFile: null,
  };
  const entries = [];

  for await (const raw of query.cursor()) {
    stats.scanned += 1;
    const label = `Facture ${documentNumber(raw)}`;

    // L'API ne calcule rien sans lignes : rien à aligner
    if (!Array.isArray(raw.items) || raw.items.length === 0) {
      stats.withoutItems += 1;
      continue;
    }

    const { invoice, totals } = computeTotals(calculateInvoiceTotals, raw);
    if (
      !INVOICE_TOTAL_FIELDS.every((field) => Number.isFinite(totals[field]))
    ) {
      stats.invalid += 1;
      log(
        `  ? ${label} (${raw._id}) : totaux incalculables (ligne sans quantité, prix ou taux de TVA), ignorée`,
      );
      continue;
    }

    const changed = INVOICE_TOTAL_FIELDS.filter((field) =>
      amountDiffers(raw[field], totals[field]),
    );
    if (changed.length === 0) {
      stats.unchanged += 1;
      continue;
    }

    const before = pickValues(raw, INVOICE_TOTAL_FIELDS);
    const reasons = differenceReasons(invoice, raw);
    const context = `${raw._id}, ${raw.status || "sans statut"}, espace ${raw.workspaceId}`;
    const gap =
      before.finalTotalTTC == null
        ? "TTC absent"
        : `écart TTC ${signedCents(toCents(totals.finalTotalTTC) - toCents(before.finalTotalTTC))}`;
    const detail = `${describeChanges(raw, totals, changed, FIELD_LABELS)} (${gap}) [${reasons.join(", ")}]`;

    // Facture déposée sur la plateforme : elle fait foi telle que transmise
    if (isEInvoiceTransmitted(raw)) {
      stats.locked += 1;
      log(
        `  🔒 ${label} (${context}) : transmise en e-facturation, jamais modifiée, à corriger par un avoir. Écart : ${detail}`,
      );
      continue;
    }

    if (shippingDiscountOnly && !reasons.includes(REASON_SHIPPING_DISCOUNT)) {
      stats.otherSkipped += 1;
      log(
        `  ⏸ ${label} (${context}) : autre cause, ignorée avec --port-remise. Écart : ${detail}`,
      );
      continue;
    }

    stats.toFix += 1;
    if (raw.status === "DRAFT") stats.drafts += 1;
    log(`  · ${label} (${context}) : ${detail}`);

    const payments = await reviewPayments(raw, before, totals);
    log(`      ${payments.line}`);
    if (payments.warning) {
      stats.paymentWarnings += 1;
      log(`      ⚠️ ${payments.warning}`);
    }

    const creditNotes = await reviewCreditNotes(raw, before, totals);
    log(`      ${creditNotes.line}`);
    if (creditNotes.warning) {
      stats.creditNoteWarnings += 1;
      log(`      ⚠️ ${creditNotes.warning}`);
    }

    const archiveReview = reviewArchive(raw);
    if (archiveReview.rearchive) stats.toRearchive += 1;
    log(
      `      archive : ${archiveReview.text}${archiveReview.rearchive && !rearchive ? " (--rearchive)" : ""}`,
    );

    entries.push({
      collection: Invoice.collection.collectionName,
      _id: raw._id,
      label,
      workspaceId: raw.workspaceId,
      status: raw.status,
      reasons,
      before,
      after: totals,
      rearchive: archiveReview.rearchive,
      archiveBefore: archiveReview.rearchive
        ? pickValues(raw, ARCHIVE_FIELDS)
        : null,
      oldPdfFile: null,
    });
  }

  if (!apply || entries.length === 0) return stats;

  // Sauvegarde AVANT la première écriture
  const backup = createBackup({
    name: "factures-totaux",
    dir: backupDir,
    meta: { shippingDiscountOnly },
  });
  backup.entries.push(...entries);
  stats.backupFile = backup.save();

  for (const entry of entries) {
    if (await applyEntry(entry)) {
      stats.updated += 1;
    } else {
      stats.changedSince += 1;
      // Rien n'a été écrit : rien à remettre ni à réarchiver
      entry.after = null;
      log(
        `  - ${entry.label} : modifiée depuis l'aperçu, laissée telle quelle`,
      );
    }
  }
  backup.save();

  if (rearchive) {
    log("\nRéarchivage des factures émises corrigées :");
    const result = await rearchiveCorrectedInvoices(backup, {
      apply: true,
      archive,
      fetchArchivedPdf,
      delayMs,
      log,
    });
    stats.rearchived = result.rearchived;
    stats.rearchiveFailed = result.failed;
    stats.rearchiveChangedSince = result.changedSince;
  }

  return stats;
}

async function main() {
  const args = parseArgs();
  const rearchive = args.flag("--rearchive");
  const shippingDiscountOnly = args.flag("--port-remise");
  const resumeFile = args.value("--reprendre");
  const delayMs = Number(args.value("--delay") ?? 2000);
  const database = await connectFromEnv();
  console.log(
    `✅ Connecté à la base ${database} (${args.apply ? "écriture" : "aperçu, aucune écriture : --apply pour écrire"}` +
      `${rearchive ? ", réarchivage des factures corrigées" : ""}` +
      `${shippingDiscountOnly ? ", port + remise en % seulement" : ""})`,
  );

  try {
    if (args.restore) {
      // R2 seulement si un ancien PDF est à remettre
      const withPdf = (readBackup(args.restore).entries || []).some(
        (entry) => entry.oldPdfFile,
      );
      const services = args.apply && withPdf ? await loadServices() : null;
      const stats = await restoreBackup(args.restore, {
        apply: args.apply,
        afterRestore: services
          ? restoreOldPdf(services.uploadArchivedPdf)
          : undefined,
      });
      console.log(
        `\n${stats.entries} facture(s) dans la sauvegarde : ${args.apply ? `${stats.restored} remise(s) à l'état d'avant` : `${stats.restorable} à remettre`}, ${stats.skipped} laissée(s) telle(s) quelle(s).`,
      );
      return;
    }

    let services = {};
    if (args.apply && (rearchive || resumeFile)) {
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

    if (resumeFile) {
      const stats = await resumeRearchive(resumeFile, {
        apply: args.apply,
        archive: services.archive,
        fetchArchivedPdf: services.fetchArchivedPdf,
        delayMs,
      });
      console.log(
        `\n${stats.pending} archive(s) restée(s) à régénérer dans la sauvegarde : ` +
          (args.apply
            ? `${stats.rearchived} réarchivée(s), ${stats.failed} échec(s)`
            : `${stats.ready} à réarchiver`) +
          `, ${stats.changedSince} facture(s) changée(s) depuis la correction (laissées telles quelles).` +
          (args.apply ? `\n💾 Sauvegarde complétée : ${resumeFile}` : ""),
      );
      return;
    }

    const stats = await recomputeInvoiceTotals({
      apply: args.apply,
      rearchive,
      shippingDiscountOnly,
      workspaceId: args.workspaceId,
      limit: args.limit,
      delayMs,
      archive: services.archive,
      fetchArchivedPdf: services.fetchArchivedPdf,
    });
    console.log(
      `\n${stats.scanned} facture(s) examinée(s) : ${stats.unchanged} déjà juste(s), ` +
        `${stats.toFix} à corriger (dont ${stats.drafts} brouillon(s)), ` +
        `${stats.locked} transmise(s) en e-facturation (jamais modifiées, à corriger par un avoir), ` +
        `${stats.otherSkipped} d'une autre cause ignorée(s) (--port-remise), ` +
        `${stats.withoutItems} sans ligne, ${stats.invalid} incalculable(s).\n` +
        `⚠️ À vérifier : ${stats.paymentWarnings} paiement(s), ${stats.creditNoteWarnings} couverture(s) par les avoirs.\n` +
        `📄 ${stats.toRearchive} archive(s) Factur-X à régénérer.`,
    );
    if (args.apply) {
      console.log(
        `${stats.updated} facture(s) mise(s) à jour, ${stats.changedSince} modifiée(s) entre-temps (non touchées).`,
      );
      if (rearchive) {
        console.log(
          `${stats.rearchived} archive(s) régénérée(s), ${stats.rearchiveFailed} échec(s), ${stats.rearchiveChangedSince} facture(s) changée(s) entre-temps.`,
        );
      }
      const remaining = rearchive
        ? stats.rearchiveFailed
        : stats.updated > 0
          ? stats.toRearchive
          : 0;
      if (remaining > 0 && stats.backupFile) {
        console.log(
          `Archives restées à régénérer : NODE_ENV=production node scripts/recompute-invoice-totals.js --reprendre ${stats.backupFile} --apply`,
        );
      }
      if (stats.backupFile) console.log(`💾 Sauvegarde : ${stats.backupFile}`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (isCliEntry(import.meta.url)) {
  // Sortie explicite : les services chargés par le resolver et les clients
  // R2 / HTTP gardent des ressources ouvertes
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Erreur:", error);
      process.exit(1);
    });
}
