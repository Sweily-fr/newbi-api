import mongoose from "mongoose";
import Event from "../models/Event.js";
import Invoice from "../models/Invoice.js";
import Client from "../models/Client.js";
import CalendarConnection from "../models/CalendarConnection.js";
import {
  assertPermissionAction,
  checkSubscriptionActive,
  requireWorkspaceAction,
  requireWorkspaceLevel,
} from "../middlewares/rbac.js";
import emailReminderService from "../services/emailReminderService.js";
import {
  deleteEventFromExternalCalendars,
  updateEventInExternalCalendars,
  pushEventToCalendar,
  autoPushEventToConnections,
} from "../services/calendar/CalendarSyncService.js";
import { publishCalendarEventsChanged } from "../services/calendar/CalendarWebhookService.js";
import { getPubSub } from "../config/redis.js";
import logger from "../utils/logger.js";
import {
  buildAssignedMemberInfo,
  loadAssignedUsers,
} from "../utils/assignedMemberInfo.js";
import {
  accessibleEventFilter,
  hiddenDocumentEventTypes,
  keepWorkspaceMemberIds,
} from "../utils/eventAccess.js";

/**
 * Paires « espace:utilisateur » des membres parmi `userIds`, pour les
 * espaces `workspaceIds` : seuls ces membres sont décrits (nom, e-mail,
 * photo) dans les membres assignés d'un événement.
 */
async function workspaceMemberPairs(userIds, workspaceIds, db) {
  const toId = (v) => {
    try {
      return new mongoose.Types.ObjectId(String(v));
    } catch {
      return null;
    }
  };
  const users = [...new Set(userIds.map(String))].map(toId).filter(Boolean);
  const orgs = [...new Set(workspaceIds.filter(Boolean).map(String))]
    .map(toId)
    .filter(Boolean);
  const pairs = new Set();
  if (!db || users.length === 0 || orgs.length === 0) return pairs;
  const members = await db
    .collection("member")
    .find(
      { organizationId: { $in: orgs }, userId: { $in: users } },
      { projection: { userId: 1, organizationId: 1 } },
    )
    .toArray();
  for (const m of members) pairs.add(`${m.organizationId}:${m.userId}`);
  return pairs;
}
import { AppError, ERROR_CODES } from "../utils/errors.js";

const CALENDAR_EVENTS_CHANGED = "CALENDAR_EVENTS_CHANGED";

// Plafond d'une page de getEvents (le site en demande 500)
export const MAX_EVENTS_PER_PAGE = 1000;

// Rendez-vous pris sur une page de réservation : gérés (déplacés, annulés)
// depuis la prise de rendez-vous, qui prévient l'invité
const APPOINTMENT_MANAGED_ELSEWHERE =
  "Gérez ce rendez-vous depuis Communication > Prise de rendez-vous.";

/**
 * Détermine le statut d'un rappel lors d'un (re)calcul.
 * Règle clé : si l'heure d'envoi recalculée est déjà passée ET que le rappel
 * a déjà été envoyé, on conserve "sent" pour NE PAS le renvoyer (évite les
 * doublons lors d'une simple édition/déplacement de l'événement).
 * @param {Date|null} scheduledTime - heure d'envoi calculée (null = pas de rappel)
 * @param {string|null} previousStatus - statut précédent du rappel
 * @param {Date} now
 * @returns {string|null}
 */
function reminderStatusFor(scheduledTime, previousStatus, now) {
  if (!scheduledTime) return null;
  if (scheduledTime <= now && previousStatus === "sent") return "sent";
  return "pending";
}

/**
 * Construit l'objet emailReminder (statuts + dates d'envoi) à partir des
 * réglages souhaités, en préservant les rappels déjà envoyés.
 * @param {object} params
 * @param {Date} params.start - date de début de l'événement
 * @param {boolean} params.isAllDay
 * @param {string|null} params.anticipation
 * @param {string|null} params.echeance
 * @param {object} [params.previous] - emailReminder existant (pour préserver "sent"/sentAt)
 * @param {Date} params.now
 */
