import mongoose from "mongoose";
import AccountBanking from "../../models/AccountBanking.js";
import Invoice from "../../models/Invoice.js";
import PurchaseInvoice from "../../models/PurchaseInvoice.js";
import { addDays, parisDay } from "../../utils/invoiceRecurrenceSchedule.js";
import { getCalendarLinkedItems } from "./linkedItemsService.js";

/**
 * Trésorerie au jour le jour du calendrier : solde actuel des comptes
 * bancaires, puis solde prévu en fin de chaque journée en ajoutant les
 * échéances non réglées (factures de vente à encaisser, factures d'achat à
 * payer) et les prévisions (récurrences détectées, saisies manuelles).
 *
 * Les échéances déjà en retard ne sont pas projetées (on ne sait pas quand
 * elles seront réglées) : leurs totaux sont rendus à part. Montants en
 * euros seulement. Réservé à qui voit la page Prévision ou Analytiques,
 * comme treasuryForecastData.
 */
const TREASURY_KINDS = ["INVOICE", "PURCHASE_INVOICE", "FORECAST"];

const round2 = (value) => Math.round(value * 100) / 100;

export function canSeeTreasury(permissions) {
  return ["forecast", "analytics"].some((moduleKey) =>
    permissions?.hasPermission?.(moduleKey, "view"),
  );
}

// Même lecture du solde que la page Prévision
function accountBalance(account) {
  return typeof account.balance === "number"
    ? account.balance
    : (account.balance?.current ?? account.balance?.available ?? 0);
}

function isIncome(item) {
  return (
    item.kind === "INVOICE" ||
    (item.kind === "FORECAST" && item.flowType === "INCOME")
  );
}

const isEuro = (item) => !item.currency || item.currency === "EUR";

async function overdueTotals({ workspaceId, today, permissions }) {
  // Minuit à Paris tombe la veille entre 22 h et 23 h UTC
  const startOfToday = new Date(`${addDays(today, -1)}T22:00:00.000Z`);
  const [income, expense] = await Promise.all([
    permissions?.hasPermission?.("invoices", "view")
      ? Invoice.aggregate([
          {
            $match: {
              workspaceId,
              status: { $in: ["PENDING", "OVERDUE"] },
              dueDate: { $lt: startOfToday },
            },
          },
          { $group: { _id: null, total: { $sum: "$finalTotalTTC" } } },
        ])
      : [],
    permissions?.hasPermission?.("purchaseInvoices", "view")
      ? PurchaseInvoice.aggregate([
          {
            $match: {
              workspaceId,
              status: { $nin: ["PAID", "ARCHIVED"] },
              dueDate: { $lt: startOfToday },
              currency: { $in: ["EUR", null] },
            },
          },
          { $group: { _id: null, total: { $sum: "$amountTTC" } } },
        ])
      : [],
  ]);
  return {
    overdueIncome: round2(income[0]?.total || 0),
    overdueExpense: round2(expense[0]?.total || 0),
  };
}

export async function getCalendarTreasury({
  workspaceId,
  userId,
  permissions,
  db,
  from,
  to,
  now = new Date(),
}) {
  if (!canSeeTreasury(permissions)) return null;

  const today = parisDay(now);
  const wId = new mongoose.Types.ObjectId(String(workspaceId));
  const accounts = await AccountBanking.find(
    { workspaceId: wId, status: "active" },
    { balance: 1 },
  ).lean();
  const currentBalance = accounts.reduce(
    (sum, account) => sum + accountBalance(account),
    0,
  );

  // Les jours passés ne se prévoient pas
  const start = from > today ? from : today;
  const flows = new Map();
  let sources = [];
  if (start <= to) {
    const result = await getCalendarLinkedItems({
      workspaceId,
      userId,
      permissions,
      db,
      from: start,
      to,
      now,
      onlyKinds: TREASURY_KINDS,
    });
    sources = result.kinds;
    for (const item of result.items) {
      // Réglé, passé ou en retard : hors projection
      if (item.state !== "UPCOMING") continue;
      if (!Number.isFinite(item.amount) || !isEuro(item)) continue;
      const flow = flows.get(item.day) || { income: 0, expense: 0 };
      if (isIncome(item)) flow.income += item.amount;
      else flow.expense += item.amount;
      flows.set(item.day, flow);
    }
  }

  const days = [];
  let running = currentBalance;
  for (let day = start; day <= to; day = addDays(day, 1)) {
    const flow = flows.get(day) || { income: 0, expense: 0 };
    running += flow.income - flow.expense;
    days.push({
      day,
      income: round2(flow.income),
      expense: round2(flow.expense),
      balance: round2(running),
    });
  }
  const lowest = days.reduce(
    (min, day) => (!min || day.balance < min.balance ? day : min),
    null,
  );

  return {
    today,
    currentBalance: round2(currentBalance),
    hasBankAccounts: accounts.length > 0,
    days,
    lowest,
    sources,
    ...(await overdueTotals({ workspaceId: wId, today, permissions })),
  };
}
