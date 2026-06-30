import cron from "node-cron";
import mongoose from "mongoose";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Invoice from "../models/Invoice.js";
import DetectedRecurrence from "../models/DetectedRecurrence.js";
import logger from "../utils/logger.js";

const AMOUNT_TOLERANCE = 0.35; // ±35% of median (variable bills still count)
const SCAN_PAST_MONTHS = 24; // months scanned before current month (annual needs ≥13)
const SCAN_FUTURE_MONTHS = 6; // months scanned after current month (scheduled invoices)
const DAY = 86400000;

// Periodicities detected from the gaps (in days) between consecutive
// occurrences. `min`/`max` bound a single interval; `minOccur` is how many
// occurrences are required before we trust the pattern (a yearly charge only
// needs 2, a weekly one needs more to be distinguishable from noise).
const FREQUENCIES = [
  { key: "WEEKLY", days: 7, min: 5, max: 10, minOccur: 4 },
  { key: "BIWEEKLY", days: 14, min: 11, max: 18, minOccur: 3 },
  { key: "MONTHLY", days: 30, min: 24, max: 38, minOccur: 3 },
  { key: "QUARTERLY", days: 91, min: 75, max: 110, minOccur: 2 },
  { key: "SEMIANNUAL", days: 182, min: 150, max: 215, minOccur: 2 },
  { key: "ANNUAL", days: 365, min: 300, max: 430, minOccur: 2 },
];

export const normalizeParty = (name) =>
  (name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Bank labels carry operation prefixes (PRLV SEPA, VIR, CB\u2026) and reference
// numbers/dates that change on every occurrence \u2014 strip them so the same
// subscription maps to a stable partyKey across months.
const BANK_LABEL_NOISE =
  /\b(prlv|sepa|vir|virement|cb|carte|paiement|achat|echeance|echange|pmt|facture|abonnement|recu|emis|inst|web|janvier|janv|fevrier|fevr|mars|avril|avr|mai|juin|juillet|juil|aout|septembre|sept|octobre|oct|novembre|nov|decembre|dec)\b/g;
export const normalizeBankLabel = (label) =>
  (label || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\d+/g, " ")
    .replace(BANK_LABEL_NOISE, " ")
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "");

const median = (arr) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const monthKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// Scan window bounds [start, end) spanning past + current + future months.
const getScanBounds = () => {
  const now = new Date();
  const start = new Date(
    now.getFullYear(),
    now.getMonth() - SCAN_PAST_MONTHS,
    1,
  );
  const end = new Date(
    now.getFullYear(),
    now.getMonth() + SCAN_FUTURE_MONTHS + 1,
    1,
  );
  return { start, end };
};

// Analyse the dated occurrences of one party and decide whether they form a
// recurrence. Instead of requiring N consecutive calendar months, we look at
// the gaps (in days) between consecutive occurrences and match them against a
// known periodicity — so weekly, monthly, quarterly and yearly patterns are
// all detected. Returns { frequency, intervalDays, median, lastSeenDate,
// occurrenceCount } or null.
export const analyzeRecurrence = (occurrences) => {
  if (!occurrences || occurrences.length < 2) return null;
  const sorted = [...occurrences].sort((a, b) => a.date - b.date);

  // Merge near-duplicate charges (a split payment, a double bank posting, or
  // an invoice + its mirrored transaction) that land within 3 days, so they
  // don't masquerade as a tiny interval.
  const merged = [];
  for (const o of sorted) {
    const last = merged[merged.length - 1];
    if (last && (o.date - last.date) / DAY <= 3) {
      last.amount += o.amount;
      continue;
    }
    merged.push({ date: o.date, amount: o.amount });
  }
  if (merged.length < 2) return null;

  const gaps = [];
  for (let i = 1; i < merged.length; i++) {
    gaps.push((merged[i].date - merged[i - 1].date) / DAY);
  }
  const medGap = median(gaps);
  const freq = FREQUENCIES.find((f) => medGap >= f.min && medGap <= f.max);
  if (!freq) return null;

  // The pattern must be regular enough: most gaps land on the chosen interval
  // (a few missed/extra occurrences are tolerated), and we need enough history.
  const matching = gaps.filter((g) => g >= freq.min && g <= freq.max).length;
  if (merged.length < freq.minOccur) return null;
  if (matching < freq.minOccur - 1) return null;
  if (matching / gaps.length < 0.5) return null;

  const amounts = merged.map((m) => m.amount);
  const medAmount = median(amounts);
  if (medAmount <= 0) return null;
  const inTol = amounts.filter(
    (a) => Math.abs(a - medAmount) / medAmount <= AMOUNT_TOLERANCE,
  ).length;
  if (inTol / amounts.length < 0.5) return null;

  return {
    frequency: freq.key,
    intervalDays: freq.days,
    median: medAmount,
    lastSeenDate: merged[merged.length - 1].date,
    occurrenceCount: merged.length,
  };
};

