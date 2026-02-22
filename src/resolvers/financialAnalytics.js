import mongoose from 'mongoose';
import { requireRead } from '../middlewares/rbac.js';
import { AppError, ERROR_CODES } from '../utils/errors.js';
import { Board, Task } from '../models/kanban.js';

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
    throw new AppError('Organisation invalide.', ERROR_CODES.FORBIDDEN);
  }
  return inputWorkspaceId || contextWorkspaceId;
};

/**
 * Generate alerts based on KPI values
 */
function generateAlerts(kpi) {
  const alerts = [];

  // Gross margin rate < 20% → danger
  if (kpi.netRevenueHT > 0 && kpi.grossMarginRate < 20) {
    alerts.push({
      type: 'MARGIN',
      severity: 'danger',
      message: `Taux de marge brute faible : ${kpi.grossMarginRate.toFixed(1)}% (seuil : 20%)`,
      value: kpi.grossMarginRate,
      threshold: 20,
    });
  }

  // DSO > 45 days → warning, > 60 → danger
  if (kpi.dso > 60) {
    alerts.push({
      type: 'DSO',
      severity: 'danger',
      message: `DSO critique : ${Math.round(kpi.dso)} jours (seuil : 60 jours)`,
      value: kpi.dso,
      threshold: 60,
    });
  } else if (kpi.dso > 45) {
    alerts.push({
      type: 'DSO',
      severity: 'warning',
      message: `DSO élevé : ${Math.round(kpi.dso)} jours (seuil : 45 jours)`,
      value: kpi.dso,
      threshold: 45,
    });
  }

  // Top 3 client concentration > 70% → warning
  if (kpi.topClientConcentration > 70) {
    alerts.push({
      type: 'CONCENTRATION',
      severity: 'warning',
      message: `Concentration clients élevée : ${kpi.topClientConcentration.toFixed(1)}% du CA sur les 3 premiers clients`,
      value: kpi.topClientConcentration,
      threshold: 70,
    });
  }

  // Overdue invoices > 0 → danger
  if (kpi.overdueCount > 0) {
    const formatted = new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(kpi.overdueAmount);
    alerts.push({
      type: 'OVERDUE',
      severity: 'danger',
      message: `${kpi.overdueCount} facture${kpi.overdueCount > 1 ? 's' : ''} en retard pour un total de ${formatted}`,
      value: kpi.overdueAmount,
      threshold: 0,
    });
  }

  return alerts;
}

/**
 * Compute N-1 previous period dates by mirroring the current period
 */
function computePreviousPeriod(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const durationMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - 1); // day before current start
  const prevStart = new Date(prevEnd.getTime() - durationMs);
  return { prevStart, prevEnd };
}

