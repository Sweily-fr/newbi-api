import TreasuryForecast from "../models/TreasuryForecast.js";
import mongoose from "mongoose";
import {
  requireRead,
  requireWrite,
  requireDelete,
} from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";

const resolveWorkspaceId = (inputWorkspaceId, contextWorkspaceId) => {
  if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
    throw new AppError("Organisation invalide.", ERROR_CODES.FORBIDDEN);
  }
  return inputWorkspaceId || contextWorkspaceId;
};

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

const treasuryForecastResolvers = {
  Query: {
    treasuryForecastData: requireRead("expenses")(
      async (_, { workspaceId: inputWorkspaceId, startDate, endDate, accountId }, context) => {
        const workspaceId = resolveWorkspaceId(inputWorkspaceId, context.workspaceId);
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
          const bal = typeof a.balance === "number" ? a.balance : (a.balance?.available ?? 0);
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

        const bankTxBaseMatch = {
          workspaceId: workspaceId,
          status: "completed",
          date: { $gte: txStartDate, $lt: txEndDate },
        };

        // 4a. Income: all positive-amount transactions
        const bankIncomeTx = await Transaction.aggregate([
          { $match: { ...bankTxBaseMatch, amount: { $gt: 0 } } },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$date" } },
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
          {
            $group: {
              _id: {
                month: { $dateToString: { format: "%Y-%m", date: "$date" } },
                category: { $ifNull: ["$expenseCategory", "OTHER"] },
              },
              total: { $sum: "$amount" },
            },
          },
        ]);
        const expenseMap = {};
        for (const item of bankExpenseTx) {
          const month = item._id.month;
          if (!expenseMap[month]) expenseMap[month] = { total: 0, byCategory: {} };
          const absAmount = Math.abs(item.total);
          expenseMap[month].total += absAmount;
          const cat = item._id.category || "OTHER";
          expenseMap[month].byCategory[cat] = (expenseMap[month].byCategory[cat] || 0) + absAmount;
        }

        // 5b. Calculate past averages for auto-forecast (future months without manual forecasts)
        const pastMonthRange = monthRange.filter(m => m < currentMonth);
        const monthsWithIncome = pastMonthRange.filter(m => (incomeMap[m] || 0) > 0);
        const avgMonthlyIncome = monthsWithIncome.length > 0
          ? Math.round(monthsWithIncome.reduce((sum, m) => sum + incomeMap[m], 0) / monthsWithIncome.length)
          : 0;

        const EXPENSE_CATS = [
          "RENT", "SUBSCRIPTIONS", "OFFICE_SUPPLIES", "SERVICES", "TRANSPORT",
          "MEALS", "TELECOMMUNICATIONS", "INSURANCE", "ENERGY", "SOFTWARE",
          "HARDWARE", "MARKETING", "TRAINING", "MAINTENANCE", "TAXES",
          "UTILITIES", "SALARIES", "OTHER_EXPENSE",
        ];
        const autoExpenseByCategory = {};
        let avgMonthlyExpense = 0;
        for (const cat of EXPENSE_CATS) {
          const mapKey = cat === "OTHER_EXPENSE" ? "OTHER" : cat;
          const mwc = pastMonthRange.filter(m => (expenseMap[m]?.byCategory[mapKey] || 0) > 0);
          if (mwc.length > 0) {
            const avg = Math.round(
              mwc.reduce((sum, m) => sum + (expenseMap[m].byCategory[mapKey] || 0), 0) / mwc.length
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

        // 7. Build month-by-month data with cumulative balance
        // Anchor: current month opening balance = currentBalance - current month net
        // We build forward and backward from currentMonth
        const monthsData = monthRange.map((month) => {
          const actualIncome = incomeMap[month] || 0;
          const actualExpenseData = expenseMap[month] || { total: 0, byCategory: {} };
          const actualExpense = actualExpenseData.total;

          const manualForecast = forecastMap[month] || { income: {}, expense: {} };
          let forecastIncome = Object.values(manualForecast.income).reduce((s, v) => s + v, 0);
          let forecastExpense = Object.values(manualForecast.expense).reduce((s, v) => s + v, 0);

          // Auto-forecast: apply when no manual forecast AND (current/future month OR past month with actual data)
          const hasActualData = actualIncome > 0 || actualExpense > 0;
          const needsAutoForecast = forecastIncome === 0 && forecastExpense === 0 && (month >= currentMonth || hasActualData);
          const autoForecastIncome = needsAutoForecast && avgMonthlyIncome > 0 ? { SALES: avgMonthlyIncome } : {};
          const autoForecastExpense = needsAutoForecast && avgMonthlyExpense > 0 ? { ...autoExpenseByCategory } : {};

          if (needsAutoForecast) {
            if (avgMonthlyIncome > 0) forecastIncome = avgMonthlyIncome;
            if (avgMonthlyExpense > 0) forecastExpense = avgMonthlyExpense;
          }

          // Merge manual + auto forecast for category breakdown
          const mergedForecastIncome = { ...autoForecastIncome, ...manualForecast.income };
          const mergedForecastExpense = { ...autoForecastExpense, ...manualForecast.expense };

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
        const currentMonthIdx = monthsData.findIndex((m) => m.month === currentMonth);

        if (currentMonthIdx >= 0) {
          // Current month: opening = currentBalance, then adjust
          // For past/present months, use actual data; for future, use forecast
          // Closing = opening + income - expense
          // Work backwards from currentMonth to set opening balance
          // currentMonth closing balance ≈ currentBalance
          // So opening of currentMonth = currentBalance - (actual net of current month so far)
          const currentMonthData = monthsData[currentMonthIdx];
          const currentNet = currentMonthData.actualIncome - currentMonthData.actualExpense;
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
            const income = isPast ? md.actualIncome : (md.forecastIncome || md.actualIncome);
            const expense = isPast ? md.actualExpense : (md.forecastExpense || md.actualExpense);
            md.closingBalance = md.openingBalance + income - expense;
          }
        } else {
          // Current month not in range — just build from first month with balance 0
          let runningBalance = currentBalance;
          for (const md of monthsData) {
            md.openingBalance = runningBalance;
            const isPast = md.month <= currentMonth;
            const income = isPast ? md.actualIncome : (md.forecastIncome || md.actualIncome);
            const expense = isPast ? md.actualExpense : (md.forecastExpense || md.actualExpense);
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
          : (monthsData.length > 0 ? monthsData[monthsData.length - 1].closingBalance : currentBalance);

        return {
          kpi: {
            currentBalance,
            projectedBalance3Months,
            pendingReceivables,
            pendingPayables,
          },
          months: monthsData,
        };
      }
    ),

    treasuryForecasts: requireRead("expenses")(
      async (_, { workspaceId: inputWorkspaceId, startMonth, endMonth }, context) => {
        const workspaceId = resolveWorkspaceId(inputWorkspaceId, context.workspaceId);
        return await TreasuryForecast.find({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          month: { $gte: startMonth, $lte: endMonth },
        })
          .sort({ month: 1, category: 1 })
          .lean();
      }
    ),
  },

  Mutation: {
    upsertTreasuryForecast: requireWrite("expenses")(
      async (_, { input }, context) => {
        const workspaceId = resolveWorkspaceId(input.workspaceId, context.workspaceId);

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
          { upsert: true, new: true, lean: true }
        );

        return result;
      }
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
      }
    ),
  },

  TreasuryForecast: {
    id: (parent) => parent._id?.toString() || parent.id,
  },
};

export default treasuryForecastResolvers;
