import mongoose from "mongoose";
import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import Transaction from "../models/Transaction.js";
import AccountBanking from "../models/AccountBanking.js";
import Invoice from "../models/Invoice.js";
import { aggregateByCategory } from "../utils/bank-categories.js";

/**
 * Fin de journée (UTC) du jour calendaire courant en France.
 * Les transactions saisies manuellement sont datées à minuit UTC du jour
 * choisi : avec `endDate = now`, une saisie datée d'aujourd'hui restait
 * invisible tant que minuit UTC n'était pas passé (ex. avant 2h du matin
 * heure de Paris). On borne donc la période à la fin du jour courant,
 * sans inclure les transactions datées dans le futur.
 */
function endOfCurrentDay(now) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
  }).format(now);
  return new Date(`${ymd}T23:59:59.999Z`);
}

/**
 * Résout les dates de début/fin à partir d'un preset ou de dates custom
 */
function resolvePeriodDates(period) {
  const now = new Date();

  if (period.startDate && period.endDate && !period.preset) {
    // Date du picker (YYYY-MM-DD) parsée à minuit UTC → étendre à la fin
    // de journée pour que la borne de fin soit inclusive.
    const endDate = new Date(period.endDate);
    endDate.setUTCHours(23, 59, 59, 999);
    return {
      startDate: new Date(period.startDate),
      endDate,
    };
  }

  const endDate = endOfCurrentDay(now);
  const preset = period.preset || "cumul-year";

  switch (preset) {
    case "cumul-month":
      return {
        startDate: new Date(now.getFullYear(), now.getMonth(), 1),
        endDate,
      };
    case "cumul-quarter": {
      const qm = Math.floor(now.getMonth() / 3) * 3;
      return { startDate: new Date(now.getFullYear(), qm, 1), endDate };
    }
    case "cumul-year":
      return { startDate: new Date(now.getFullYear(), 0, 1), endDate };
    case "30d":
    case "90d":
    case "365d":
    case "730d": {
      const days = parseInt(preset);
      const s = new Date(now);
      s.setDate(s.getDate() - days);
      return { startDate: s, endDate };
    }
    default:
      return { startDate: new Date(now.getFullYear(), 0, 1), endDate };
  }
}

/**
 * Borne [début, fin] de l'exercice comptable EN COURS d'une organisation.
 *
 * Lit `fiscalYearStartDate` / `fiscalYearEndDate` (format "YYYY-MM-DD") de
 * l'organisation. Si aucune date n'est configurée, l'exercice par défaut est
 * l'année civile (1er janvier → 31 décembre).
 *
 * Pour respecter « exercice en cours », l'ancre (jour/mois de la date de début)
 * est reportée d'année en année jusqu'à la fenêtre annuelle qui contient `now`.
 * Exception : si la période littérale configurée contient déjà `now`, on
 * l'utilise telle quelle (gère un premier exercice atypique, ex. exercice long).
 *
 * La borne de fin est plafonnée à la fin du jour courant (heure de Paris) pour
 * exclure les transactions datées dans le futur, comme resolvePeriodDates.
 */