const financialAnalyticsResolvers = {
  Query: {
    financialAnalytics: requireRead('invoices')(
      async (_, { workspaceId: inputWorkspaceId, startDate, endDate, clientId, clientIds, status }, context) => {
        const workspaceId = resolveWorkspaceId(inputWorkspaceId, context.workspaceId);
        const wId = new mongoose.Types.ObjectId(workspaceId);
        const now = new Date();

        const dateQuery = {};
        if (startDate) dateQuery.$gte = new Date(startDate);
        if (endDate) dateQuery.$lte = new Date(endDate);

        // --- Invoice match ---
        const invoiceMatch = {
          workspaceId: wId,
          status: { $ne: 'DRAFT' },
        };
        if (startDate || endDate) invoiceMatch.issueDate = dateQuery;
        if (clientIds && clientIds.length > 0) {
          invoiceMatch['client.id'] = { $in: clientIds };
        } else if (clientId) {
          invoiceMatch['client.id'] = clientId;
        }
        if (status && status.length > 0) invoiceMatch.status = { $in: status };

        // --- Expense match ---
        const expenseMatch = {
          workspaceId: wId,
        };
        if (startDate || endDate) expenseMatch.date = dateQuery;

        // --- Quote match ---
        const quoteMatch = {
          workspaceId: wId,
          status: { $in: ['COMPLETED', 'CANCELED', 'PENDING'] },
        };
        if (startDate || endDate) quoteMatch.issueDate = dateQuery;

        // --- CreditNote match ---
        const creditNoteMatch = {
          workspaceId: wId,
        };
        if (startDate || endDate) creditNoteMatch.issueDate = dateQuery;

        const Invoice = mongoose.model('Invoice');
        const Expense = mongoose.model('Expense');
        const Quote = mongoose.model('Quote');
        const CreditNote = mongoose.model('CreditNote');

        // ==============================
        // MAIN AGGREGATIONS (parallel)
        // ==============================
        const [invoiceStats, expenseStats, quoteStats, creditNoteStats] = await Promise.all([
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
                        clientId: '$client.id',
                        clientName: {
                          $cond: {
                            if: { $eq: ['$client.type', 'INDIVIDUAL'] },
                            then: {
                              $concat: [
                                { $ifNull: ['$client.firstName', ''] },
                                ' ',
                                { $ifNull: ['$client.lastName', ''] },
                              ],
                            },
                            else: { $ifNull: ['$client.name', 'Client inconnu'] },
                          },
                        },
                        clientType: '$client.type',
                      },
                      totalHT: { $sum: '$finalTotalHT' },
                      totalTTC: { $sum: '$finalTotalTTC' },
                      totalVAT: { $sum: '$finalTotalVAT' },
                      invoiceCount: { $sum: 1 },
                    },
                  },
                  { $sort: { totalHT: -1 } },
                ],
                // Revenue by product (unwind items)
                revenueByProduct: [
                  { $unwind: '$items' },
                  {
                    $group: {
                      _id: '$items.description',
                      totalHT: {
                        $sum: {
                          $multiply: [
                            '$items.quantity',
                            '$items.unitPrice',
                            {
                              $divide: [
                                { $ifNull: ['$items.progressPercentage', 100] },
                                100,
                              ],
                            },
                          ],
                        },
                      },
                      totalQuantity: { $sum: '$items.quantity' },
                      invoiceCount: { $addToSet: '$_id' },
                      unitPrices: { $push: '$items.unitPrice' },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      description: '$_id',
                      totalHT: { $round: ['$totalHT', 2] },
                      totalQuantity: 1,
                      invoiceCount: { $size: '$invoiceCount' },
                      averageUnitPrice: {
                        $round: [{ $avg: '$unitPrices' }, 2],
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
                        year: { $year: '$issueDate' },
                        month: { $month: '$issueDate' },
                      },
                      revenueHT: { $sum: '$finalTotalHT' },
                      revenueTTC: { $sum: '$finalTotalTTC' },
                      revenueVAT: { $sum: '$finalTotalVAT' },
                      invoiceCount: { $sum: 1 },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      month: {
                        $concat: [
                          { $toString: '$_id.year' },
                          '-',
                          {
                            $cond: {
                              if: { $lt: ['$_id.month', 10] },
                              then: { $concat: ['0', { $toString: '$_id.month' }] },
                              else: { $toString: '$_id.month' },
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
                      _id: '$paymentMethod',
                      count: { $sum: 1 },
                      totalTTC: { $sum: '$finalTotalTTC' },
                    },
                  },
                  { $sort: { totalTTC: -1 } },
                ],
                // Status breakdown
                statusBreakdown: [
                  {
                    $group: {
                      _id: '$status',
                      count: { $sum: 1 },
                      totalTTC: { $sum: '$finalTotalTTC' },
                    },
                  },
                ],
                // Revenue by client x month
                revenueByClientMonthly: [
                  {
                    $group: {
                      _id: {
                        clientId: '$client.id',
                        clientName: {
                          $cond: {
                            if: { $eq: ['$client.type', 'INDIVIDUAL'] },
                            then: {
                              $concat: [
                                { $ifNull: ['$client.firstName', ''] },
                                ' ',
                                { $ifNull: ['$client.lastName', ''] },
                              ],
                            },
                            else: { $ifNull: ['$client.name', 'Client inconnu'] },
                          },
                        },
                        year: { $year: '$issueDate' },
                        month: { $month: '$issueDate' },
                      },
                      totalHT: { $sum: '$finalTotalHT' },
                      totalTTC: { $sum: '$finalTotalTTC' },
                      totalVAT: { $sum: '$finalTotalVAT' },
                      invoiceCount: { $sum: 1 },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      clientId: '$_id.clientId',
                      clientName: '$_id.clientName',
                      month: {
                        $concat: [
                          { $toString: '$_id.year' },
                          '-',
                          {
                            $cond: {
                              if: { $lt: ['$_id.month', 10] },
                              then: { $concat: ['0', { $toString: '$_id.month' }] },
                              else: { $toString: '$_id.month' },
                            },
                          },
                        ],
                      },
                      totalHT: { $round: ['$totalHT', 2] },
                      totalTTC: { $round: ['$totalTTC', 2] },
                      totalVAT: { $round: ['$totalVAT', 2] },
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
                      totalRevenueHT: { $sum: '$finalTotalHT' },
                      totalRevenueTTC: { $sum: '$finalTotalTTC' },
                      invoiceCount: { $sum: 1 },
                      clients: { $addToSet: '$client.id' },
                    },
                  },
                ],
                // Outstanding receivables (PENDING + OVERDUE)
                receivables: [
                  { $match: { status: { $in: ['PENDING', 'OVERDUE'] } } },
                  {
                    $group: {
                      _id: null,
                      outstandingReceivables: { $sum: '$finalTotalTTC' },
                    },
                  },
                ],
                // Overdue invoices list
                overdueInvoices: [
                  {
                    $match: {
                      status: 'OVERDUE',
                      dueDate: { $ne: null },
                    },
                  },
                  {
                    $project: {
                      invoiceId: '$_id',
                      invoiceNumber: {
                        $cond: {
                          if: { $and: [{ $ifNull: ['$prefix', false] }, { $ifNull: ['$number', false] }] },
                          then: { $concat: ['$prefix', '-', '$number'] },
                          else: { $ifNull: ['$number', 'N/A'] },
                        },
                      },
                      clientName: {
                        $cond: {
                          if: { $eq: ['$client.type', 'INDIVIDUAL'] },
                          then: {
                            $concat: [
                              { $ifNull: ['$client.firstName', ''] },
                              ' ',
                              { $ifNull: ['$client.lastName', ''] },
                            ],
                          },
                          else: { $ifNull: ['$client.name', 'Client inconnu'] },
                        },
                      },
                      totalTTC: '$finalTotalTTC',
                      dueDate: 1,
                      daysOverdue: {
                        $floor: {
                          $divide: [
                            { $subtract: [now, '$dueDate'] },
                            86400000, // ms in a day
                          ],
                        },
                      },
                    },
                  },
                  { $sort: { daysOverdue: -1 } },
                ],
                // Aging buckets
                agingBuckets: [
                  {
                    $match: {
                      status: { $in: ['PENDING', 'OVERDUE'] },
                      dueDate: { $ne: null },
                    },
                  },
                  {
                    $addFields: {
                      daysOverdue: {
                        $floor: {
                          $divide: [
                            { $subtract: [now, '$dueDate'] },
                            86400000,
                          ],
                        },
                      },
                    },
                  },
                  // Exclude invoices not yet due (negative daysOverdue)
                  { $match: { daysOverdue: { $gte: 0 } } },
                  {
                    $bucket: {
                      groupBy: '$daysOverdue',
                      boundaries: [0, 31, 61, 91],
                      default: '90+',
                      output: {
                        count: { $sum: 1 },
                        totalTTC: { $sum: '$finalTotalTTC' },
                      },
                    },
                  },
                ],
                // Monthly collected (based on paymentDate of COMPLETED invoices)
                monthlyCollected: [
                  {
                    $match: {
                      status: 'COMPLETED',
                      paymentDate: { $ne: null },
                    },
                  },
                  {
                    $group: {
                      _id: {
                        year: { $year: '$paymentDate' },
                        month: { $month: '$paymentDate' },
                      },
                      collectedTTC: { $sum: '$finalTotalTTC' },
                      collectedCount: { $sum: 1 },
                    },
                  },
                ],
                // Collection rate data
                collectionTotals: [
                  {
                    $group: {
                      _id: null,
                      totalInvoices: { $sum: 1 },
                      completedInvoices: {
                        $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
                      },
                    },
                  },
                ],
              },
            },
          ]),

          // 2. Expense aggregation — now with HT calculation
          Expense.aggregate([
            { $match: expenseMatch },
            {
              $facet: {
                totals: [
                  {
                    $group: {
                      _id: null,
                      totalExpensesTTC: { $sum: '$amount' },
                      totalExpensesVAT: {
                        $sum: { $ifNull: ['$vatAmount', 0] },
                      },
                      expenseCount: { $sum: 1 },
                    },
                  },
                ],
                monthly: [
                  {
                    $group: {
                      _id: {
                        year: { $year: '$date' },
                        month: { $month: '$date' },
                      },
                      amountTTC: { $sum: '$amount' },
                      vatAmount: { $sum: { $ifNull: ['$vatAmount', 0] } },
                      count: { $sum: 1 },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      month: {
                        $concat: [
                          { $toString: '$_id.year' },
                          '-',
                          {
                            $cond: {
                              if: { $lt: ['$_id.month', 10] },
                              then: { $concat: ['0', { $toString: '$_id.month' }] },
                              else: { $toString: '$_id.month' },
                            },
                          },
                        ],
                      },
                      amountTTC: 1,
                      vatAmount: 1,
                      amountHT: { $subtract: ['$amountTTC', '$vatAmount'] },
                      count: 1,
                    },
                  },
                  { $sort: { month: 1 } },
                ],
                byCategory: [
                  {
                    $group: {
                      _id: '$category',
                      amount: { $sum: '$amount' },
                      count: { $sum: 1 },
                    },
                  },
                  { $sort: { amount: -1 } },
                ],
                byCategoryMonthly: [
                  {
                    $group: {
                      _id: {
                        category: '$category',
                        year: { $year: '$date' },
                        month: { $month: '$date' },
                      },
                      amount: { $sum: '$amount' },
                      count: { $sum: 1 },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      category: { $ifNull: ['$_id.category', 'OTHER'] },
                      month: {
                        $concat: [
                          { $toString: '$_id.year' },
                          '-',
                          {
                            $cond: {
                              if: { $lt: ['$_id.month', 10] },
                              then: { $concat: ['0', { $toString: '$_id.month' }] },
                              else: { $toString: '$_id.month' },
                            },
                          },
                        ],
                      },
                      amount: { $round: ['$amount', 2] },
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
                  $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
                },
              },
            },
          ]),

          // 4. CreditNote aggregation
          CreditNote.aggregate([
            { $match: creditNoteMatch },
            {
              $facet: {
                totals: [
                  {
                    $group: {
                      _id: null,
                      totalHT: { $sum: '$finalTotalHT' },
                      totalTTC: { $sum: '$finalTotalTTC' },
                      totalVAT: { $sum: '$finalTotalVAT' },
                      count: { $sum: 1 },
                    },
                  },
                ],
                monthly: [
                  {
                    $group: {
                      _id: {
                        year: { $year: '$issueDate' },
                        month: { $month: '$issueDate' },
                      },
                      totalHT: { $sum: '$finalTotalHT' },
                      totalTTC: { $sum: '$finalTotalTTC' },
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      month: {
                        $concat: [
                          { $toString: '$_id.year' },
                          '-',
                          {
                            $cond: {
                              if: { $lt: ['$_id.month', 10] },
                              then: { $concat: ['0', { $toString: '$_id.month' }] },
                              else: { $toString: '$_id.month' },
                            },
                          },
                        ],
                      },
                      totalHT: 1,
                      totalTTC: 1,
                    },
                  },
                  { $sort: { month: 1 } },
                ],
              },
            },
          ]),
        ]);

        // ==============================
        // EXTRACT RESULTS
        // ==============================

        // Invoice results
        const invResult = invoiceStats[0];
        const invTotals = invResult.totals[0] || {
          totalRevenueHT: 0,
          totalRevenueTTC: 0,
          invoiceCount: 0,
          clients: [],
        };
        const receivables = invResult.receivables[0] || { outstandingReceivables: 0 };
        const collectionTotals = invResult.collectionTotals[0] || { totalInvoices: 0, completedInvoices: 0 };

        // Expense results
        const expResult = expenseStats[0];
        const expTotals = expResult.totals[0] || {
          totalExpensesTTC: 0,
          totalExpensesVAT: 0,
          expenseCount: 0,
        };

        // Quote results
        const quoteResult = quoteStats[0] || { total: 0, completed: 0 };
        const quoteConversionRate =
          quoteResult.total > 0
            ? Math.round((quoteResult.completed / quoteResult.total) * 10000) / 100
            : 0;

        // CreditNote results
        const cnResult = creditNoteStats[0];
        const cnTotals = cnResult.totals[0] || { totalHT: 0, totalTTC: 0, totalVAT: 0, count: 0 };

        // ==============================
        // COMPUTE DERIVED KPI
        // ==============================

        const totalRevenueHT = Math.round(invTotals.totalRevenueHT * 100) / 100;
        const totalRevenueTTC = Math.round(invTotals.totalRevenueTTC * 100) / 100;
        const creditNoteTotalHT = Math.round(cnTotals.totalHT * 100) / 100; // negative
        const netRevenueHT = Math.round((totalRevenueHT + creditNoteTotalHT) * 100) / 100;

        const totalExpensesTTC = Math.round(expTotals.totalExpensesTTC * 100) / 100;
        const totalExpensesVAT = Math.round(expTotals.totalExpensesVAT * 100) / 100;
        const totalExpensesHT = Math.round((totalExpensesTTC - totalExpensesVAT) * 100) / 100;

        const grossMargin = Math.round((netRevenueHT - totalExpensesHT) * 100) / 100;
        const grossMarginRate = netRevenueHT > 0
          ? Math.round((grossMargin / netRevenueHT) * 10000) / 100
          : 0;
        const chargeRate = netRevenueHT > 0
          ? Math.round((totalExpensesHT / netRevenueHT) * 10000) / 100
          : 0;

        // Outstanding & overdue
        const outstandingReceivables = Math.round(receivables.outstandingReceivables * 100) / 100;

        // Overdue invoices
        const overdueInvoices = invResult.overdueInvoices.map((inv) => ({
          invoiceId: inv.invoiceId.toString(),
          invoiceNumber: (inv.invoiceNumber || 'N/A').trim(),
          clientName: (inv.clientName || 'Client inconnu').trim(),
          totalTTC: Math.round((inv.totalTTC || 0) * 100) / 100,
          dueDate: inv.dueDate ? inv.dueDate.toISOString().split('T')[0] : '',
          daysOverdue: Math.max(0, inv.daysOverdue || 0),
        }));
        const overdueAmount = overdueInvoices.reduce((sum, inv) => sum + inv.totalTTC, 0);
        const overdueCount = overdueInvoices.length;

        // DSO: (créances en cours TTC / CA TTC) × nbJours
        const periodStart = new Date(startDate);
        const periodEnd = new Date(endDate);
        const nbDays = Math.max(1, Math.ceil((periodEnd - periodStart) / 86400000));
        const dso = totalRevenueTTC > 0
          ? Math.round((outstandingReceivables / totalRevenueTTC) * nbDays * 100) / 100
          : 0;

        // Collection rate: COMPLETED / total non-DRAFT (in count)
        const collectionRate = collectionTotals.totalInvoices > 0
          ? Math.round((collectionTotals.completedInvoices / collectionTotals.totalInvoices) * 10000) / 100
          : 0;

        // Aging buckets - normalize from MongoDB $bucket output
        const agingBucketsConfig = [
          { label: '0-30 jours', min: 0, max: 30 },
          { label: '31-60 jours', min: 31, max: 60 },
          { label: '61-90 jours', min: 61, max: 90 },
          { label: '90+ jours', min: 91, max: 9999 },
        ];
        const rawAgingBuckets = invResult.agingBuckets || [];
        const agingBucketMap = {};
        for (const b of rawAgingBuckets) {
          agingBucketMap[b._id] = b;
        }
        const agingBuckets = agingBucketsConfig.map((cfg) => {
          let key;
          if (cfg.min === 0) key = 0;
          else if (cfg.min === 31) key = 31;
          else if (cfg.min === 61) key = 61;
          else key = '90+';
          const raw = agingBucketMap[key] || {};
          return {
            label: cfg.label,
            min: cfg.min,
            max: cfg.max,
            count: raw.count || 0,
            totalTTC: Math.round((raw.totalTTC || 0) * 100) / 100,
          };
        });

        // Monthly collection - merge invoiced (from monthlyRevenue) + collected
        const invoicedMap = {};
        for (const r of invResult.monthlyRevenue) {
          invoicedMap[r.month] = { invoicedTTC: r.revenueTTC, invoicedCount: r.invoiceCount };
        }
        const collectedMap = {};
        for (const r of (invResult.monthlyCollected || [])) {
          const m = `${r._id.year}-${String(r._id.month).padStart(2, '0')}`;
          collectedMap[m] = { collectedTTC: r.collectedTTC, collectedCount: r.collectedCount };
        }
        const allCollectionMonths = [...new Set([...Object.keys(invoicedMap), ...Object.keys(collectedMap)])].sort();
        const monthlyCollection = allCollectionMonths.map((m) => {
          const inv = invoicedMap[m] || { invoicedTTC: 0, invoicedCount: 0 };
          const col = collectedMap[m] || { collectedTTC: 0, collectedCount: 0 };
          return {
            month: m,
            invoicedTTC: Math.round(inv.invoicedTTC * 100) / 100,
            collectedTTC: Math.round(col.collectedTTC * 100) / 100,
            invoicedCount: inv.invoicedCount,
            collectedCount: col.collectedCount,
          };
        });

        // Top client concentration
        const revenueByClientSorted = [...invResult.revenueByClient].sort((a, b) => b.totalHT - a.totalHT);
        const top3HT = revenueByClientSorted.slice(0, 3).reduce((s, c) => s + c.totalHT, 0);
        const totalHT = revenueByClientSorted.reduce((s, c) => s + c.totalHT, 0);
        const topClientConcentration = totalHT > 0
          ? Math.round((top3HT / totalHT) * 10000) / 100
          : 0;

        // Client counts
        const activeClientCount = (invTotals.clients || []).filter(Boolean).length;

        // ==============================
        // MERGE MONTHLY DATA
        // ==============================

        const expenseMonthlyMap = {};
        for (const m of expResult.monthly) {
          expenseMonthlyMap[m.month] = {
            amountTTC: m.amountTTC,
            amountHT: m.amountHT,
            vatAmount: m.vatAmount,
            count: m.count,
          };
        }

        const cnMonthlyMap = {};
        for (const m of cnResult.monthly) {
          cnMonthlyMap[m.month] = { totalHT: m.totalHT, totalTTC: m.totalTTC };
        }

        // Build from invoice months
        const monthlyRevenue = invResult.monthlyRevenue.map((m) => {
          const exp = expenseMonthlyMap[m.month] || { amountTTC: 0, amountHT: 0, vatAmount: 0, count: 0 };
          const cn = cnMonthlyMap[m.month] || { totalHT: 0, totalTTC: 0 };
          delete expenseMonthlyMap[m.month];
          delete cnMonthlyMap[m.month];

          const monthNetRevenueHT = m.revenueHT + cn.totalHT;
          const monthGrossMargin = monthNetRevenueHT - exp.amountHT;
          const monthGrossMarginRate = monthNetRevenueHT > 0
            ? Math.round((monthGrossMargin / monthNetRevenueHT) * 10000) / 100
            : 0;

          return {
            month: m.month,
            revenueHT: Math.round(m.revenueHT * 100) / 100,
            revenueTTC: Math.round(m.revenueTTC * 100) / 100,
            revenueVAT: Math.round(m.revenueVAT * 100) / 100,
            expenseAmount: Math.round(exp.amountTTC * 100) / 100,
            expenseAmountHT: Math.round(exp.amountHT * 100) / 100,
            expenseVAT: Math.round(exp.vatAmount * 100) / 100,
            invoiceCount: m.invoiceCount,
            expenseCount: exp.count,
            netResult: Math.round((m.revenueHT - exp.amountTTC) * 100) / 100, // backward compat (HT - TTC)
            creditNoteHT: Math.round(cn.totalHT * 100) / 100,
            netRevenueHT: Math.round(monthNetRevenueHT * 100) / 100,
            grossMargin: Math.round(monthGrossMargin * 100) / 100,
            grossMarginRate: monthGrossMarginRate,
          };
        });

        // Add months that only have expenses or credit notes
        const remainingMonths = new Set([...Object.keys(expenseMonthlyMap), ...Object.keys(cnMonthlyMap)]);
        for (const month of remainingMonths) {
          const exp = expenseMonthlyMap[month] || { amountTTC: 0, amountHT: 0, vatAmount: 0, count: 0 };
          const cn = cnMonthlyMap[month] || { totalHT: 0, totalTTC: 0 };
          const monthNetRevenueHT = cn.totalHT;
          const monthGrossMargin = monthNetRevenueHT - exp.amountHT;

          monthlyRevenue.push({
            month,
            revenueHT: 0,
            revenueTTC: 0,
            revenueVAT: 0,
            expenseAmount: Math.round(exp.amountTTC * 100) / 100,
            expenseAmountHT: Math.round(exp.amountHT * 100) / 100,
            expenseVAT: Math.round(exp.vatAmount * 100) / 100,
            invoiceCount: 0,
            expenseCount: exp.count,
            netResult: Math.round(-exp.amountTTC * 100) / 100,
            creditNoteHT: Math.round(cn.totalHT * 100) / 100,
            netRevenueHT: Math.round(monthNetRevenueHT * 100) / 100,
            grossMargin: Math.round(monthGrossMargin * 100) / 100,
            grossMarginRate: 0,
          });
        }
        monthlyRevenue.sort((a, b) => a.month.localeCompare(b.month));

        // ==============================
        // N-1 PREVIOUS PERIOD
        // ==============================
        let previousPeriod = null;
        let _newClientCount = 0;
        let _retainedClientCount = 0;
        try {
          const { prevStart, prevEnd } = computePreviousPeriod(startDate, endDate);

          const prevDateQuery = { $gte: prevStart, $lte: prevEnd };
          const prevInvoiceMatch = {
            workspaceId: wId,
            status: { $ne: 'DRAFT' },
            issueDate: prevDateQuery,
          };
          const prevExpenseMatch = {
            workspaceId: wId,
            date: prevDateQuery,
          };
          const prevCreditNoteMatch = {
            workspaceId: wId,
            issueDate: prevDateQuery,
          };

          const [prevInv, prevExp, prevCn, prevQuote] = await Promise.all([
            Invoice.aggregate([
              { $match: prevInvoiceMatch },
              {
                $facet: {
                  totals: [
                    {
                      $group: {
                        _id: null,
                        totalRevenueHT: { $sum: '$finalTotalHT' },
                        totalRevenueTTC: { $sum: '$finalTotalTTC' },
                        invoiceCount: { $sum: 1 },
                        clients: { $addToSet: '$client.id' },
                        completedCount: {
                          $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
                        },
                      },
                    },
                  ],
                  receivables: [
                    { $match: { status: { $in: ['PENDING', 'OVERDUE'] } } },
                    {
                      $group: {
                        _id: null,
                        outstandingReceivables: { $sum: '$finalTotalTTC' },
                      },
                    },
                  ],
                  overdue: [
                    { $match: { status: 'OVERDUE' } },
                    {
                      $group: {
                        _id: null,
                        amount: { $sum: '$finalTotalTTC' },
                        count: { $sum: 1 },
                      },
                    },
                  ],
                  revenueByClient: [
                    {
                      $group: {
                        _id: '$client.id',
                        totalHT: { $sum: '$finalTotalHT' },
                      },
                    },
                    { $sort: { totalHT: -1 } },
                  ],
                },
              },
            ]),
            Expense.aggregate([
              { $match: prevExpenseMatch },
              {
                $group: {
                  _id: null,
                  totalExpensesTTC: { $sum: '$amount' },
                  totalExpensesVAT: { $sum: { $ifNull: ['$vatAmount', 0] } },
                },
              },
            ]),
            CreditNote.aggregate([
              { $match: prevCreditNoteMatch },
              {
                $group: {
                  _id: null,
                  totalHT: { $sum: '$finalTotalHT' },
                },
              },
            ]),
            Quote.aggregate([
              {
                $match: {
                  workspaceId: wId,
                  status: { $in: ['COMPLETED', 'CANCELED', 'PENDING'] },
                  issueDate: prevDateQuery,
                },
              },
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  completed: {
                    $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] },
                  },
                },
              },
            ]),
          ]);

          const prevInvResult = prevInv[0];
          const prevInvTotals = prevInvResult.totals[0] || {
            totalRevenueHT: 0, totalRevenueTTC: 0, invoiceCount: 0, clients: [], completedCount: 0,
          };
          const prevExpTotals = prevExp[0] || { totalExpensesTTC: 0, totalExpensesVAT: 0 };
          const prevCnTotals = prevCn[0] || { totalHT: 0 };
          const prevQuoteTotals = prevQuote[0] || { total: 0, completed: 0 };
          const prevReceivables = prevInvResult.receivables[0] || { outstandingReceivables: 0 };
          const prevOverdue = prevInvResult.overdue[0] || { amount: 0, count: 0 };

          const prevTotalRevenueHT = prevInvTotals.totalRevenueHT;
          const prevTotalRevenueTTC = prevInvTotals.totalRevenueTTC;
          const prevCreditNoteTotalHT = prevCnTotals.totalHT;
          const prevNetRevenueHT = prevTotalRevenueHT + prevCreditNoteTotalHT;
          const prevTotalExpensesTTC = prevExpTotals.totalExpensesTTC;
          const prevTotalExpensesVAT = prevExpTotals.totalExpensesVAT;
          const prevTotalExpensesHT = prevTotalExpensesTTC - prevTotalExpensesVAT;
          const prevGrossMargin = prevNetRevenueHT - prevTotalExpensesHT;
          const prevGrossMarginRate = prevNetRevenueHT > 0
            ? Math.round((prevGrossMargin / prevNetRevenueHT) * 10000) / 100
            : 0;
          const prevChargeRate = prevNetRevenueHT > 0
            ? Math.round((prevTotalExpensesHT / prevNetRevenueHT) * 10000) / 100
            : 0;

          const prevCollectionRate = prevInvTotals.invoiceCount > 0
            ? Math.round((prevInvTotals.completedCount / prevInvTotals.invoiceCount) * 10000) / 100
            : 0;
          const prevNbDays = Math.max(1, Math.ceil((prevEnd - prevStart) / 86400000));
          const prevDso = prevTotalRevenueTTC > 0
            ? Math.round((prevReceivables.outstandingReceivables / prevTotalRevenueTTC) * prevNbDays * 100) / 100
            : 0;

          const prevActiveClientCount = (prevInvTotals.clients || []).filter(Boolean).length;

          // N-1 client concentration
          const prevRBC = prevInvResult.revenueByClient || [];
          const prevTop3HT = prevRBC.slice(0, 3).reduce((s, c) => s + c.totalHT, 0);
          const prevTotalHT = prevRBC.reduce((s, c) => s + c.totalHT, 0);
          const prevTopClientConcentration = prevTotalHT > 0
            ? Math.round((prevTop3HT / prevTotalHT) * 10000) / 100
            : 0;

          // New clients: clients active now but not in N-1
          const prevClientSet = new Set((prevInvTotals.clients || []).filter(Boolean));
          const currentClientSet = new Set((invTotals.clients || []).filter(Boolean));
          let newClientCount = 0;
          for (const cId of currentClientSet) {
            if (!prevClientSet.has(cId)) newClientCount++;
          }
          // Retained: clients active in both periods
          let retainedClientCount = 0;
          for (const cId of currentClientSet) {
            if (prevClientSet.has(cId)) retainedClientCount++;
          }

          const prevQuoteConversionRate = prevQuoteTotals.total > 0
            ? Math.round((prevQuoteTotals.completed / prevQuoteTotals.total) * 10000) / 100
            : 0;

          previousPeriod = {
            totalRevenueHT: Math.round(prevTotalRevenueHT * 100) / 100,
            totalExpensesHT: Math.round(prevTotalExpensesHT * 100) / 100,
            grossMargin: Math.round(prevGrossMargin * 100) / 100,
            grossMarginRate: prevGrossMarginRate,
            invoiceCount: prevInvTotals.invoiceCount,
            averageInvoiceHT: prevInvTotals.invoiceCount > 0
              ? Math.round((prevTotalRevenueHT / prevInvTotals.invoiceCount) * 100) / 100
              : 0,
            collectionRate: prevCollectionRate,
            dso: prevDso,
            activeClientCount: prevActiveClientCount,
            newClientCount: 0, // N/A for previous period
            quoteConversionRate: prevQuoteConversionRate,
            netRevenueHT: Math.round(prevNetRevenueHT * 100) / 100,
            creditNoteTotalHT: Math.round(prevCreditNoteTotalHT * 100) / 100,
            overdueAmount: Math.round(prevOverdue.amount * 100) / 100,
            overdueCount: prevOverdue.count,
            outstandingReceivables: Math.round(prevReceivables.outstandingReceivables * 100) / 100,
            topClientConcentration: prevTopClientConcentration,
            chargeRate: prevChargeRate,
          };

          // Set newClientCount and retainedClientCount on main KPI (need both periods)
          _newClientCount = newClientCount;
          _retainedClientCount = retainedClientCount;
        } catch (err) {
          // If N-1 fails, just continue without it
          console.error('N-1 period calculation error:', err.message);
        }

        // ==============================
        // AGGREGATE KANBAN TIME
        // ==============================
        const clientTimeMap = await aggregateTimeByClient(wId, startDate, endDate, clientIds);

        // Build revenueByClient with time data
        const matchedClientIds = new Set();
        const revenueByClient = invResult.revenueByClient.map((c) => {
          const cId = c._id.clientId || null;
          if (cId) matchedClientIds.add(cId);
          const timeData = cId ? clientTimeMap.get(cId) : null;
          return {
            clientId: cId,
            clientName: (c._id.clientName || 'Client inconnu').trim(),
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
        const Client = mongoose.model('Client');
        for (const [clientIdStr, timeData] of clientTimeMap) {
          if (matchedClientIds.has(clientIdStr)) continue;
          const client = await Client.findById(clientIdStr).lean();
          if (!client) continue;
          const clientName = client.type === 'INDIVIDUAL'
            ? `${client.firstName || ''} ${client.lastName || ''}`.trim()
            : client.name || 'Client inconnu';
          revenueByClient.push({
            clientId: clientIdStr,
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

        // ==============================
        // BUILD KPI
        // ==============================
        const kpi = {
          totalRevenueHT,
          totalRevenueTTC,
          // Backward compat: totalExpenses = TTC, netResult = HT - TTC (old behavior)
          totalExpenses: totalExpensesTTC,
          netResult: Math.round((totalRevenueHT - totalExpensesTTC) * 100) / 100,
          invoiceCount: invTotals.invoiceCount,
          expenseCount: expTotals.expenseCount,
          averageInvoiceHT:
            invTotals.invoiceCount > 0
              ? Math.round((totalRevenueHT / invTotals.invoiceCount) * 100) / 100
              : 0,
          clientCount: activeClientCount,
          quoteConversionRate,
          // New fields
          totalExpensesHT,
          totalExpensesTTC,
          grossMargin,
          grossMarginRate,
          chargeRate,
          creditNoteCount: cnTotals.count,
          creditNoteTotalHT,
          netRevenueHT,
          outstandingReceivables,
          overdueAmount: Math.round(overdueAmount * 100) / 100,
          overdueCount,
          dso,
          collectionRate,
          activeClientCount,
          newClientCount: _newClientCount,
          retainedClientCount: _retainedClientCount,
          topClientConcentration,
          quoteCount: quoteResult.total,
          quoteConvertedCount: quoteResult.completed,
        };

        // Generate alerts
        const alerts = generateAlerts(kpi);

        // ==============================
        // RETURN
        // ==============================
        return {
          kpi,
          previousPeriod,
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
            method: s._id || 'OTHER',
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
            category: c._id || 'OTHER',
            amount: Math.round(c.amount * 100) / 100,
            count: c.count,
          })),
          revenueByClientMonthly: invResult.revenueByClientMonthly.map((r) => ({
            clientId: r.clientId || null,
            clientName: (r.clientName || 'Client inconnu').trim(),
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
          collection: {
            overdueInvoices,
            agingBuckets,
            monthlyCollection,
          },
          alerts,
        };
      }
    ),
  },
};

export default financialAnalyticsResolvers;
