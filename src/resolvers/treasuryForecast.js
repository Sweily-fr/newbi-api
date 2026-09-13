import TreasuryForecast from "../models/TreasuryForecast.js";
import ManualCashflowEntry from "../models/ManualCashflowEntry.js";
import DetectedRecurrence from "../models/DetectedRecurrence.js";
import ForecastScenario from "../models/ForecastScenario.js";
import {
  runRecurringInvoiceDetectionForWorkspace,
  normalizeParty,
} from "../cron/recurringInvoiceDetectionCron.js";
import mongoose from "mongoose";
import {
  requireRead,
  requireWrite,
  requireDelete,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import {
  loadScenarioOverlay,
  projectableRecurrenceFilter,
} from "../utils/forecastScenarioOverlay.js";

// Income categories for filtering
const INCOME_CATEGORIES = ["SALES", "REFUNDS_RECEIVED", "OTHER_INCOME"];

// Map legacy/Bridge category names to forecast category names
const CATEGORY_ALIAS = {
  TRAVEL: "TRANSPORT",
  ACCOMMODATION: "OTHER_EXPENSE",
};
const normalizeCat = (cat) => CATEGORY_ALIAS[cat] || cat;

// Bucket an expense category into the forecast enum (OTHER and Bridge
// aliases like TRAVEL don't exist in EXPENSE_CATS).
const toExpenseCat = (cat) => {
  const c = normalizeCat(cat || "OTHER");
  return c === "OTHER" ? "OTHER_EXPENSE" : c;
};

// Catégorie de prévision d'une récurrence détectée : le choix de
// l'utilisateur (categoryOverride) prime, sinon la catégorie détectée est
// rabattue sur l'enum ForecastCategory. Seule source pour toutes les
// projections (tableau, occurrences, détails du mois) et pour le champ
// forecastCategory exposé au front.
export const recurrenceForecastCategory = (rec) => {
  if (rec.categoryOverride) return rec.categoryOverride;
  if (rec.source === "INVOICE") return "SALES";
  if (rec.source === "PURCHASE_INVOICE" || rec.type === "EXPENSE") {
    return toExpenseCat(rec.category);
  }
  return INCOME_CATEGORIES.includes(rec.category)
    ? rec.category
    : "OTHER_INCOME";
};

// Helper: generate array of "YYYY-MM" strings between start and end (inclusive).
// On itère en arithmétique entière sur (année, mois) : mélanger un parsing UTC
// (new Date("YYYY-MM-01")) avec setMonth (heure locale) provoquait un off-by-one
// au passage heure d'été/hiver — la dernière borne tombant un mois d'hiver était
// exclue (ex. plage 6 mois juin->novembre qui ne renvoyait que 5 mois).
const getMonthRange = (startDate, endDate) => {
  const months = [];
  const [startYear, startMonth] = startDate.split("-").map(Number);
  const [endYear, endMonth] = endDate.split("-").map(Number);
  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
};

// Amount of the nth occurrence (0-based, counted from startDate): the
// "Augmenter ou diminuer de" delta applies at each repetition — fixed EUR
// step or compounding percent. Never goes below 0.
const occurrenceAmount = (entry, index) => {
  const delta = entry.amountDelta || 0;
  if (!delta || index === 0) return entry.amount;
  const amount =
    entry.amountDeltaType === "PERCENT"
      ? entry.amount * Math.pow(1 + delta / 100, index)
      : entry.amount + delta * index;
  return Math.max(0, Math.round(amount * 100) / 100);
};

// Expand a manual entry into { date, amount } occurrences within
// [rangeStart, rangeEnd). The occurrence index keeps counting through
// occurrences before rangeStart so the amount progression stays anchored
// on startDate. frequency: ONCE, WEEKLY, MONTHLY, QUARTERLY, SEMIANNUAL,
// ANNUAL. Exported for tests.
export const expandManualEntry = (entry, rangeStart, rangeEnd) => {
  const occurrences = [];
  const start = new Date(entry.startDate);
  const end = entry.endDate ? new Date(entry.endDate) : null;
  const upperBound =
    end && end < rangeEnd ? new Date(end.getTime() + 1) : rangeEnd;

  if (entry.frequency === "ONCE") {
    if (start >= rangeStart && start < rangeEnd && (!end || start <= end)) {
      occurrences.push({ date: new Date(start), amount: entry.amount });
    }
    return occurrences;
  }

  const current = new Date(start);
  // Safety cap to avoid runaway loops on malformed data.
  let guard = 0;
  while (current < upperBound && guard < 600) {
    if (current >= rangeStart) {
      occurrences.push({
        date: new Date(current),
        amount: occurrenceAmount(entry, guard),
      });
    }
    switch (entry.frequency) {
      case "WEEKLY":
        current.setDate(current.getDate() + 7);
        break;
      case "MONTHLY":
        current.setMonth(current.getMonth() + 1);
        break;
      case "QUARTERLY":
        current.setMonth(current.getMonth() + 3);
        break;
      case "SEMIANNUAL":
        current.setMonth(current.getMonth() + 6);
        break;
      case "ANNUAL":
        current.setFullYear(current.getFullYear() + 1);
        break;
      default:
        return occurrences;
    }
    guard += 1;
  }
  return occurrences;
};

// Project manual entries + active detected recurrences into a FLAT list of
// per-occurrence forecast items within [rangeStart, rangeEnd). Each item keeps
// its parent id + kind so it can be addressed individually (deletion via
// excludeForecastOccurrence). The aggregate treasuryForecastData sums by
// category and loses that identity, hence this dedicated projection — it mirrors
// the same future-gating (month >= currentMonth) and real-invoice dedup as
// sections 6b2/6c. Auto-forecast (historical average) is intentionally excluded:
// it has no entity to delete. `includePast` lifts the future-gating so a past
// month can still show what had been forecast (read-only consultation); the
// aggregate chart/table keeps ignoring past forecasts. `scenarioId` applique
// le calque du scénario (saisies propres, masquages et exclusions du
// scénario) sans jamais toucher Base. Returns [{ id, kind, name, category,
// type, amount, date: Date }] sorted chronologically.
export const projectForecastOccurrences = async (
  workspaceId,
  rangeStart,
  rangeEnd,
  { includePast = false, scenarioId = null } = {},
) => {
  const wId = new mongoose.Types.ObjectId(workspaceId);
  const overlay = await loadScenarioOverlay(scenarioId, wId);
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const mk = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const occurrences = [];

  // --- Manual cashflow entries (recurrence-expanded) ---
  const manualEntries = await ManualCashflowEntry.find({
    workspaceId: wId,
    startDate: { $lt: rangeEnd },
    ...overlay.manualEntryFilter(),
  }).lean();
  for (const entry of manualEntries) {
    if (overlay.isManualEntryHidden(entry)) continue;
    for (const occ of expandManualEntry(entry, rangeStart, rangeEnd)) {
      const month = mk(occ.date);
      if (!includePast && month < currentMonth) continue;
      if (entry.excludedMonths?.includes(month)) continue;
      if (overlay.isOccurrenceExcluded("MANUAL", entry._id, month)) continue;
      occurrences.push({
        id: entry._id.toString(),
        kind: "MANUAL",
        name: entry.name,
        category:
          entry.category ||
          (entry.type === "INCOME" ? "OTHER_INCOME" : "OTHER_EXPENSE"),
        type: entry.type,
        amount: occ.amount,
        date: occ.date,
      });
    }
  }

  // --- Active detected recurrences (état effectif dans le scénario) ---
  const activeRecurrences = (
    await DetectedRecurrence.find(
      projectableRecurrenceFilter(wId, overlay),
    ).lean()
  ).filter((rec) => overlay.isRecurrenceProjected(rec));
  if (activeRecurrences.length > 0) {
    // Dedup window: aligned on the projection window. When past months are
    // included, real invoices of those months must also be considered so a
    // detected recurrence doesn't duplicate an invoice already shown in Réel.
    const currentMonthStart = new Date(currentMonth + "-01");
    const dedupStart =
      includePast && rangeStart < currentMonthStart
        ? rangeStart
        : currentMonthStart;
    const PurchaseInvoice = mongoose.model("PurchaseInvoice");
    const futurePurchaseInvoices = await PurchaseInvoice.find({
      workspaceId: wId,
      issueDate: { $gte: dedupStart },
    })
      .select("supplierName category issueDate")
      .lean();
    const existingPurchaseKeys = new Set();
    for (const pi of futurePurchaseInvoices) {
      const m = mk(new Date(pi.issueDate));
      existingPurchaseKeys.add(
        `${normalizeParty(pi.supplierName)}::${pi.category || "OTHER"}::${m}`,
      );
    }
    const InvoiceModel = mongoose.model("Invoice");
    const futureInvoices = await InvoiceModel.find({
      workspaceId: wId,
      issueDate: { $gte: dedupStart },
    })
      .select("client issueDate")
      .lean();
    const existingInvoiceKeys = new Set();
    for (const inv of futureInvoices) {
      const name =
        inv?.client?.name ||
        [inv?.client?.firstName, inv?.client?.lastName]
          .filter(Boolean)
          .join(" ") ||
        inv?.client?.email ||
        "";
      existingInvoiceKeys.add(
        `${normalizeParty(name)}::${mk(new Date(inv.issueDate))}`,
      );
    }
    const invoiceRecurrenceKeys = new Set(
      activeRecurrences
        .filter((r) => r.source !== "TRANSACTION")
        .map((r) => `${r.partyKey}::${r.type}`),
    );
    const monthStep = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 };
    const dayStep = { WEEKLY: 7, BIWEEKLY: 14 };
    const advance = (date, freq) => {
      const d = new Date(date);
      if (dayStep[freq]) d.setDate(d.getDate() + dayStep[freq]);
      else d.setMonth(d.getMonth() + (monthStep[freq] || 1));
      return d;
    };

    for (const rec of activeRecurrences) {
      if (
        rec.source === "TRANSACTION" &&
        invoiceRecurrenceKeys.has(`${rec.partyKey}::${rec.type}`)
      )
        continue;
      const freq = rec.frequency || "MONTHLY";
      const anchor = rec.lastSeenDate
        ? new Date(rec.lastSeenDate)
        : new Date((rec.lastSeenMonth || currentMonth) + "-01");
      let occ = advance(anchor, freq);
      let guard = 0;
      while (occ < rangeEnd && guard++ < 1000) {
        const occDate = new Date(occ);
        const month = mk(occDate);
        occ = advance(occ, freq);
        if (occDate < rangeStart) continue;
        if (!includePast && month < currentMonth) continue;
        if (rec.excludedMonths?.includes(month)) continue;
        if (overlay.isOccurrenceExcluded("DETECTED", rec._id, month)) continue;
        // La déduplication avec les vraies factures se fait sur la catégorie
        // détectée (identité de la récurrence), jamais sur la surcharge.
        let type = rec.type;
        if (rec.source === "PURCHASE_INVOICE") {
          const key = `${rec.partyKey || normalizeParty(rec.partyName)}::${rec.category || "OTHER"}::${month}`;
          if (existingPurchaseKeys.has(key)) continue;
          type = "EXPENSE";
        } else if (rec.source === "INVOICE") {
          const key = `${rec.partyKey || normalizeParty(rec.partyName)}::${month}`;
          if (existingInvoiceKeys.has(key)) continue;
          type = "INCOME";
        }
        occurrences.push({
          id: rec._id.toString(),
          kind: "DETECTED",
          name: rec.partyName,
          category: recurrenceForecastCategory(rec),
          type,
          amount: rec.averageAmount,
          date: occDate,
        });
      }
    }
  }

  occurrences.sort((a, b) => a.date - b.date);
  return occurrences;
};