function getCurrentFiscalYearRange(org, now = new Date()) {
  const startStr = org?.fiscalYearStartDate;
  const endStr = org?.fiscalYearEndDate;
  const todayEnd = endOfCurrentDay(now);
  const cap = (endDate) => (endDate < todayEnd ? endDate : todayEnd);

  // Aucun exercice configuré → année civile en cours
  if (!startStr) {
    const y = now.getUTCFullYear();
    return {
      startDate: new Date(`${y}-01-01T00:00:00.000Z`),
      endDate: cap(new Date(`${y}-12-31T23:59:59.999Z`)),
    };
  }

  const litStart = new Date(`${startStr}T00:00:00.000Z`);

  // Période littérale configurée contenant aujourd'hui (exercice atypique)
  if (endStr) {
    const litEnd = new Date(`${endStr}T23:59:59.999Z`);
    if (now >= litStart && now <= litEnd) {
      return { startDate: litStart, endDate: cap(litEnd) };
    }
  }

  // Sinon : report de l'ancre (mois/jour) sur la fenêtre annuelle contenant aujourd'hui
  const month = litStart.getUTCMonth();
  const day = litStart.getUTCDate();
  let startDate = new Date(
    Date.UTC(now.getUTCFullYear(), month, day, 0, 0, 0, 0),
  );
  if (startDate > now) {
    startDate = new Date(
      Date.UTC(now.getUTCFullYear() - 1, month, day, 0, 0, 0, 0),
    );
  }
  const endDate = new Date(startDate);
  endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);
  endDate.setUTCMilliseconds(endDate.getUTCMilliseconds() - 1);
  return { startDate, endDate: cap(endDate) };
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
        const matchFilter = { workspaceId, deletedAt: null };
        if (accountId) matchFilter.fromAccount = accountId;

        // Encaissements / décaissements bornés à l'exercice comptable en cours
        // (défaut : année civile). Le solde et le nombre de transactions restent
        // calculés sur l'ensemble pour ne pas altérer leur sémantique.
        let org = null;
        try {
          org = await mongoose.connection.db
            .collection("organization")
            .findOne(
              { _id: new mongoose.Types.ObjectId(workspaceId) },
              { projection: { fiscalYearStartDate: 1, fiscalYearEndDate: 1 } },
            );
        } catch {
          org = null;
        }
        const { startDate, endDate } = getCurrentFiscalYearRange(org);
        const inFiscalYear = [
          { $gte: ["$date", startDate] },
          { $lte: ["$date", endDate] },
        ];

        const [transactionStats, { balance }] = await Promise.all([
          Transaction.aggregate([
            { $match: matchFilter },
            {
              $group: {
                _id: null,
                totalIncome: {
                  $sum: {
                    $cond: [
                      { $and: [{ $gt: ["$amount", 0] }, ...inFiscalYear] },
                      "$amount",
                      0,
                    ],
                  },
                },
                totalExpenses: {
                  $sum: {
                    $cond: [
                      { $and: [{ $lt: ["$amount", 0] }, ...inFiscalYear] },
                      { $abs: "$amount" },
                      0,
                    ],
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
          deletedAt: null,
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
          deletedAt: null,
          date: { $gte: startDate, $lte: endDate },
          amount: isIncome ? { $gt: 0 } : { $lt: 0 },
        };
        if (accountId) matchFilter.fromAccount = accountId;

        // Entrées : la tranche "Chiffre d'affaires" est dérivée des factures
        // émises (cf. plus bas), pas des transactions bancaires. On exclut donc
        // les transactions déjà rattachées à une facture pour éviter de
        // compter deux fois les factures payées et rapprochées.
        if (isIncome) matchFilter.linkedInvoiceId = null;

        // T4/T5 : on a besoin de linkedInvoiceId, category, expenseCategory
        // pour respecter les catégorisations manuelles + reclasser les
        // paiements de factures clients en "Chiffre d'affaires".
        const transactions = await Transaction.find(matchFilter)
          .select(
            "amount description metadata linkedInvoiceId category expenseCategory",
          )
          .lean();

        const categories = aggregateByCategory(transactions, isIncome);

        // Entrées : on injecte le chiffre d'affaires issu des factures émises.
        // "Factures clients" et "factures clients importées" vivent toutes deux
        // dans la collection Invoice (les importées ont un préfixe vide). Base
        // retenue : TOUTES les factures émises (hors brouillon/annulée) sur la
        // période, par date d'émission, en TTC. Non filtré par compte bancaire
        // (une facture n'est pas rattachée à un compte) : on n'injecte donc le
        // CA que lorsqu'aucun compte précis n'est sélectionné.
        if (isIncome && !accountId) {
          const [invAgg] = await Invoice.aggregate([
            {
              $match: {
                workspaceId: new mongoose.Types.ObjectId(workspaceId),
                status: { $in: ["PENDING", "OVERDUE", "COMPLETED"] },
                issueDate: { $gte: startDate, $lte: endDate },
              },
            },
            {
              $group: {
                _id: null,
                totalTTC: {
                  $sum: {
                    $ifNull: ["$finalTotalTTC", { $ifNull: ["$totalTTC", 0] }],
                  },
                },
                count: { $sum: 1 },
              },
            },
          ]);

          const revenueTTC = invAgg?.totalTTC || 0;
          const invoiceCount = invAgg?.count || 0;

          if (revenueTTC > 0) {
            const CA_NAME = "Chiffre d'affaires";
            const existing = categories.find((c) => c.name === CA_NAME);
            if (existing) {
              existing.amount += revenueTTC;
              existing.count += invoiceCount;
            } else {
              categories.push({
                name: CA_NAME,
                amount: revenueTTC,
                count: invoiceCount,
                color: "#5b50ff",
              });
            }
            // Re-trier par montant décroissant après injection du CA.
            categories.sort((a, b) => b.amount - a.amount);
          }
        }

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
