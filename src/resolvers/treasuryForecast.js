import TreasuryForecast from "../models/TreasuryForecast.js";
import ManualCashflowEntry from "../models/ManualCashflowEntry.js";
import DetectedRecurrence from "../models/DetectedRecurrence.js";
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

// Income categories for filtering
const INCOME_CATEGORIES = ["SALES", "REFUNDS_RECEIVED", "OTHER_INCOME"];

// Helper: generate array of "YYYY-MM" strings between start and end
const getMonthRange = (startDate, endDate) => {
  const months = [];
  const start = new Date(startDate + "-01");
  const end = new Date(endDate + "-01");
  const current = new Date(start);
  while (current <= end) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, "0");
    months.push(`${y}-${m}`);
    current.setMonth(current.getMonth() + 1);
  }
  return months;
};

// Expand a manual entry into occurrence dates within [rangeStart, rangeEnd).
// frequency: ONCE, WEEKLY, MONTHLY, QUARTERLY, SEMIANNUAL, ANNUAL.
const expandManualEntry = (entry, rangeStart, rangeEnd) => {
  const occurrences = [];
  const start = new Date(entry.startDate);
  const end = entry.endDate ? new Date(entry.endDate) : null;
  const upperBound =
    end && end < rangeEnd ? new Date(end.getTime() + 1) : rangeEnd;

  if (entry.frequency === "ONCE") {
    if (start >= rangeStart && start < rangeEnd && (!end || start <= end)) {
      occurrences.push(new Date(start));
    }
    return occurrences;
  }

  const current = new Date(start);
  // Safety cap to avoid runaway loops on malformed data.
  let guard = 0;
  while (current < upperBound && guard < 600) {
    if (current >= rangeStart) occurrences.push(new Date(current));
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

const treasuryForecastResolvers = {
  Query: {
    treasuryForecastData: requireRead("expenses")(
      async (
        _,
        { workspaceId: inputWorkspaceId, startDate, endDate, accountId },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const wId = new mongoose.Types.ObjectId(workspaceId);

        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

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
          const cat = item._id.category || "OTHER";
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
        // ones for future months. Skip months where a matching purchase invoice
        // already exists (deduplication).
        const activeRecurrences = await DetectedRecurrence.find({
          workspaceId: wId,
          isActive: true,
          isMuted: false,
        }).lean();
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

          for (const rec of activeRecurrences) {
            for (const month of monthRange) {
              if (month < currentMonth) continue;
              // Only project months strictly after the last observed occurrence,
              // so a streak May→Jul doesn't pollute April (or earlier gaps).
              if (rec.lastSeenMonth && month <= rec.lastSeenMonth) continue;
              if (rec.source === "PURCHASE_INVOICE") {
                const key = `${rec.partyKey || normalizeParty(rec.partyName)}::${rec.category || "OTHER"}::${month}`;
                if (existingPurchaseKeys.has(key)) continue;
                const cat = rec.category || "OTHER_EXPENSE";
                if (!recurrenceExpenseMap[month])
                  recurrenceExpenseMap[month] = {};
                recurrenceExpenseMap[month][cat] =
                  (recurrenceExpenseMap[month][cat] || 0) + rec.averageAmount;
              } else {
                const key = `${rec.partyKey || normalizeParty(rec.partyName)}::${month}`;
                if (existingInvoiceKeys.has(key)) continue;
                if (!recurrenceIncomeMap[month])
                  recurrenceIncomeMap[month] = {};
                recurrenceIncomeMap[month].SALES =
                  (recurrenceIncomeMap[month].SALES || 0) + rec.averageAmount;
              }
            }
          }
        }

        // 6c. Manual cashflow entries (with recurrence) — expand each entry
        // into occurrences within the horizon and bucket by month.
        const manualEntries = await ManualCashflowEntry.find({
          workspaceId: wId,
          startDate: { $lt: txEndDate },
        }).lean();
        const manualIncomeMap = {};
        const manualExpenseMap = {};
        for (const entry of manualEntries) {
          const occurrences = expandManualEntry(entry, txStartDate, txEndDate);
          for (const occ of occurrences) {
            const m = `${occ.getFullYear()}-${String(occ.getMonth() + 1).padStart(2, "0")}`;
            const cat =
              entry.category ||
              (entry.type === "INCOME" ? "OTHER_INCOME" : "OTHER_EXPENSE");
            if (entry.type === "INCOME") {
              if (!manualIncomeMap[m]) manualIncomeMap[m] = {};
              manualIncomeMap[m][cat] =
                (manualIncomeMap[m][cat] || 0) + entry.amount;
            } else {
              if (!manualExpenseMap[m]) manualExpenseMap[m] = {};
              manualExpenseMap[m][cat] =
                (manualExpenseMap[m][cat] || 0) + entry.amount;
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

          // Auto-forecast: applied to every month (past, current, future) so the
          // chart always has a projection reference even when there is no actual.
          // Concrete signals (quotes, recurrences) replace the historical average
          // for the corresponding side (otherwise we'd double-count: the past
          // invoices that built the average are the same that triggered the
          // recurrence detection).
          const hasConcreteIncomeSignal =
            quoteIncome > 0 || recurrenceIncomeTotal > 0;
          const hasConcreteExpenseSignal = recurrenceExpenseTotal > 0;
          const needsAutoForecast =
            forecastIncome === 0 && forecastExpense === 0;
          const autoForecastIncome =
            needsAutoForecast &&
            avgMonthlyIncome > 0 &&
            !hasConcreteIncomeSignal
              ? { SALES: avgMonthlyIncome }
              : {};
          const autoForecastExpense =
            needsAutoForecast &&
            avgMonthlyExpense > 0 &&
            !hasConcreteExpenseSignal
              ? { ...autoExpenseByCategory }
              : {};

          if (needsAutoForecast) {
            if (avgMonthlyIncome > 0 && !hasConcreteIncomeSignal)
              forecastIncome = avgMonthlyIncome;
            if (avgMonthlyExpense > 0 && !hasConcreteExpenseSignal)
              forecastExpense = avgMonthlyExpense;
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
          // Auto-detected recurrences stack on top for future months. Auto
          // historical avg is already suppressed above when a recurrence exists,
          // so no double-counting on the past-data side.
          if (recurrenceIncomeTotal > 0) {
            forecastIncome += recurrenceIncomeTotal;
          }
          if (recurrenceExpenseTotal > 0) {
            forecastExpense += recurrenceExpenseTotal;
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

    manualCashflowEntries: requireRead("expenses")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        return await ManualCashflowEntry.find({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        })
          .sort({ startDate: 1 })
          .lean();
      },
    ),

    detectedRecurrences: requireRead("expenses")(
      async (_, { workspaceId: inputWorkspaceId }, context) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        return await DetectedRecurrence.find({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        })
          .sort({ isActive: -1, lastDetectedAt: -1 })
          .lean();
      },
    ),
  },

  Mutation: {
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

        const created = await ManualCashflowEntry.create({
          ...payload,
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
      async (_, { id, muted }, context) => {
        const workspaceId = context.workspaceId;
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
        // If unmuting and the streak is full, flip active back on.
        if (!muted && updated.consecutiveMonths >= 3 && !updated.isActive) {
          await DetectedRecurrence.updateOne(
            { _id: updated._id },
            { $set: { isActive: true } },
          );
          updated.isActive = true;
        }
        return updated;
      },
    ),
  },

  TreasuryForecast: {
    id: (parent) => parent._id?.toString() || parent.id,
  },

  ManualCashflowEntry: {
    id: (parent) => parent._id?.toString() || parent.id,
    startDate: (parent) =>
      parent.startDate instanceof Date
        ? parent.startDate.toISOString()
        : parent.startDate,
    endDate: (parent) =>
      parent.endDate instanceof Date
        ? parent.endDate.toISOString()
        : parent.endDate,
  },

  DetectedRecurrence: {
    id: (parent) => parent._id?.toString() || parent.id,
    lastDetectedAt: (parent) =>
      parent.lastDetectedAt instanceof Date
        ? parent.lastDetectedAt.toISOString()
        : parent.lastDetectedAt,
  },
};

export default treasuryForecastResolvers;
