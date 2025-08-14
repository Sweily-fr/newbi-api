import Event from '../models/Event.js';
import Invoice from '../models/Invoice.js';
import { isAuthenticated } from '../middlewares/auth.js';

const eventResolvers = {
  Event: {
    // Mapper le champ invoiceId populé vers invoice pour la compatibilité GraphQL
    invoice: (parent) => parent.invoiceId,
  },
  
  Query: {
    getEvents: async (_, { startDate, endDate, type, limit = 100, offset = 0 }, context) => {
      try {
        await isAuthenticated(context);
        const userId = context.user.id;

        // Construire le filtre
        const filter = { userId };
        
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
          .populate('invoiceId')
          .sort({ start: 1 })
          .limit(limit)
          .skip(offset);

        const totalCount = await Event.countDocuments(filter);

        return {
          success: true,
          events,
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
    },

    getEvent: async (_, { id }, context) => {
      try {
        await isAuthenticated(context);
        const userId = context.user.id;

        const event = await Event.findOne({ _id: id, userId })
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
    }
  },

  Mutation: {
    createEvent: async (_, { input }, context) => {
      try {
        await isAuthenticated(context);
        const userId = context.user.id;

        const event = new Event({
          ...input,
          userId
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
    },

    updateEvent: async (_, { input }, context) => {
      try {
        await isAuthenticated(context);
        const userId = context.user.id;

        const { id, ...updateData } = input;

        const event = await Event.findOneAndUpdate(
          { _id: id, userId },
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
    },

    deleteEvent: async (_, { id }, context) => {
      try {
        await isAuthenticated(context);
        const userId = context.user.id;

        const event = await Event.findOneAndDelete({ _id: id, userId });

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
    },

    syncInvoiceEvents: async (_, __, context) => {
      try {
        await isAuthenticated(context);
        const userId = context.user.id;

        // Récupérer toutes les factures de l'utilisateur
        const invoices = await Invoice.find({ userId });

        const events = [];
        
        for (const invoice of invoices) {
          if (invoice.dueDate) {
            try {
              const event = await Event.createInvoiceDueEvent(invoice, userId);
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
    }
  },

  Event: {
    id: (event) => event._id.toString(),
    userId: (event) => event.userId.toString(),
    invoiceId: (event) => event.invoiceId ? event.invoiceId.toString() : null,
  }
};

export default eventResolvers;
