import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import Transaction from "../models/Transaction.js";
import AccountBanking from "../models/AccountBanking.js";
import { aggregateByCategory } from "../utils/bank-categories.js";

/**
 * Résout les dates de début/fin à partir d'un preset ou de dates custom
 */
function resolvePeriodDates(period) {
  const now = new Date();

  if (period.startDate && period.endDate && !period.preset) {
    return {
      startDate: new Date(period.startDate),
      endDate: new Date(period.endDate),
    };
  }

  const preset = period.preset || "cumul-year";

  switch (preset) {
    case "cumul-month":
      return {
        startDate: new Date(now.getFullYear(), now.getMonth(), 1),
        endDate: now,
      };
    case "cumul-quarter": {
      const qm = Math.floor(now.getMonth() / 3) * 3;
      return { startDate: new Date(now.getFullYear(), qm, 1), endDate: now };
    }
    case "cumul-year":
      return { startDate: new Date(now.getFullYear(), 0, 1), endDate: now };
    case "30d":
    case "90d":
    case "365d":
    case "730d": {
      const days = parseInt(preset);
      const s = new Date(now);
      s.setDate(s.getDate() - days);
      return { startDate: s, endDate: now };
    }
    default:
      return { startDate: new Date(now.getFullYear(), 0, 1), endDate: now };
  }
}

/**
 * Récupère le solde total des comptes bancaires (avec filtre optionnel)
 */
async function getAccountsBalance(workspaceId, accountId) {
  const filter = { workspaceId };
  if (accountId) {
    filter.$or = [{ _id: accountId }, { externalId: accountId }];
  }

  const accounts = await AccountBanking.find(filter).lean();
  const balance = accounts.reduce((sum, acc) => {
    const bal =
      typeof acc.balance === "number"
        ? acc.balance
        : (acc.balance?.current ?? 0);
    return sum + bal;
  }, 0);

  return { accounts, balance };
}

const dashboardAggregationResolvers = {
  Query: {
    /**
     * Stats résumées pour les cartes du dashboard
     */
    dashboardSummary: withWorkspace(
      async (parent, { workspaceId, accountId }) => {
        const matchFilter = { workspaceId };
        if (accountId) matchFilter.fromAccount = accountId;

        const [transactionStats, { balance }] = await Promise.all([
          Transaction.aggregate([
            { $match: matchFilter },
            {
              $group: {
                _id: null,
                totalIncome: {
                  $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] },
                },
                totalExpenses: {
                  $sum: {
                    $cond: [{ $lt: ["$amount", 0] }, { $abs: "$amount" }, 0],
                  },
                },
                count: { $sum: 1 },
              },
            },
          ]),
          getAccountsBalance(workspaceId, accountId),
        ]);

        const stats = transactionStats[0] || {
          totalIncome: 0,
          totalExpenses: 0,
          count: 0,
        };

        return {
          totalIncome: Math.round(stats.totalIncome * 100) / 100,
          totalExpenses: Math.round(stats.totalExpenses * 100) / 100,
          bankBalance: Math.round(balance * 100) / 100,
          transactionCount: stats.count,
        };
      },
    ),

    /**
     * Données pour le graphique de trésorerie (un point par jour)
     */
    dashboardTreasuryChart: withWorkspace(
      async (parent, { workspaceId, period, accountId }) => {
        const { startDate, endDate } = resolvePeriodDates(period);

        const matchFilter = {
          workspaceId,
          date: { $gte: startDate, $lte: endDate },
        };
        if (accountId) matchFilter.fromAccount = accountId;

        const [dailyData, { balance: currentBalance }] = await Promise.all([
          Transaction.aggregate([
            { $match: matchFilter },
            {
              $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
                income: {
                  $sum: { $cond: [{ $gt: ["$amount", 0] }, "$amount", 0] },
                },
                expenses: {
                  $sum: {
                    $cond: [{ $lt: ["$amount", 0] }, { $abs: "$amount" }, 0],
                  },
                },
              },
            },
            { $sort: { _id: 1 } },
          ]),
          getAccountsBalance(workspaceId, accountId),
        ]);

        // Map des données par jour
        const dayMap = new Map();
        for (const d of dailyData) {
          dayMap.set(d._id, { income: d.income, expenses: d.expenses });
        }

        // Construire le tableau jour par jour en remplissant les trous
        const daysDiff = Math.ceil(
          (endDate - startDate) / (1000 * 60 * 60 * 24),
        );
        const dataPoints = [];
        for (let i = 0; i <= daysDiff; i++) {
          const d = new Date(startDate);
          d.setDate(d.getDate() + i);
          const dateStr = d.toISOString().split("T")[0];
          const dayData = dayMap.get(dateStr) || { income: 0, expenses: 0 };
          dataPoints.push({
            date: dateStr,
            income: dayData.income,
            expenses: dayData.expenses,
            netMovement: dayData.income - dayData.expenses,
            treasury: 0,
          });
        }

        // Calcul cumulatif du solde de trésorerie (backward depuis balance actuelle)
        let treasury = currentBalance;
        for (let i = dataPoints.length - 1; i >= 0; i--) {
          dataPoints[i].treasury = Math.round(treasury * 100) / 100;
          treasury -= dataPoints[i].netMovement;
        }

        const totalIncome = dataPoints.reduce((s, d) => s + d.income, 0);
        const totalExpenses = dataPoints.reduce((s, d) => s + d.expenses, 0);

        return {
          dataPoints: dataPoints.map(
            ({ date, income, expenses, treasury }) => ({
              date,
              income: Math.round(income * 100) / 100,
              expenses: Math.round(expenses * 100) / 100,
              treasury,
            }),
          ),
          startBalance: dataPoints[0]?.treasury ?? currentBalance,
          endBalance: Math.round(currentBalance * 100) / 100,
          totalIncome: Math.round(totalIncome * 100) / 100,
          totalExpenses: Math.round(totalExpenses * 100) / 100,
        };
      },
    ),

    /**
     * Agrégation par catégorie pour les pie charts (income ou expense)
     */
    dashboardCategoryAggregation: withWorkspace(
      async (parent, { workspaceId, type, period, accountId }) => {
        const { startDate, endDate } = resolvePeriodDates(period);
        const isIncome = type === "income";

        const matchFilter = {
          workspaceId,
          date: { $gte: startDate, $lte: endDate },
          amount: isIncome ? { $gt: 0 } : { $lt: 0 },
        };
        if (accountId) matchFilter.fromAccount = accountId;

        // Ne récupérer que les champs nécessaires à la catégorisation
        const transactions = await Transaction.find(matchFilter)
          .select("amount description metadata")
          .lean();

        const categories = aggregateByCategory(transactions, isIncome);
        const total = categories.reduce((s, c) => s + c.amount, 0);

        return {
          categories: categories.map((c) => ({
            name: c.name,
            amount: Math.round(c.amount * 100) / 100,
            count: c.count,
            color: c.color,
          })),
          total: Math.round(total * 100) / 100,
          transactionCount: transactions.length,
        };
      },
    ),
  },
};

export default dashboardAggregationResolvers;
