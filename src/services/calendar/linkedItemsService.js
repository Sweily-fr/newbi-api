import mongoose from "mongoose";
import Invoice from "../../models/Invoice.js";
import Quote from "../../models/Quote.js";
import PurchaseInvoice from "../../models/PurchaseInvoice.js";
import InvoiceRecurrence from "../../models/InvoiceRecurrence.js";
import { Board, Column, Task } from "../../models/kanban.js";
import {
  addDays,
  isDayString,
  nextOccurrenceFrom,
  parisDay,
} from "../../utils/invoiceRecurrenceSchedule.js";
import {
  buildAssignedMemberInfo,
  loadAssignedUsers,
} from "../../utils/assignedMemberInfo.js";
import {
  FISCAL_ORGANIZATION_FIELDS,
  computeFiscalDeadlines,
} from "./fiscalDeadlines.js";

/**
 * Éléments des autres pages affichés dans le calendrier : échéances des
 * factures de vente et d'achat, fin de validité des devis en attente,
 * échéances des tâches et prochaines factures récurrentes.
 *
 * Rien n'est copié dans la collection des événements : tout est relu dans
 * les documents à chaque affichage, le statut montré est donc toujours le
 * leur (une facture payée apparaît payée, un devis signé disparaît).
 *
 * Les jours sont des jours calendaires « AAAA-MM-JJ » à l'heure de Paris,
 * comme les factures récurrentes : le front les place sans conversion de
 * fuseau, une échéance ne glisse jamais d'un jour.
 */

// Source → page dont le droit « Voir » est exigé
export const LINKED_KIND_MODULES = {
  INVOICE: "invoices",
  PURCHASE_INVOICE: "purchaseInvoices",
  QUOTE: "quotes",
  TASK: "kanban",
  RECURRING_INVOICE: "invoices",
  // Échéances fiscales : calculées, sans document d'une autre page
  FISCAL: "calendar",
};

// Au-delà, la source est tronquée et le front le signale
export const MAX_ITEMS_PER_KIND = 300;
// La vue mois couvre au plus 42 jours, l'agenda 30
export const MAX_RANGE_DAYS = 100;
// Garde-fou des récurrences quotidiennes sur une longue période
const MAX_OCCURRENCES_PER_RECURRENCE = 100;

const OPEN_INVOICE_STATUSES = ["PENDING", "OVERDUE"];
const PURCHASE_HIDDEN_STATUSES = ["ARCHIVED"];

// Colonne qui vaut « terminé » (tableaux par défaut : « Terminées ») : une
// tâche qui s'y trouve n'est jamais signalée en retard
const DONE_COLUMN_PATTERN = /^(termin|fini|done|complet|clotur|clos|archiv)/;

export function isDoneColumnTitle(title) {
  const normalized = String(title || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
  return DONE_COLUMN_PATTERN.test(normalized);
}

const daySpan = (from, to) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86400000,
  );

/**
 * Vérifie la période demandée. Retourne un message d'erreur, ou null.
 */
export function validateRange(from, to) {
  if (!isDayString(from) || !isDayString(to)) {
    return "Les dates doivent être au format AAAA-MM-JJ.";
  }
  if (to < from) return "La date de fin précède la date de début.";
  if (daySpan(from, to) > MAX_RANGE_DAYS) {
    return `La période ne peut pas dépasser ${MAX_RANGE_DAYS} jours.`;
  }
  return null;
}

// Bornes UTC élargies d'un jour : un jour de Paris commence la veille à
// 22 h ou 23 h UTC. Le filtre exact se fait ensuite sur parisDay().
function dateBounds(from, to) {
  return {
    $gte: new Date(`${addDays(from, -1)}T00:00:00.000Z`),
    $lte: new Date(`${addDays(to, 1)}T00:00:00.000Z`),
  };
}

const stateFor = (day, today, done) =>
  done ? "DONE" : day < today ? "OVERDUE" : "UPCOMING";

const documentNumber = (doc) =>
  doc?.prefix && doc?.number ? `${doc.prefix}-${doc.number}` : null;

