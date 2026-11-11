import mongoose from "mongoose";
import Event from "../../models/Event.js";
import { getActiveOrganization } from "../../middlewares/org-resolver.js";
import { hasPermission, hasPermissionLevel } from "../../middlewares/rbac.js";
import { getEffectiveLevelsFor } from "../organizationRoleService.js";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import { addDays, parisDay } from "../../utils/invoiceRecurrenceSchedule.js";
import {
  getCalendarLinkedItems,
  MAX_RANGE_DAYS,
} from "./linkedItemsService.js";

/**
 * Contenu du calendrier d'un membre lu hors de l'application (abonnement
 * iCal, récap du lundi), sans session : les droits sont recalculés à chaque
 * lecture, comme le fait withRBAC pour une requête GraphQL.
 */

// Événements copiés depuis Google, Outlook ou Apple : déjà dans l'agenda
// d'origine, ils feraient doublon chez qui s'abonne depuis ce même agenda
export const EXTERNAL_EVENT_SOURCES = ["google", "microsoft", "apple"];

// Événements créés depuis un document : visibles seulement avec « Voir » sur
// la page du document (même règle que getEvents, resolvers/event.js)
const DOCUMENT_EVENT_MODULES = {
  INVOICE_DUE: "invoices",
  CREDIT_NOTE_CREATED: "creditNotes",
};

export const MAX_AGENDA_EVENTS = 2000;

/**
 * Grille de droits du membre dans l'espace, ou null s'il n'en est plus
 * membre (ou si l'espace n'existe plus). Même calcul que withRBAC : rôle lu
 * dans `member` (sans le cache de 60 s, un membre retiré perd l'accès tout
 * de suite), grille effective du rôle, prédéfini ou personnalisé.
 */
export async function getMemberCalendarAccess(userId, workspaceId) {
  if (!toObjectIdOrNull(userId) || !toObjectIdOrNull(workspaceId)) {
    return null;
  }
  const organization = await getActiveOrganization(
    String(userId),
    String(workspaceId),
  );
  if (!organization) return null;
  const role = organization.memberRole;
  const levels = await getEffectiveLevelsFor(organization.id, role);
  return {
    workspaceId: organization.id,
    role,
    permissions: {
      hasPermission: (resource, action) =>
        hasPermission(role, resource, action, levels),
      hasPermissionLevel: (resource, level) =>
        hasPermissionLevel(role, resource, level, levels),
      canRead: (resource) => hasPermissionLevel(role, resource, "read", levels),
      canWrite: (resource) =>
        hasPermissionLevel(role, resource, "write", levels),
      canDelete: (resource) =>
        hasPermissionLevel(role, resource, "delete", levels),
      canAdmin: (resource) =>
        hasPermissionLevel(role, resource, "admin", levels),
    },
  };
}

/**
 * Échéance de facture copiée dans les événements à la création de la
 * facture : remplacée par l'échéance relue dans la facture, sauf si
 * quelqu'un l'a enrichie (membres assignés, rappel par e-mail). Même règle
 * que le site (isPlainInvoiceDueEvent).
 */
export function isPlainInvoiceDueEvent(event) {
  return (
    event?.type === "INVOICE_DUE" &&
    !(event.assignedMembers?.length > 0) &&
    !event.emailReminder?.enabled
  );
}

/** Jours de Paris couverts par un événement (fin incluse). */
export function eventDays(event) {
  const startDay = parisDay(new Date(event.start));
  const endDay = parisDay(new Date(event.end));
  return { startDay, endDay: endDay < startDay ? startDay : endDay };
}

/**
 * Événements Newbi visibles par le membre qui touchent la période
 * [from, to] (jours de Paris inclus) : ceux de l'espace et ses événements
 * privés ; jamais ceux des agendas externes.
 */
export async function loadVisibleEvents({
  workspaceId,
  userId,
  permissions,
  from,
  to,
  limit = MAX_AGENDA_EVENTS,
}) {
  const hiddenTypes = Object.entries(DOCUMENT_EVENT_MODULES)
    .filter(([, moduleKey]) => !permissions?.hasPermission?.(moduleKey, "view"))
    .map(([type]) => type);

  const filter = {
    workspaceId: new mongoose.Types.ObjectId(String(workspaceId)),
    source: { $nin: EXTERNAL_EVENT_SOURCES },
    $or: [
      { visibility: { $in: ["workspace", null] } },
      {
        visibility: "private",
        userId: new mongoose.Types.ObjectId(String(userId)),
      },
    ],
    // Bornes UTC élargies d'un jour, filtre exact ensuite sur les jours
    start: { $lt: new Date(`${addDays(to, 2)}T00:00:00.000Z`) },
    end: { $gte: new Date(`${addDays(from, -1)}T00:00:00.000Z`) },
  };
  if (hiddenTypes.length > 0) filter.type = { $nin: hiddenTypes };

  const events = await Event.find(filter, {
    title: 1,
    description: 1,
    location: 1,
    start: 1,
    end: 1,
    allDay: 1,
    type: 1,
    assignedMembers: 1,
    "emailReminder.enabled": 1,
    createdAt: 1,
    updatedAt: 1,
  })
    .sort({ start: 1 })
    .limit(limit)
    .lean();

  return events.filter((event) => {
    if (isPlainInvoiceDueEvent(event)) return false;
    const { startDay, endDay } = eventDays(event);
    return startDay <= to && endDay >= from;
  });
}

/**
 * Échéances des autres pages sur [from, to], lues par tranches de
 * MAX_RANGE_DAYS jours au plus (limite du service des échéances).
 */
export async function loadLinkedItems({
  workspaceId,
  userId,
  permissions,
  db = mongoose.connection.db,
  from,
  to,
  now = new Date(),
}) {
  const chunkDays = Math.max(1, MAX_RANGE_DAYS);
  const items = [];
  const seen = new Set();
  let truncated = false;
  let kinds = [];
  for (let start = from; start <= to; ) {
    const candidate = addDays(start, chunkDays - 1);
    const end = candidate < to ? candidate : to;
    const result = await getCalendarLinkedItems({
      workspaceId: String(workspaceId),
      userId: String(userId),
      permissions,
      db,
      from: start,
      to: end,
      now,
    });
    kinds = result.kinds;
    truncated = truncated || result.truncated;
    for (const item of result.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    start = addDays(end, 1);
  }
  return { items, kinds, truncated };
}
