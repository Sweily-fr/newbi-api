import mongoose from "mongoose";
import { requireRead } from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import { Board, Task } from "../models/kanban.js";

/**
 * Aggregate time tracked in Kanban tasks by client.
 * Returns a Map<clientIdString, { totalTimeSeconds, totalBillableAmount }>
 */
const aggregateTimeByClient = async (workspaceId, startDate, endDate, clientIds) => {
  // Find boards that have a clientId assigned
  const boardQuery = { workspaceId, clientId: { $ne: null } };
  if (clientIds && clientIds.length > 0) {
    boardQuery.clientId = { $in: clientIds.map(id => new mongoose.Types.ObjectId(id)) };
  }
  const boards = await Board.find(boardQuery).lean();
  if (boards.length === 0) return new Map();

  const boardMap = new Map(); // boardId -> clientId
  for (const b of boards) {
    boardMap.set(b._id.toString(), b.clientId.toString());
  }

  // Find tasks for those boards that have timeTracking data
  const taskQuery = {
    workspaceId,
    boardId: { $in: boards.map(b => b._id) },
    'timeTracking.totalSeconds': { $gt: 0 },
  };
  // Also include tasks with running timers
  const taskQueryWithRunning = {
    workspaceId,
    boardId: { $in: boards.map(b => b._id) },
    $or: [
      { 'timeTracking.totalSeconds': { $gt: 0 } },
      { 'timeTracking.isRunning': true },
    ],
  };
  const tasks = await Task.find(taskQueryWithRunning).lean();

  const result = new Map();
  for (const task of tasks) {
    const tt = task.timeTracking;
    if (!tt) continue;

    const clientId = boardMap.get(task.boardId.toString());
    if (!clientId) continue;

    // Filter by date range if provided (use task updatedAt as proxy)
    if (startDate && task.updatedAt < new Date(startDate)) continue;
    if (endDate && task.createdAt > new Date(endDate)) continue;

    let totalSeconds = tt.totalSeconds || 0;
    if (tt.isRunning && tt.currentStartTime) {
      totalSeconds += Math.floor((Date.now() - new Date(tt.currentStartTime).getTime()) / 1000);
    }
    if (totalSeconds <= 0) continue;

    let billableAmount = 0;
    if (tt.hourlyRate && tt.hourlyRate > 0) {
      const hours = totalSeconds / 3600;
      let billableHours = hours;
      if (tt.roundingOption === 'up') billableHours = Math.ceil(hours);
      else if (tt.roundingOption === 'down') billableHours = Math.floor(hours);
      billableAmount = billableHours * tt.hourlyRate;
    }

    const existing = result.get(clientId) || { totalTimeSeconds: 0, totalBillableAmount: 0 };
    existing.totalTimeSeconds += totalSeconds;
    existing.totalBillableAmount += billableAmount;
    result.set(clientId, existing);
  }

  return result;
};

const resolveWorkspaceId = (inputWorkspaceId, contextWorkspaceId) => {
  if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
    throw new AppError("Organisation invalide.", ERROR_CODES.FORBIDDEN);
  }
  return inputWorkspaceId || contextWorkspaceId;
};