// Vue d'une récurrence depuis un scénario : isMuted / isActive effectifs et
// drapeau scenarioOverride. En Base, renvoie le document tel quel.
const applyRecurrenceOverlay = (rec, overlay) => {
  if (!overlay?.isScenario) return { ...rec, scenarioOverride: false };
  return {
    ...rec,
    isMuted: overlay.isRecurrenceMuted(rec),
    isActive: overlay.isRecurrenceProjected(rec),
    scenarioOverride: overlay.hasRecurrenceOverride(rec),
  };
};

// Une entité supprimée (saisie manuelle, récurrence) ne doit plus être
// référencée par les calques des scénarios du workspace.
const pullEntityFromScenarios = async (workspaceId, kind, entityId) => {
  const pull = { excludedOccurrences: { kind, entityId } };
  if (kind === "MANUAL") pull.hiddenManualEntryIds = entityId;
  if (kind === "DETECTED")
    pull.recurrenceOverrides = { recurrenceId: entityId };
  await ForecastScenario.updateMany({ workspaceId }, { $pull: pull });
};

const treasuryForecastResolvers = {
  Query: {
    treasuryForecastData: requireRead("expenses")(
      async (
        _,
        {
          workspaceId: inputWorkspaceId,
          startDate,
          endDate,
          accountId,
          scenarioId,
        },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const wId = new mongoose.Types.ObjectId(workspaceId);

        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

        // Scénario : multiplicateurs + calque (saisies propres, masquages,
        // exclusions) — cf. utils/forecastScenarioOverlay.js.
        const overlay = await loadScenarioOverlay(scenarioId, wId);
        const scenario = overlay.scenario;

        // Parse start/end as YYYY-MM
        const startMonth = startDate.substring(0, 7);
        const endMonth = endDate.substring(0, 7);
        const monthRange = getMonthRange(startMonth, endMonth);

        // 1. Get current bank balance
        const AccountBanking = mongoose.model("AccountBanking");
        const accountQuery = { workspaceId: wId, status: "active" };
        if (accountId) {
          accountQuery._id = new mongoose.Types.ObjectId(accountId);
        }
        const accounts = await AccountBanking.find(accountQuery).lean();
        const currentBalance = accounts.reduce((sum, a) => {
          // Use same logic as GraphQL resolver: balance is stored as Number in MongoDB
          const bal =
            typeof a.balance === "number"
              ? a.balance
              : (a.balance?.current ?? a.balance?.available ?? 0);
          return sum + bal;
        }, 0);

        // 2. Pending receivables (unpaid client invoices)
        const Invoice = mongoose.model("Invoice");
        const pendingReceivablesAgg = await Invoice.aggregate([
          {
            $match: {
              workspaceId: wId,
              status: { $in: ["PENDING", "OVERDUE"] },
            },
          },
          { $group: { _id: null, total: { $sum: "$finalTotalTTC" } } },
        ]);
        const pendingReceivables = pendingReceivablesAgg[0]?.total || 0;

        // 3. Pending payables (unpaid purchase invoices)
        const PurchaseInvoice = mongoose.model("PurchaseInvoice");
        const pendingPayablesAgg = await PurchaseInvoice.aggregate([
          {
            $match: {
              workspaceId: wId,
              status: { $in: ["TO_PAY", "PENDING", "OVERDUE"] },
            },
          },
          { $group: { _id: null, total: { $sum: "$amountTTC" } } },
        ]);
        const pendingPayables = pendingPayablesAgg[0]?.total || 0;

        // 4. Actual flows from bank transactions (sole source of truth)
        const Transaction = mongoose.model("Transaction");
        const txStartDate = new Date(startMonth + "-01");
        const txEndDate = new Date(endMonth + "-01");
        txEndDate.setMonth(txEndDate.getMonth() + 1);

        // Resolve effective date: date → processedAt → createdAt (same fallback as frontend)
        const effectiveDateField = {
          $ifNull: ["$date", { $ifNull: ["$processedAt", "$createdAt"] }],
        };

        const bankTxBaseMatch = {
          workspaceId: workspaceId,
          status: "completed",
          deletedAt: null,
        };

        // 4a. Income: all positive-amount transactions
        const bankIncomeTx = await Transaction.aggregate([
          { $match: { ...bankTxBaseMatch, amount: { $gt: 0 } } },
          { $addFields: { _effectiveDate: effectiveDateField } },
          { $match: { _effectiveDate: { $gte: txStartDate, $lt: txEndDate } } },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m", date: "$_effectiveDate" },
              },
              total: { $sum: "$amount" },
            },
          },
        ]);
        const incomeMap = {};
        for (const item of bankIncomeTx) {
          incomeMap[item._id] = item.total;
        }

        // 4b. Expenses: all negative-amount transactions (stored as absolute values)
        const bankExpenseTx = await Transaction.aggregate([
          { $match: { ...bankTxBaseMatch, amount: { $lt: 0 } } },
          { $addFields: { _effectiveDate: effectiveDateField } },
          { $match: { _effectiveDate: { $gte: txStartDate, $lt: txEndDate } } },
          {
            $group: {
              _id: {
                month: {
                  $dateToString: { format: "%Y-%m", date: "$_effectiveDate" },
                },
                category: { $ifNull: ["$expenseCategory", "OTHER"] },
              },
              total: { $sum: "$amount" },
            },
          },
        ]);
        const expenseMap = {};
        for (const item of bankExpenseTx) {
          const month = item._id.month;
          if (!expenseMap[month])
            expenseMap[month] = { total: 0, byCategory: {} };
          const absAmount = Math.abs(item.total);
          expenseMap[month].total += absAmount;
          const cat = normalizeCat(item._id.category || "OTHER");
          expenseMap[month].byCategory[cat] =
            (expenseMap[month].byCategory[cat] || 0) + absAmount;
        }

        // 5b. Calculate past averages for auto-forecast (future months without manual forecasts)
        const pastMonthRange = monthRange.filter((m) => m < currentMonth);
        const monthsWithIncome = pastMonthRange.filter(
          (m) => (incomeMap[m] || 0) > 0,
        );
        const avgMonthlyIncome =
          monthsWithIncome.length > 0
            ? Math.round(
                monthsWithIncome.reduce((sum, m) => sum + incomeMap[m], 0) /
                  monthsWithIncome.length,
              )
            : 0;

        const EXPENSE_CATS = [
          "RENT",
          "SUBSCRIPTIONS",
          "OFFICE_SUPPLIES",
          "SERVICES",
          "TRANSPORT",
          "MEALS",
          "TELECOMMUNICATIONS",
          "INSURANCE",
          "ENERGY",
          "SOFTWARE",
          "HARDWARE",
          "MARKETING",
          "TRAINING",
          "MAINTENANCE",
          "TAXES",
          "UTILITIES",
          "SALARIES",
          "OTHER_EXPENSE",
        ];
        const autoExpenseByCategory = {};
        let avgMonthlyExpense = 0;
        for (const cat of EXPENSE_CATS) {
          const mapKey = cat === "OTHER_EXPENSE" ? "OTHER" : cat;
          const mwc = pastMonthRange.filter(
            (m) => (expenseMap[m]?.byCategory[mapKey] || 0) > 0,
          );
          if (mwc.length > 0) {
            const avg = Math.round(
              mwc.reduce(
                (sum, m) => sum + (expenseMap[m].byCategory[mapKey] || 0),
                0,
              ) / mwc.length,
            );
            autoExpenseByCategory[cat] = avg;
            avgMonthlyExpense += avg;
          }
        }

        // 6. Manual forecasts
        const forecasts = await TreasuryForecast.find({
          workspaceId: wId,
          month: { $gte: startMonth, $lte: endMonth },
        }).lean();
        // forecastMap[month] = { income: { CAT: amount }, expense: { CAT: amount } }
        const forecastMap = {};
        for (const f of forecasts) {
          const m = f.month;
          if (!forecastMap[m]) forecastMap[m] = { income: {}, expense: {} };
          if (f.type === "INCOME") {
            forecastMap[m].income[f.category] = f.forecastAmount;
          } else {
            forecastMap[m].expense[f.category] = f.forecastAmount;
          }
        }

        // 6b. Signed quotes not yet converted to invoice — projected as SALES income
        // on their issueDate month (quote model has no execution date).
        // Amounts are TTC (aligned with bank transactions).
        const Quote = mongoose.model("Quote");
        const signedQuotes = await Quote.find({
          workspaceId: wId,
          status: "COMPLETED",
          $or: [
            { convertedToInvoice: { $exists: false } },
            { convertedToInvoice: null },
          ],
          issueDate: { $gte: txStartDate, $lt: txEndDate },
        })
          .select("issueDate finalTotalTTC")
          .lean();
        const quoteIncomeMap = {};
        for (const q of signedQuotes) {
          if (!q.issueDate || !q.finalTotalTTC) continue;
          const d = new Date(q.issueDate);
          const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          quoteIncomeMap[m] = (quoteIncomeMap[m] || 0) + q.finalTotalTTC;
        }

        // 6b2. Auto-detected recurrences (from monthly cron) — project active
        // ones for future months (état effectif dans le scénario). Skip months
        // where a matching purchase invoice already exists (deduplication).
        const activeRecurrences = (
          await DetectedRecurrence.find(
            projectableRecurrenceFilter(wId, overlay),
          ).lean()
        ).filter((rec) => overlay.isRecurrenceProjected(rec));
        const recurrenceIncomeMap = {};
        const recurrenceExpenseMap = {};
        if (activeRecurrences.length > 0) {
          // Fetch future PurchaseInvoice occurrences to dedupe by (supplier, category, month).
          const PurchaseInvoice = mongoose.model("PurchaseInvoice");
          const futurePurchaseInvoices = await PurchaseInvoice.find({
            workspaceId: wId,
            issueDate: { $gte: new Date(currentMonth + "-01") },
          })
            .select("supplierName category issueDate")
            .lean();
          const existingPurchaseKeys = new Set();
          for (const pi of futurePurchaseInvoices) {
            const d = new Date(pi.issueDate);
            const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            const key = `${normalizeParty(pi.supplierName)}::${pi.category || "OTHER"}::${m}`;
            existingPurchaseKeys.add(key);
          }
          // Also dedupe INCOME against future client Invoice docs.
          const InvoiceModel = mongoose.model("Invoice");
          const futureInvoices = await InvoiceModel.find({
            workspaceId: wId,
            issueDate: { $gte: new Date(currentMonth + "-01") },
          })
            .select("client issueDate")
            .lean();
          const existingInvoiceKeys = new Set();
          for (const inv of futureInvoices) {
            const name =
              inv?.client?.name ||
              [inv?.client?.firstName, inv?.client?.lastName]
                .filter(Boolean)
                .join(" ") ||
              inv?.client?.email ||
              "";
            const d = new Date(inv.issueDate);
            const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            existingInvoiceKeys.add(`${normalizeParty(name)}::${m}`);
          }

          // Invoice-based recurrences win over transaction-based ones for the
          // same party/type (the bank movement is the invoice being paid).
          const invoiceRecurrenceKeys = new Set(
            activeRecurrences
              .filter((r) => r.source !== "TRANSACTION")
              .map((r) => `${r.partyKey}::${r.type}`),
          );
          const mk = (d) =>
            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          // Step forward one occurrence at a time according to the detected
          // periodicity. Weekly/biweekly advance by days (several land in a
          // month → naturally summed); the rest advance by calendar months so
          // quarterly/yearly charges only hit their actual month.
          const monthStep = {
            MONTHLY: 1,
            QUARTERLY: 3,
            SEMIANNUAL: 6,
            ANNUAL: 12,
          };
          const dayStep = { WEEKLY: 7, BIWEEKLY: 14 };
          const advance = (date, freq) => {
            const d = new Date(date);
            if (dayStep[freq]) d.setDate(d.getDate() + dayStep[freq]);
            else d.setMonth(d.getMonth() + (monthStep[freq] || 1));
            return d;
          };
          const monthSet = new Set(monthRange);

          for (const rec of activeRecurrences) {
            if (
              rec.source === "TRANSACTION" &&
              invoiceRecurrenceKeys.has(`${rec.partyKey}::${rec.type}`)
            )
              continue;
            const freq = rec.frequency || "MONTHLY";
            const anchor = rec.lastSeenDate
              ? new Date(rec.lastSeenDate)
              : new Date((rec.lastSeenMonth || currentMonth) + "-01");
            // Project each occurrence strictly after the last observed one,
            // so a past streak doesn't pollute earlier months.
            let occ = advance(anchor, freq);
            let guard = 0;
            while (occ < txEndDate && guard++ < 1000) {
              const month = mk(occ);
              occ = advance(occ, freq);
              if (month < currentMonth || !monthSet.has(month)) continue;
              // Occurrence supprimée individuellement pour ce mois (en Base
              // ou dans ce scénario).
              if (rec.excludedMonths?.includes(month)) continue;
              if (overlay.isOccurrenceExcluded("DETECTED", rec._id, month))
                continue;
              // Déduplication sur la catégorie détectée (identité), somme
              // dans la catégorie de prévision (surcharge utilisateur ou
              // catégorie détectée rabattue sur l'enum).
              let type = rec.type;
              if (rec.source === "PURCHASE_INVOICE") {
                const key = `${rec.partyKey || normalizeParty(rec.partyName)}::${rec.category || "OTHER"}::${month}`;
                if (existingPurchaseKeys.has(key)) continue;
                type = "EXPENSE";
              } else if (rec.source === "INVOICE") {
                const key = `${rec.partyKey || normalizeParty(rec.partyName)}::${month}`;
                if (existingInvoiceKeys.has(key)) continue;
                type = "INCOME";
              }
              const cat = recurrenceForecastCategory(rec);
              const target =
                type === "INCOME" ? recurrenceIncomeMap : recurrenceExpenseMap;
              if (!target[month]) target[month] = {};
              target[month][cat] =
                (target[month][cat] || 0) + rec.averageAmount;
            }
          }
        }

        // 6c. Manual cashflow entries (with recurrence) — expand each entry
        // into occurrences within the horizon and bucket by month.
        const manualEntries = await ManualCashflowEntry.find({
          workspaceId: wId,
          startDate: { $lt: txEndDate },
          ...overlay.manualEntryFilter(),
        }).lean();
        const manualIncomeMap = {};
        const manualExpenseMap = {};
        for (const entry of manualEntries) {
          if (overlay.isManualEntryHidden(entry)) continue;
          const occurrences = expandManualEntry(entry, txStartDate, txEndDate);
          for (const occ of occurrences) {
            const m = `${occ.date.getFullYear()}-${String(occ.date.getMonth() + 1).padStart(2, "0")}`;
            // Occurrence supprimée individuellement pour ce mois (en Base ou
            // dans ce scénario).
            if (entry.excludedMonths?.includes(m)) continue;
            if (overlay.isOccurrenceExcluded("MANUAL", entry._id, m)) continue;
            const cat =
              entry.category ||
              (entry.type === "INCOME" ? "OTHER_INCOME" : "OTHER_EXPENSE");
            if (entry.type === "INCOME") {
              if (!manualIncomeMap[m]) manualIncomeMap[m] = {};
              manualIncomeMap[m][cat] =
                (manualIncomeMap[m][cat] || 0) + occ.amount;
            } else {
              if (!manualExpenseMap[m]) manualExpenseMap[m] = {};
              manualExpenseMap[m][cat] =
                (manualExpenseMap[m][cat] || 0) + occ.amount;
            }
          }
        }

        // 7. Build month-by-month data with cumulative balance
        // Anchor: current month opening balance = currentBalance - current month net
        // We build forward and backward from currentMonth
        const monthsData = monthRange.map((month) => {
          const actualIncome = incomeMap[month] || 0;
          const actualExpenseData = expenseMap[month] || {
            total: 0,
            byCategory: {},
          };
          const actualExpense = actualExpenseData.total;

          const manualForecast = forecastMap[month] || {
            income: {},
            expense: {},
          };
          const quoteIncome =
            month >= currentMonth ? quoteIncomeMap[month] || 0 : 0;
          const manualEntryIncomeByCat =
            month >= currentMonth ? manualIncomeMap[month] || {} : {};
          const manualEntryExpenseByCat =
            month >= currentMonth ? manualExpenseMap[month] || {} : {};
          const recurrenceIncomeByCat =
            month >= currentMonth ? recurrenceIncomeMap[month] || {} : {};
          const recurrenceExpenseByCat =
            month >= currentMonth ? recurrenceExpenseMap[month] || {} : {};
          const manualEntryIncomeTotal = Object.values(
            manualEntryIncomeByCat,
          ).reduce((s, v) => s + v, 0);
          const manualEntryExpenseTotal = Object.values(
            manualEntryExpenseByCat,
          ).reduce((s, v) => s + v, 0);
          const recurrenceIncomeTotal = Object.values(
            recurrenceIncomeByCat,
          ).reduce((s, v) => s + v, 0);
          const recurrenceExpenseTotal = Object.values(
            recurrenceExpenseByCat,
          ).reduce((s, v) => s + v, 0);
          let forecastIncome = Object.values(manualForecast.income).reduce(
            (s, v) => s + v,
            0,
          );
          let forecastExpense = Object.values(manualForecast.expense).reduce(
            (s, v) => s + v,
            0,
          );

          // Auto-forecast: only apply to current and future months without manual
          // forecast. Past months keep their actuals untouched (no projection
          // overlay on what already happened).
          // Quotes and manual entries STACK ON TOP of the historical average.
          // Detected recurrences are deducted from the auto base first (they
          // are computed FROM the same history that feeds the averages, so
          // their amount is already inside avgMonthly*), then re-added below
          // as their own visible component — total stays at the historical
          // level instead of double-counting.
          const needsAutoForecast =
            forecastIncome === 0 &&
            forecastExpense === 0 &&
            month >= currentMonth;
          const autoForecastIncome =
            needsAutoForecast && avgMonthlyIncome > 0 && quoteIncome === 0
              ? { SALES: avgMonthlyIncome }
              : {};
          const autoForecastExpense =
            needsAutoForecast && avgMonthlyExpense > 0
              ? { ...autoExpenseByCategory }
              : {};

          if (needsAutoForecast) {
            if (recurrenceIncomeTotal > 0 && autoForecastIncome.SALES) {
              autoForecastIncome.SALES = Math.max(
                0,
                autoForecastIncome.SALES - recurrenceIncomeTotal,
              );
            }
            for (const [cat, amt] of Object.entries(recurrenceExpenseByCat)) {
              if (autoForecastExpense[cat]) {
                autoForecastExpense[cat] = Math.max(
                  0,
                  autoForecastExpense[cat] - amt,
                );
              }
            }
            if (avgMonthlyIncome > 0 && quoteIncome === 0)
              forecastIncome = autoForecastIncome.SALES || 0;
            if (avgMonthlyExpense > 0)
              forecastExpense = Object.values(autoForecastExpense).reduce(
                (s, v) => s + v,
                0,
              );
          }

          // Signed quotes: add on top (stacks with manual SALES forecast if any).
          if (quoteIncome > 0) {
            forecastIncome += quoteIncome;
          }
          // Manual cashflow entries (recurrence-expanded) stack on top of
          // existing forecast for the month, regardless of auto/manual status.
          if (manualEntryIncomeTotal > 0)
            forecastIncome += manualEntryIncomeTotal;
          if (manualEntryExpenseTotal > 0)
            forecastExpense += manualEntryExpenseTotal;
          // Auto-detected recurrences: their share was deducted from the auto
          // base above, re-adding them here keeps the total unchanged while
          // making them visible as a distinct component.
          if (recurrenceIncomeTotal > 0) {
            forecastIncome += recurrenceIncomeTotal;
          }
          if (recurrenceExpenseTotal > 0) {
            forecastExpense += recurrenceExpenseTotal;
          }

          // Apply scenario multipliers to future months
          if (scenario && month >= currentMonth) {
            forecastIncome = Math.round(
              forecastIncome * (scenario.incomeMultiplier || 1),
            );
            forecastExpense = Math.round(
              forecastExpense * (scenario.expenseMultiplier || 1),
            );
          }

          // Merge manual + auto forecast for category breakdown
          const mergedForecastIncome = {
            ...autoForecastIncome,
            ...manualForecast.income,
          };
          const mergedForecastExpense = {
            ...autoForecastExpense,
            ...manualForecast.expense,
          };
          if (quoteIncome > 0) {
            mergedForecastIncome.SALES =
              (mergedForecastIncome.SALES || 0) + quoteIncome;
          }
          for (const [cat, amt] of Object.entries(manualEntryIncomeByCat)) {
            mergedForecastIncome[cat] = (mergedForecastIncome[cat] || 0) + amt;
          }
          for (const [cat, amt] of Object.entries(manualEntryExpenseByCat)) {
            mergedForecastExpense[cat] =
              (mergedForecastExpense[cat] || 0) + amt;
          }
          for (const [cat, amt] of Object.entries(recurrenceIncomeByCat)) {
            mergedForecastIncome[cat] = (mergedForecastIncome[cat] || 0) + amt;
          }
          for (const [cat, amt] of Object.entries(recurrenceExpenseByCat)) {
            mergedForecastExpense[cat] =
              (mergedForecastExpense[cat] || 0) + amt;
          }

          // Apply scenario multipliers to category breakdown
          if (scenario && month >= currentMonth) {
            for (const cat of Object.keys(mergedForecastIncome)) {
              mergedForecastIncome[cat] = Math.round(
                (mergedForecastIncome[cat] || 0) *
                  (scenario.incomeMultiplier || 1),
              );
            }
            for (const cat of Object.keys(mergedForecastExpense)) {
              mergedForecastExpense[cat] = Math.round(
                (mergedForecastExpense[cat] || 0) *
                  (scenario.expenseMultiplier || 1),
              );
            }
          }

          // Build category breakdown
          const categoryBreakdown = [];

          // Income categories
          for (const cat of INCOME_CATEGORIES) {
            const actual = cat === "SALES" ? actualIncome : 0;
            const forecast = mergedForecastIncome[cat] || 0;
            if (actual > 0 || forecast > 0) {
              categoryBreakdown.push({
                category: cat,
                type: "INCOME",
                actualAmount: actual,
                forecastAmount: forecast,
              });
            }
          }

          // Expense categories
          for (const cat of EXPENSE_CATS) {
            const actualCatKey = cat === "OTHER_EXPENSE" ? "OTHER" : cat;
            const actual = actualExpenseData.byCategory[actualCatKey] || 0;
            const forecast = mergedForecastExpense[cat] || 0;
            if (actual > 0 || forecast > 0) {
              categoryBreakdown.push({
                category: cat,
                type: "EXPENSE",
                actualAmount: actual,
                forecastAmount: forecast,
              });
            }
          }

          return {
            month,
            actualIncome,
            actualExpense,
            forecastIncome,
            forecastExpense,
            categoryBreakdown,
            // Balance will be filled in the next step
            openingBalance: 0,
            closingBalance: 0,
          };
        });

        // Calculate cumulative balances anchored on current month
        // Find current month index
        const currentMonthIdx = monthsData.findIndex(
          (m) => m.month === currentMonth,
        );

        if (currentMonthIdx >= 0) {
          // Current month: opening = currentBalance, then adjust
          // For past/present months, use actual data; for future, use forecast
          // Closing = opening + income - expense
          // Work backwards from currentMonth to set opening balance
          // currentMonth closing balance ≈ currentBalance
          // So opening of currentMonth = currentBalance - (actual net of current month so far)
          const currentMonthData = monthsData[currentMonthIdx];
          const currentNet =
            currentMonthData.actualIncome - currentMonthData.actualExpense;
          currentMonthData.openingBalance = currentBalance - currentNet;
          currentMonthData.closingBalance = currentBalance;

          // Go backwards
          for (let i = currentMonthIdx - 1; i >= 0; i--) {
            const md = monthsData[i];
            const net = md.actualIncome - md.actualExpense;
            md.closingBalance = monthsData[i + 1].openingBalance;
            md.openingBalance = md.closingBalance - net;
          }

          // Go forwards (future months use forecast if no actual)
          for (let i = currentMonthIdx + 1; i < monthsData.length; i++) {
            const md = monthsData[i];
            md.openingBalance = monthsData[i - 1].closingBalance;
            const isPast = md.month <= currentMonth;
            const income = isPast
              ? md.actualIncome
              : md.forecastIncome || md.actualIncome;
            const expense = isPast
              ? md.actualExpense
              : md.forecastExpense || md.actualExpense;
            md.closingBalance = md.openingBalance + income - expense;
          }
        } else {
          // Current month not in range — just build from first month with balance 0
          let runningBalance = currentBalance;
          for (const md of monthsData) {
            md.openingBalance = runningBalance;
            const isPast = md.month <= currentMonth;
            const income = isPast
              ? md.actualIncome
              : md.forecastIncome || md.actualIncome;
            const expense = isPast
              ? md.actualExpense
              : md.forecastExpense || md.actualExpense;
            md.closingBalance = runningBalance + income - expense;
            runningBalance = md.closingBalance;
          }
        }

        // 8. Calculate projected balance at 3 months
        const threeMonthsLater = new Date(now);
        threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3);
        const targetMonth = `${threeMonthsLater.getFullYear()}-${String(threeMonthsLater.getMonth() + 1).padStart(2, "0")}`;
        const targetMonthData = monthsData.find((m) => m.month === targetMonth);
        const projectedBalance3Months = targetMonthData
          ? targetMonthData.closingBalance
          : monthsData.length > 0
            ? monthsData[monthsData.length - 1].closingBalance
            : currentBalance;

        // Signed quotes not converted (total, independent of horizon filter)
        const signedQuotesTotal = Object.values(quoteIncomeMap).reduce(
          (s, v) => s + v,
          0,
        );

        return {
          kpi: {
            currentBalance,
            projectedBalance3Months,
            pendingReceivables,
            pendingPayables,
            signedQuotes: signedQuotesTotal,
          },
          months: monthsData,
        };
      },
    ),

    treasuryForecasts: requireRead("expenses")(
      async (
        _,
        { workspaceId: inputWorkspaceId, startMonth, endMonth },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        return await TreasuryForecast.find({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          month: { $gte: startMonth, $lte: endMonth },
        })
          .sort({ month: 1, category: 1 })
          .lean();
      },
    ),

    // Base : saisies de Base. Scénario : saisies de Base (avec leur état
    // hiddenInScenario) + saisies propres au scénario.
    manualCashflowEntries: requireRead("expenses")(
      async (_, { workspaceId: inputWorkspaceId, scenarioId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const wId = new mongoose.Types.ObjectId(workspaceId);
        const overlay = await loadScenarioOverlay(scenarioId, wId);
        const entries = await ManualCashflowEntry.find({
          workspaceId: wId,
          ...overlay.manualEntryFilter(),
        })
          .sort({ startDate: 1 })
          .lean();
        return entries.map((e) => ({
          ...e,
          hiddenInScenario: overlay.isManualEntryHidden(e),
        }));
      },
    ),

    // Dans un scénario, isMuted/isActive sont l'état effectif (surcharge du
    // scénario sinon Base) et scenarioOverride signale une surcharge.
    detectedRecurrences: requireRead("expenses")(
      async (_, { workspaceId: inputWorkspaceId, scenarioId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const wId = new mongoose.Types.ObjectId(workspaceId);
        const overlay = await loadScenarioOverlay(scenarioId, wId);
        const recurrences = await DetectedRecurrence.find({
          workspaceId: wId,
        })
          .sort({ isActive: -1, lastDetectedAt: -1 })
          .lean();
        return recurrences.map((rec) => applyRecurrenceOverlay(rec, overlay));
      },
    ),

    forecastMonthDetails: requireRead("expenses")(
      async (
        _,
        { workspaceId: inputWorkspaceId, month, scenarioId },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        if (!/^\d{4}-\d{2}$/.test(month)) {
          throw new AppError(
            "Format de mois invalide (attendu YYYY-MM)",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }
        const wId = new mongoose.Types.ObjectId(workspaceId);
        const start = new Date(month + "-01");
        const end = new Date(start);
        end.setMonth(end.getMonth() + 1);

        const InvoiceModel = mongoose.model("Invoice");
        const PurchaseInvoiceModel = mongoose.model("PurchaseInvoice");
        const QuoteModel = mongoose.model("Quote");
        const TransactionModel = mongoose.model("Transaction");

        const [invoices, purchaseInvoices, quotes, transactions] =
          await Promise.all([
            InvoiceModel.find({
              workspaceId: wId,
              status: { $ne: "DRAFT" },
              issueDate: { $gte: start, $lt: end },
            })
              .select("number prefix client finalTotalTTC issueDate status")
              .sort({ issueDate: 1 })
              .lean(),
            PurchaseInvoiceModel.find({
              workspaceId: wId,
              issueDate: { $gte: start, $lt: end },
            })
              .select("invoiceNumber supplierName amountTTC issueDate status")
              .sort({ issueDate: 1 })
              .lean(),
            QuoteModel.find({
              workspaceId: wId,
              status: "COMPLETED",
              $or: [
                { convertedToInvoice: { $exists: false } },
                { convertedToInvoice: null },
              ],
              issueDate: { $gte: start, $lt: end },
            })
              .select("number prefix client finalTotalTTC issueDate status")
              .sort({ issueDate: 1 })
              .lean(),
            // Bank transactions: use same "effective date" fallback as the
            // main resolver (date → processedAt → createdAt) so amounts line
            // up with the chart aggregate.
            TransactionModel.aggregate([
              {
                $match: {
                  workspaceId: workspaceId,
                  status: "completed",
                },
              },
              {
                $addFields: {
                  _effectiveDate: {
                    $ifNull: [
                      "$date",
                      { $ifNull: ["$processedAt", "$createdAt"] },
                    ],
                  },
                },
              },
              {
                $match: {
                  _effectiveDate: { $gte: start, $lt: end },
                },
              },
              { $sort: { _effectiveDate: 1 } },
            ]),
          ]);

        const resolveClientName = (client) =>
          client?.name ||
          [client?.firstName, client?.lastName].filter(Boolean).join(" ") ||
          client?.email ||
          "Client inconnu";

        // Prévisions (saisies manuelles + récurrences détectées) projetées sur
        // ce mois — includePast: un mois passé reste consultable (onglet
        // Prévision du drawer, en lecture seule côté front), même si le
        // tableau agrégé, lui, ignore les prévisions passées.
        const forecastEntries = (
          await projectForecastOccurrences(workspaceId, start, end, {
            includePast: true,
            scenarioId,
          })
        ).map((o) => ({
          id: o.id,
          kind: o.kind,
          name: o.name,
          category: o.category,
          type: o.type,
          amount: o.amount,
          date: o.date.toISOString(),
        }));

        return {
          month,
          invoices: invoices.map((i) => ({
            id: i._id.toString(),
            number: [i.prefix, i.number].filter(Boolean).join("-") || null,
            partyName: resolveClientName(i.client),
            amountTTC: i.finalTotalTTC || 0,
            issueDate: i.issueDate?.toISOString(),
            status: i.status,
            kind: "INVOICE",
          })),
          purchaseInvoices: purchaseInvoices.map((p) => ({
            id: p._id.toString(),
            number: p.invoiceNumber || null,
            partyName: p.supplierName || "Fournisseur inconnu",
            amountTTC: p.amountTTC || 0,
            issueDate: p.issueDate?.toISOString(),
            status: p.status,
            kind: "PURCHASE_INVOICE",
          })),
          signedQuotes: quotes.map((q) => ({
            id: q._id.toString(),
            number: [q.prefix, q.number].filter(Boolean).join("-") || null,
            partyName: resolveClientName(q.client),
            amountTTC: q.finalTotalTTC || 0,
            issueDate: q.issueDate?.toISOString(),
            status: q.status,
            kind: "QUOTE",
          })),
          bankTransactions: transactions.map((t) => ({
            id: t._id.toString(),
            description:
              t.description ||
              t.cleanDescription ||
              t.originalDescription ||
              "Opération bancaire",
            amount: t.amount || 0,
            date: (t._effectiveDate || t.date || t.createdAt)?.toISOString?.(),
            category: t.expenseCategory || null,
          })),
          forecastEntries,
        };
      },
    ),

    // Liste à plat des occurrences de prévision (saisies manuelles + récurrences
    // détectées) sur l'horizon — alimente l'onglet « Détails prévisions ».
    forecastOccurrences: requireRead("expenses")(
      async (
        _,
        { workspaceId: inputWorkspaceId, startMonth, endMonth, scenarioId },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        if (
          !/^\d{4}-\d{2}$/.test(startMonth) ||
          !/^\d{4}-\d{2}$/.test(endMonth)
        ) {
          throw new AppError(
            "Format de mois invalide (attendu YYYY-MM)",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }
        const start = new Date(startMonth + "-01");
        const end = new Date(endMonth + "-01");
        end.setMonth(end.getMonth() + 1);
        const occurrences = await projectForecastOccurrences(
          workspaceId,
          start,
          end,
          { scenarioId },
        );
        return occurrences.map((o) => ({
          id: o.id,
          kind: o.kind,
          name: o.name,
          category: o.category,
          type: o.type,
          amount: o.amount,
          date: o.date.toISOString(),
        }));
      },
    ),

    forecastScenarios: requireRead("expenses")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        return ForecastScenario.find({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        })
          .sort({ createdAt: 1 })
          .lean();
      },
    ),
  },

  Mutation: {
    upsertForecastScenario: requireWrite("expenses")(
      async (_, { input }, context) => {
        const workspaceId = resolveWorkspaceId(
          input.workspaceId,
          context.workspaceId,
        );
        const wId = new mongoose.Types.ObjectId(workspaceId);

        // Enforce 5-scenario limit for new scenarios
        if (!input.id) {
          const count = await ForecastScenario.countDocuments({
            workspaceId: wId,
          });
          if (count >= 5) {
            throw new AppError(
              "Vous ne pouvez pas créer plus de 5 scénarios",
              ERROR_CODES.VALIDATION_ERROR,
            );
          }
        }

        const result = await ForecastScenario.findOneAndUpdate(
          input.id
            ? { _id: input.id, workspaceId: wId }
            : { workspaceId: wId, name: input.name },
          {
            $set: {
              name: input.name,
              incomeMultiplier: input.incomeMultiplier,
              expenseMultiplier: input.expenseMultiplier,
            },
            $setOnInsert: {
              workspaceId: wId,
              createdBy: new mongoose.Types.ObjectId(context.user.id),
            },
          },
          { upsert: true, new: true, lean: true },
        );
        return result;
      },
    ),

    deleteForecastScenario: requireDelete("expenses")(
      async (_, { id }, context) => {
        const workspaceId = context.workspaceId;
        const result = await ForecastScenario.findOneAndDelete({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });
        if (!result) {
          throw new AppError("Scénario non trouvé", ERROR_CODES.NOT_FOUND);
        }
        // Les saisies propres au scénario disparaissent avec lui ; les
        // surcharges (masquages, exclusions) étaient portées par le scénario.
        await ManualCashflowEntry.deleteMany({
          workspaceId: result.workspaceId,
          scenarioId: result._id,
        });
        return { success: true, message: "Scénario supprimé" };
      },
    ),

    upsertTreasuryForecast: requireWrite("expenses")(
      async (_, { input }, context) => {
        const workspaceId = resolveWorkspaceId(
          input.workspaceId,
          context.workspaceId,
        );

        const result = await TreasuryForecast.findOneAndUpdate(
          {
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            month: input.month,
            category: input.category,
          },
          {
            $set: {
              type: input.type,
              forecastAmount: input.forecastAmount,
              notes: input.notes || "",
            },
            $setOnInsert: {
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
              month: input.month,
              category: input.category,
              createdBy: context.user.id,
            },
          },
          { upsert: true, new: true, lean: true },
        );

        return result;
      },
    ),

    deleteTreasuryForecast: requireDelete("expenses")(
      async (_, { id }, context) => {
        const workspaceId = context.workspaceId;
        const forecast = await TreasuryForecast.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!forecast) {
          throw new AppError("Prévision non trouvée", ERROR_CODES.NOT_FOUND);
        }

        await TreasuryForecast.deleteOne({ _id: id });
        return { success: true, message: "Prévision supprimée" };
      },
    ),

    upsertManualCashflowEntry: requireWrite("expenses")(
      async (_, { input }, context) => {
        const workspaceId = resolveWorkspaceId(
          input.workspaceId,
          context.workspaceId,
        );
        const wObjId = new mongoose.Types.ObjectId(workspaceId);

        const payload = {
          name: input.name,
          type: input.type,
          category: input.category || null,
          amount: input.amount,
          amountDelta: input.amountDelta || 0,
          amountDeltaType: input.amountDeltaType || "AMOUNT",
          startDate: new Date(input.startDate),
          endDate: input.endDate ? new Date(input.endDate) : null,
          frequency: input.frequency,
          notes: input.notes || "",
        };

        if (input.id) {
          const updated = await ManualCashflowEntry.findOneAndUpdate(
            { _id: input.id, workspaceId: wObjId },
            { $set: payload },
            { new: true, lean: true },
          );
          if (!updated) {
            throw new AppError(
              "Entrée manuelle non trouvée",
              ERROR_CODES.NOT_FOUND,
            );
          }
          return updated;
        }

        // Saisie créée depuis un scénario : elle lui appartient et n'apparaît
        // que dans ce scénario (Base intacte). Un scénario inconnu → Base.
        let scenarioObjId = null;
        if (input.scenarioId) {
          const scenario = await ForecastScenario.findOne({
            _id: input.scenarioId,
            workspaceId: wObjId,
          })
            .select("_id")
            .lean();
          if (!scenario) {
            throw new AppError("Scénario non trouvé", ERROR_CODES.NOT_FOUND);
          }
          scenarioObjId = scenario._id;
        }

        const created = await ManualCashflowEntry.create({
          ...payload,
          scenarioId: scenarioObjId,
          workspaceId: wObjId,
          createdBy: context.user.id,
        });
        return created.toObject();
      },
    ),

    deleteManualCashflowEntry: requireDelete("expenses")(
      async (_, { id }, context) => {
        const workspaceId = context.workspaceId;
        const entry = await ManualCashflowEntry.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });
        if (!entry) {
          throw new AppError(
            "Entrée manuelle non trouvée",
            ERROR_CODES.NOT_FOUND,
          );
        }
        await ManualCashflowEntry.deleteOne({ _id: id });
        await pullEntityFromScenarios(entry.workspaceId, "MANUAL", entry._id);
        return { success: true, message: "Entrée supprimée" };
      },
    ),

    runRecurrenceDetection: requireWrite("expenses")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const wId = new mongoose.Types.ObjectId(workspaceId);
        await runRecurringInvoiceDetectionForWorkspace(wId);
        const count = await DetectedRecurrence.countDocuments({
          workspaceId: wId,
          isActive: true,
          isMuted: false,
        });
        return count;
      },
    ),

    muteDetectedRecurrence: requireWrite("expenses")(
      async (_, { id, muted, scenarioId }, context) => {
        const workspaceId = context.workspaceId;
        const wId = new mongoose.Types.ObjectId(workspaceId);

        // Dans un scénario : surcharge propre au scénario, Base intacte. Si
        // l'état demandé est celui de Base, la surcharge est simplement
        // retirée (le scénario suit à nouveau Base).
        if (scenarioId) {
          const recurrence = await DetectedRecurrence.findOne({
            _id: id,
            workspaceId: wId,
          }).lean();
          if (!recurrence) {
            throw new AppError("Récurrence non trouvée", ERROR_CODES.NOT_FOUND);
          }
          const scenario = await ForecastScenario.findOne({
            _id: scenarioId,
            workspaceId: wId,
          })
            .select("_id")
            .lean();
          if (!scenario) {
            throw new AppError("Scénario non trouvé", ERROR_CODES.NOT_FOUND);
          }
          await ForecastScenario.updateOne(
            { _id: scenario._id },
            {
              $pull: { recurrenceOverrides: { recurrenceId: recurrence._id } },
            },
          );
          if (Boolean(recurrence.isMuted) !== muted) {
            await ForecastScenario.updateOne(
              { _id: scenario._id },
              {
                $push: {
                  recurrenceOverrides: {
                    recurrenceId: recurrence._id,
                    isMuted: muted,
                  },
                },
              },
            );
          }
          const overlay = await loadScenarioOverlay(scenario._id, wId);
          return applyRecurrenceOverlay(recurrence, overlay);
        }

        const updated = await DetectedRecurrence.findOneAndUpdate(
          {
            _id: id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          },
          {
            $set: {
              isMuted: muted,
              isActive: muted
                ? false
                : // Reactivate only if the streak is still valid.
                  undefined,
            },
          },
          { new: true, lean: true },
        );
        if (!updated) {
          throw new AppError("Récurrence non trouvée", ERROR_CODES.NOT_FOUND);
        }
        // If unmuting and the recurrence still has a valid streak, flip active
        // back on (2 occurrences is the floor for the longest periodicities).
        if (!muted && updated.consecutiveMonths >= 2 && !updated.isActive) {
          await DetectedRecurrence.updateOne(
            { _id: updated._id },
            { $set: { isActive: true } },
          );
          updated.isActive = true;
        }
        return updated;
      },
    ),

    // Masque (ou réaffiche) une saisie de Base dans un scénario uniquement.
    hideManualCashflowEntryInScenario: requireWrite("expenses")(
      async (_, { id, scenarioId, hidden }, context) => {
        const wId = new mongoose.Types.ObjectId(context.workspaceId);
        const entry = await ManualCashflowEntry.findOne({
          _id: id,
          workspaceId: wId,
        }).lean();
        if (!entry) {
          throw new AppError(
            "Entrée manuelle non trouvée",
            ERROR_CODES.NOT_FOUND,
          );
        }
        if (entry.scenarioId) {
          throw new AppError(
            "Cette saisie appartient à un scénario : supprimez-la plutôt",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }
        const scenario = await ForecastScenario.findOne({
          _id: scenarioId,
          workspaceId: wId,
        })
          .select("_id")
          .lean();
        if (!scenario) {
          throw new AppError("Scénario non trouvé", ERROR_CODES.NOT_FOUND);
        }
        await ForecastScenario.updateOne(
          { _id: scenario._id },
          hidden
            ? { $addToSet: { hiddenManualEntryIds: entry._id } }
            : { $pull: { hiddenManualEntryIds: entry._id } },
        );
        return { ...entry, hiddenInScenario: hidden };
      },
    ),

    // Catégorie de prévision choisie par l'utilisateur (null = revenir à la
    // catégorie détectée). Action de Base, commune à tous les scénarios : la
    // catégorie est une correction de données, pas une hypothèse de scénario.
    setDetectedRecurrenceCategory: requireWrite("expenses")(
      async (_, { id, category }, context) => {
        const wId = new mongoose.Types.ObjectId(context.workspaceId);
        const recurrence = await DetectedRecurrence.findOne({
          _id: id,
          workspaceId: wId,
        }).lean();
        if (!recurrence) {
          throw new AppError("Récurrence non trouvée", ERROR_CODES.NOT_FOUND);
        }
        const nextCategory = category || null;
        if (nextCategory) {
          const isIncomeCat = INCOME_CATEGORIES.includes(nextCategory);
          const isIncomeRec =
            recurrence.source === "INVOICE" ||
            (recurrence.source === "TRANSACTION" &&
              recurrence.type === "INCOME");
          if (isIncomeCat !== isIncomeRec) {
            throw new AppError(
              isIncomeRec
                ? "Choisissez une catégorie de revenu pour cette récurrence"
                : "Choisissez une catégorie de dépense pour cette récurrence",
              ERROR_CODES.VALIDATION_ERROR,
            );
          }
        }
        const updated = await DetectedRecurrence.findOneAndUpdate(
          { _id: recurrence._id },
          { $set: { categoryOverride: nextCategory } },
          { new: true, lean: true },
        );
        return updated;
      },
    ),

    deleteDetectedRecurrence: requireWrite("expenses")(
      async (_, { id }, context) => {
        const recurrence = await DetectedRecurrence.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(context.workspaceId),
        }).lean();
        if (!recurrence) {
          throw new AppError("Récurrence non trouvée", ERROR_CODES.NOT_FOUND);
        }
        await DetectedRecurrence.deleteOne({ _id: id });
        await pullEntityFromScenarios(
          recurrence.workspaceId,
          "DETECTED",
          recurrence._id,
        );
        return { success: true, message: "Récurrence supprimée" };
      },
    ),

    // Supprime UNE occurrence (un mois) d'une prévision récurrente sans toucher
    // aux autres mois : ajoute le mois à excludedMonths de l'entité ciblée.
    excludeForecastOccurrence: requireWrite("expenses")(
      async (_, { kind, id, month, scenarioId }, context) => {
        const workspaceId = context.workspaceId;
        if (!/^\d{4}-\d{2}$/.test(month)) {
          throw new AppError(
            "Format de mois invalide (attendu YYYY-MM)",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }
        const Model =
          kind === "MANUAL" ? ManualCashflowEntry : DetectedRecurrence;

        // Dans un scénario : l'exclusion est portée par le scénario, l'entité
        // (et donc Base) n'est pas modifiée.
        if (scenarioId) {
          const wId = new mongoose.Types.ObjectId(workspaceId);
          const entity = await Model.findOne({ _id: id, workspaceId: wId })
            .select("_id")
            .lean();
          if (!entity) {
            throw new AppError("Prévision non trouvée", ERROR_CODES.NOT_FOUND);
          }
          const scenario = await ForecastScenario.findOne({
            _id: scenarioId,
            workspaceId: wId,
          })
            .select("_id")
            .lean();
          if (!scenario) {
            throw new AppError("Scénario non trouvé", ERROR_CODES.NOT_FOUND);
          }
          const occurrence = { kind, entityId: entity._id, month };
          await ForecastScenario.updateOne(
            {
              _id: scenario._id,
              excludedOccurrences: { $not: { $elemMatch: occurrence } },
            },
            { $push: { excludedOccurrences: occurrence } },
          );
          return true;
        }

        const updated = await Model.findOneAndUpdate(
          {
            _id: id,
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
          },
          { $addToSet: { excludedMonths: month } },
          { new: true },
        );
        if (!updated) {
          throw new AppError("Prévision non trouvée", ERROR_CODES.NOT_FOUND);
        }
        return true;
      },
    ),
  },

  TreasuryForecast: {
    id: (parent) => parent._id?.toString() || parent.id,
  },

  ManualCashflowEntry: {
    id: (parent) => parent._id?.toString() || parent.id,
    scenarioId: (parent) =>
      parent.scenarioId ? parent.scenarioId.toString() : null,
    hiddenInScenario: (parent) => Boolean(parent.hiddenInScenario),
    startDate: (parent) =>
      parent.startDate instanceof Date
        ? parent.startDate.toISOString()
        : parent.startDate,
    endDate: (parent) =>
      parent.endDate instanceof Date
        ? parent.endDate.toISOString()
        : parent.endDate,
  },

  ForecastScenario: {
    id: (parent) => parent._id?.toString() || parent.id,
  },

  DetectedRecurrence: {
    id: (parent) => parent._id?.toString() || parent.id,
    scenarioOverride: (parent) => Boolean(parent.scenarioOverride),
    categoryOverride: (parent) => parent.categoryOverride || null,
    forecastCategory: (parent) => recurrenceForecastCategory(parent),
    lastDetectedAt: (parent) =>
      parent.lastDetectedAt instanceof Date
        ? parent.lastDetectedAt.toISOString()
        : parent.lastDetectedAt,
  },
};

export default treasuryForecastResolvers;
