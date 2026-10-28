import Invoice from "../../models/Invoice.js";
import InvoiceReminderSettings from "../../models/InvoiceReminderSettings.js";
import InvoiceReminderLog from "../../models/InvoiceReminderLog.js";
import { addDays, parisDay } from "../../utils/invoiceRecurrenceSchedule.js";
import {
  CLIENT_NAME_PROJECTION,
  MAX_ITEMS_PER_KIND,
  clientName,
  dateBounds,
  documentNumber,
  inRange,
} from "./linkedItemsCommon.js";

/**
 * Relances automatiques des factures impayées : celles déjà parties (ou en
 * échec), relues dans leur journal, et celles à venir, calculées comme le
 * cron (invoiceReminderService) : 1re relance n jours après l'échéance,
 * 2e relance m jours après, une seule par facture et par passage, clients
 * exclus ignorés, à l'heure réglée.
 */
const STEP = { FIRST: 1, SECOND: 2 };

const maxDay = (a, b) => (a > b ? a : b);

function parisHour(now) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      hourCycle: "h23",
    }).format(now),
  );
}

function reminderItem({ id, invoice, step, day, state, reminderStatus }) {
  const reference = documentNumber(invoice);
  const counterparty = clientName(invoice.client);
  return {
    id,
    kind: "REMINDER",
    entityId: invoice._id.toString(),
    day,
    title: counterparty || reference || "Relance",
    reference,
    counterparty,
    amount: invoice.finalTotalTTC ?? null,
    currency: "EUR",
    state,
    documentStatus: reminderStatus,
    reminderStep: step,
    reminderStatus,
  };
}

const INVOICE_PROJECTION = {
  prefix: 1,
  number: 1,
  finalTotalTTC: 1,
  dueDate: 1,
  "client.email": 1,
  ...CLIENT_NAME_PROJECTION,
};

export async function reminderItems({
  workspaceId,
  from,
  to,
  today,
  now = new Date(),
}) {
  const [settings, logs] = await Promise.all([
    InvoiceReminderSettings.findOne({ workspaceId }).lean(),
    InvoiceReminderLog.find({ workspaceId, sentAt: dateBounds(from, to) })
      .sort({ sentAt: 1 })
      .limit(MAX_ITEMS_PER_KIND + 1)
      .lean(),
  ]);

  const items = [];
  let truncated = logs.length > MAX_ITEMS_PER_KIND;

  // 1. Relances parties ou en échec, même si le réglage a été coupé depuis
  const loggedIds = [...new Set(logs.map((log) => log.invoiceId.toString()))];
  const loggedInvoices = loggedIds.length
    ? await Invoice.find(
        { _id: { $in: loggedIds }, workspaceId },
        INVOICE_PROJECTION,
      ).lean()
    : [];
  const invoicesById = new Map(
    loggedInvoices.map((invoice) => [invoice._id.toString(), invoice]),
  );
  for (const log of logs.slice(0, MAX_ITEMS_PER_KIND)) {
    const day = inRange(log.sentAt, from, to);
    const invoice = invoicesById.get(log.invoiceId.toString());
    // Facture supprimée depuis : rien à ouvrir
    if (!day || !invoice) continue;
    const failed = log.status === "FAILED";
    items.push(
      reminderItem({
        id: `REMINDER:log:${log._id}`,
        invoice,
        step: STEP[log.reminderType] || 1,
        day,
        state: failed ? "OVERDUE" : "DONE",
        reminderStatus: failed ? "FAILED" : "SENT",
      }),
    );
  }

  // 2. Relances à venir, seulement si les relances sont activées
  if (!settings?.enabled) return { items, truncated };

  const firstDays = settings.firstReminderDays ?? 7;
  const secondDays = settings.secondReminderDays ?? 14;
  // Une relance due et pas encore partie part au prochain passage du cron
  const nextRunDay =
    parisHour(now) <= (settings.reminderHour ?? 9) ? today : addDays(today, 1);

  const query = {
    workspaceId,
    status: { $in: ["PENDING", "OVERDUE"] },
    // Échéances dont une relance peut tomber au plus tard le dernier jour
    dueDate: {
      $lte: new Date(
        `${addDays(to, 1 - Math.min(firstDays, secondDays))}T00:00:00.000Z`,
      ),
    },
  };
  if (settings.excludedClientIds?.length) {
    query["client.id"] = { $nin: settings.excludedClientIds.map(String) };
  }
  const invoices = await Invoice.find(query, INVOICE_PROJECTION)
    .sort({ dueDate: -1 })
    .limit(MAX_ITEMS_PER_KIND * 2)
    .lean();
  if (invoices.length === 0) return { items, truncated };

  const sentLogs = await InvoiceReminderLog.find(
    { invoiceId: { $in: invoices.map((invoice) => invoice._id) } },
    { invoiceId: 1, reminderType: 1 },
  ).lean();
  const sent = new Set(
    sentLogs.map((log) => `${log.invoiceId}_${log.reminderType}`),
  );

  const planned = [];
  for (const invoice of invoices) {
    const dueDay = parisDay(new Date(invoice.dueDate));
    const reminderStatus = invoice.client?.email ? "PLANNED" : "NO_EMAIL";
    let firstDay = null;
    if (!sent.has(`${invoice._id}_FIRST`)) {
      firstDay = maxDay(addDays(dueDay, firstDays), nextRunDay);
      planned.push({ invoice, step: 1, day: firstDay, reminderStatus });
    }
    if (!sent.has(`${invoice._id}_SECOND`)) {
      let secondDay = maxDay(addDays(dueDay, secondDays), nextRunDay);
      // Le cron n'envoie qu'une relance par facture et par passage : la
      // 2e attend le lendemain de la 1re quand elles tombent ensemble
      if (firstDay && firstDays <= secondDays && secondDay <= firstDay) {
        secondDay = addDays(firstDay, 1);
      }
      planned.push({ invoice, step: 2, day: secondDay, reminderStatus });
    }
  }

  for (const reminder of planned) {
    if (reminder.day < from || reminder.day > to) continue;
    if (items.length >= MAX_ITEMS_PER_KIND) {
      truncated = true;
      break;
    }
    items.push(
      reminderItem({
        id: `REMINDER:${reminder.invoice._id}:${reminder.step}`,
        invoice: reminder.invoice,
        step: reminder.step,
        day: reminder.day,
        state: "UPCOMING",
        reminderStatus: reminder.reminderStatus,
      }),
    );
  }
  return { items, truncated };
}