function clientName(client) {
  if (!client) return null;
  const name =
    client.name ||
    [client.firstName, client.lastName].filter(Boolean).join(" ");
  return name || null;
}

function inRange(date, from, to) {
  if (!date) return null;
  const day = parisDay(new Date(date));
  return day >= from && day <= to ? day : null;
}

async function invoiceItems({ workspaceId, from, to, today }) {
  const invoices = await Invoice.find(
    {
      workspaceId,
      status: { $in: [...OPEN_INVOICE_STATUSES, "COMPLETED"] },
      dueDate: dateBounds(from, to),
    },
    {
      prefix: 1,
      number: 1,
      status: 1,
      dueDate: 1,
      finalTotalTTC: 1,
      "client.name": 1,
      "client.firstName": 1,
      "client.lastName": 1,
    },
  )
    .sort({ dueDate: 1 })
    .limit(MAX_ITEMS_PER_KIND + 1)
    .lean();

  const items = [];
  for (const invoice of invoices.slice(0, MAX_ITEMS_PER_KIND)) {
    const day = inRange(invoice.dueDate, from, to);
    if (!day) continue;
    const reference = documentNumber(invoice);
    const counterparty = clientName(invoice.client);
    items.push({
      id: `INVOICE:${invoice._id}`,
      kind: "INVOICE",
      entityId: invoice._id.toString(),
      day,
      title: counterparty || reference || "Facture",
      reference,
      counterparty,
      amount: invoice.finalTotalTTC ?? null,
      currency: "EUR",
      state: stateFor(day, today, invoice.status === "COMPLETED"),
      documentStatus: invoice.status,
    });
  }
  return { items, truncated: invoices.length > MAX_ITEMS_PER_KIND };
}

async function purchaseInvoiceItems({ workspaceId, from, to, today }) {
  const invoices = await PurchaseInvoice.find(
    {
      workspaceId,
      status: { $nin: PURCHASE_HIDDEN_STATUSES },
      dueDate: dateBounds(from, to),
    },
    {
      supplierName: 1,
      invoiceNumber: 1,
      status: 1,
      dueDate: 1,
      amountTTC: 1,
      currency: 1,
    },
  )
    .sort({ dueDate: 1 })
    .limit(MAX_ITEMS_PER_KIND + 1)
    .lean();

  const items = [];
  for (const invoice of invoices.slice(0, MAX_ITEMS_PER_KIND)) {
    const day = inRange(invoice.dueDate, from, to);
    if (!day) continue;
    const counterparty = invoice.supplierName || null;
    items.push({
      id: `PURCHASE_INVOICE:${invoice._id}`,
      kind: "PURCHASE_INVOICE",
      entityId: invoice._id.toString(),
      day,
      title: counterparty || invoice.invoiceNumber || "Facture fournisseur",
      reference: invoice.invoiceNumber || null,
      counterparty,
      amount: invoice.amountTTC ?? null,
      currency: invoice.currency || "EUR",
      state: stateFor(day, today, invoice.status === "PAID"),
      documentStatus: invoice.status,
    });
  }
  return { items, truncated: invoices.length > MAX_ITEMS_PER_KIND };
}

// Devis en attente de réponse : leur fin de validité est la date à laquelle
// relancer le client. Signé ou refusé, le devis n'a plus rien à rappeler.
async function quoteItems({ workspaceId, from, to, today }) {
  const quotes = await Quote.find(
    {
      workspaceId,
      status: "PENDING",
      validUntil: dateBounds(from, to),
    },
    {
      prefix: 1,
      number: 1,
      status: 1,
      validUntil: 1,
      finalTotalTTC: 1,
      "client.name": 1,
      "client.firstName": 1,
      "client.lastName": 1,
    },
  )
    .sort({ validUntil: 1 })
    .limit(MAX_ITEMS_PER_KIND + 1)
    .lean();

  const items = [];
  for (const quote of quotes.slice(0, MAX_ITEMS_PER_KIND)) {
    const day = inRange(quote.validUntil, from, to);
    if (!day) continue;
    const reference = documentNumber(quote);
    const counterparty = clientName(quote.client);
    items.push({
      id: `QUOTE:${quote._id}`,
      kind: "QUOTE",
      entityId: quote._id.toString(),
      day,
      title: counterparty || reference || "Devis",
      reference,
      counterparty,
      amount: quote.finalTotalTTC ?? null,
      currency: "EUR",
      state: stateFor(day, today, false),
      documentStatus: quote.status,
    });
  }
  return { items, truncated: quotes.length > MAX_ITEMS_PER_KIND };
}

