import mongoose from "mongoose";
import { requireRead, resolveWorkspaceId } from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import { Board, Task } from "../models/kanban.js";

/**
 * Aggregate time tracked in Kanban tasks by client.
 * Returns a Map<clientIdString, { totalTimeSeconds, totalBillableAmount }>
 */
const aggregateTimeByClient = async (
  workspaceId,
  startDate,
  endDate,
  clientIds,
) => {
  // Find boards that have a clientId assigned
  const boardQuery = { workspaceId, clientId: { $ne: null } };
  if (clientIds && clientIds.length > 0) {
    boardQuery.clientId = {
      $in: clientIds.map((id) => new mongoose.Types.ObjectId(id)),
    };
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
    boardId: { $in: boards.map((b) => b._id) },
    $or: [
      { "timeTracking.totalSeconds": { $gt: 0 } },
      { "timeTracking.isRunning": true },
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
      totalSeconds += Math.floor(
        (Date.now() - new Date(tt.currentStartTime).getTime()) / 1000,
      );
    }
    if (totalSeconds <= 0) continue;

    let billableAmount = 0;
    if (tt.hourlyRate && tt.hourlyRate > 0) {
      const hours = totalSeconds / 3600;
      let billableHours = hours;
      if (tt.roundingOption === "up") billableHours = Math.ceil(hours);
      else if (tt.roundingOption === "down") billableHours = Math.floor(hours);
      billableAmount = billableHours * tt.hourlyRate;
    }

    const existing = result.get(clientId) || {
      totalTimeSeconds: 0,
      totalBillableAmount: 0,
    };
    existing.totalTimeSeconds += totalSeconds;
    existing.totalBillableAmount += billableAmount;
    result.set(clientId, existing);
  }

  return result;
};

/**
 * Normalise une description d'article pour regrouper les variantes périodiques
 * du même article catalogue. Les utilisateurs facturent souvent le même article
 * avec un suffixe temporel ("du mois", "d'avril", "(janvier 2026)" …).
 */
