import { isAuthenticated } from '../middlewares/better-auth.js';
import User from '../models/User.js';
import EmailLog from '../models/EmailLog.js';
import emailReminderService from '../services/emailReminderService.js';
import Event from '../models/Event.js';
import logger from '../utils/logger.js';

const emailReminderResolvers = {
  Query: {
    /**
     * Récupère les préférences email de l'utilisateur
     */
    getEmailPreferences: isAuthenticated(async (_, __, { user }) => {
      try {
        const dbUser = await User.findById(user._id);
        
        if (!dbUser) {
          throw new Error('Utilisateur non trouvé');
        }

        // Retourner les préférences ou valeurs par défaut
        const emailPreferences = dbUser.emailPreferences || {};
        const reminders = emailPreferences.reminders || {};

        return {
          enabled: reminders.enabled || false,
          types: reminders.types || ['due', 'anticipated'],
          doNotDisturb: reminders.doNotDisturb || {
            weekday: { start: '22:00', end: '08:00' },
            weekend: { start: '22:00', end: '10:00' }
          }
        };
      } catch (error) {
        logger.error('Erreur lors de la récupération des préférences email:', error);
        throw error;
      }
    }),

    /**
     * Récupère les logs d'emails pour une organisation
     */
    getEmailLogs: isAuthenticated(async (_, { workspaceId, status, limit = 30, offset = 0 }, { user }) => {
      try {
        const query = { workspaceId };
        
        if (status) {
          query.status = status;
        }

        const logs = await EmailLog.find(query)
          .sort({ createdAt: -1 })
          .limit(limit)
          .skip(offset)
          .populate('eventId', 'title description start end')
          .populate('recipientUserId', 'name email');

        const totalCount = await EmailLog.countDocuments(query);

        return {
          logs: logs.map(log => ({
            id: log._id.toString(),
            eventId: log.eventId?._id.toString(),
            workspaceId: log.workspaceId.toString(),
            recipientEmail: log.recipientEmail,
            recipientUserId: log.recipientUserId._id.toString(),
            reminderType: log.reminderType,
            anticipation: log.anticipation,
            status: log.status,
            sentAt: log.sentAt.toISOString(),
            scheduledFor: log.scheduledFor.toISOString(),
            failureReason: log.failureReason,
            deferredReason: log.deferredReason,
            eventSnapshot: log.eventSnapshot ? {
              title: log.eventSnapshot.title,
              description: log.eventSnapshot.description,
              start: log.eventSnapshot.start?.toISOString(),
              end: log.eventSnapshot.end?.toISOString()
            } : null,
            createdAt: log.createdAt.toISOString()
          })),
          totalCount,
          hasMore: totalCount > offset + limit
        };
      } catch (error) {
        logger.error('Erreur lors de la récupération des logs d\'emails:', error);
        throw error;
      }
    }),

    /**
     * Teste l'envoi d'un email de rappel
     */
    testEmailReminder: isAuthenticated(async (_, { eventId }, { user }) => {
      try {
        const event = await Event.findById(eventId);
        
        if (!event) {
          return {
            success: false,
            message: 'Événement non trouvé'
          };
        }

        if (event.userId.toString() !== user._id.toString()) {
          return {
            success: false,
            message: 'Vous n\'êtes pas autorisé à tester cet événement'
          };
        }

        const reminderType = event.emailReminder?.anticipation ? 'anticipated' : 'due';
        const result = await emailReminderService.sendReminder(
          eventId,
          reminderType,
          event.emailReminder?.anticipation
        );

        if (result.success) {
          return {
            success: true,
            message: 'Email de test envoyé avec succès'
          };
        } else {
          return {
            success: false,
            message: result.reason || 'Échec de l\'envoi de l\'email de test'
          };
        }
      } catch (error) {
        logger.error('Erreur lors du test d\'email:', error);
        return {
          success: false,
          message: error.message
        };
      }
    })
  },

  Mutation: {
    /**
     * Met à jour les préférences email de l'utilisateur
     */
    updateEmailPreferences: isAuthenticated(async (_, { input }, { user }) => {
      try {
        const dbUser = await User.findById(user._id);
        
        if (!dbUser) {
          return {
            success: false,
            message: 'Utilisateur non trouvé'
          };
        }

        // Initialiser emailPreferences si nécessaire
        if (!dbUser.emailPreferences) {
          dbUser.emailPreferences = {};
        }

        // Mettre à jour les préférences de rappels
        dbUser.emailPreferences.reminders = {
          enabled: input.enabled,
          types: input.types || ['due', 'anticipated'],
          doNotDisturb: input.doNotDisturb || {
            weekday: { start: '22:00', end: '08:00' },
            weekend: { start: '22:00', end: '10:00' }
          }
        };

        await dbUser.save();

        logger.info(`Préférences email mises à jour pour ${user.email}`);

        return {
          success: true,
          message: 'Préférences enregistrées avec succès'
        };
      } catch (error) {
        logger.error('Erreur lors de la mise à jour des préférences email:', error);
        return {
          success: false,
          message: error.message
        };
      }
    }),

    /**
     * Envoie un email de test
     */
    sendTestEmail: isAuthenticated(async (_, __, { user }) => {
      try {
        const dbUser = await User.findById(user._id);
        
        if (!dbUser || !dbUser.email) {
          return {
            success: false,
            message: 'Utilisateur ou email non trouvé'
          };
        }

        // Créer un événement de test temporaire
        const testEvent = {
          _id: 'test',
          title: 'Exemple de tâche',
          description: 'Ceci est un email de test pour vérifier que vos rappels fonctionnent correctement.',
          start: new Date(),
          end: new Date(),
          allDay: false,
          location: 'Paris, France',
          userId: dbUser
        };

        const { subject, html } = emailReminderService.generateEmailContent(testEvent, 'due');

        logger.info(`📧 Tentative d'envoi d'email de test à ${dbUser.email}`);

        await emailReminderService.sendEmail({
          to: dbUser.email,
          subject: `[TEST] ${subject}`,
          html
        });

        logger.info(`✅ Email de test envoyé avec succès à ${dbUser.email}`);

        return {
          success: true,
          message: `Email de test envoyé à ${dbUser.email}`
        };
      } catch (error) {
        logger.error('Erreur lors de l\'envoi de l\'email de test:', error);
        return {
          success: false,
          message: error.message
        };
      }
    })
  }
};

export default emailReminderResolvers;