function buildEmailReminder({
  start,
  isAllDay,
  anticipation,
  echeance,
  previous = {},
  now,
}) {
  const finalEcheance = isAllDay ? null : echeance || null;
  const finalAnticipation = anticipation || null;

  // Heure d'envoi du rappel anticipé
  const scheduledFor = finalAnticipation
    ? emailReminderService.calculateScheduledTime(
        start,
        finalAnticipation,
        isAllDay,
      )
    : isAllDay
      ? emailReminderService.calculateScheduledTime(start, null, true)
      : null;

  // Heure d'envoi du rappel à l'échéance (pas d'échéance pour les allDay)
  const echeanceScheduledFor = finalEcheance
    ? emailReminderService.calculateScheduledTime(start, finalEcheance, false)
    : null;

  // Statut anticipé : "sent" si aucun rappel anticipé (rien à envoyer),
  // sinon calculé en préservant un envoi déjà effectué.
  const status = scheduledFor
    ? reminderStatusFor(scheduledFor, previous.status, now)
    : "sent";

  const echeanceStatus = echeanceScheduledFor
    ? reminderStatusFor(echeanceScheduledFor, previous.echeanceStatus, now)
    : null;

  return {
    enabled: true,
    anticipation: finalAnticipation,
    echeance: finalEcheance,
    status,
    scheduledFor,
    echeanceScheduledFor,
    echeanceStatus,
    // On préserve les horodatages d'envoi : ne pas les effacer ré-enverrait
    // un rappel déjà parti lorsqu'on garde le statut "sent".
    sentAt: status === "sent" ? previous.sentAt || null : null,
    echeanceSentAt:
      echeanceStatus === "sent" ? previous.echeanceSentAt || null : null,
    failureReason: null,
  };
}