function normalizeProductDescription(desc) {
  if (!desc) return "";
  const months =
    "(janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre)";
  let normalized = desc
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
  // Supprimer suffixes de période courants
  const patterns = [
    new RegExp(`\\s*[-–—]\\s*${months}\\s*\\d{0,4}\\s*$`, "i"),
    new RegExp(`\\s*\\(\\s*${months}\\s*\\d{0,4}\\s*\\)\\s*$`, "i"),
    new RegExp(
      `\\s+(?:du mois\\s+)?d(?:e|')\\s*${months}(?:\\s+\\d{2,4})?\\s*$`,
      "i",
    ),
    /\s+du mois(?:\s+d[e']\s*\w+)?\s*$/i,
    /\s+\d{4}\s*$/,
    /\s*[-–—]\s*\d{1,2}\/\d{4}\s*$/,
  ];
  for (const re of patterns) {
    normalized = normalized.replace(re, "");
  }
  return normalized.replace(/\s+/g, " ").trim();
}

function mergeRevenueByProduct(rawProducts) {
  if (!Array.isArray(rawProducts) || rawProducts.length === 0) return [];
  const groups = new Map();
  for (const p of rawProducts) {
    const key = normalizeProductDescription(p.description) || p.description;
    if (!groups.has(key)) {
      groups.set(key, {
        description: p.description,
        totalHT: 0,
        totalQuantity: 0,
        invoiceCount: 0,
        _unitPriceSum: 0,
        _unitPriceCount: 0,
      });
    }
    const g = groups.get(key);
    g.totalHT += p.totalHT || 0;
    g.totalQuantity += p.totalQuantity || 0;
    g.invoiceCount += p.invoiceCount || 0;
    if (p.averageUnitPrice != null) {
      g._unitPriceSum += p.averageUnitPrice;
      g._unitPriceCount += 1;
    }
    // Garder la description la plus courte comme libellé canonique
    if ((p.description || "").length < (g.description || "").length) {
      g.description = p.description;
    }
  }
  return Array.from(groups.values())
    .map((g) => ({
      description: g.description,
      totalHT: Math.round(g.totalHT * 100) / 100,
      totalQuantity: g.totalQuantity,
      invoiceCount: g.invoiceCount,
      averageUnitPrice:
        g._unitPriceCount > 0
          ? Math.round((g._unitPriceSum / g._unitPriceCount) * 100) / 100
          : 0,
    }))
    .sort((a, b) => b.totalHT - a.totalHT);
}

/**
 * Generate alerts based on KPI values
 */
function generateAlerts(kpi) {
  const alerts = [];

  // Gross margin rate < 20% → danger
  if (kpi.netRevenueHT > 0 && kpi.grossMarginRate < 20) {
    alerts.push({
      type: "MARGIN",
      severity: "danger",
      message: `Taux de marge brute faible : ${kpi.grossMarginRate.toFixed(1)}% (seuil : 20%)`,
      value: kpi.grossMarginRate,
      threshold: 20,
    });
  }

  // DSO > 45 days → warning, > 60 → danger
  if (kpi.dso > 60) {
    alerts.push({
      type: "DSO",
      severity: "danger",
      message: `DSO critique : ${Math.round(kpi.dso)} jours (seuil : 60 jours)`,
      value: kpi.dso,
      threshold: 60,
    });
  } else if (kpi.dso > 45) {
    alerts.push({
      type: "DSO",
      severity: "warning",
      message: `DSO élevé : ${Math.round(kpi.dso)} jours (seuil : 45 jours)`,
      value: kpi.dso,
      threshold: 45,
    });
  }

  // Top 3 client concentration > 70% → warning
  if (kpi.topClientConcentration > 70) {
    alerts.push({
      type: "CONCENTRATION",
      severity: "warning",
      message: `Concentration clients élevée : ${kpi.topClientConcentration.toFixed(1)}% du CA sur les 3 premiers clients`,
      value: kpi.topClientConcentration,
      threshold: 70,
    });
  }

  // Overdue invoices > 0 → danger
  if (kpi.overdueCount > 0) {
    const formatted = new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(kpi.overdueAmount);
    alerts.push({
      type: "OVERDUE",
      severity: "danger",
      message: `${kpi.overdueCount} facture${kpi.overdueCount > 1 ? "s" : ""} en retard pour un total de ${formatted}`,
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
    financialAnalytics: requireRead("invoices")(
      async (
        _,
        {
          workspaceId: inputWorkspaceId,
          startDate,
          endDate,
          clientId,
          clientIds,
          status,
        },
        context,
      ) => {
        const workspaceId = resolveWorkspaceId(
          inputWorkspaceId,
          context.workspaceId,
        );
        const wId = new mongoose.Types.ObjectId(workspaceId);
        const now = new Date();

        const dateQuery = {};
        if (startDate) dateQuery.$gte = new Date(startDate);
        if (endDate) dateQuery.$lte = new Date(endDate);

        // --- Invoice match ---
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

        // --- Paid invoice match (revenu reconnu à la DATE DE PAIEMENT) ---
        // Les graphiques "Détail par client" et "Tableau croisé Client x Mois"
        // — ainsi que "Top 10 clients" et "Répartition par type" qui partagent
        // la même source — se basent uniquement sur les factures CLIENT PAYÉES
        // (status COMPLETED), filtrées et regroupées par paymentDate.
        // Les factures client créées sur Newbi ET les factures client importées
        // vivent toutes dans la collection Invoice (les importées ont un préfixe
        // vide) : une seule agrégation suffit. Les factures d'ACHAT
        // (ImportedInvoice) ne sont PAS du CA client → exclues de ces graphiques.
        const paymentDateRange = { $ne: null };
        if (startDate) paymentDateRange.$gte = new Date(startDate);
        if (endDate) paymentDateRange.$lte = new Date(endDate);
        const paidInvoiceMatch = {
          workspaceId: wId,
          status: "COMPLETED",
          paymentDate: paymentDateRange,
        };
        if (clientIds && clientIds.length > 0) {
          paidInvoiceMatch["client.id"] = { $in: clientIds };
        } else if (clientId) {
          paidInvoiceMatch["client.id"] = clientId;
        }

        // --- Expense match ---
        const expenseMatch = {
          workspaceId: wId,
        };
        if (startDate || endDate) expenseMatch.date = dateQuery;

        // --- Quote match ---
        const quoteMatch = {
          workspaceId: wId,
          status: { $in: ["COMPLETED", "CANCELED", "PENDING"] },
        };
        if (startDate || endDate) quoteMatch.issueDate = dateQuery;

        // --- CreditNote match ---
        const creditNoteMatch = {
          workspaceId: wId,
        };
        if (startDate || endDate) creditNoteMatch.issueDate = dateQuery;

        const Invoice = mongoose.model("Invoice");
        const Expense = mongoose.model("Expense");
        const PurchaseInvoice = mongoose.model("PurchaseInvoice");
        const Quote = mongoose.model("Quote");
        const CreditNote = mongoose.model("CreditNote");
        const ImportedInvoice = mongoose.model("ImportedInvoice");

        // ==============================
        // MAIN AGGREGATIONS (parallel)
        // ==============================
        const [
          invoiceStats,
          expenseStats,
          quoteStats,
          creditNoteStats,
          monthlyCollectedStats,
          currentReceivablesStats,
          importedInvoiceMonthlyStats,
          importedInvoiceCollectedStats,
          purchaseInvoiceMonthlyStats,
          paidInvoiceByClientMonthly,
          invoiceUnpaidStats,
          importedInvoiceUnpaidStats,
        ] = await Promise.all([
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
                            else: {
                              $ifNull: ["$client.name", "Client inconnu"],
                            },
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
                              then: {
                                $concat: ["0", { $toString: "$_id.month" }],
                              },
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
                // NB : revenueByClient (par date de paiement, Newbi + importées)
                // et revenueByClientMonthly (tableau croisé) sont désormais
                // calculés via des agrégations dédiées #11/#12 (factures PAYÉES,
                // regroupées par paymentDate) puis fusionnés en JS.
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
                // Note: receivables, overdueInvoices, agingBuckets moved to separate aggregation
                // (unfiltered by issueDate — snapshot of current state)
                // Note: monthlyCollected moved to a separate aggregation (filtered by paymentDate, not issueDate)
                // Collection rate data (excluding CANCELED from denominator)
                collectionTotals: [
                  {
                    $match: { status: { $ne: "CANCELED" } },
                  },
                  {
                    $group: {
                      _id: null,
                      totalInvoices: { $sum: 1 },
                      completedInvoices: {
                        $sum: {
                          $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0],
                        },
                      },
                      // Revenue TTC excluding CANCELED (for DSO calculation)
                      totalRevenueTTCExclCanceled: { $sum: "$finalTotalTTC" },
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
                      totalExpensesTTC: { $sum: "$amount" },
                      totalExpensesVAT: {
                        $sum: { $ifNull: ["$vatAmount", 0] },
                      },
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
                      amountTTC: { $sum: "$amount" },
                      vatAmount: { $sum: { $ifNull: ["$vatAmount", 0] } },
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
                              then: {
                                $concat: ["0", { $toString: "$_id.month" }],
                              },
                              else: { $toString: "$_id.month" },
                            },
                          },
                        ],
                      },
                      amountTTC: 1,
                      vatAmount: 1,
                      amountHT: { $subtract: ["$amountTTC", "$vatAmount"] },
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
                              then: {
                                $concat: ["0", { $toString: "$_id.month" }],
                              },
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

          // 4. CreditNote aggregation
          CreditNote.aggregate([
            { $match: creditNoteMatch },
            {
              $facet: {
                totals: [
                  {
                    $group: {
                      _id: null,
                      totalHT: { $sum: "$finalTotalHT" },
                      totalTTC: { $sum: "$finalTotalTTC" },
                      totalVAT: { $sum: "$finalTotalVAT" },
                      count: { $sum: 1 },
                    },
                  },
                ],
                monthly: [
                  {
                    $group: {
                      _id: {
                        year: { $year: "$issueDate" },
                        month: { $month: "$issueDate" },
                      },
                      totalHT: { $sum: "$finalTotalHT" },
                      totalTTC: { $sum: "$finalTotalTTC" },
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
                              then: {
                                $concat: ["0", { $toString: "$_id.month" }],
                              },
                              else: { $toString: "$_id.month" },
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

          // 5. Monthly collected — separate aggregation filtered by paymentDate (not issueDate)
          // This ensures invoices issued before the selected period but paid during it are counted
          (() => {
            const paymentDateQuery = { $ne: null };
            if (startDate) paymentDateQuery.$gte = new Date(startDate);
            if (endDate) paymentDateQuery.$lte = new Date(endDate);
            return Invoice.aggregate([
              {
                $match: {
                  workspaceId: wId,
                  status: "COMPLETED",
                  paymentDate: paymentDateQuery,
                },
              },
              {
                $facet: {
                  // Monthly breakdown by paymentDate
                  monthly: [
                    {
                      $group: {
                        _id: {
                          year: { $year: "$paymentDate" },
                          month: { $month: "$paymentDate" },
                        },
                        collectedTTC: { $sum: "$finalTotalTTC" },
                        collectedHT: { $sum: "$finalTotalHT" },
                        collectedCount: { $sum: 1 },
                      },
                    },
                  ],
                  // T10 : totaux des factures payées sur la période (par paymentDate)
                  totals: [
                    {
                      $group: {
                        _id: null,
                        paidRevenueHT: { $sum: "$finalTotalHT" },
                        paidRevenueTTC: { $sum: "$finalTotalTTC" },
                        paidInvoiceCount: { $sum: 1 },
                        // DSO : moyenne des jours entre émission et paiement (T10.4)
                        avgDaysToPay: {
                          $avg: {
                            $cond: [
                              {
                                $and: [
                                  { $ne: ["$paymentDate", null] },
                                  { $ne: ["$issueDate", null] },
                                ],
                              },
                              {
                                $divide: [
                                  { $subtract: ["$paymentDate", "$issueDate"] },
                                  86400000,
                                ],
                              },
                              null,
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            ]);
          })(),

          // 6. Current receivables snapshot (NOT filtered by issueDate — shows all unpaid invoices)
          Invoice.aggregate([
            {
              $match: {
                workspaceId: wId,
                status: { $in: ["PENDING", "OVERDUE"] },
              },
            },
            {
              $facet: {
                // Total outstanding receivables
                receivables: [
                  {
                    $group: {
                      _id: null,
                      outstandingReceivables: { $sum: "$finalTotalTTC" },
                    },
                  },
                ],
                // Overdue invoices: PENDING or OVERDUE with dueDate in the past
                overdueInvoices: [
                  {
                    $match: {
                      dueDate: { $ne: null, $lt: now },
                    },
                  },
                  {
                    $project: {
                      invoiceId: "$_id",
                      invoiceNumber: {
                        $cond: {
                          if: {
                            $and: [
                              { $ifNull: ["$prefix", false] },
                              { $ifNull: ["$number", false] },
                            ],
                          },
                          then: { $concat: ["$prefix", "-", "$number"] },
                          else: { $ifNull: ["$number", "N/A"] },
                        },
                      },
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
                      totalTTC: "$finalTotalTTC",
                      dueDate: 1,
                      daysOverdue: {
                        $floor: {
                          $divide: [{ $subtract: [now, "$dueDate"] }, 86400000],
                        },
                      },
                    },
                  },
                  { $sort: { daysOverdue: -1 } },
                ],
                // Aging buckets: PENDING+OVERDUE with past due date
                agingBuckets: [
                  {
                    $match: {
                      dueDate: { $ne: null },
                    },
                  },
                  {
                    $addFields: {
                      daysOverdue: {
                        $floor: {
                          $divide: [{ $subtract: [now, "$dueDate"] }, 86400000],
                        },
                      },
                    },
                  },
                  { $match: { daysOverdue: { $gte: 0 } } },
                  {
                    $bucket: {
                      groupBy: "$daysOverdue",
                      boundaries: [0, 31, 61, 91],
                      default: "91+",
                      output: {
                        count: { $sum: 1 },
                        totalTTC: { $sum: "$finalTotalTTC" },
                      },
                    },
                  },
                ],
              },
            },
          ]),

          // 7. Imported invoices — monthly invoiced (by invoiceDate, fallback createdAt)
          (() => {
            const importedMatch = {
              workspaceId: wId,
              status: { $in: ["VALIDATED", "COMPLETED"] },
            };
            const pipeline = [
              { $match: importedMatch },
              {
                $addFields: {
                  _effectiveDate: { $ifNull: ["$invoiceDate", "$createdAt"] },
                },
              },
            ];
            if (startDate || endDate) {
              const effectiveDateFilter = {};
              if (startDate) effectiveDateFilter.$gte = new Date(startDate);
              if (endDate) effectiveDateFilter.$lte = new Date(endDate);
              pipeline.push({
                $match: { _effectiveDate: effectiveDateFilter },
              });
            }
            pipeline.push({
              $group: {
                _id: {
                  year: { $year: "$_effectiveDate" },
                  month: { $month: "$_effectiveDate" },
                },
                invoicedTTC: { $sum: "$totalTTC" },
                invoicedCount: { $sum: 1 },
              },
            });
            return ImportedInvoice.aggregate(pipeline);
          })(),

          // 8. Imported invoices — monthly collected (COMPLETED = encaissé, by invoiceDate fallback createdAt)
          (() => {
            const importedCollectedMatch = {
              workspaceId: wId,
              status: "COMPLETED",
            };
            const pipeline = [
              { $match: importedCollectedMatch },
              {
                $addFields: {
                  _effectiveDate: { $ifNull: ["$invoiceDate", "$createdAt"] },
                },
              },
            ];
            if (startDate || endDate) {
              const effectiveDateFilter = {};
              if (startDate) effectiveDateFilter.$gte = new Date(startDate);
              if (endDate) effectiveDateFilter.$lte = new Date(endDate);
              pipeline.push({
                $match: { _effectiveDate: effectiveDateFilter },
              });
            }
            pipeline.push({
              $group: {
                _id: {
                  year: { $year: "$_effectiveDate" },
                  month: { $month: "$_effectiveDate" },
                },
                collectedTTC: { $sum: "$totalTTC" },
                collectedCount: { $sum: 1 },
              },
            });
            return ImportedInvoice.aggregate(pipeline);
          })(),

          // 9. PurchaseInvoice — TVA déductible mensuelle + dépenses (HT/TTC/VAT)
          // (T22 : ajouter TVA des factures d'achats au graphique TVA)
          // (T11 : inclure les factures d'achats payées dans les dépenses mensuelles)
          (() => {
            const piMatch = { workspaceId: wId };
            if (startDate || endDate) {
              piMatch.issueDate = {};
              if (startDate) piMatch.issueDate.$gte = new Date(startDate);
              if (endDate) piMatch.issueDate.$lte = new Date(endDate);
            }
            return PurchaseInvoice.aggregate([
              { $match: piMatch },
              {
                $group: {
                  _id: {
                    year: { $year: "$issueDate" },
                    month: { $month: "$issueDate" },
                  },
                  amountTTC: { $sum: { $ifNull: ["$amountTTC", 0] } },
                  amountTVA: { $sum: { $ifNull: ["$amountTVA", 0] } },
                  amountHT: { $sum: { $ifNull: ["$amountHT", 0] } },
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
                  amountTTC: 1,
                  amountTVA: 1,
                  amountHT: 1,
                  count: 1,
                },
              },
            ]);
          })(),

          // 11. Invoice — CA client payé par client x mois (paymentDate)
          // Alimente "Détail par client", "Top 10 clients", "Répartition par
          // type" et "Tableau croisé Client x Mois". Couvre les factures client
          // créées sur Newbi ET importées (toutes dans la collection Invoice).
          // Granularité mensuelle : les totaux par client sont sommés en JS.
          Invoice.aggregate([
            { $match: paidInvoiceMatch },
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
                  year: { $year: "$paymentDate" },
                  month: { $month: "$paymentDate" },
                },
                totalHT: { $sum: "$finalTotalHT" },
                totalTTC: { $sum: "$finalTotalTTC" },
                totalVAT: { $sum: "$finalTotalVAT" },
                invoiceCount: { $sum: 1 },
              },
            },
          ]),

          // 13. Invoice — impayés échus SANS avoir, par mois d'échéance (dueDate)
          // Factures PENDING/OVERDUE dont l'échéance est dépassée et qui n'ont
          // pas d'avoir associé. Alimente le taux de recouvrement (encaissé/impayé).
          (() => {
            const dueDateMatch = { $ne: null, $lt: now };
            if (startDate) dueDateMatch.$gte = new Date(startDate);
            if (endDate) dueDateMatch.$lte = new Date(endDate);
            return Invoice.aggregate([
              {
                $match: {
                  workspaceId: wId,
                  status: { $in: ["PENDING", "OVERDUE"] },
                  dueDate: dueDateMatch,
                },
              },
              // "sans avoir" : exclure les factures ayant au moins un avoir associé
              {
                $lookup: {
                  from: "creditnotes",
                  localField: "_id",
                  foreignField: "originalInvoice",
                  as: "_creditNotes",
                },
              },
              { $match: { _creditNotes: { $size: 0 } } },
              {
                $group: {
                  _id: {
                    year: { $year: "$dueDate" },
                    month: { $month: "$dueDate" },
                  },
                  unpaidTTC: { $sum: "$finalTotalTTC" },
                  unpaidCount: { $sum: 1 },
                },
              },
            ]);
          })(),

          // 14. ImportedInvoice — impayés échus par mois d'échéance (dueDate)
          // Factures importées VALIDATED (validées, non encaissées) dont
          // l'échéance est dépassée. Les importées n'ont pas d'avoirs.
          (() => {
            const dueDateMatch = { $ne: null, $lt: now };
            if (startDate) dueDateMatch.$gte = new Date(startDate);
            if (endDate) dueDateMatch.$lte = new Date(endDate);
            return ImportedInvoice.aggregate([
              {
                $match: {
                  workspaceId: wId,
                  status: "VALIDATED",
                  dueDate: dueDateMatch,
                },
              },
              {
                $group: {
                  _id: {
                    year: { $year: "$dueDate" },
                    month: { $month: "$dueDate" },
                  },
                  unpaidTTC: { $sum: "$totalTTC" },
                  unpaidCount: { $sum: 1 },
                },
              },
            ]);
          })(),
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
        const collectionTotals = invResult.collectionTotals[0] || {
          totalInvoices: 0,
          completedInvoices: 0,
          totalRevenueTTCExclCanceled: 0,
        };

        // Current receivables snapshot (unfiltered by issueDate)
        const recvResult = currentReceivablesStats[0] || {
          receivables: [],
          overdueInvoices: [],
          agingBuckets: [],
        };
        const receivables = recvResult.receivables[0] || {
          outstandingReceivables: 0,
        };

        // Expense results — incluant aussi les factures d'achats (PurchaseInvoice)
        // pour T10/T11/T22.
        const expResult = expenseStats[0];
        const rawExpTotals = expResult.totals[0] || {
          totalExpensesTTC: 0,
          totalExpensesVAT: 0,
          expenseCount: 0,
        };
        const piTotalAgg = (purchaseInvoiceMonthlyStats || []).reduce(
          (acc, m) => {
            acc.amountTTC += m.amountTTC || 0;
            acc.amountTVA += m.amountTVA || 0;
            acc.count += m.count || 0;
            return acc;
          },
          { amountTTC: 0, amountTVA: 0, count: 0 },
        );
        const expTotals = {
          totalExpensesTTC:
            rawExpTotals.totalExpensesTTC + piTotalAgg.amountTTC,
          totalExpensesVAT:
            rawExpTotals.totalExpensesVAT + piTotalAgg.amountTVA,
          expenseCount: rawExpTotals.expenseCount + piTotalAgg.count,
        };

        // T10 — extraction anticipée du facet "monthlyCollected" pour exposer
        // paidTotalsAgg et collectedFacet aux calculs KPI (DSO, netRevenueHT)
        // avant la section MERGE MONTHLY DATA.
        const collectedFacet = (monthlyCollectedStats &&
          monthlyCollectedStats[0]) || { monthly: [], totals: [] };
        const paidTotalsAgg = collectedFacet.totals[0] || {
          paidRevenueHT: 0,
          paidRevenueTTC: 0,
          paidInvoiceCount: 0,
          avgDaysToPay: null,
        };

        // Quote results
        const quoteResult = quoteStats[0] || { total: 0, completed: 0 };
        const quoteConversionRate =
          quoteResult.total > 0
            ? Math.round((quoteResult.completed / quoteResult.total) * 10000) /
              100
            : 0;

        // CreditNote results
        const cnResult = creditNoteStats[0];
        const cnTotals = cnResult.totals[0] || {
          totalHT: 0,
          totalTTC: 0,
          totalVAT: 0,
          count: 0,
        };

        // ==============================
        // COMPUTE DERIVED KPI
        // ==============================

        const totalRevenueHT = Math.round(invTotals.totalRevenueHT * 100) / 100;
        const totalRevenueTTC =
          Math.round(invTotals.totalRevenueTTC * 100) / 100;
        const creditNoteTotalHT = Math.round(cnTotals.totalHT * 100) / 100; // negative

        // T10.1 : netRevenueHT = factures payées (Newbi + importées) sur la
        // période (filtre paymentDate), moins les avoirs émis sur la période.
        const importedCollectedHT = (
          importedInvoiceCollectedStats || []
        ).reduce((sum, r) => sum + (r.collectedHT || r.collectedTTC || 0), 0);
        // Note: si collectedHT manque côté ImportedInvoice agg, on retombera sur
        // collectedTTC. C'est volontairement approximatif faute de champ HT systématique.
        const paidRevenueHT = paidTotalsAgg.paidRevenueHT || 0;
        const netRevenueHT =
          Math.round(
            (paidRevenueHT + importedCollectedHT + creditNoteTotalHT) * 100,
          ) / 100;

        const totalExpensesTTC =
          Math.round(expTotals.totalExpensesTTC * 100) / 100;
        const totalExpensesVAT =
          Math.round(expTotals.totalExpensesVAT * 100) / 100;
        const totalExpensesHT =
          Math.round((totalExpensesTTC - totalExpensesVAT) * 100) / 100;

        const grossMargin =
          Math.round((netRevenueHT - totalExpensesHT) * 100) / 100;
        const grossMarginRate =
          netRevenueHT > 0
            ? Math.round((grossMargin / netRevenueHT) * 10000) / 100
            : 0;
        const chargeRate =
          netRevenueHT > 0
            ? Math.round((totalExpensesHT / netRevenueHT) * 10000) / 100
            : 0;

        // Outstanding & overdue
        const outstandingReceivables =
          Math.round(receivables.outstandingReceivables * 100) / 100;

        // Overdue invoices
        const overdueInvoices = (recvResult.overdueInvoices || []).map(
          (inv) => ({
            invoiceId: inv.invoiceId.toString(),
            invoiceNumber: (inv.invoiceNumber || "N/A").trim(),
            clientName: (inv.clientName || "Client inconnu").trim(),
            totalTTC: Math.round((inv.totalTTC || 0) * 100) / 100,
            dueDate: inv.dueDate ? inv.dueDate.toISOString().split("T")[0] : "",
            daysOverdue: Math.max(0, inv.daysOverdue || 0),
          }),
        );
        const overdueAmount = overdueInvoices.reduce(
          (sum, inv) => sum + inv.totalTTC,
          0,
        );
        const overdueCount = overdueInvoices.length;

        // DSO (T10.4) : moyenne directe entre date d'émission et date de
        // paiement des factures payées sur la période. Fallback sur l'ancienne
        // formule (créances en cours / CA × nbJours) si aucune facture payée.
        const periodStart = new Date(startDate);
        const periodEnd = new Date(endDate);
        const nbDays = Math.max(
          1,
          Math.ceil((periodEnd - periodStart) / 86400000),
        );
        const dsoFromPayments = paidTotalsAgg.avgDaysToPay;
        let dso;
        if (dsoFromPayments != null && !Number.isNaN(dsoFromPayments)) {
          dso = Math.round(dsoFromPayments * 100) / 100;
        } else {
          const revenueTTCForDso =
            collectionTotals.totalRevenueTTCExclCanceled || totalRevenueTTC;
          dso =
            revenueTTCForDso > 0
              ? Math.round(
                  (outstandingReceivables / revenueTTCForDso) * nbDays * 100,
                ) / 100
              : 0;
        }

        // Collection rate: COMPLETED / total non-DRAFT (in count)
        const collectionRate =
          collectionTotals.totalInvoices > 0
            ? Math.round(
                (collectionTotals.completedInvoices /
                  collectionTotals.totalInvoices) *
                  10000,
              ) / 100
            : 0;

        // Aging buckets - normalize from MongoDB $bucket output
        const agingBucketsConfig = [
          { label: "1-30 jours", min: 0, max: 30 },
          { label: "31-60 jours", min: 31, max: 60 },
          { label: "61-90 jours", min: 61, max: 90 },
          { label: "91+ jours", min: 91, max: 9999 },
        ];
        const rawAgingBuckets = recvResult.agingBuckets || [];
        const agingBucketMap = {};
        for (const b of rawAgingBuckets) {
          agingBucketMap[b._id] = b;
        }
        const agingBuckets = agingBucketsConfig.map((cfg) => {
          let key;
          if (cfg.min === 0) key = 0;
          else if (cfg.min === 31) key = 31;
          else if (cfg.min === 61) key = 61;
          else key = "91+";
          const raw = agingBucketMap[key] || {};
          return {
            label: cfg.label,
            min: cfg.min,
            max: cfg.max,
            count: raw.count || 0,
            totalTTC: Math.round((raw.totalTTC || 0) * 100) / 100,
          };
        });

        // Monthly collection - merge invoiced (from monthlyRevenue) + collected (from separate paymentDate query)
        const invoicedMap = {};
        for (const r of invResult.monthlyRevenue) {
          invoicedMap[r.month] = {
            invoicedTTC: r.revenueTTC,
            invoicedCount: r.invoiceCount,
          };
        }
        // Merge imported invoices into invoicedMap
        for (const r of importedInvoiceMonthlyStats || []) {
          if (!r._id.year || !r._id.month) continue;
          const m = `${r._id.year}-${String(r._id.month).padStart(2, "0")}`;
          if (invoicedMap[m]) {
            invoicedMap[m].invoicedTTC += r.invoicedTTC;
            invoicedMap[m].invoicedCount += r.invoicedCount;
          } else {
            invoicedMap[m] = {
              invoicedTTC: r.invoicedTTC,
              invoicedCount: r.invoicedCount,
            };
          }
        }
        const collectedMap = {};
        // collectedFacet / paidTotalsAgg sont déjà extraits plus haut (T10).
        for (const r of collectedFacet.monthly || []) {
          const m = `${r._id.year}-${String(r._id.month).padStart(2, "0")}`;
          collectedMap[m] = {
            collectedTTC: r.collectedTTC,
            collectedCount: r.collectedCount,
          };
        }
        // Merge imported invoices into collectedMap
        for (const r of importedInvoiceCollectedStats || []) {
          if (!r._id.year || !r._id.month) continue;
          const m = `${r._id.year}-${String(r._id.month).padStart(2, "0")}`;
          if (collectedMap[m]) {
            collectedMap[m].collectedTTC += r.collectedTTC;
            collectedMap[m].collectedCount += r.collectedCount;
          } else {
            collectedMap[m] = {
              collectedTTC: r.collectedTTC,
              collectedCount: r.collectedCount,
            };
          }
        }
        // Impayés échus (échéance dépassée, sans avoir) — Newbi + importées,
        // regroupés par mois d'échéance.
        const unpaidMap = {};
        const mergeUnpaid = (rows) => {
          for (const r of rows || []) {
            if (!r._id.year || !r._id.month) continue;
            const m = `${r._id.year}-${String(r._id.month).padStart(2, "0")}`;
            unpaidMap[m] = {
              unpaidTTC: (unpaidMap[m]?.unpaidTTC || 0) + (r.unpaidTTC || 0),
              unpaidCount:
                (unpaidMap[m]?.unpaidCount || 0) + (r.unpaidCount || 0),
            };
          }
        };
        mergeUnpaid(invoiceUnpaidStats);
        mergeUnpaid(importedInvoiceUnpaidStats);

        const allCollectionMonths = [
          ...new Set([
            ...Object.keys(invoicedMap),
            ...Object.keys(collectedMap),
            ...Object.keys(unpaidMap),
          ]),
        ].sort();
        const monthlyCollection = allCollectionMonths.map((m) => {
          const inv = invoicedMap[m] || { invoicedTTC: 0, invoicedCount: 0 };
          const col = collectedMap[m] || { collectedTTC: 0, collectedCount: 0 };
          const unp = unpaidMap[m] || { unpaidTTC: 0, unpaidCount: 0 };
          return {
            month: m,
            invoicedTTC: Math.round(inv.invoicedTTC * 100) / 100,
            collectedTTC: Math.round(col.collectedTTC * 100) / 100,
            invoicedCount: inv.invoicedCount,
            collectedCount: col.collectedCount,
            unpaidTTC: Math.round(unp.unpaidTTC * 100) / 100,
            unpaidCount: unp.unpaidCount,
          };
        });

        // Top client concentration
        const revenueByClientSorted = [...invResult.revenueByClient].sort(
          (a, b) => b.totalHT - a.totalHT,
        );
        const top3HT = revenueByClientSorted
          .slice(0, 3)
          .reduce((s, c) => s + c.totalHT, 0);
        const totalHT = revenueByClientSorted.reduce(
          (s, c) => s + c.totalHT,
          0,
        );
        const topClientConcentration =
          totalHT > 0 ? Math.round((top3HT / totalHT) * 10000) / 100 : 0;

        // Client counts
        const activeClientCount = (invTotals.clients || []).filter(
          Boolean,
        ).length;

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
        // T11 + T22 : fusion des factures d'achats (PurchaseInvoice) dans le
        // map mensuel des dépenses (HT/TTC/VAT) — la TVA déductible vient des
        // factures d'achats, et les dépenses du mois doivent inclure factures
        // d'achats + dépenses libres.
        for (const m of purchaseInvoiceMonthlyStats || []) {
          if (!m.month) continue;
          const existing = expenseMonthlyMap[m.month] || {
            amountTTC: 0,
            amountHT: 0,
            vatAmount: 0,
            count: 0,
          };
          expenseMonthlyMap[m.month] = {
            amountTTC: existing.amountTTC + (m.amountTTC || 0),
            amountHT: existing.amountHT + (m.amountHT || 0),
            vatAmount: existing.vatAmount + (m.amountTVA || 0),
            count: existing.count + (m.count || 0),
          };
        }

        const cnMonthlyMap = {};
        for (const m of cnResult.monthly) {
          cnMonthlyMap[m.month] = { totalHT: m.totalHT, totalTTC: m.totalTTC };
        }

        // T11 : construire un map mensuel basé sur les paiements (Newbi + importées)
        // Le graphique CA / Dépenses / Marge brute doit refléter les flux du mois,
        // donc le CA mensuel = factures encaissées le mois (paymentDate).
        const paidMonthlyMap = {};
        for (const r of collectedFacet.monthly || []) {
          const m = `${r._id.year}-${String(r._id.month).padStart(2, "0")}`;
          paidMonthlyMap[m] = {
            revenueHT: r.collectedHT || 0,
            revenueTTC: r.collectedTTC || 0,
            revenueVAT: Math.max(
              0,
              (r.collectedTTC || 0) - (r.collectedHT || 0),
            ),
            invoiceCount: r.collectedCount || 0,
          };
        }
        for (const r of importedInvoiceCollectedStats || []) {
          if (!r._id?.year || !r._id?.month) continue;
          const m = `${r._id.year}-${String(r._id.month).padStart(2, "0")}`;
          const existing = paidMonthlyMap[m] || {
            revenueHT: 0,
            revenueTTC: 0,
            revenueVAT: 0,
            invoiceCount: 0,
          };
          // Pour ImportedInvoice on n'a que TTC ; on l'ajoute en HT (approximation)
          existing.revenueHT += r.collectedTTC || 0;
          existing.revenueTTC += r.collectedTTC || 0;
          existing.invoiceCount += r.collectedCount || 0;
          paidMonthlyMap[m] = existing;
        }

        // Build monthly series — clé = union des mois CA + dépenses + avoirs
        const allMonths = new Set([
          ...Object.keys(paidMonthlyMap),
          ...invResult.monthlyRevenue.map((m) => m.month),
          ...Object.keys(expenseMonthlyMap),
          ...Object.keys(cnMonthlyMap),
        ]);
        const invoiceIssuedMap = {};
        for (const m of invResult.monthlyRevenue) {
          invoiceIssuedMap[m.month] = m;
        }
        const monthlyRevenue = Array.from(allMonths).map((month) => {
          const paid = paidMonthlyMap[month] || {
            revenueHT: 0,
            revenueTTC: 0,
            revenueVAT: 0,
            invoiceCount: 0,
          };
          const issued = invoiceIssuedMap[month] || {
            invoiceCount: 0,
          };
          const exp = expenseMonthlyMap[month] || {
            amountTTC: 0,
            amountHT: 0,
            vatAmount: 0,
            count: 0,
          };
          const cn = cnMonthlyMap[month] || { totalHT: 0, totalTTC: 0 };

          // T11.1 : CA mensuel = factures payées sur le mois (HT)
          // T11.3 : Marge brute = CA HT − Dépenses HT
          const monthNetRevenueHT = paid.revenueHT + cn.totalHT;
          const monthGrossMargin = monthNetRevenueHT - exp.amountHT;
          const monthGrossMarginRate =
            monthNetRevenueHT > 0
              ? Math.round((monthGrossMargin / monthNetRevenueHT) * 10000) / 100
              : 0;

          return {
            month,
            revenueHT: Math.round(paid.revenueHT * 100) / 100,
            revenueTTC: Math.round(paid.revenueTTC * 100) / 100,
            revenueVAT: Math.round(paid.revenueVAT * 100) / 100,
            expenseAmount: Math.round(exp.amountTTC * 100) / 100,
            expenseAmountHT: Math.round(exp.amountHT * 100) / 100,
            expenseVAT: Math.round(exp.vatAmount * 100) / 100,
            invoiceCount: issued.invoiceCount || paid.invoiceCount,
            expenseCount: exp.count,
            netResult: Math.round((paid.revenueHT - exp.amountTTC) * 100) / 100,
            creditNoteHT: Math.round(cn.totalHT * 100) / 100,
            netRevenueHT: Math.round(monthNetRevenueHT * 100) / 100,
            grossMargin: Math.round(monthGrossMargin * 100) / 100,
            grossMarginRate: monthGrossMarginRate,
          };
        });
        // Vider les map pour ne pas dupliquer ci-dessous
        for (const month of allMonths) {
          delete expenseMonthlyMap[month];
          delete cnMonthlyMap[month];
        }

        // Add months that only have expenses or credit notes
        const remainingMonths = new Set([
          ...Object.keys(expenseMonthlyMap),
          ...Object.keys(cnMonthlyMap),
        ]);
        for (const month of remainingMonths) {
          const exp = expenseMonthlyMap[month] || {
            amountTTC: 0,
            amountHT: 0,
            vatAmount: 0,
            count: 0,
          };
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
          const { prevStart, prevEnd } = computePreviousPeriod(
            startDate,
            endDate,
          );

          const prevDateQuery = { $gte: prevStart, $lte: prevEnd };
          const prevInvoiceMatch = {
            workspaceId: wId,
            status: { $ne: "DRAFT" },
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
                        totalRevenueHT: { $sum: "$finalTotalHT" },
                        totalRevenueTTC: { $sum: "$finalTotalTTC" },
                        invoiceCount: { $sum: 1 },
                        // Count/revenue excluding CANCELED (for collectionRate and DSO)
                        invoiceCountExclCanceled: {
                          $sum: {
                            $cond: [{ $ne: ["$status", "CANCELED"] }, 1, 0],
                          },
                        },
                        revenueTTCExclCanceled: {
                          $sum: {
                            $cond: [
                              { $ne: ["$status", "CANCELED"] },
                              "$finalTotalTTC",
                              0,
                            ],
                          },
                        },
                        clients: { $addToSet: "$client.id" },
                        completedCount: {
                          $sum: {
                            $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0],
                          },
                        },
                      },
                    },
                  ],
                  receivables: [
                    { $match: { status: { $in: ["PENDING", "OVERDUE"] } } },
                    {
                      $group: {
                        _id: null,
                        outstandingReceivables: { $sum: "$finalTotalTTC" },
                      },
                    },
                  ],
                  overdue: [
                    {
                      $match: {
                        status: { $in: ["PENDING", "OVERDUE"] },
                        dueDate: { $ne: null, $lt: now },
                      },
                    },
                    {
                      $group: {
                        _id: null,
                        amount: { $sum: "$finalTotalTTC" },
                        count: { $sum: 1 },
                      },
                    },
                  ],
                  revenueByClient: [
                    {
                      $group: {
                        _id: "$client.id",
                        totalHT: { $sum: "$finalTotalHT" },
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
                  totalExpensesTTC: { $sum: "$amount" },
                  totalExpensesVAT: { $sum: { $ifNull: ["$vatAmount", 0] } },
                },
              },
            ]),
            CreditNote.aggregate([
              { $match: prevCreditNoteMatch },
              {
                $group: {
                  _id: null,
                  totalHT: { $sum: "$finalTotalHT" },
                },
              },
            ]),
            Quote.aggregate([
              {
                $match: {
                  workspaceId: wId,
                  status: { $in: ["COMPLETED", "CANCELED", "PENDING"] },
                  issueDate: prevDateQuery,
                },
              },
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

          const prevInvResult = prevInv[0];
          const prevInvTotals = prevInvResult.totals[0] || {
            totalRevenueHT: 0,
            totalRevenueTTC: 0,
            invoiceCount: 0,
            clients: [],
            completedCount: 0,
          };
          const prevExpTotals = prevExp[0] || {
            totalExpensesTTC: 0,
            totalExpensesVAT: 0,
          };
          const prevCnTotals = prevCn[0] || { totalHT: 0 };
          const prevQuoteTotals = prevQuote[0] || { total: 0, completed: 0 };
          const prevReceivables = prevInvResult.receivables[0] || {
            outstandingReceivables: 0,
          };
          const prevOverdue = prevInvResult.overdue[0] || {
            amount: 0,
            count: 0,
          };

          const prevTotalRevenueHT = prevInvTotals.totalRevenueHT;
          const prevTotalRevenueTTC = prevInvTotals.totalRevenueTTC;
          const prevCreditNoteTotalHT = prevCnTotals.totalHT;
          const prevNetRevenueHT = prevTotalRevenueHT + prevCreditNoteTotalHT;
          const prevTotalExpensesTTC = prevExpTotals.totalExpensesTTC;
          const prevTotalExpensesVAT = prevExpTotals.totalExpensesVAT;
          const prevTotalExpensesHT =
            prevTotalExpensesTTC - prevTotalExpensesVAT;
          const prevGrossMargin = prevNetRevenueHT - prevTotalExpensesHT;
          const prevGrossMarginRate =
            prevNetRevenueHT > 0
              ? Math.round((prevGrossMargin / prevNetRevenueHT) * 10000) / 100
              : 0;
          const prevChargeRate =
            prevNetRevenueHT > 0
              ? Math.round((prevTotalExpensesHT / prevNetRevenueHT) * 10000) /
                100
              : 0;

          const prevInvoiceCountForRate =
            prevInvTotals.invoiceCountExclCanceled ||
            prevInvTotals.invoiceCount;
          const prevCollectionRate =
            prevInvoiceCountForRate > 0
              ? Math.round(
                  (prevInvTotals.completedCount / prevInvoiceCountForRate) *
                    10000,
                ) / 100
              : 0;
          const prevNbDays = Math.max(
            1,
            Math.ceil((prevEnd - prevStart) / 86400000),
          );
          const prevRevenueTTCForDso =
            prevInvTotals.revenueTTCExclCanceled || prevTotalRevenueTTC;
          const prevDso =
            prevRevenueTTCForDso > 0
              ? Math.round(
                  (prevReceivables.outstandingReceivables /
                    prevRevenueTTCForDso) *
                    prevNbDays *
                    100,
                ) / 100
              : 0;

          const prevActiveClientCount = (prevInvTotals.clients || []).filter(
            Boolean,
          ).length;

          // N-1 client concentration
          const prevRBC = prevInvResult.revenueByClient || [];
          const prevTop3HT = prevRBC
            .slice(0, 3)
            .reduce((s, c) => s + c.totalHT, 0);
          const prevTotalHT = prevRBC.reduce((s, c) => s + c.totalHT, 0);
          const prevTopClientConcentration =
            prevTotalHT > 0
              ? Math.round((prevTop3HT / prevTotalHT) * 10000) / 100
              : 0;

          // New clients: clients active now but not in N-1
          const prevClientSet = new Set(
            (prevInvTotals.clients || []).filter(Boolean),
          );
          const currentClientSet = new Set(
            (invTotals.clients || []).filter(Boolean),
          );
          let newClientCount = 0;
          for (const cId of currentClientSet) {
            if (!prevClientSet.has(cId)) newClientCount++;
          }
          // Retained: clients active in both periods
          let retainedClientCount = 0;
          for (const cId of currentClientSet) {
            if (prevClientSet.has(cId)) retainedClientCount++;
          }

          const prevQuoteConversionRate =
            prevQuoteTotals.total > 0
              ? Math.round(
                  (prevQuoteTotals.completed / prevQuoteTotals.total) * 10000,
                ) / 100
              : 0;

          previousPeriod = {
            totalRevenueHT: Math.round(prevTotalRevenueHT * 100) / 100,
            totalExpensesHT: Math.round(prevTotalExpensesHT * 100) / 100,
            grossMargin: Math.round(prevGrossMargin * 100) / 100,
            grossMarginRate: prevGrossMarginRate,
            invoiceCount: prevInvTotals.invoiceCount,
            averageInvoiceHT:
              prevInvTotals.invoiceCount > 0
                ? Math.round(
                    (prevTotalRevenueHT / prevInvTotals.invoiceCount) * 100,
                  ) / 100
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
            outstandingReceivables:
              Math.round(prevReceivables.outstandingReceivables * 100) / 100,
            topClientConcentration: prevTopClientConcentration,
            chargeRate: prevChargeRate,
          };

          // Set newClientCount and retainedClientCount on main KPI (need both periods)
          _newClientCount = newClientCount;
          _retainedClientCount = retainedClientCount;
        } catch (err) {
          // If N-1 fails, just continue without it
          console.error("N-1 period calculation error:", err.message);
        }

        // ==============================
        // AGGREGATE KANBAN TIME
        // ==============================
        const clientTimeMap = await aggregateTimeByClient(
          wId,
          startDate,
          endDate,
          clientIds,
        );

        // ── CA CLIENT PAYÉ par client (factures Newbi + importées) ──
        // À partir des lignes mensuelles (regroupées par paymentDate), on dérive
        // le détail/total par client ("Détail par client", "Top 10",
        // "Répartition par type") et le "Tableau croisé Client x Mois".
        // Factures client natives ET importées vivent toutes dans la collection
        // Invoice (agrégation #11) : aucun rapprochement par nom n'est requis,
        // et les factures d'achat (ImportedInvoice) sont exclues.
        const normName = (s) => (s || "Client inconnu").trim();

        // 1) Agrégat par client (somme des mois).
        const clientAgg = new Map(); // clé : clientId, sinon `name:<nom>`
        for (const row of paidInvoiceByClientMonthly || []) {
          const cId = row._id.clientId || null;
          const name = normName(row._id.clientName);
          const key = cId || `name:${name.toLowerCase()}`;
          let entry = clientAgg.get(key);
          if (!entry) {
            entry = {
              clientId: cId,
              clientName: name,
              clientType: row._id.clientType || null,
              totalHT: 0,
              totalTTC: 0,
              totalVAT: 0,
              invoiceCount: 0,
            };
            clientAgg.set(key, entry);
          }
          entry.totalHT += row.totalHT || 0;
          entry.totalTTC += row.totalTTC || 0;
          entry.totalVAT += row.totalVAT || 0;
          entry.invoiceCount += row.invoiceCount || 0;
        }

        // 2) Construire revenueByClient (+ temps passé via clientTimeMap).
        const matchedClientIds = new Set();
        const revenueByClient = [];
        for (const entry of clientAgg.values()) {
          const cId = entry.clientId || null;
          if (cId) matchedClientIds.add(cId);
          const timeData = cId ? clientTimeMap.get(cId) : null;
          const totalHT = Math.round(entry.totalHT * 100) / 100;
          revenueByClient.push({
            clientId: cId,
            clientName: entry.clientName,
            clientType: entry.clientType || null,
            totalHT,
            totalTTC: Math.round(entry.totalTTC * 100) / 100,
            totalVAT: Math.round(entry.totalVAT * 100) / 100,
            invoiceCount: entry.invoiceCount,
            averageInvoiceHT:
              entry.invoiceCount > 0
                ? Math.round((totalHT / entry.invoiceCount) * 100) / 100
                : 0,
            totalTimeSeconds: timeData?.totalTimeSeconds || 0,
            totalBillableAmount: timeData
              ? Math.round(timeData.totalBillableAmount * 100) / 100
              : 0,
            totalHours: timeData
              ? Math.round((timeData.totalTimeSeconds / 3600) * 100) / 100
              : 0,
          });
        }

        // Add clients that have time tracked but no paid invoices
        const Client = mongoose.model("Client");
        for (const [clientIdStr, timeData] of clientTimeMap) {
          if (matchedClientIds.has(clientIdStr)) continue;
          const client = await Client.findById(clientIdStr).lean();
          if (!client) continue;
          const clientName =
            client.type === "INDIVIDUAL"
              ? `${client.firstName || ""} ${client.lastName || ""}`.trim()
              : client.name || "Client inconnu";
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
            totalBillableAmount:
              Math.round(timeData.totalBillableAmount * 100) / 100,
            totalHours:
              Math.round((timeData.totalTimeSeconds / 3600) * 100) / 100,
          });
        }

        // Trier par CA TTC payé décroissant.
        revenueByClient.sort((a, b) => (b.totalTTC || 0) - (a.totalTTC || 0));

        // Top 10 clients (CA TTC payé, Newbi + importées).
        const totalTTCAll =
          revenueByClient.reduce((s, c) => s + (c.totalTTC || 0), 0) || 1;
        const topClients = revenueByClient.slice(0, 10).map((c) => ({
          clientId: c.clientId,
          clientName: c.clientName,
          totalTTC: c.totalTTC,
          invoiceCount: c.invoiceCount,
          percentage: Math.round((c.totalTTC / totalTTCAll) * 10000) / 100,
        }));

        // 3) Tableau croisé Client x Mois (CA client payé par mois de paiement,
        // factures Newbi + importées, toutes issues de la collection Invoice).
        const monthlyByClientMonth = new Map();
        const fmtMonth = (year, month) =>
          `${year}-${month < 10 ? "0" + month : month}`;
        const addMonthly = (name, month, r) => {
          const key = `${name.toLowerCase()}::${month}`;
          let m = monthlyByClientMonth.get(key);
          if (!m) {
            m = {
              clientName: name,
              month,
              totalHT: 0,
              totalTTC: 0,
              totalVAT: 0,
              invoiceCount: 0,
            };
            monthlyByClientMonth.set(key, m);
          }
          m.totalHT += r.totalHT || 0;
          m.totalTTC += r.totalTTC || 0;
          m.totalVAT += r.totalVAT || 0;
          m.invoiceCount += r.invoiceCount || 0;
        };
        for (const row of paidInvoiceByClientMonthly || []) {
          addMonthly(
            normName(row._id.clientName),
            fmtMonth(row._id.year, row._id.month),
            row,
          );
        }
        const revenueByClientMonthly = [...monthlyByClientMonth.values()]
          .map((m) => ({
            clientId: null,
            clientName: m.clientName,
            month: m.month,
            totalHT: Math.round(m.totalHT * 100) / 100,
            totalTTC: Math.round(m.totalTTC * 100) / 100,
            totalVAT: Math.round(m.totalVAT * 100) / 100,
            invoiceCount: m.invoiceCount,
          }))
          .sort((a, b) =>
            a.month === b.month
              ? a.clientName.localeCompare(b.clientName)
              : a.month.localeCompare(b.month),
          );

        // ==============================
        // BUILD KPI
        // ==============================
        const kpi = {
          totalRevenueHT,
          totalRevenueTTC,
          // Backward compat: totalExpenses = TTC, netResult = HT - TTC (old behavior)
          totalExpenses: totalExpensesTTC,
          netResult:
            Math.round((totalRevenueHT - totalExpensesTTC) * 100) / 100,
          invoiceCount: invTotals.invoiceCount,
          expenseCount: expTotals.expenseCount,
          averageInvoiceHT:
            invTotals.invoiceCount > 0
              ? Math.round((totalRevenueHT / invTotals.invoiceCount) * 100) /
                100
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
          revenueByProduct: mergeRevenueByProduct(invResult.revenueByProduct),
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
          revenueByClientMonthly,
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
      },
    ),
  },
};

export default financialAnalyticsResolvers;
