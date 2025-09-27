import Event from '../models/Event.js';
import Invoice from '../models/Invoice.js';
import { isAuthenticated, withWorkspace } from '../middlewares/better-auth-jwt.js';

const eventResolvers = {
  Event: {
    // Mapper le champ invoiceId populé vers invoice pour la compatibilité GraphQL
    invoice: (parent) => parent.invoiceId,
    // Convertir l'ObjectId en string pour GraphQL
    invoiceId: (parent) => parent.invoiceId ? parent.invoiceId._id?.toString() || parent.invoiceId.toString() : null,
  },
  
  Query: {
    getEvents: withWorkspace(async (_, { startDate, endDate, type, limit = 100, offset = 0, workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
      try {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        

        // Construire le filtre
        const filter = { workspaceId: finalWorkspaceId };
        
        if (type) {
          filter.type = type;
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
            invoiceId: event.invoiceId ? event.invoiceId._id?.toString() || event.invoiceId.toString() : null
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


        return {
          success: true,
          events: serializedEvents,
          totalCount,
          message: `${events.length} événement(s) récupéré(s)`
        };
      } catch (error) {
        console.error('Erreur lors de la récupération des événements:', error);
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

        const event = await Event.findOne({ _id: id, workspaceId: finalWorkspaceId })
          .populate('invoiceId');

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
        console.error('Erreur lors de la récupération de l\'événement:', error);
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

        await event.save();

        return {
          success: true,
          event,
          message: 'Événement créé avec succès'
        };
      } catch (error) {
        console.error('Erreur lors de la création de l\'événement:', error);
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

        return {
          success: true,
          event,
          message: 'Événement mis à jour avec succès'
        };
      } catch (error) {
        console.error('Erreur lors de la mise à jour de l\'événement:', error);
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
        console.error('Erreur lors de la suppression de l\'événement:', error);
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
              console.error(`Erreur lors de la création de l'événement pour la facture ${invoice._id}:`, error);
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
        console.error('Erreur lors de la synchronisation des événements de factures:', error);
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