const eventResolvers = {
  Event: {
    // Mapper le champ invoiceId populé vers invoice pour la compatibilité GraphQL
    invoice: (parent) => {
      // Retourner null si pas d'invoiceId ou si non populé (juste un ObjectId)
      if (!parent.invoiceId) return null;

      // Si invoiceId est un objet avec _id, c'est qu'il est populé
      if (parent.invoiceId._id) {
        return parent.invoiceId;
      }

      // Sinon c'est juste un ObjectId, retourner null
      return null;
    },
    // Convertir l'ObjectId en string pour GraphQL
    invoiceId: (parent) =>
      parent.invoiceId
        ? parent.invoiceId._id?.toString() || parent.invoiceId.toString()
        : null,

    // Enrichir les membres assignés avec leurs infos (nom, email, photo).
    // getEvents pré-enrichit en batch ; ce resolver sert de fallback pour
    // getEvent et les réponses de mutations.
    assignedMembersInfo: async (parent, _, { db }) => {
      if (parent.assignedMembersInfo) return parent.assignedMembersInfo;

      const assignedIds = (parent.assignedMembers || [])
        .filter(Boolean)
        .map(String);
      if (assignedIds.length === 0) return [];

      // Seuls les membres de l'espace de l'événement sont décrits
      const workspaceId = String(parent.workspaceId || "");
      const pairs = await workspaceMemberPairs(assignedIds, [workspaceId], db);
      const memberIds = assignedIds.filter((id) =>
        pairs.has(`${workspaceId}:${id}`),
      );
      const usersMap = await loadAssignedUsers(memberIds, db);
      return memberIds.map((id) =>
        buildAssignedMemberInfo(id, usersMap.get(id) || null),
      );
    },
  },

  Query: {
    getEvents: requireWorkspaceLevel(
      "calendar",
      "read",
    )(
      async (
        _,
        {
          startDate,
          endDate,
          type,
          limit = 500,
          offset = 0,
          workspaceId,
          includeExternalCalendars = false,
          sources,
        },
        { user, workspaceId: contextWorkspaceId, db, permissions },
      ) => {
        try {
          const finalWorkspaceId = workspaceId || contextWorkspaceId;
          const userId = user?.id || user?._id;
          const hiddenTypes = hiddenDocumentEventTypes(permissions);
          // Page bornée : une seule requête ne charge pas tout l'historique
          const boundedLimit = Math.min(
            Math.max(Number.parseInt(limit, 10) || 0, 1),
            MAX_EVENTS_PER_PAGE,
          );
          const boundedOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
          if (type && hiddenTypes.includes(type)) {
            return {
              success: true,
              events: [],
              totalCount: 0,
              message: "0 événement(s) récupéré(s)",
            };
          }

          // Construire le filtre avec le modèle de confidentialité multi-membres
          // Événements workspace (visibles par tous) + événements privés (seulement le propriétaire)
          const filter = {};

          if (includeExternalCalendars && userId) {
            // Inclure les événements workspace ET les événements privés/externes du user courant
            // Note: les événements externes peuvent avoir visibility=undefined (migration)
            filter.$or = [
              {
                visibility: { $in: ["workspace", null, undefined] },
                workspaceId: finalWorkspaceId,
              },
              { visibility: "private", userId: userId },
              {
                source: { $in: ["google", "microsoft", "apple"] },
                userId: userId,
              },
            ];
          } else {
            // Comportement par défaut : seulement les événements workspace
            filter.workspaceId = finalWorkspaceId;
            filter.visibility = { $in: ["workspace", null, undefined] };
          }

          if (type) {
            filter.type = type;
          } else if (hiddenTypes.length > 0) {
            filter.type = { $nin: hiddenTypes };
          }

          if (sources && sources.length > 0) {
            filter.source = { $in: sources };
          }

          if (startDate || endDate) {
            filter.start = {};
            if (startDate) {
              filter.start.$gte = new Date(startDate);
            }
            if (endDate) {
              filter.start.$lte = new Date(endDate);
            }
          }

          // Récupérer les événements
          const events = await Event.find(filter)
            .populate({
              path: "invoiceId",
              populate: {
                path: "client",
                select: "name",
              },
            })
            .sort({ start: 1 })
            .limit(boundedLimit)
            .skip(boundedOffset);

          const totalCount = await Event.countDocuments(filter);

          // Charger en une seule requête les infos des membres assignés
          // (même pattern que l'enrichissement des tâches kanban)
          const allAssignedIds = new Set();
          for (const event of events) {
            (event.assignedMembers || []).forEach((id) => {
              if (id) allAssignedIds.add(String(id));
            });
          }
          // Seuls les membres de l'espace de chaque événement sont décrits
          // (un id d'une autre entreprise ne donne ni nom ni e-mail)
          const memberPairs = await workspaceMemberPairs(
            Array.from(allAssignedIds),
            events.map((event) => event.workspaceId),
            db,
          );
          const assignedOf = (event) =>
            (event.assignedMembers || [])
              .filter(Boolean)
              .map(String)
              .filter((id) => memberPairs.has(`${event.workspaceId}:${id}`));
          const assignedUsersMap = await loadAssignedUsers(
            Array.from(allAssignedIds),
            db,
          );

          // S'assurer que tous les champs sont correctement sérialisés
          const serializedEvents = events.map((event) => {
            const baseEvent = {
              ...event.toObject(),
              id: event._id.toString(),
              start: event.start.toISOString(),
              end: event.end.toISOString(),
              invoiceId: event.invoiceId
                ? event.invoiceId._id?.toString() || event.invoiceId.toString()
                : null,
              source: event.source || "newbi",
              visibility: event.visibility || "workspace",
              isReadOnly: event.isReadOnly || false,
              externalEventId: event.externalEventId || null,
              calendarConnectionId:
                event.calendarConnectionId?.toString() || null,
              externalCalendarLinks: (event.externalCalendarLinks || []).map(
                (link) => ({
                  provider: link.provider,
                  externalEventId: link.externalEventId,
                  calendarConnectionId: link.calendarConnectionId?.toString(),
                }),
              ),
              assignedMembers: assignedOf(event),
              assignedMembersInfo: assignedOf(event).map((id) =>
                buildAssignedMemberInfo(id, assignedUsersMap.get(id) || null),
              ),
            };

            // Seulement inclure invoice si invoiceId existe et est populé
            if (event.invoiceId && event.invoiceId._id) {
              baseEvent.invoice = {
                id: event.invoiceId._id.toString(),
                prefix: event.invoiceId.prefix || "",
                number: event.invoiceId.number || "",
                client: event.invoiceId.client
                  ? {
                      name: event.invoiceId.client.name || "",
                    }
                  : null,
                finalTotalTTC: event.invoiceId.finalTotalTTC || 0,
                status: event.invoiceId.status || "DRAFT",
              };
            } else {
              // Ne pas inclure invoice du tout si pas d'invoiceId
              baseEvent.invoice = null;
            }

            return baseEvent;
          });

          // Deduplicate bounce-backs: external events that are copies of pushed Newbi events
          // Collect all externalEventIds from Newbi events' externalCalendarLinks
          const pushedIds = new Set();
          for (const event of serializedEvents) {
            if ((event.externalCalendarLinks || []).length > 0) {
              for (const link of event.externalCalendarLinks) {
                if (link.calendarConnectionId && link.externalEventId) {
                  pushedIds.add(
                    `${link.calendarConnectionId}:${link.externalEventId}`,
                  );
                }
              }
            }
          }
          // Filter out external events that match a pushed Newbi event
          const deduplicatedEvents = serializedEvents.filter((event) => {
            if (
              event.source !== "newbi" &&
              event.externalEventId &&
              event.calendarConnectionId
            ) {
              const key = `${event.calendarConnectionId}:${event.externalEventId}`;
              if (pushedIds.has(key)) return false;
            }
            return true;
          });

          return {
            success: true,
            events: deduplicatedEvents,
            totalCount: deduplicatedEvents.length,
            message: `${deduplicatedEvents.length} événement(s) récupéré(s)`,
          };
        } catch (error) {
          logger.error("Erreur lors de la récupération des événements:", error);
          return {
            success: false,
            events: [],
            totalCount: 0,
            message:
              error.message || "Erreur lors de la récupération des événements",
          };
        }
      },
    ),

    getEvent: requireWorkspaceLevel(
      "calendar",
      "read",
    )(
      async (
        _,
        { id, workspaceId },
        { user, workspaceId: contextWorkspaceId, permissions },
      ) => {
        try {
          const finalWorkspaceId = workspaceId || contextWorkspaceId;

          const userId = user?.id || user?._id;

          // Chercher dans les événements workspace OU les événements privés du user
          const event = await Event.findOne({
            _id: id,
            $or: [
              {
                workspaceId: finalWorkspaceId,
                visibility: { $in: ["workspace", null, undefined] },
              },
              { visibility: "private", userId: userId },
            ],
          }).populate("invoiceId");

          if (
            !event ||
            hiddenDocumentEventTypes(permissions).includes(event.type)
          ) {
            return {
              success: false,
              event: null,
              message: "Événement non trouvé",
            };
          }

          return {
            success: true,
            event,
            message: "Événement récupéré avec succès",
          };
        } catch (error) {
          logger.error("Erreur lors de la récupération de l'événement:", error);
          return {
            success: false,
            event: null,
            message:
              error.message || "Erreur lors de la récupération de l'événement",
          };
        }
      },
    ),
  },

  Mutation: {
    createEvent: requireWorkspaceAction(
      "calendar",
      "create",
    )(
      async (
        _,
        { input, workspaceId },
        { user, workspaceId: contextWorkspaceId, permissions },
      ) => {
        try {
          const finalWorkspaceId = workspaceId || contextWorkspaceId;

          if (input.type === "APPOINTMENT") {
            return {
              success: false,
              event: null,
              message: APPOINTMENT_MANAGED_ELSEWHERE,
            };
          }

          if (hiddenDocumentEventTypes(permissions).includes(input.type)) {
            return {
              success: false,
              event: null,
              message:
                "Vous n'avez pas la permission d'effectuer cette action.",
            };
          }

          const event = new Event({
            ...input,
            // Seuls des membres de l'espace sont assignés
            ...(input.assignedMembers
              ? {
                  assignedMembers: await keepWorkspaceMemberIds(
                    input.assignedMembers,
                    finalWorkspaceId,
                  ),
                }
              : {}),
            userId: user.id,
            workspaceId: finalWorkspaceId,
          });

          // Si rappel email activé, calculer les dates d'envoi
          if (input.emailReminder?.enabled) {
            event.emailReminder = buildEmailReminder({
              start: input.start,
              isAllDay: input.allDay || false,
              anticipation: input.emailReminder.anticipation,
              echeance: input.emailReminder.echeance,
              now: new Date(),
            });
          }

          await event.save();

          // Ajouter l'activité "reminder_created" sur le client associé
          // (un client de l'espace seulement : sinon on écrivait dans la
          // chronologie du client d'un autre espace)
          if (input.clientId) {
            try {
              await Client.updateOne(
                { _id: input.clientId, workspaceId: finalWorkspaceId },
                {
                  $push: {
                    activity: {
                      id: new mongoose.Types.ObjectId().toString(),
                      type: "reminder_created",
                      description: `a créé un rappel "${event.title}"`,
                      userId: user.id,
                      userName: user.name || user.email,
                      userImage: user.image || null,
                      metadata: {
                        eventId: event._id.toString(),
                        eventTitle: event.title,
                        eventDate: event.start.toISOString(),
                      },
                      createdAt: new Date(),
                    },
                  },
                },
              );
            } catch (activityError) {
              logger.error(
                "[createEvent] Erreur lors de l'ajout de l'activité client:",
                activityError.message,
              );
            }
          }

          // Le rappel email sera envoyé par le scheduler (emailReminderScheduler) à l'heure programmée (scheduledFor)

          // Publish calendar events changed for real-time sync
          publishCalendarEventsChanged(user.id || user._id);

          // Auto-push to external calendars with autoSync enabled (fire-and-forget)
          CalendarConnection.find({
            userId: user.id || user._id,
            autoSync: true,
            status: "active",
          })
            .then(async (autoSyncConnections) => {
              for (const conn of autoSyncConnections) {
                try {
                  await pushEventToCalendar(event._id, conn._id);
                  logger.info(
                    `[createEvent] Auto-push vers ${conn.provider} (${conn._id}) réussi pour event ${event._id}`,
                  );
                } catch (err) {
                  logger.error(
                    `[createEvent] Auto-push vers ${conn.provider} (${conn._id}) échoué pour event ${event._id}:`,
                    err.message,
                  );
                }
              }
            })
            .catch((err) => {
              logger.error(
                "[createEvent] Erreur recherche connexions autoSync:",
                err.message,
              );
            });

          return {
            success: true,
            event,
            message: "Événement créé avec succès",
          };
        } catch (error) {
          logger.error("Erreur lors de la création de l'événement:", error);
          return {
            success: false,
            event: null,
            message:
              error.message || "Erreur lors de la création de l'événement",
          };
        }
      },
    ),

    updateEvent: requireWorkspaceLevel(
      "calendar",
      "write",
    )(
      async (
        _,
        { input, workspaceId },
        { user, workspaceId: contextWorkspaceId, permissions },
      ) => {
        try {
          const finalWorkspaceId = workspaceId || contextWorkspaceId;

          const { id, ...updateData } = input;

          // Événement que ce membre peut voir : ni l'événement privé d'un
          // autre membre, ni une échéance cachée par son rôle (introuvables)
          const accessFilter = accessibleEventFilter({
            id,
            workspaceId: finalWorkspaceId,
            userId: user.id || user._id,
            permissions,
          });
          const existingEvent = await Event.findOne(accessFilter);
          if (
            !existingEvent ||
            hiddenDocumentEventTypes(permissions).includes(updateData.type)
          ) {
            return {
              success: false,
              event: null,
              message: "Événement non trouvé",
            };
          }

          if (updateData.assignedMembers) {
            updateData.assignedMembers = await keepWorkspaceMemberIds(
              updateData.assignedMembers,
              finalWorkspaceId,
            );
          }

          // Vérifier si l'événement est en lecture seule (événement externe)
          if (existingEvent?.isReadOnly) {
            return {
              success: false,
              event: null,
              message: "Les événements externes ne peuvent pas être modifiés",
            };
          }
          if (
            existingEvent?.type === "APPOINTMENT" ||
            updateData.type === "APPOINTMENT"
          ) {
            return {
              success: false,
              event: null,
              message: APPOINTMENT_MANAGED_ELSEWHERE,
            };
          }

          // Si la date ou le rappel email change, recalculer la date d'envoi
          if (updateData.emailReminder || updateData.start) {
            const event = existingEvent;

            if (event) {
              const newStart = updateData.start || event.start;
              const isAllDay =
                updateData.allDay !== undefined
                  ? updateData.allDay
                  : event.allDay;

              const now = new Date();
              const previous = event.emailReminder
                ? event.emailReminder.toObject()
                : {};

              if (updateData.emailReminder?.enabled) {
                // L'utilisateur modifie explicitement le rappel : on recalcule
                // en préservant un éventuel envoi déjà effectué.
                updateData.emailReminder = buildEmailReminder({
                  start: newStart,
                  isAllDay,
                  anticipation: updateData.emailReminder.anticipation,
                  echeance: updateData.emailReminder.echeance,
                  previous,
                  now,
                });
              } else if (
                updateData.emailReminder &&
                !updateData.emailReminder.enabled
              ) {
                // Désactiver le rappel
                updateData.emailReminder = {
                  enabled: false,
                  status: "cancelled",
                  echeanceStatus: "cancelled",
                };
              } else if (updateData.start && event.emailReminder?.enabled) {
                // Seule la date change : recalculer les heures d'envoi sans
                // ré-envoyer un rappel déjà parti (statut "sent" préservé).
                updateData.emailReminder = buildEmailReminder({
                  start: newStart,
                  isAllDay,
                  anticipation: event.emailReminder.anticipation,
                  echeance: event.emailReminder.echeance,
                  previous,
                  now,
                });
              }
            }
          }

          const event = await Event.findOneAndUpdate(accessFilter, updateData, {
            new: true,
            runValidators: true,
          }).populate("invoiceId");

          if (!event) {
            return {
              success: false,
              event: null,
              message: "Événement non trouvé",
            };
          }

          // Publish calendar events changed for real-time sync
          publishCalendarEventsChanged(user.id || user._id);

          // Propagate changes to external calendars (fire-and-forget)
          if (event.externalCalendarLinks?.length > 0) {
            updateEventInExternalCalendars(event).catch((err) =>
              logger.error(
                "[updateEvent] Erreur propagation update calendriers externes:",
                err.message,
              ),
            );
          }

          return {
            success: true,
            event,
            message: "Événement mis à jour avec succès",
          };
        } catch (error) {
          logger.error("Erreur lors de la mise à jour de l'événement:", error);
          return {
            success: false,
            event: null,
            message:
              error.message || "Erreur lors de la mise à jour de l'événement",
          };
        }
      },
    ),

    deleteEvent: requireWorkspaceLevel(
      "calendar",
      "delete",
    )(
      async (
        _,
        { id, workspaceId },
        { user, workspaceId: contextWorkspaceId, permissions },
      ) => {
        try {
          const finalWorkspaceId = workspaceId || contextWorkspaceId;

          // Ni l'événement privé d'un autre membre, ni une échéance cachée
          // par son rôle : introuvables
          const accessFilter = accessibleEventFilter({
            id,
            workspaceId: finalWorkspaceId,
            userId: user.id || user._id,
            permissions,
          });
          const existingEvent = await Event.findOne(accessFilter);
          if (!existingEvent) {
            return {
              success: false,
              event: null,
              message: "Événement non trouvé",
            };
          }

          // Vérifier si l'événement est en lecture seule (événement externe)
          if (existingEvent?.isReadOnly) {
            return {
              success: false,
              event: null,
              message: "Les événements externes ne peuvent pas être supprimés",
            };
          }
          if (existingEvent?.type === "APPOINTMENT") {
            return {
              success: false,
              event: null,
              message: APPOINTMENT_MANAGED_ELSEWHERE,
            };
          }

          // Propagate deletion to external calendars before removing (fire-and-forget)
          if (existingEvent?.externalCalendarLinks?.length > 0) {
            deleteEventFromExternalCalendars(existingEvent).catch((err) =>
              logger.error(
                "[deleteEvent] Erreur propagation suppression calendriers externes:",
                err.message,
              ),
            );
          }

          const event = await Event.findOneAndDelete(accessFilter);

          if (!event) {
            return {
              success: false,
              event: null,
              message: "Événement non trouvé",
            };
          }

          // Publish calendar events changed for real-time sync
          publishCalendarEventsChanged(user.id || user._id);

          return {
            success: true,
            event,
            message: "Événement supprimé avec succès",
          };
        } catch (error) {
          logger.error("Erreur lors de la suppression de l'événement:", error);
          return {
            success: false,
            event: null,
            message:
              error.message || "Erreur lors de la suppression de l'événement",
          };
        }
      },
    ),

    syncInvoiceEvents: requireWorkspaceLevel(
      "calendar",
      "write",
    )(async (_, { workspaceId }, context) => {
      const { user, workspaceId: contextWorkspaceId } = context;
      // Les échéances reprennent client et montant des factures
      assertPermissionAction(context, "invoices", "view");
      try {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        // Récupérer toutes les factures du workspace
        const invoices = await Invoice.find({
          workspaceId: finalWorkspaceId,
        }).limit(500);

        const events = [];

        for (const invoice of invoices) {
          if (invoice.dueDate) {
            try {
              const event = await Event.createInvoiceDueEvent(
                invoice,
                user.id,
                finalWorkspaceId,
              );
              events.push(event);

              // Pousser vers les calendriers externes (autoSync) ou propager
              // une mise à jour si déjà lié
              if (event?._id) {
                if (event.externalCalendarLinks?.length > 0) {
                  updateEventInExternalCalendars(event).catch((err) =>
                    logger.error(
                      `[syncInvoiceEvents] Erreur propagation update pour ${event._id}: ${err.message}`,
                    ),
                  );
                } else {
                  autoPushEventToConnections(event._id, user.id).catch((err) =>
                    logger.error(
                      `[syncInvoiceEvents] Erreur auto-push pour ${event._id}: ${err.message}`,
                    ),
                  );
                }
              }
            } catch (error) {
              logger.error(
                `Erreur lors de la création de l'événement pour la facture ${invoice._id}:`,
                error,
              );
            }
          }
        }

        return {
          success: true,
          events,
          totalCount: events.length,
          message: `${events.length} événement(s) de facture synchronisé(s)`,
        };
      } catch (error) {
        logger.error(
          "Erreur lors de la synchronisation des événements de factures:",
          error,
        );
        return {
          success: false,
          events: [],
          totalCount: 0,
          message:
            error.message || "Erreur lors de la synchronisation des événements",
        };
      }
    }),
  },

  Subscription: {
    calendarEventsChanged: {
      // 🔐 Canal propre à un utilisateur : seul cet utilisateur, connecté,
      // peut s'y abonner (un client anonyme suivait l'agenda de n'importe qui)
      subscribe: (_, { userId }, context) => {
        if (!context?.user) {
          throw new AppError(
            "Vous devez être connecté pour effectuer cette action",
            ERROR_CODES.UNAUTHENTICATED,
          );
        }
        const currentUserId = String(context.user._id || context.user.id);
        if (String(userId) !== currentUserId) {
          throw new AppError(
            "Vous n'avez pas la permission d'effectuer cette action.",
            ERROR_CODES.FORBIDDEN,
          );
        }
        const pubsub = getPubSub();
        return pubsub.asyncIterableIterator([
          `${CALENDAR_EVENTS_CHANGED}_${userId}`,
        ]);
      },
    },
  },
};

// ✅ Phase A.3 — Subscription check sur toutes les mutations event
const originalEventMutations = eventResolvers.Mutation;
eventResolvers.Mutation = Object.fromEntries(
  Object.entries(originalEventMutations).map(([name, fn]) => [
    name,
    async (parent, args, context, info) => {
      await checkSubscriptionActive(context);
      return fn(parent, args, context, info);
    },
  ]),
);

export default eventResolvers;
