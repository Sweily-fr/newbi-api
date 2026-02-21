import Event from '../models/Event.js';
import Invoice from '../models/Invoice.js';
import CalendarConnection from '../models/CalendarConnection.js';
import { isAuthenticated, withWorkspace } from '../middlewares/better-auth-jwt.js';
import emailReminderService from '../services/emailReminderService.js';
import { deleteEventFromExternalCalendars, updateEventInExternalCalendars, pushEventToCalendar } from '../services/calendar/CalendarSyncService.js';
import logger from '../utils/logger.js';

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
    invoiceId: (parent) => parent.invoiceId ? parent.invoiceId._id?.toString() || parent.invoiceId.toString() : null,
  },
  
  Query: {
    getEvents: withWorkspace(async (_, { startDate, endDate, type, limit = 500, offset = 0, workspaceId, includeExternalCalendars = false, sources }, { user, workspaceId: contextWorkspaceId }) => {
      try {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const userId = user?.id || user?._id;

        // Construire le filtre avec le modèle de confidentialité multi-membres
        // Événements workspace (visibles par tous) + événements privés (seulement le propriétaire)
        const filter = {};

        if (includeExternalCalendars && userId) {
          // Inclure les événements workspace ET les événements privés/externes du user courant
          // Note: les événements externes peuvent avoir visibility=undefined (migration)
          filter.$or = [
            { visibility: { $in: ['workspace', null, undefined] }, workspaceId: finalWorkspaceId },
            { visibility: 'private', userId: userId },
            { source: { $in: ['google', 'microsoft', 'apple'] }, userId: userId }
          ];
        } else {
          // Comportement par défaut : seulement les événements workspace
          filter.workspaceId = finalWorkspaceId;
          filter.visibility = { $in: ['workspace', null, undefined] };
        }

        if (type) {
          filter.type = type;
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
            path: 'invoiceId',
            populate: {
              path: 'client',
              select: 'name'
            }
          })
          .sort({ start: 1 })
          .limit(limit)
          .skip(offset);

        const totalCount = await Event.countDocuments(filter);

        // S'assurer que tous les champs sont correctement sérialisés
        const serializedEvents = events.map(event => {
          const baseEvent = {
            ...event.toObject(),
            id: event._id.toString(),
            start: event.start.toISOString(),
            end: event.end.toISOString(),
            invoiceId: event.invoiceId ? event.invoiceId._id?.toString() || event.invoiceId.toString() : null,
            source: event.source || 'newbi',
            visibility: event.visibility || 'workspace',
            isReadOnly: event.isReadOnly || false,
            externalEventId: event.externalEventId || null,
            calendarConnectionId: event.calendarConnectionId?.toString() || null,
            externalCalendarLinks: (event.externalCalendarLinks || []).map(link => ({
              provider: link.provider,
              externalEventId: link.externalEventId,
              calendarConnectionId: link.calendarConnectionId?.toString()
            }))
          };

          // Seulement inclure invoice si invoiceId existe et est populé
          if (event.invoiceId && event.invoiceId._id) {
            baseEvent.invoice = {
              id: event.invoiceId._id.toString(),
              prefix: event.invoiceId.prefix || '',
              number: event.invoiceId.number || '',
              client: event.invoiceId.client ? {
                name: event.invoiceId.client.name || ''
              } : null,
              finalTotalTTC: event.invoiceId.finalTotalTTC || 0,
              status: event.invoiceId.status || 'DRAFT'
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
                pushedIds.add(`${link.calendarConnectionId}:${link.externalEventId}`);
              }
            }
          }
        }
        // Filter out external events that match a pushed Newbi event
        const deduplicatedEvents = serializedEvents.filter(event => {
          if (event.source !== 'newbi' && event.externalEventId && event.calendarConnectionId) {
            const key = `${event.calendarConnectionId}:${event.externalEventId}`;
            if (pushedIds.has(key)) return false;
          }
          return true;
        });

        return {
          success: true,
          events: deduplicatedEvents,
          totalCount: deduplicatedEvents.length,
          message: `${deduplicatedEvents.length} événement(s) récupéré(s)`
        };
      } catch (error) {
        logger.error('Erreur lors de la récupération des événements:', error);
        return {
          success: false,
          events: [],
          totalCount: 0,
          message: error.message || 'Erreur lors de la récupération des événements'
        };
      }
    }),

    getEvent: withWorkspace(async (_, { id, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      try {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        const userId = user?.id || user?._id;

        // Chercher dans les événements workspace OU les événements privés du user
        const event = await Event.findOne({
          _id: id,
          $or: [
            { workspaceId: finalWorkspaceId, visibility: { $in: ['workspace', null, undefined] } },
            { visibility: 'private', userId: userId }
          ]
        }).populate('invoiceId');

        if (!event) {
          return {
            success: false,
            event: null,
            message: 'Événement non trouvé'
          };
        }

        return {
          success: true,
          event,
          message: 'Événement récupéré avec succès'
        };
      } catch (error) {
        logger.error('Erreur lors de la récupération de l\'événement:', error);
        return {
          success: false,
          event: null,
          message: error.message || 'Erreur lors de la récupération de l\'événement'
        };
      }
    })
  },

  Mutation: {
    createEvent: withWorkspace(async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      try {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        const event = new Event({
          ...input,
          userId: user.id,
          workspaceId: finalWorkspaceId
        });

        // Si rappel email activé, calculer la date d'envoi
        if (input.emailReminder?.enabled) {
          const scheduledTime = emailReminderService.calculateScheduledTime(
            input.start,
            input.emailReminder.anticipation
          );
          
          event.emailReminder = {
            enabled: true,
            anticipation: input.emailReminder.anticipation || null,
            status: 'pending',
            scheduledFor: scheduledTime
          };
        }

        await event.save();

        // Auto-push to external calendars with autoSync enabled (fire-and-forget)
        CalendarConnection.find({
          userId: user.id || user._id,
          autoSync: true,
          status: 'active'
        }).then(async (autoSyncConnections) => {
          for (const conn of autoSyncConnections) {
            try {
              await pushEventToCalendar(event._id, conn._id);
              logger.info(`[createEvent] Auto-push vers ${conn.provider} (${conn._id}) réussi pour event ${event._id}`);
            } catch (err) {
              logger.error(`[createEvent] Auto-push vers ${conn.provider} (${conn._id}) échoué pour event ${event._id}:`, err.message);
            }
          }
        }).catch(err => {
          logger.error('[createEvent] Erreur recherche connexions autoSync:', err.message);
        });

        return {
          success: true,
          event,
          message: 'Événement créé avec succès'
        };
      } catch (error) {
        logger.error('Erreur lors de la création de l\'événement:', error);
        return {
          success: false,
          event: null,
          message: error.message || 'Erreur lors de la création de l\'événement'
        };
      }
    }),

    updateEvent: withWorkspace(async (_, { input, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      try {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        const { id, ...updateData } = input;

        // Vérifier si l'événement est en lecture seule (événement externe)
        const existingEvent = await Event.findOne({ _id: id, workspaceId: finalWorkspaceId });
        if (existingEvent?.isReadOnly) {
          return {
            success: false,
            event: null,
            message: 'Les événements externes ne peuvent pas être modifiés'
          };
        }

        // Si la date ou le rappel email change, recalculer la date d'envoi
        if (updateData.emailReminder || updateData.start) {
          const event = await Event.findOne({ _id: id, workspaceId: finalWorkspaceId });
          
          if (event) {
            const newStart = updateData.start || event.start;
            
            if (updateData.emailReminder?.enabled) {
              const scheduledTime = emailReminderService.calculateScheduledTime(
                newStart,
                updateData.emailReminder.anticipation
              );
              
              updateData.emailReminder = {
                enabled: true,
                anticipation: updateData.emailReminder.anticipation || null,
                status: 'pending',
                scheduledFor: scheduledTime,
                sentAt: null,
                failureReason: null
              };
            } else if (updateData.emailReminder && !updateData.emailReminder.enabled) {
              // Désactiver le rappel
              updateData.emailReminder = {
                enabled: false,
                status: 'cancelled'
              };
            } else if (updateData.start && event.emailReminder?.enabled) {
              // La date change mais le rappel reste activé, recalculer
              const scheduledTime = emailReminderService.calculateScheduledTime(
                newStart,
                event.emailReminder.anticipation
              );
              
              updateData.emailReminder = {
                ...event.emailReminder.toObject(),
                scheduledFor: scheduledTime,
                status: 'pending',
                sentAt: null
              };
            }
          }
        }

        const event = await Event.findOneAndUpdate(
          { _id: id, workspaceId: finalWorkspaceId },
          updateData,
          { new: true, runValidators: true }
        ).populate('invoiceId');

        if (!event) {
          return {
            success: false,
            event: null,
            message: 'Événement non trouvé'
          };
        }

        // Propagate changes to external calendars (fire-and-forget)
        if (event.externalCalendarLinks?.length > 0) {
          updateEventInExternalCalendars(event).catch(err =>
            logger.error('[updateEvent] Erreur propagation update calendriers externes:', err.message)
          );
        }

        return {
          success: true,
          event,
          message: 'Événement mis à jour avec succès'
        };
      } catch (error) {
        logger.error('Erreur lors de la mise à jour de l\'événement:', error);
        return {
          success: false,
          event: null,
          message: error.message || 'Erreur lors de la mise à jour de l\'événement'
        };
      }
    }),

    deleteEvent: withWorkspace(async (_, { id, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      try {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        // Vérifier si l'événement est en lecture seule (événement externe)
        const existingEvent = await Event.findOne({ _id: id, workspaceId: finalWorkspaceId });
        if (existingEvent?.isReadOnly) {
          return {
            success: false,
            event: null,
            message: 'Les événements externes ne peuvent pas être supprimés'
          };
        }

        // Propagate deletion to external calendars before removing (fire-and-forget)
        if (existingEvent?.externalCalendarLinks?.length > 0) {
          deleteEventFromExternalCalendars(existingEvent).catch(err =>
            logger.error('[deleteEvent] Erreur propagation suppression calendriers externes:', err.message)
          );
        }

        const event = await Event.findOneAndDelete({ _id: id, workspaceId: finalWorkspaceId });

        if (!event) {
          return {
            success: false,
            event: null,
            message: 'Événement non trouvé'
          };
        }

        return {
          success: true,
          event,
          message: 'Événement supprimé avec succès'
        };
      } catch (error) {
        logger.error('Erreur lors de la suppression de l\'événement:', error);
        return {
          success: false,
          event: null,
          message: error.message || 'Erreur lors de la suppression de l\'événement'
        };
      }
    }),

    syncInvoiceEvents: withWorkspace(async (_, { workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      try {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        // Récupérer toutes les factures du workspace
        const invoices = await Invoice.find({ workspaceId: finalWorkspaceId });

        const events = [];
        
        for (const invoice of invoices) {
          if (invoice.dueDate) {
            try {
              const event = await Event.createInvoiceDueEvent(invoice, user.id, finalWorkspaceId);
              events.push(event);
            } catch (error) {
              logger.error(`Erreur lors de la création de l'événement pour la facture ${invoice._id}:`, error);
            }
          }
        }

        return {
          success: true,
          events,
          totalCount: events.length,
          message: `${events.length} événement(s) de facture synchronisé(s)`
        };
      } catch (error) {
        logger.error('Erreur lors de la synchronisation des événements de factures:', error);
        return {
          success: false,
          events: [],
          totalCount: 0,
          message: error.message || 'Erreur lors de la synchronisation des événements'
        };
      }
    })
  },

};

export default eventResolvers;
