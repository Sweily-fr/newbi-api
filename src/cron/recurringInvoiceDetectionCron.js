import cron from "node-cron";
import mongoose from "mongoose";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Invoice from "../models/Invoice.js";
import DetectedRecurrence from "../models/DetectedRecurrence.js";
import logger from "../utils/logger.js";

const AMOUNT_TOLERANCE = 0.2; // ±20% of median
const WINDOW_MONTHS = 3;
const SCAN_PAST_MONTHS = 6; // months scanned before current month
const SCAN_FUTURE_MONTHS = 6; // months scanned after current month (scheduled invoices)

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

const getLastNMonthKeys = (n) => {
  const months = [];
  const now = new Date();
  // Window includes the current month (a recurring invoice that has already
  // been issued this month should count toward the streak).
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
    );
  }
  return months.sort();
};

// Scan window spanning past + current + future months, sorted oldest-first.
const getScanMonthRange = () => {
  const months = [];
  const now = new Date();
  for (let i = -SCAN_PAST_MONTHS; i <= SCAN_FUTURE_MONTHS; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    months.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
    );
  }
  return months;
};

// Find any window of WINDOW_MONTHS consecutive months in `scanMonths` where
// the group has invoices in every month and amounts are within tolerance.
// Returns { months, amounts, median } or null.
const findValidStreak = (scanMonths, monthsSeen) => {
  for (let start = scanMonths.length - WINDOW_MONTHS; start >= 0; start--) {
    const window = scanMonths.slice(start, start + WINDOW_MONTHS);
    const amountsPerMonth = window.map((m) => {
      const amts = monthsSeen.get(m) || [];
      return amts.length ? amts.reduce((s, v) => s + v, 0) : null;
    });
    if (amountsPerMonth.some((v) => v == null)) continue;
    const med = median(amountsPerMonth);
    if (med <= 0) continue;
    const inTolerance = amountsPerMonth.every(
      (v) => Math.abs(v - med) / med <= AMOUNT_TOLERANCE,
    );
    if (inTolerance) {
      return { months: window, amounts: amountsPerMonth, median: med };
    }
  }
  return null;
};

export const detectForSource = async (workspaceId, source) => {
  // Scan past + future months to find any 3-consecutive-month streak.
  // Future-dated invoices count too (a planned recurrence is still recurring).
  const scanMonths = getScanMonthRange();
  const startBound = new Date(scanMonths[0] + "-01");
  const endBoundDate = new Date(scanMonths[scanMonths.length - 1] + "-01");
  endBoundDate.setMonth(endBoundDate.getMonth() + 1);

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
    if (invoiceRecurrenceKeys.has(`${partyKey}::${type}`)) continue;
    const groupKey = `${partyKey}::${category}`;
    const m = monthKey(docDate);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        partyKey,
        partyName,
        category,
        type,
        monthsSeen: new Map(),
      });
    }
    const g = groups.get(groupKey);
    if (!g.monthsSeen.has(m)) g.monthsSeen.set(m, []);
    g.monthsSeen.get(m).push(amount);
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
    const streak = findValidStreak(scanMonths, g.monthsSeen);
    const prev = existingMap.get(groupKey);

    if (streak) {
      const lastSeen = streak.months[streak.months.length - 1];
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
            lastSeenMonth: lastSeen,
            consecutiveMonths: WINDOW_MONTHS,
            isActive: !prev?.isMuted,
            lastDetectedAt: new Date(),
          },
          $setOnInsert: {
            workspaceId,
            source,
            partyKey: g.partyKey,
            category: g.category,
            isMuted: false,
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
