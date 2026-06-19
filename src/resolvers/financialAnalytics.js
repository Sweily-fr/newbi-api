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

/**
 * Détecte les lignes d'article générées automatiquement lors de la
 * facturation d'un devis (acompte, facture partielle, facture de solde,
 * facture sur devis). Ces lignes représentent un document, pas un produit,
 * et ne doivent pas apparaître dans le « Top produits / services ».
 */
function isQuoteLinkedLineItem(desc) {
  if (!desc) return false;
  const normalized = desc
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
  return /^(acompte|facture)\b.*\bdevis\b/i.test(normalized);
}

function mergeRevenueByProduct(rawProducts) {
  if (!Array.isArray(rawProducts) || rawProducts.length === 0) return [];
  const groups = new Map();
  for (const p of rawProducts) {
    // Exclure les lignes liées à un devis (acompte/partielle/solde) :
    // ce sont des documents, pas des produits.
    if (isQuoteLinkedLineItem(p.description)) continue;
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
        const PurchaseInvoice = mongoose.model("PurchaseInvoice");
        const Quote = mongoose.model("Quote");
        const CreditNote = mongoose.model("CreditNote");
        const ImportedInvoice = mongoose.model("ImportedInvoice");
        const Transaction = mongoose.model("Transaction");

        // --- Dépenses : transactions sortantes payées ---
        // Les dépenses = factures d'achat PAYÉES (agrégation #9) + transactions
        // sortantes payées (montant < 0, status "completed" — minuscule en
        // base). Les transactions déjà rapprochées à une facture d'achat
        // (linkedTransactionIds) sont exclues pour éviter le double comptage
        // avec la facture payée. NB : workspaceId est stocké en String sur
        // Transaction (pas en ObjectId).
        const linkedTxIds = (
          await PurchaseInvoice.distinct("linkedTransactionIds", {
            workspaceId: wId,
          })
        ).filter(Boolean);
        const outgoingTxMatch = {
          workspaceId: String(workspaceId),
          amount: { $lt: 0 },
          status: "completed",
          deletedAt: null,
        };
        if (linkedTxIds.length > 0) outgoingTxMatch._id = { $nin: linkedTxIds };
        if (startDate || endDate) outgoingTxMatch.date = dateQuery;

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
              },
            },
          ]),

          // 2. Dépenses : transactions sortantes payées (montant < 0,
          // status "completed"), hors transactions rapprochées à une facture
          // d'achat. Une transaction bancaire ne porte pas de TVA → vatAmount
          // vaut 0 et HT = TTC. Montants stockés négatifs → valeur absolue.
          Transaction.aggregate([
            { $match: outgoingTxMatch },
            {
              $addFields: {
                _absAmount: { $abs: "$amount" },
              },
            },
            {
              $facet: {
                totals: [
                  {
                    $group: {
                      _id: null,
                      totalExpensesTTC: { $sum: "$_absAmount" },
                      totalExpensesVAT: { $sum: 0 },
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
                      amountTTC: { $sum: "$_absAmount" },
                      vatAmount: { $sum: 0 },
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
                      _id: { $ifNull: ["$expenseCategory", "OTHER"] },
                      amount: { $sum: "$_absAmount" },
                      count: { $sum: 1 },
                    },
                  },
                  { $sort: { amount: -1 } },
                ],
                byCategoryMonthly: [
                  {
                    $group: {
                      _id: {
                        category: { $ifNull: ["$expenseCategory", "OTHER"] },
                        year: { $year: "$date" },
                        month: { $month: "$date" },
                      },
                      amount: { $sum: "$_absAmount" },
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
          // Le CA est reconnu à l'encaissement (paymentDate) : seuls les
          // avoirs « cash » — liés à une facture encaissée (COMPLETED), donc
          // correspondant à un remboursement réel — doivent réduire le CA net.
          // Les avoirs sur factures non payées ou supprimées (orphelins)
          // annulent un CA qui n'a jamais été encaissé : ils sont comptés dans
          // `totals` (KPI « avoirs émis ») mais exclus de `cashTotals` et
          // `monthly` (qui alimentent netRevenueHT global et mensuel).
          CreditNote.aggregate([
            { $match: creditNoteMatch },
            {
              $lookup: {
                from: "invoices",
                localField: "originalInvoice",
                foreignField: "_id",
                as: "_origInvoice",
              },
            },
            {
              $addFields: {
                _origStatus: { $arrayElemAt: ["$_origInvoice.status", 0] },
              },
            },
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
                cashTotals: [
                  { $match: { _origStatus: "COMPLETED" } },
                  {
                    $group: {
                      _id: null,
                      totalHT: { $sum: "$finalTotalHT" },
                      totalTTC: { $sum: "$finalTotalTTC" },
                    },
                  },
                ],
                monthly: [
                  { $match: { _origStatus: "COMPLETED" } },
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
                        // DSO : jours entre émission et paiement (T10.4).
                        // Somme + compteur pour pondérer la moyenne avec les
                        // factures importées (paymentDate non-null via $match).
                        sumDaysToPay: {
                          $sum: {
                            $cond: [
                              { $ne: ["$issueDate", null] },
                              {
                                $divide: [
                                  { $subtract: ["$paymentDate", "$issueDate"] },
                                  86400000,
                                ],
                              },
                              0,
                            ],
                          },
                        },
                        daysToPayCount: {
                          $sum: {
                            $cond: [{ $ne: ["$issueDate", null] }, 1, 0],
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

          // 7. Imported invoices — émises (by invoiceDate, fallback createdAt).
          // Les factures importées comptent dans « Factures émises » et le
          // « Panier moyen » au même titre que les factures créées sur Newbi.
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
              $facet: {
                monthly: [
                  {
                    $group: {
                      _id: {
                        year: { $year: "$_effectiveDate" },
                        month: { $month: "$_effectiveDate" },
                      },
                      invoicedTTC: { $sum: "$totalTTC" },
                      invoicedCount: { $sum: 1 },
                    },
                  },
                ],
                totals: [
                  {
                    $group: {
                      _id: null,
                      invoicedTTC: { $sum: "$totalTTC" },
                      // totalHT vaut 0 par défaut sur le modèle → fallback TTC
                      invoicedHT: {
                        $sum: {
                          $cond: [
                            { $gt: ["$totalHT", 0] },
                            "$totalHT",
                            "$totalTTC",
                          ],
                        },
                      },
                      invoicedCount: { $sum: 1 },
                    },
                  },
                ],
              },
            });
            return ImportedInvoice.aggregate(pipeline);
          })(),

          // 8. Imported invoices — encaissées (COMPLETED). L'encaissement est
          // reconnu STRICTEMENT à la DATE DE PAIEMENT (paymentDate) : une
          // facture importée payée sans paymentDate n'entre pas dans le CA net.
          (() => {
            const importedPaymentDateRange = { $ne: null };
            if (startDate) importedPaymentDateRange.$gte = new Date(startDate);
            if (endDate) importedPaymentDateRange.$lte = new Date(endDate);
            return ImportedInvoice.aggregate([
              {
                $match: {
                  workspaceId: wId,
                  status: "COMPLETED",
                  paymentDate: importedPaymentDateRange,
                },
              },
              {
                $facet: {
                  monthly: [
                    {
                      $group: {
                        _id: {
                          year: { $year: "$paymentDate" },
                          month: { $month: "$paymentDate" },
                        },
                        collectedTTC: { $sum: "$totalTTC" },
                        // totalHT vaut 0 par défaut sur le modèle → fallback TTC
                        collectedHT: {
                          $sum: {
                            $cond: [
                              { $gt: ["$totalHT", 0] },
                              "$totalHT",
                              "$totalTTC",
                            ],
                          },
                        },
                        collectedCount: { $sum: 1 },
                      },
                    },
                  ],
                  totals: [
                    {
                      $group: {
                        _id: null,
                        collectedTTC: { $sum: "$totalTTC" },
                        collectedHT: {
                          $sum: {
                            $cond: [
                              { $gt: ["$totalHT", 0] },
                              "$totalHT",
                              "$totalTTC",
                            ],
                          },
                        },
                        collectedCount: { $sum: 1 },
                        // DSO : jours entre émission (invoiceDate) et paiement
                        sumDaysToPay: {
                          $sum: {
                            $cond: [
                              { $ne: ["$invoiceDate", null] },
                              {
                                $divide: [
                                  {
                                    $subtract: ["$paymentDate", "$invoiceDate"],
                                  },
                                  86400000,
                                ],
                              },
                              0,
                            ],
                          },
                        },
                        daysToPayCount: {
                          $sum: {
                            $cond: [{ $ne: ["$invoiceDate", null] }, 1, 0],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            ]);
          })(),

          // 9. PurchaseInvoice — TVA déductible mensuelle + dépenses (HT/TTC/VAT)
          // (T22 : ajouter TVA des factures d'achats au graphique TVA)
          // (T11 : inclure les factures d'achats payées dans les dépenses mensuelles)
          // T-rentabilité : seules les factures d'achat PAYÉES comptent en
          // dépenses, rattachées au mois de paiement (paymentDate, fallback
          // issueDate pour les anciennes données sans paymentDate).
          (() => {
            const pipeline = [
              { $match: { workspaceId: wId, status: "PAID" } },
              {
                $addFields: {
                  _effectiveDate: { $ifNull: ["$paymentDate", "$issueDate"] },
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
            return PurchaseInvoice.aggregate([
              ...pipeline,
              {
                $facet: {
                  monthly: [
                    {
                      $group: {
                        _id: {
                          year: { $year: "$_effectiveDate" },
                          month: { $month: "$_effectiveDate" },
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
                                then: {
                                  $concat: ["0", { $toString: "$_id.month" }],
                                },
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
                  ],
                  byCategory: [
                    {
                      $group: {
                        _id: { $ifNull: ["$category", "OTHER"] },
                        amount: { $sum: { $ifNull: ["$amountTTC", 0] } },
                        count: { $sum: 1 },
                      },
                    },
                  ],
                  byCategoryMonthly: [
                    {
                      $group: {
                        _id: {
                          category: { $ifNull: ["$category", "OTHER"] },
                          year: { $year: "$_effectiveDate" },
                          month: { $month: "$_effectiveDate" },
                        },
                        amount: { $sum: { $ifNull: ["$amountTTC", 0] } },
                        count: { $sum: 1 },
                      },
                    },
                    {
                      $project: {
                        _id: 0,
                        category: "$_id.category",
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
                  ],
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
        // Current receivables snapshot (unfiltered by issueDate)
        const recvResult = currentReceivablesStats[0] || {
          receivables: [],
          overdueInvoices: [],
          agingBuckets: [],
        };
        const receivables = recvResult.receivables[0] || {
          outstandingReceivables: 0,
        };

        // Dépenses = transactions sortantes payées (expenseStats) + factures
        // d'achats payées (purchaseInvoiceMonthlyStats).
        const expResult = expenseStats[0];
        const rawExpTotals = expResult.totals[0] || {
          totalExpensesTTC: 0,
          totalExpensesVAT: 0,
          expenseCount: 0,
        };
        const piFacet = (purchaseInvoiceMonthlyStats &&
          purchaseInvoiceMonthlyStats[0]) || {
          monthly: [],
          byCategory: [],
          byCategoryMonthly: [],
        };
        const piTotalAgg = (piFacet.monthly || []).reduce(
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
          sumDaysToPay: 0,
          daysToPayCount: 0,
        };

        // Factures importées — facettes émises (#7) et encaissées (#8)
        const importedInvoicedFacet = (importedInvoiceMonthlyStats &&
          importedInvoiceMonthlyStats[0]) || { monthly: [], totals: [] };
        const importedInvoicedTotals = importedInvoicedFacet.totals[0] || {
          invoicedHT: 0,
          invoicedTTC: 0,
          invoicedCount: 0,
        };
        const importedCollectedFacet = (importedInvoiceCollectedStats &&
          importedInvoiceCollectedStats[0]) || { monthly: [], totals: [] };
        const importedCollectedTotals = importedCollectedFacet.totals[0] || {
          collectedHT: 0,
          collectedTTC: 0,
          collectedCount: 0,
          sumDaysToPay: 0,
          daysToPayCount: 0,
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
        // Avoirs « cash » uniquement (facture d'origine encaissée) — seuls
        // ceux-là réduisent le CA encaissé.
        const cnCashTotals = (cnResult.cashTotals || [])[0] || {
          totalHT: 0,
          totalTTC: 0,
        };

        // ==============================
        // COMPUTE DERIVED KPI
        // ==============================

        const totalRevenueHT = Math.round(invTotals.totalRevenueHT * 100) / 100;
        const totalRevenueTTC =
          Math.round(invTotals.totalRevenueTTC * 100) / 100;
        const creditNoteTotalHT = Math.round(cnTotals.totalHT * 100) / 100; // negative — avoirs émis (KPI)
        const cashCreditNoteHT = Math.round(cnCashTotals.totalHT * 100) / 100; // negative — avoirs sur factures encaissées

        // T10.1 : netRevenueHT = factures payées (Newbi + importées) sur la
        // période (filtre paymentDate), moins les avoirs « cash » (liés à une
        // facture encaissée). Les avoirs sur factures non payées/supprimées ne
        // réduisent pas le CA encaissé.
        const importedCollectedHT = importedCollectedTotals.collectedHT || 0;
        const paidRevenueHT = paidTotalsAgg.paidRevenueHT || 0;
        const netRevenueHT =
          Math.round(
            (paidRevenueHT + importedCollectedHT + cashCreditNoteHT) * 100,
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

        // DSO (T10.4) : moyenne pondérée des jours entre date d'émission et
        // date de paiement des factures payées sur la période — factures
        // Newbi + importées. 0 si aucune facture payée sur la période.
        const dsoSumDays =
          (paidTotalsAgg.sumDaysToPay || 0) +
          (importedCollectedTotals.sumDaysToPay || 0);
        const dsoCount =
          (paidTotalsAgg.daysToPayCount || 0) +
          (importedCollectedTotals.daysToPayCount || 0);
        const dso =
          dsoCount > 0 ? Math.round((dsoSumDays / dsoCount) * 100) / 100 : 0;

        // Taux de recouvrement = montant encaissé / montant impayé × 100.
        // Calculé plus bas, à partir des totaux de `monthlyCollection`
        // (encaissé + impayés échus sans avoir, factures Newbi + importées).
        let collectionRate = 0;

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
        for (const r of importedInvoicedFacet.monthly || []) {
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
        for (const r of importedCollectedFacet.monthly || []) {
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

        // Taux de recouvrement = (montant encaissé / montant impayé) × 100.
        // Impayé = factures échues (échéance dépassée), sans avoir,
        // Newbi + importées — cf. unpaidTTC. Si aucun impayé, on retourne 0
        // (le champ est non-nullable côté schéma GraphQL).
        const totalCollectedTTCForRate = monthlyCollection.reduce(
          (s, m) => s + (m.collectedTTC || 0),
          0,
        );
        const totalUnpaidTTCForRate = monthlyCollection.reduce(
          (s, m) => s + (m.unpaidTTC || 0),
          0,
        );
        collectionRate =
          totalUnpaidTTCForRate > 0
            ? Math.round(
                (totalCollectedTTCForRate / totalUnpaidTTCForRate) * 10000,
              ) / 100
            : 0;

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
        // d'achats + transactions sortantes payées.
        for (const m of piFacet.monthly || []) {
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

        // Avoirs « cash » par mois (cnResult.monthly est déjà filtré sur les
        // avoirs dont la facture d'origine est encaissée).
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
        for (const r of importedCollectedFacet.monthly || []) {
          if (!r._id?.year || !r._id?.month) continue;
          const m = `${r._id.year}-${String(r._id.month).padStart(2, "0")}`;
          const existing = paidMonthlyMap[m] || {
            revenueHT: 0,
            revenueTTC: 0,
            revenueVAT: 0,
            invoiceCount: 0,
          };
          const impHT = r.collectedHT || r.collectedTTC || 0;
          const impTTC = r.collectedTTC || 0;
          existing.revenueHT += impHT;
          existing.revenueTTC += impTTC;
          existing.revenueVAT += Math.max(0, impTTC - impHT);
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
          // Sans CA encaissé sur le mois, le taux n'est pas défini → null
          // (et non 0, qui laisserait croire à une marge nulle).
          const monthNetRevenueHT = paid.revenueHT + cn.totalHT;
          const monthGrossMargin = monthNetRevenueHT - exp.amountHT;
          const monthGrossMarginRate =
            monthNetRevenueHT > 0
              ? Math.round((monthGrossMargin / monthNetRevenueHT) * 10000) / 100
              : null;

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
            grossMarginRate: null,
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
          // Dépenses N-1 : transactions sortantes payées (mêmes règles que la
          // période courante — montant < 0, status "completed", hors
          // transactions rapprochées à une facture d'achat).
          const prevOutgoingTxMatch = {
            workspaceId: String(workspaceId),
            amount: { $lt: 0 },
            status: "completed",
            deletedAt: null,
            date: prevDateQuery,
          };
          if (linkedTxIds.length > 0) {
            prevOutgoingTxMatch._id = { $nin: linkedTxIds };
          }
          const prevCreditNoteMatch = {
            workspaceId: wId,
            issueDate: prevDateQuery,
          };

          const [
            prevInv,
            prevExp,
            prevCn,
            prevQuote,
            prevInvCollected,
            prevImpCollected,
            prevInvUnpaid,
            prevImpUnpaid,
            prevPurchaseInv,
            prevImpInvoiced,
          ] = await Promise.all([
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
            Transaction.aggregate([
              { $match: prevOutgoingTxMatch },
              {
                $group: {
                  _id: null,
                  totalExpensesTTC: { $sum: { $abs: "$amount" } },
                  totalExpensesVAT: { $sum: 0 },
                },
              },
            ]),
            // Avoirs N-1 : mêmes règles que la période courante — totals (tous,
            // KPI) vs cashTotals (facture d'origine encaissée → réduit le CA).
            CreditNote.aggregate([
              { $match: prevCreditNoteMatch },
              {
                $lookup: {
                  from: "invoices",
                  localField: "originalInvoice",
                  foreignField: "_id",
                  as: "_origInvoice",
                },
              },
              {
                $addFields: {
                  _origStatus: { $arrayElemAt: ["$_origInvoice.status", 0] },
                },
              },
              {
                $facet: {
                  totals: [
                    {
                      $group: {
                        _id: null,
                        totalHT: { $sum: "$finalTotalHT" },
                      },
                    },
                  ],
                  cashTotals: [
                    { $match: { _origStatus: "COMPLETED" } },
                    {
                      $group: {
                        _id: null,
                        totalHT: { $sum: "$finalTotalHT" },
                      },
                    },
                  ],
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
            // Encaissé N-1 (Newbi, par paymentDate) — alimente le CA net,
            // le taux de recouvrement et le DSO N-1.
            Invoice.aggregate([
              {
                $match: {
                  workspaceId: wId,
                  status: "COMPLETED",
                  paymentDate: { $ne: null, $gte: prevStart, $lte: prevEnd },
                },
              },
              {
                $group: {
                  _id: null,
                  collectedTTC: { $sum: "$finalTotalTTC" },
                  collectedHT: { $sum: "$finalTotalHT" },
                  sumDaysToPay: {
                    $sum: {
                      $cond: [
                        { $ne: ["$issueDate", null] },
                        {
                          $divide: [
                            { $subtract: ["$paymentDate", "$issueDate"] },
                            86400000,
                          ],
                        },
                        0,
                      ],
                    },
                  },
                  daysToPayCount: {
                    $sum: { $cond: [{ $ne: ["$issueDate", null] }, 1, 0] },
                  },
                },
              },
            ]),
            // Encaissé N-1 (importées) — STRICTEMENT à la date de paiement,
            // comme la période courante.
            ImportedInvoice.aggregate([
              {
                $match: {
                  workspaceId: wId,
                  status: "COMPLETED",
                  paymentDate: { $ne: null, $gte: prevStart, $lte: prevEnd },
                },
              },
              {
                $group: {
                  _id: null,
                  collectedTTC: { $sum: "$totalTTC" },
                  // totalHT vaut 0 par défaut sur le modèle → fallback TTC
                  collectedHT: {
                    $sum: {
                      $cond: [
                        { $gt: ["$totalHT", 0] },
                        "$totalHT",
                        "$totalTTC",
                      ],
                    },
                  },
                  sumDaysToPay: {
                    $sum: {
                      $cond: [
                        { $ne: ["$invoiceDate", null] },
                        {
                          $divide: [
                            { $subtract: ["$paymentDate", "$invoiceDate"] },
                            86400000,
                          ],
                        },
                        0,
                      ],
                    },
                  },
                  daysToPayCount: {
                    $sum: { $cond: [{ $ne: ["$invoiceDate", null] }, 1, 0] },
                  },
                },
              },
            ]),
            // Taux de recouvrement N-1 : montant impayé échu sans avoir (Newbi)
            Invoice.aggregate([
              {
                $match: {
                  workspaceId: wId,
                  status: { $in: ["PENDING", "OVERDUE"] },
                  dueDate: {
                    $ne: null,
                    $lt: now,
                    $gte: prevStart,
                    $lte: prevEnd,
                  },
                },
              },
              {
                $lookup: {
                  from: "creditnotes",
                  localField: "_id",
                  foreignField: "originalInvoice",
                  as: "_creditNotes",
                },
              },
              { $match: { _creditNotes: { $size: 0 } } },
              { $group: { _id: null, unpaidTTC: { $sum: "$finalTotalTTC" } } },
            ]),
            // Taux de recouvrement N-1 : montant impayé échu (importées)
            ImportedInvoice.aggregate([
              {
                $match: {
                  workspaceId: wId,
                  status: "VALIDATED",
                  dueDate: {
                    $ne: null,
                    $lt: now,
                    $gte: prevStart,
                    $lte: prevEnd,
                  },
                },
              },
              { $group: { _id: null, unpaidTTC: { $sum: "$totalTTC" } } },
            ]),
            // Dépenses N-1 : factures d'achat PAYÉES (mêmes règles que la
            // période courante — par paymentDate, fallback issueDate).
            PurchaseInvoice.aggregate([
              { $match: { workspaceId: wId, status: "PAID" } },
              {
                $addFields: {
                  _effectiveDate: { $ifNull: ["$paymentDate", "$issueDate"] },
                },
              },
              { $match: { _effectiveDate: prevDateQuery } },
              {
                $group: {
                  _id: null,
                  amountTTC: { $sum: { $ifNull: ["$amountTTC", 0] } },
                  amountTVA: { $sum: { $ifNull: ["$amountTVA", 0] } },
                },
              },
            ]),
            // Factures importées émises N-1 (VALIDATED/COMPLETED, par
            // invoiceDate) — pour « Factures émises » et « Panier moyen » N-1.
            ImportedInvoice.aggregate([
              {
                $match: {
                  workspaceId: wId,
                  status: { $in: ["VALIDATED", "COMPLETED"] },
                },
              },
              {
                $addFields: {
                  _effectiveDate: { $ifNull: ["$invoiceDate", "$createdAt"] },
                },
              },
              { $match: { _effectiveDate: prevDateQuery } },
              {
                $group: {
                  _id: null,
                  invoicedTTC: { $sum: "$totalTTC" },
                  invoicedHT: {
                    $sum: {
                      $cond: [
                        { $gt: ["$totalHT", 0] },
                        "$totalHT",
                        "$totalTTC",
                      ],
                    },
                  },
                  invoicedCount: { $sum: 1 },
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
          const prevCnResult = prevCn[0] || {};
          const prevCnTotals = (prevCnResult.totals || [])[0] || { totalHT: 0 };
          const prevCnCashTotals = (prevCnResult.cashTotals || [])[0] || {
            totalHT: 0,
          };
          const prevPiTotals = prevPurchaseInv[0] || {
            amountTTC: 0,
            amountTVA: 0,
          };
          const prevQuoteTotals = prevQuote[0] || { total: 0, completed: 0 };
          const prevReceivables = prevInvResult.receivables[0] || {
            outstandingReceivables: 0,
          };
          const prevOverdue = prevInvResult.overdue[0] || {
            amount: 0,
            count: 0,
          };

          const prevTotalRevenueHT = prevInvTotals.totalRevenueHT;
          const prevCreditNoteTotalHT = prevCnTotals.totalHT;
          const prevImpInvoicedTotals = prevImpInvoiced[0] || {
            invoicedHT: 0,
            invoicedTTC: 0,
            invoicedCount: 0,
          };
          // CA net N-1 sur la même base que la période courante : factures
          // ENCAISSÉES (paymentDate) + avoirs « cash » — et non le CA facturé.
          const prevNetRevenueHT =
            (prevInvCollected[0]?.collectedHT || 0) +
            (prevImpCollected[0]?.collectedHT || 0) +
            (prevCnCashTotals.totalHT || 0);
          // Dépenses N-1 = transactions sortantes payées + factures d'achat
          // payées (comme la période courante).
          const prevTotalExpensesTTC =
            prevExpTotals.totalExpensesTTC + (prevPiTotals.amountTTC || 0);
          const prevTotalExpensesVAT =
            prevExpTotals.totalExpensesVAT + (prevPiTotals.amountTVA || 0);
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

          // Taux de recouvrement N-1 = montant encaissé / montant impayé × 100
          // (même formule que la période courante : encaissé et impayés échus
          // sans avoir, factures Newbi + importées).
          const prevCollectedTTC =
            (prevInvCollected[0]?.collectedTTC || 0) +
            (prevImpCollected[0]?.collectedTTC || 0);
          const prevUnpaidTTC =
            (prevInvUnpaid[0]?.unpaidTTC || 0) +
            (prevImpUnpaid[0]?.unpaidTTC || 0);
          const prevCollectionRate =
            prevUnpaidTTC > 0
              ? Math.round((prevCollectedTTC / prevUnpaidTTC) * 10000) / 100
              : 0;
          // DSO N-1 : même définition que la période courante — moyenne
          // pondérée des jours entre émission et paiement des factures payées
          // sur N-1 (Newbi + importées).
          const prevDsoSumDays =
            (prevInvCollected[0]?.sumDaysToPay || 0) +
            (prevImpCollected[0]?.sumDaysToPay || 0);
          const prevDsoCount =
            (prevInvCollected[0]?.daysToPayCount || 0) +
            (prevImpCollected[0]?.daysToPayCount || 0);
          const prevDso =
            prevDsoCount > 0
              ? Math.round((prevDsoSumDays / prevDsoCount) * 100) / 100
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
            // Factures émises et panier moyen N-1 : Newbi + importées,
            // comme la période courante.
            invoiceCount:
              (prevInvTotals.invoiceCount || 0) +
              (prevImpInvoicedTotals.invoicedCount || 0),
            averageInvoiceHT:
              (prevInvTotals.invoiceCount || 0) +
                (prevImpInvoicedTotals.invoicedCount || 0) >
              0
                ? Math.round(
                    ((prevTotalRevenueHT +
                      (prevImpInvoicedTotals.invoicedHT || 0)) /
                      ((prevInvTotals.invoiceCount || 0) +
                        (prevImpInvoicedTotals.invoicedCount || 0))) *
                      100,
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

        // ── Dépenses par catégorie : transactions sortantes payées
        // (expenseCategory) + factures d'achat payées (category), fusionnées
        // pour rester cohérent avec le total « Dépenses HT ».
        const expenseCategoryMap = new Map();
        const addExpenseCategory = (category, amount, count) => {
          const key = category || "OTHER";
          const entry = expenseCategoryMap.get(key) || { amount: 0, count: 0 };
          entry.amount += amount || 0;
          entry.count += count || 0;
          expenseCategoryMap.set(key, entry);
        };
        for (const c of expResult.byCategory || []) {
          addExpenseCategory(c._id, c.amount, c.count);
        }
        for (const c of piFacet.byCategory || []) {
          addExpenseCategory(c._id, c.amount, c.count);
        }
        const expenseByCategory = [...expenseCategoryMap.entries()]
          .map(([category, e]) => ({
            category,
            amount: Math.round(e.amount * 100) / 100,
            count: e.count,
          }))
          .sort((a, b) => b.amount - a.amount);

        const expenseCategoryMonthlyMap = new Map();
        const addExpenseCategoryMonthly = (category, month, amount, count) => {
          if (!month) return;
          const cat = category || "OTHER";
          const key = `${cat}::${month}`;
          const entry = expenseCategoryMonthlyMap.get(key) || {
            category: cat,
            month,
            amount: 0,
            count: 0,
          };
          entry.amount += amount || 0;
          entry.count += count || 0;
          expenseCategoryMonthlyMap.set(key, entry);
        };
        for (const e of expResult.byCategoryMonthly || []) {
          addExpenseCategoryMonthly(e.category, e.month, e.amount, e.count);
        }
        for (const e of piFacet.byCategoryMonthly || []) {
          addExpenseCategoryMonthly(e.category, e.month, e.amount, e.count);
        }
        const expenseByCategoryMonthly = [...expenseCategoryMonthlyMap.values()]
          .map((e) => ({
            category: e.category,
            month: e.month,
            amount: Math.round(e.amount * 100) / 100,
            count: e.count,
          }))
          .sort((a, b) =>
            a.month === b.month
              ? a.category.localeCompare(b.category)
              : a.month.localeCompare(b.month),
          );

        // ==============================
        // BUILD KPI
        // ==============================

        // Factures émises et panier moyen : factures créées sur Newbi
        // (collection Invoice, hors brouillons) + factures importées
        // (VALIDATED/COMPLETED), sur la base du CA facturé (date d'émission).
        const issuedInvoiceCount =
          (invTotals.invoiceCount || 0) +
          (importedInvoicedTotals.invoicedCount || 0);
        const issuedRevenueHT =
          totalRevenueHT + (importedInvoicedTotals.invoicedHT || 0);

        const kpi = {
          totalRevenueHT,
          totalRevenueTTC,
          // Backward compat: totalExpenses = TTC, netResult = HT - TTC (old behavior)
          totalExpenses: totalExpensesTTC,
          netResult:
            Math.round((totalRevenueHT - totalExpensesTTC) * 100) / 100,
          invoiceCount: issuedInvoiceCount,
          expenseCount: expTotals.expenseCount,
          averageInvoiceHT:
            issuedInvoiceCount > 0
              ? Math.round((issuedRevenueHT / issuedInvoiceCount) * 100) / 100
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
          expenseByCategory,
          revenueByClientMonthly,
          expenseByCategoryMonthly,
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