// Mêmes tableaux que la liste des projets : tous pour qui peut supprimer
// dans les projets, sinon ceux dont on est propriétaire ou membre, et ceux
// sans membres désignés (ouverts à tout l'espace)
async function visibleBoards({ workspaceId, userId, permissions }) {
  const filter = { workspaceId };
  if (!permissions?.canDelete?.("kanban")) {
    filter.$or = [
      { userId },
      { members: String(userId) },
      { members: { $exists: false } },
      { members: { $size: 0 } },
    ];
  }
  return Board.find(filter, { title: 1, emoji: 1, color: 1 }).lean();
}

async function taskItems({
  workspaceId,
  from,
  to,
  today,
  userId,
  permissions,
  db,
}) {
  const boards = await visibleBoards({ workspaceId, userId, permissions });
  if (boards.length === 0) return { items: [], truncated: false };
  const boardsById = new Map(boards.map((b) => [b._id.toString(), b]));

  const tasks = await Task.find(
    {
      workspaceId,
      boardId: { $in: boards.map((b) => b._id) },
      dueDate: dateBounds(from, to),
    },
    {
      title: 1,
      dueDate: 1,
      boardId: 1,
      columnId: 1,
      priority: 1,
      assignedMembers: 1,
    },
  )
    .sort({ dueDate: 1 })
    .limit(MAX_ITEMS_PER_KIND + 1)
    .lean();
  const kept = tasks.slice(0, MAX_ITEMS_PER_KIND);

  const columnIds = [
    ...new Set(kept.map((t) => t.columnId).filter(Boolean)),
  ].filter((id) => mongoose.Types.ObjectId.isValid(id));
  const columns = columnIds.length
    ? await Column.find(
        { _id: { $in: columnIds }, workspaceId },
        { title: 1, color: 1 },
      ).lean()
    : [];
  const columnsById = new Map(columns.map((c) => [c._id.toString(), c]));

  const memberIds = [
    ...new Set(kept.flatMap((t) => t.assignedMembers || []).filter(Boolean)),
  ].map(String);
  const usersMap = await loadAssignedUsers(memberIds, db);

  const items = [];
  for (const task of kept) {
    const day = inRange(task.dueDate, from, to);
    if (!day) continue;
    const board = boardsById.get(task.boardId.toString());
    const column = columnsById.get(String(task.columnId));
    items.push({
      id: `TASK:${task._id}`,
      kind: "TASK",
      entityId: task._id.toString(),
      day,
      title: task.title,
      reference: null,
      counterparty: null,
      amount: null,
      currency: null,
      state: stateFor(day, today, isDoneColumnTitle(column?.title)),
      documentStatus: column?.title || null,
      boardId: task.boardId.toString(),
      boardTitle: board?.title || null,
      boardEmoji: board?.emoji || null,
      boardColor: board?.color || null,
      columnTitle: column?.title || null,
      columnColor: column?.color || null,
      priority: task.priority || null,
      assignedMembersInfo: (task.assignedMembers || [])
        .filter(Boolean)
        .map(String)
        .map((id) => buildAssignedMemberInfo(id, usersMap.get(id) || null)),
    });
  }
  return { items, truncated: tasks.length > MAX_ITEMS_PER_KIND };
}