export const detectForSource = async (workspaceId, source) => {
  // Scan a wide past + future window and look for a regular interval between
  // occurrences (any periodicity). Future-dated invoices count too (a planned
  // recurrence is still recurring).
  const { start: startBound, end: endBoundDate } = getScanBounds();

  let docs;
  if (source === "PURCHASE_INVOICE") {
    docs = await PurchaseInvoice.find({
      workspaceId,
      issueDate: { $gte: startBound, $lt: endBoundDate },
    })
      .select("supplierName category amountTTC issueDate")
      .lean();
  } else if (source === "TRANSACTION") {
    // Bank transactions (subscriptions, recurring transfers). workspaceId is
    // stored as a String on Transaction, and legacy docs may miss `date` —
    // same effective-date fallback as the forecast resolver.
    const Transaction = mongoose.model("Transaction");
    docs = await Transaction.aggregate([
      {
        $match: {
          workspaceId: String(workspaceId),
          status: "completed",
          deletedAt: null,
          amount: { $ne: 0 },
        },
      },
      {
        $addFields: {
          _effectiveDate: {
            $ifNull: ["$date", { $ifNull: ["$processedAt", "$createdAt"] }],
          },
        },
      },
      { $match: { _effectiveDate: { $gte: startBound, $lt: endBoundDate } } },
      {
        $project: {
          description: 1,
          amount: 1,
          expenseCategory: 1,
          _effectiveDate: 1,
        },
      },
    ]);
  } else {
    docs = await Invoice.find({
      workspaceId,
      status: { $in: ["COMPLETED", "PENDING", "OVERDUE"] },
      issueDate: { $gte: startBound, $lt: endBoundDate },
    })
      .select("client finalTotalTTC issueDate")
      .lean();
  }

  // An invoice-based recurrence wins over a transaction-based one for the
  // same party (the bank movement is just the invoice being paid).
  let invoiceRecurrenceKeys = new Set();
  if (source === "TRANSACTION") {
    const invoiceRecs = await DetectedRecurrence.find({
      workspaceId,
      source: { $ne: "TRANSACTION" },
      isActive: true,
    })
      .select("partyKey type")
      .lean();
    invoiceRecurrenceKeys = new Set(
      invoiceRecs.map((r) => `${r.partyKey}::${r.type}`),
    );
  }

  // Group by (partyKey, category)
  const groups = new Map();
  for (const d of docs) {
    let partyName;
    let category;
    let amount;
    let type;
    let partyKey;
    let docDate;
    if (source === "PURCHASE_INVOICE") {
      partyName = d.supplierName;
      category = d.category || "OTHER";
      amount = d.amountTTC;
      type = "EXPENSE";
      partyKey = normalizeParty(partyName);
      docDate = d.issueDate;
    } else if (source === "TRANSACTION") {
      partyName = (d.description || "").trim();
      type = d.amount > 0 ? "INCOME" : "EXPENSE";
      category =
        type === "EXPENSE" ? d.expenseCategory || "OTHER" : "OTHER_INCOME";
      amount = Math.abs(d.amount);
      partyKey = normalizeBankLabel(partyName);
      docDate = d._effectiveDate;
    } else {
      partyName =
        d?.client?.name ||
        [d?.client?.firstName, d?.client?.lastName].filter(Boolean).join(" ") ||
        d?.client?.email;
      category = "SALES";
      amount = d.finalTotalTTC;
      type = "INCOME";
      partyKey = normalizeParty(partyName);
      docDate = d.issueDate;
    }
    if (!partyName || !partyKey) continue;
    if (!amount || amount <= 0) continue;
    if (!docDate) continue;
    if (invoiceRecurrenceKeys.has(`${partyKey}::${type}`)) continue;
    const groupKey = `${partyKey}::${category}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        partyKey,
        partyName,
        category,
        type,
        occurrences: [],
      });
    }
    groups.get(groupKey).occurrences.push({ date: new Date(docDate), amount });
  }

  // Existing recurrences for this source/workspace to apply stop/resume.
  const existing = await DetectedRecurrence.find({
    workspaceId,
    source,
  }).lean();
  const existingMap = new Map(
    existing.map((e) => [`${e.partyKey}::${e.category || "OTHER"}`, e]),
  );
  const seenGroupKeys = new Set();

  for (const [groupKey, g] of groups) {
    seenGroupKeys.add(groupKey);
    const streak = analyzeRecurrence(g.occurrences);
    const prev = existingMap.get(groupKey);

    if (streak) {
      await DetectedRecurrence.findOneAndUpdate(
        {
          workspaceId,
          source,
          partyKey: g.partyKey,
          category: g.category,
        },
        {
          $set: {
            type: g.type,
            partyName: g.partyName,
            averageAmount: Math.round(streak.median),
            frequency: streak.frequency,
            intervalDays: streak.intervalDays,
            occurrenceCount: streak.occurrenceCount,
            lastSeenDate: streak.lastSeenDate,
            lastSeenMonth: monthKey(streak.lastSeenDate),
            consecutiveMonths: streak.occurrenceCount,
            isActive: !prev?.isMuted,
            lastDetectedAt: new Date(),
          },
          // excludedMonths est délibérément absent du $set : les occurrences
          // supprimées individuellement par l'utilisateur doivent survivre à
          // chaque re-détection.
          $setOnInsert: {
            workspaceId,
            source,
            partyKey: g.partyKey,
            category: g.category,
            isMuted: false,
            excludedMonths: [],
          },
        },
        { upsert: true, new: true },
      );
    } else if (prev) {
      // No valid streak now — decrement and deactivate when stale.
      const newCount = Math.max(0, (prev.consecutiveMonths || 0) - 1);
      await DetectedRecurrence.updateOne(
        { _id: prev._id },
        {
          $set: {
            consecutiveMonths: newCount,
            isActive: newCount > 0 && !prev.isMuted,
            lastDetectedAt: new Date(),
          },
        },
      );
    }
  }

  // Existing recurrences whose group vanished entirely → decrement.
  for (const [groupKey, prev] of existingMap) {
    if (seenGroupKeys.has(groupKey)) continue;
    const newCount = Math.max(0, (prev.consecutiveMonths || 0) - 1);
    await DetectedRecurrence.updateOne(
      { _id: prev._id },
      {
        $set: {
          consecutiveMonths: newCount,
          isActive: newCount > 0 && !prev.isMuted,
          lastDetectedAt: new Date(),
        },
      },
    );
  }
};

export const runRecurringInvoiceDetectionForWorkspace = async (workspaceId) => {
  // TRANSACTION runs last: its dedup reads the invoice-based recurrences
  // freshly upserted by the two previous passes.
  await detectForSource(workspaceId, "PURCHASE_INVOICE");
  await detectForSource(workspaceId, "INVOICE");
  await detectForSource(workspaceId, "TRANSACTION");
};

export const runRecurringInvoiceDetection = async () => {
  const Organization = mongoose.model("Organization");
  const workspaces = await Organization.find({}).select("_id").lean();
  logger.info(
    `🔁 [Cron] Détection récurrences — ${workspaces.length} workspaces`,
  );
  for (const ws of workspaces) {
    try {
      await runRecurringInvoiceDetectionForWorkspace(ws._id);
    } catch (error) {
      logger.error(
        `❌ [Cron] Détection récurrences workspace ${ws._id}:`,
        error,
      );
    }
  }
};

export function startRecurringInvoiceDetectionCron() {
  // Monthly — 1st of month at 03:15 Europe/Paris.
  const expression = "15 3 1 * *";
  const task = cron.schedule(
    expression,
    async () => {
      logger.info("⏰ [Cron] Lancement détection récurrences");
      try {
        await runRecurringInvoiceDetection();
        logger.info("✅ [Cron] Détection récurrences terminée");
      } catch (error) {
        logger.error("❌ [Cron] Détection récurrences:", error);
      }
    },
    { scheduled: true, timezone: "Europe/Paris" },
  );
  logger.info(
    "🕐 [Cron] Détection récurrences configurée (1er du mois, 03:15)",
  );
  return task;
}