const financialAnalyticsResolvers = {
  Query: {
    financialAnalytics: requireRead("invoices")(
      async (_, { workspaceId: inputWorkspaceId, startDate, endDate, clientId, clientIds, status }, context) => {
        const workspaceId = resolveWorkspaceId(inputWorkspaceId, context.workspaceId);
        const wId = new mongoose.Types.ObjectId(workspaceId);

        const dateQuery = {};
        if (startDate) dateQuery.$gte = new Date(startDate);
        if (endDate) dateQuery.$lte = new Date(endDate);

        // --- Invoice aggregation ---
        const invoiceMatch = {
          workspaceId: wId,
          status: { $ne: "DRAFT" },
        };
        if (startDate || endDate) invoiceMatch.issueDate = dateQuery;
        if (clientIds && clientIds.length > 0) {
          invoiceMatch["client.id"] = { $in: clientIds };
        } else if (clientId) {
          invoiceMatch["client.id"] = clientId;
        }
        if (status && status.length > 0) invoiceMatch.status = { $in: status };

        // --- Expense aggregation ---
        const expenseMatch = {
          workspaceId: wId,
        };
        if (startDate || endDate) expenseMatch.date = dateQuery;

        // --- Quote aggregation ---
        const quoteMatch = {
          workspaceId: wId,
          status: { $in: ["COMPLETED", "CANCELED", "PENDING"] },
        };
        if (startDate || endDate) quoteMatch.issueDate = dateQuery;

        const Invoice = mongoose.model("Invoice");
        const Expense = mongoose.model("Expense");
        const Quote = mongoose.model("Quote");

        const [invoiceStats, expenseStats, quoteStats] = await Promise.all([
          // 1. Invoice facet aggregation
          Invoice.aggregate([
            { $match: invoiceMatch },
            {
              $facet: {
                // Revenue by client
                revenueByClient: [
                  {
                    $group: {
                      _id: {
                        clientId: "$client.id",
                        clientName: {
                          $cond: {
                            if: { $eq: ["$client.type", "INDIVIDUAL"] },
                            then: {
                              $concat: [
                                { $ifNull: ["$client.firstName", ""] },
                                " ",
                                { $ifNull: ["$client.lastName", ""] },
                              ],
                            },
                            else: { $ifNull: ["$client.name", "Client inconnu"] },
                          },
                        },
                        clientType: "$client.type",
                      },
                      totalHT: { $sum: "$finalTotalHT" },
                      totalTTC: { $sum: "$finalTotalTTC" },
                      totalVAT: { $sum: "$finalTotalVAT" },
                      invoiceCount: { $sum: 1 },
                    },
                  },
                  { $sort: { totalHT: -1 } },
                ],
                // Revenue by product (unwind items)
                revenueByProduct: [
                  { $unwind: "$items" },
                  {
                    $group: {
                      _id: "$items.description",
                      totalHT: {
                        $sum: {
                          $multiply: [
                            "$items.quantity",
                            "$items.unitPrice",
                            {
                              $divide: [
                                { $ifNull: ["$items.progressPercentage", 100] },
                                100,
                              ],
                            },
                          ],
                        },
                      },
                      totalQuantity: { $sum: "$items.quantity" },
                      invoiceCount: { $addToSet: "$_id" },
                      unitPrices: { $push: "$items.unitPrice" },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      description: "$_id",
                      totalHT: { $round: ["$totalHT", 2] },
                      totalQuantity: 1,
                      invoiceCount: { $size: "$invoiceCount" },
                      averageUnitPrice: {
                        $round: [{ $avg: "$unitPrices" }, 2],
                      },
                    },
                  },
                  { $sort: { totalHT: -1 } },
                ],
                // Monthly revenue
                monthlyRevenue: [
                  {
                    $group: {
                      _id: {
                        year: { $year: "$issueDate" },
                        month: { $month: "$issueDate" },
                      },
                      revenueHT: { $sum: "$finalTotalHT" },
                      revenueTTC: { $sum: "$finalTotalTTC" },
                      revenueVAT: { $sum: "$finalTotalVAT" },
                      invoiceCount: { $sum: 1 },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      month: {
                        $concat: [
                          { $toString: "$_id.year" },
                          "-",
                          {
                            $cond: {
                              if: { $lt: ["$_id.month", 10] },
                              then: { $concat: ["0", { $toString: "$_id.month" }] },
                              else: { $toString: "$_id.month" },
                            },
                          },
                        ],
                      },
                      revenueHT: 1,
                      revenueTTC: 1,
                      revenueVAT: 1,
                      invoiceCount: 1,
                    },
                  },
                  { $sort: { month: 1 } },
                ],
                // Payment method stats
                paymentMethodStats: [
                  {
                    $group: {
                      _id: "$paymentMethod",
                      count: { $sum: 1 },
                      totalTTC: { $sum: "$finalTotalTTC" },
                    },
                  },
                  { $sort: { totalTTC: -1 } },
                ],
                // Status breakdown
                statusBreakdown: [
                  {
                    $group: {
                      _id: "$status",
                      count: { $sum: 1 },
                      totalTTC: { $sum: "$finalTotalTTC" },
                    },
                  },
                ],
                // Revenue by client x month
                revenueByClientMonthly: [
                  {
                    $group: {
                      _id: {
                        clientId: "$client.id",
                        clientName: {
                          $cond: {
                            if: { $eq: ["$client.type", "INDIVIDUAL"] },
                            then: {
                              $concat: [
                                { $ifNull: ["$client.firstName", ""] },
                                " ",
                                { $ifNull: ["$client.lastName", ""] },
                              ],
                            },
                            else: { $ifNull: ["$client.name", "Client inconnu"] },
                          },
                        },
                        year: { $year: "$issueDate" },
                        month: { $month: "$issueDate" },
                      },
                      totalHT: { $sum: "$finalTotalHT" },
                      totalTTC: { $sum: "$finalTotalTTC" },
                      totalVAT: { $sum: "$finalTotalVAT" },
                      invoiceCount: { $sum: 1 },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      clientId: "$_id.clientId",
                      clientName: "$_id.clientName",
                      month: {
                        $concat: [
                          { $toString: "$_id.year" },
                          "-",
                          {
                            $cond: {
                              if: { $lt: ["$_id.month", 10] },
                              then: { $concat: ["0", { $toString: "$_id.month" }] },
                              else: { $toString: "$_id.month" },
                            },
                          },
                        ],
                      },
                      totalHT: { $round: ["$totalHT", 2] },
                      totalTTC: { $round: ["$totalTTC", 2] },
                      totalVAT: { $round: ["$totalVAT", 2] },
                      invoiceCount: 1,
                    },
                  },
                  { $sort: { month: 1, clientName: 1 } },
                ],
                // Global totals
                totals: [
                  {
                    $group: {
                      _id: null,
                      totalRevenueHT: { $sum: "$finalTotalHT" },
                      totalRevenueTTC: { $sum: "$finalTotalTTC" },
                      invoiceCount: { $sum: 1 },
                      clients: { $addToSet: "$client.id" },
                    },
                  },
                ],
              },
            },
          ]),

          // 2. Expense aggregation
          Expense.aggregate([
            { $match: expenseMatch },
            {
              $facet: {
                totals: [
                  {
                    $group: {
                      _id: null,
                      totalExpenses: { $sum: "$amount" },
                      expenseCount: { $sum: 1 },
                    },
                  },
                ],
                monthly: [
                  {
                    $group: {
                      _id: {
                        year: { $year: "$date" },
                        month: { $month: "$date" },
                      },
                      amount: { $sum: "$amount" },
                      count: { $sum: 1 },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      month: {
                        $concat: [
                          { $toString: "$_id.year" },
                          "-",
                          {
                            $cond: {
                              if: { $lt: ["$_id.month", 10] },
                              then: { $concat: ["0", { $toString: "$_id.month" }] },
                              else: { $toString: "$_id.month" },
                            },
                          },
                        ],
                      },
                      amount: 1,
                      count: 1,
                    },
                  },
                  { $sort: { month: 1 } },
                ],
                byCategory: [
                  {
                    $group: {
                      _id: "$category",
                      amount: { $sum: "$amount" },
                      count: { $sum: 1 },
                    },
                  },
                  { $sort: { amount: -1 } },
                ],
                byCategoryMonthly: [
                  {
                    $group: {
                      _id: {
                        category: "$category",
                        year: { $year: "$date" },
                        month: { $month: "$date" },
                      },
                      amount: { $sum: "$amount" },
                      count: { $sum: 1 },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      category: { $ifNull: ["$_id.category", "OTHER"] },
                      month: {
                        $concat: [
                          { $toString: "$_id.year" },
                          "-",
                          {
                            $cond: {
                              if: { $lt: ["$_id.month", 10] },
                              then: { $concat: ["0", { $toString: "$_id.month" }] },
                              else: { $toString: "$_id.month" },
                            },
                          },
                        ],
                      },
                      amount: { $round: ["$amount", 2] },
                      count: 1,
                    },
                  },
                  { $sort: { month: 1, category: 1 } },
                ],
              },
            },
          ]),

          // 3. Quote aggregation (conversion rate)
          Quote.aggregate([
            { $match: quoteMatch },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                completed: {
                  $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
                },
              },
            },
          ]),
        ]);

        // Extract invoice results
        const invResult = invoiceStats[0];
        const invTotals = invResult.totals[0] || {
          totalRevenueHT: 0,
          totalRevenueTTC: 0,
          invoiceCount: 0,
          clients: [],
        };

        // Extract expense results
        const expResult = expenseStats[0];
        const expTotals = expResult.totals[0] || {
          totalExpenses: 0,
          expenseCount: 0,
        };

        // Extract quote results
        const quoteResult = quoteStats[0] || { total: 0, completed: 0 };
        const quoteConversionRate =
          quoteResult.total > 0
            ? Math.round((quoteResult.completed / quoteResult.total) * 10000) / 100
            : 0;

        // Merge monthly data (invoice + expense)
        const expenseMonthlyMap = {};
        for (const m of expResult.monthly) {
          expenseMonthlyMap[m.month] = { amount: m.amount, count: m.count };
        }

        const monthlyRevenue = invResult.monthlyRevenue.map((m) => {
          const exp = expenseMonthlyMap[m.month] || { amount: 0, count: 0 };
          delete expenseMonthlyMap[m.month];
          return {
            month: m.month,
            revenueHT: Math.round(m.revenueHT * 100) / 100,
            revenueTTC: Math.round(m.revenueTTC * 100) / 100,
            revenueVAT: Math.round(m.revenueVAT * 100) / 100,
            expenseAmount: Math.round(exp.amount * 100) / 100,
            invoiceCount: m.invoiceCount,
            expenseCount: exp.count,
            netResult: Math.round((m.revenueHT - exp.amount) * 100) / 100,
          };
        });

        // Add months that only have expenses
        for (const [month, exp] of Object.entries(expenseMonthlyMap)) {
          monthlyRevenue.push({
            month,
            revenueHT: 0,
            revenueTTC: 0,
            revenueVAT: 0,
            expenseAmount: Math.round(exp.amount * 100) / 100,
            invoiceCount: 0,
            expenseCount: exp.count,
            netResult: Math.round(-exp.amount * 100) / 100,
          });
        }
        monthlyRevenue.sort((a, b) => a.month.localeCompare(b.month));

        // Aggregate kanban time by client
        const clientTimeMap = await aggregateTimeByClient(wId, startDate, endDate, clientIds);

        // Build revenueByClient with time data
        const matchedClientIds = new Set();
        const revenueByClient = invResult.revenueByClient.map((c) => {
          const cId = c._id.clientId || null;
          if (cId) matchedClientIds.add(cId);
          const timeData = cId ? clientTimeMap.get(cId) : null;
          return {
            clientId: cId,
            clientName: (c._id.clientName || "Client inconnu").trim(),
            clientType: c._id.clientType || null,
            totalHT: Math.round(c.totalHT * 100) / 100,
            totalTTC: Math.round(c.totalTTC * 100) / 100,
            totalVAT: Math.round(c.totalVAT * 100) / 100,
            invoiceCount: c.invoiceCount,
            averageInvoiceHT:
              c.invoiceCount > 0
                ? Math.round((c.totalHT / c.invoiceCount) * 100) / 100
                : 0,
            totalTimeSeconds: timeData?.totalTimeSeconds || 0,
            totalBillableAmount: timeData ? Math.round(timeData.totalBillableAmount * 100) / 100 : 0,
            totalHours: timeData ? Math.round((timeData.totalTimeSeconds / 3600) * 100) / 100 : 0,
          };
        });

        // Add clients that have time tracked but no invoices
        const Client = mongoose.model("Client");
        for (const [clientId, timeData] of clientTimeMap) {
          if (matchedClientIds.has(clientId)) continue;
          const client = await Client.findById(clientId).lean();
          if (!client) continue;
          const clientName = client.type === "INDIVIDUAL"
            ? `${client.firstName || ""} ${client.lastName || ""}`.trim()
            : client.name || "Client inconnu";
          revenueByClient.push({
            clientId,
            clientName,
            clientType: client.type || null,
            totalHT: 0,
            totalTTC: 0,
            totalVAT: 0,
            invoiceCount: 0,
            averageInvoiceHT: 0,
            totalTimeSeconds: timeData.totalTimeSeconds,
            totalBillableAmount: Math.round(timeData.totalBillableAmount * 100) / 100,
            totalHours: Math.round((timeData.totalTimeSeconds / 3600) * 100) / 100,
          });
        }

        // Top 10 clients
        const totalTTCAll = invTotals.totalRevenueTTC || 1;
        const topClients = revenueByClient.slice(0, 10).map((c) => ({
          clientId: c.clientId,
          clientName: c.clientName,
          totalTTC: c.totalTTC,
          invoiceCount: c.invoiceCount,
          percentage: Math.round((c.totalTTC / totalTTCAll) * 10000) / 100,
        }));

        // KPI
        const totalRevenueHT = Math.round(invTotals.totalRevenueHT * 100) / 100;
        const kpi = {
          totalRevenueHT,
          totalRevenueTTC: Math.round(invTotals.totalRevenueTTC * 100) / 100,
          totalExpenses: Math.round(expTotals.totalExpenses * 100) / 100,
          netResult: Math.round((totalRevenueHT - expTotals.totalExpenses) * 100) / 100,
          invoiceCount: invTotals.invoiceCount,
          expenseCount: expTotals.expenseCount,
          averageInvoiceHT:
            invTotals.invoiceCount > 0
              ? Math.round((totalRevenueHT / invTotals.invoiceCount) * 100) / 100
              : 0,
          clientCount: (invTotals.clients || []).filter(Boolean).length,
          quoteConversionRate,
        };

        return {
          kpi,
          revenueByClient,
          revenueByProduct: invResult.revenueByProduct.map((p) => ({
            description: p.description,
            totalHT: p.totalHT,
            totalQuantity: p.totalQuantity,
            invoiceCount: p.invoiceCount,
            averageUnitPrice: p.averageUnitPrice,
          })),
          monthlyRevenue,
          paymentMethodStats: invResult.paymentMethodStats.map((s) => ({
            method: s._id || "OTHER",
            count: s.count,
            totalTTC: Math.round(s.totalTTC * 100) / 100,
          })),
          statusBreakdown: invResult.statusBreakdown.map((s) => ({
            status: s._id,
            count: s.count,
            totalTTC: Math.round(s.totalTTC * 100) / 100,
          })),
          topClients,
          expenseByCategory: expResult.byCategory.map((c) => ({
            category: c._id || "OTHER",
            amount: Math.round(c.amount * 100) / 100,
            count: c.count,
          })),
          revenueByClientMonthly: invResult.revenueByClientMonthly.map((r) => ({
            clientId: r.clientId || null,
            clientName: (r.clientName || "Client inconnu").trim(),
            month: r.month,
            totalHT: r.totalHT,
            totalTTC: r.totalTTC,
            totalVAT: r.totalVAT,
            invoiceCount: r.invoiceCount,
          })),
          expenseByCategoryMonthly: expResult.byCategoryMonthly.map((e) => ({
            category: e.category,
            month: e.month,
            amount: e.amount,
            count: e.count,
          })),
        };
      }
    ),
  },
};

export default financialAnalyticsResolvers;