// Prochaines factures que les récurrences actives vont émettre : une entrée
// par échéance de la période, à partir de la prochaine (les précédentes sont
// devenues de vraies factures, affichées comme telles)
async function recurringInvoiceItems({ workspaceId, from, to, today }) {
  const recurrences = await InvoiceRecurrence.find(
    { workspaceId, status: "ACTIVE", nextRunDate: { $ne: null, $lte: to } },
    {
      sourceInvoiceId: 1,
      frequency: 1,
      interval: 1,
      startDate: 1,
      endDate: 1,
      nextRunDate: 1,
    },
  ).lean();
  if (recurrences.length === 0) return { items: [], truncated: false };

  const sources = await Invoice.find(
    {
      _id: { $in: recurrences.map((r) => r.sourceInvoiceId) },
      workspaceId,
    },
    {
      prefix: 1,
      number: 1,
      finalTotalTTC: 1,
      "client.name": 1,
      "client.firstName": 1,
      "client.lastName": 1,
    },
  ).lean();
  const sourcesById = new Map(sources.map((s) => [s._id.toString(), s]));

  const items = [];
  let truncated = false;
  for (const recurrence of recurrences) {
    const source = sourcesById.get(recurrence.sourceInvoiceId.toString());
    if (!source) continue;
    const counterparty = clientName(source.client);
    const reference = documentNumber(source);

    let day = nextOccurrenceFrom(
      recurrence,
      recurrence.nextRunDate > from ? recurrence.nextRunDate : from,
    );
    let count = 0;
    while (day && day <= to && count < MAX_OCCURRENCES_PER_RECURRENCE) {
      if (items.length >= MAX_ITEMS_PER_KIND) {
        truncated = true;
        break;
      }
      items.push({
        id: `RECURRING_INVOICE:${recurrence._id}:${day}`,
        kind: "RECURRING_INVOICE",
        entityId: recurrence._id.toString(),
        day,
        title: counterparty || reference || "Facture récurrente",
        reference,
        counterparty,
        amount: source.finalTotalTTC ?? null,
        currency: "EUR",
        state: stateFor(day, today, false),
        documentStatus: "ACTIVE",
        sourceInvoiceId: source._id.toString(),
        frequency: recurrence.frequency,
        interval: recurrence.interval || 1,
      });
      count += 1;
      day = nextOccurrenceFrom(recurrence, day, { strict: true });
    }
  }
  return { items, truncated };
}

// Échéances fiscales et sociales calculées depuis les informations légales
// de l'espace (fiscalDeadlines.js), avec ce qui manque pour les calculer
async function fiscalItems({ workspaceId, from, to, today, db }) {
  const organization = await (db || mongoose.connection.db)
    .collection("organization")
    .findOne({ _id: workspaceId }, { projection: FISCAL_ORGANIZATION_FIELDS });
  const { items, setup } = computeFiscalDeadlines(organization, {
    from,
    to,
    today,
  });
  return { items, truncated: false, fiscalSetup: setup };
}

const LOADERS = {
  INVOICE: invoiceItems,
  PURCHASE_INVOICE: purchaseInvoiceItems,
  QUOTE: quoteItems,
  TASK: taskItems,
  RECURRING_INVOICE: recurringInvoiceItems,
  FISCAL: fiscalItems,
};

/**
 * Sources visibles par le rôle : « Voir » sur la page d'origine.
 */
export function allowedLinkedKinds(permissions) {
  return Object.entries(LINKED_KIND_MODULES)
    .filter(([, moduleKey]) => permissions?.hasPermission?.(moduleKey, "view"))
    .map(([kind]) => kind);
}

/**
 * Éléments des sources permises sur la période [from, to] (jours inclus).
 */
export async function getCalendarLinkedItems({
  workspaceId,
  userId,
  permissions,
  db,
  from,
  to,
  now = new Date(),
}) {
  const kinds = allowedLinkedKinds(permissions);
  const today = parisDay(now);
  const workspaceObjectId = new mongoose.Types.ObjectId(String(workspaceId));

  const results = await Promise.all(
    kinds.map((kind) =>
      LOADERS[kind]({
        workspaceId: workspaceObjectId,
        from,
        to,
        today,
        userId,
        permissions,
        db,
      }),
    ),
  );

  const items = results
    .flatMap((r) => r.items)
    .sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind));

  return {
    items,
    kinds,
    truncated: results.some((r) => r.truncated),
    // Source Fiscal : informations légales manquantes (null sans la source)
    fiscalSetup: results.find((r) => r.fiscalSetup)?.fiscalSetup ?? null,
  };
}
