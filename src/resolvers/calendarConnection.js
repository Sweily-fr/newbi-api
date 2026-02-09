import CalendarConnection from '../models/CalendarConnection.js';
import { isAuthenticated } from '../middlewares/better-auth-jwt.js';
import { getCalendarProvider } from '../services/calendar/CalendarProviderFactory.js';
import {
  syncConnection,
  syncAllForUser,
  pushEventToCalendar,
  disconnectCalendar
} from '../services/calendar/CalendarSyncService.js';
import logger from '../utils/logger.js';

const calendarConnectionResolvers = {
  Query: {
    getCalendarConnections: async (_, __, { user }) => {
      if (!user) {
        return { success: false, message: 'Non authentifié', connections: [] };
      }

      try {
        const connections = await CalendarConnection.find({
          userId: user.id || user._id,
          status: { $ne: 'disconnected' }
        }).sort({ createdAt: -1 });

        return {
          success: true,
          connections: connections.map(c => ({
            id: c._id.toString(),
            userId: c.userId.toString(),
            provider: c.provider,
            status: c.status,
            accountEmail: c.accountEmail,
            accountName: c.accountName,
            selectedCalendars: c.selectedCalendars,
            lastSyncAt: c.lastSyncAt,
            lastSyncError: c.lastSyncError,
            autoSync: c.autoSync || false,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt
          })),
          message: `${connections.length} connexion(s) trouvée(s)`
        };
      } catch (error) {
        logger.error('Erreur getCalendarConnections:', error);
        return { success: false, message: 'Erreur lors de la récupération des connexions calendrier.', connections: [] };
      }
    },

    getAvailableCalendars: async (_, { connectionId }, { user }) => {
      if (!user) {
        return { success: false, message: 'Non authentifié', calendars: [] };
      }

      try {
        const connection = await CalendarConnection.findOne({
          _id: connectionId,
          userId: user.id || user._id
        });

        if (!connection) {
          return { success: false, message: 'Connexion non trouvée', calendars: [] };
        }

        const provider = getCalendarProvider(connection.provider);
        const calendars = await provider.listCalendars(connection);

        return {
          success: true,
          calendars,
          message: `${calendars.length} calendrier(s) disponible(s)`
        };
      } catch (error) {
        logger.error('Erreur getAvailableCalendars:', error);
        return { success: false, message: 'Erreur lors de la récupération des calendriers disponibles.', calendars: [] };
      }
    }
  },

  Mutation: {
    connectAppleCalendar: async (_, { input }, { user }) => {
      if (!user) {
        return { success: false, message: 'Non authentifié', connection: null };
      }

      try {
        const provider = getCalendarProvider('apple');

        // Validate credentials
        const validation = await provider.validateCredentials(
          input.username,
          input.appPassword,
          input.calDavUrl
        );

        if (!validation.valid) {
          return { success: false, message: `Identifiants invalides: ${validation.error}`, connection: null };
        }

        // Check for existing connection
        let connection = await CalendarConnection.findOne({
          userId: user.id || user._id,
          provider: 'apple'
        });

        if (connection) {
          connection.calDavUsername = input.username;
          connection.calDavPassword = input.appPassword;
          connection.calDavUrl = input.calDavUrl || null;
          connection.accountEmail = validation.email;
          connection.accountName = validation.name;
          connection.status = 'active';
          connection.lastSyncError = null;
          await connection.save();
        } else {
          connection = await CalendarConnection.create({
            userId: user.id || user._id,
            provider: 'apple',
            calDavUsername: input.username,
            calDavPassword: input.appPassword,
            calDavUrl: input.calDavUrl || null,
            accountEmail: validation.email,
            accountName: validation.name,
            status: 'active'
          });
        }

        // Fetch available calendars and select all
        let syncMessage = '';
        try {
          const calendars = await provider.listCalendars(connection);
          logger.info(`[connectAppleCalendar] ${calendars.length} calendrier(s) d'événements trouvé(s)`);
          // Apple CalDAV : activer tous les calendriers d'événements par défaut
          // (listCalendars filtre déjà les VTODO/rappels)
          connection.selectedCalendars = calendars.map(cal => ({
            calendarId: cal.calendarId,
            name: cal.name,
            color: cal.color,
            enabled: true
          }));
          await connection.save();
          const syncResult = await syncConnection(connection._id);
          syncMessage = ` (${syncResult.created} événement(s) synchronisé(s))`;
        } catch (syncError) {
          logger.warn('Initial Apple calendar sync failed:', syncError.message);
          syncMessage = '. Synchronisation initiale échouée, réessayez depuis le panneau calendrier.';
        }

        // Re-fetch connection pour avoir lastSyncAt à jour
        const updatedConnection = await CalendarConnection.findById(connection._id);

        return {
          success: true,
          message: `Calendrier Apple connecté avec succès${syncMessage}`,
          connection: {
            id: (updatedConnection || connection)._id.toString(),
            userId: (updatedConnection || connection).userId.toString(),
            provider: (updatedConnection || connection).provider,
            status: (updatedConnection || connection).status,
            accountEmail: (updatedConnection || connection).accountEmail,
            accountName: (updatedConnection || connection).accountName,
            selectedCalendars: (updatedConnection || connection).selectedCalendars,
            lastSyncAt: (updatedConnection || connection).lastSyncAt,
            lastSyncError: (updatedConnection || connection).lastSyncError,
            autoSync: (updatedConnection || connection).autoSync || false,
            createdAt: (updatedConnection || connection).createdAt,
            updatedAt: (updatedConnection || connection).updatedAt
          }
        };
      } catch (error) {
        logger.error('Erreur connectAppleCalendar:', error);
        return { success: false, message: 'Erreur lors de la connexion du calendrier Apple. Veuillez réessayer.', connection: null };
      }
    },

    disconnectCalendar: async (_, { connectionId }, { user }) => {
      if (!user) {
        return { success: false, message: 'Non authentifié', connection: null };
      }

      try {
        const connection = await CalendarConnection.findOne({
          _id: connectionId,
          userId: user.id || user._id
        });

        if (!connection) {
          return { success: false, message: 'Connexion non trouvée', connection: null };
        }

        const disconnected = await disconnectCalendar(connectionId);

        return {
          success: true,
          message: `Calendrier ${connection.provider} déconnecté`,
          connection: {
            id: disconnected._id.toString(),
            userId: disconnected.userId.toString(),
            provider: disconnected.provider,
            status: disconnected.status,
            accountEmail: disconnected.accountEmail,
            accountName: disconnected.accountName,
            selectedCalendars: disconnected.selectedCalendars,
            lastSyncAt: disconnected.lastSyncAt,
            lastSyncError: disconnected.lastSyncError,
            autoSync: disconnected.autoSync || false,
            createdAt: disconnected.createdAt,
            updatedAt: disconnected.updatedAt
          }
        };
      } catch (error) {
        logger.error('Erreur disconnectCalendar:', error);
        return { success: false, message: 'Erreur lors de la déconnexion du calendrier. Veuillez réessayer.', connection: null };
      }
    },

    updateSelectedCalendars: async (_, { input }, { user }) => {
      if (!user) {
        return { success: false, message: 'Non authentifié', connection: null };
      }

      try {
        const connection = await CalendarConnection.findOne({
          _id: input.connectionId,
          userId: user.id || user._id
        });

        if (!connection) {
          return { success: false, message: 'Connexion non trouvée', connection: null };
        }

        connection.selectedCalendars = input.selectedCalendars;
        await connection.save();

        // Re-sync with updated calendar selection
        try {
          await syncConnection(connection._id);
        } catch (syncError) {
          logger.warn('Re-sync after calendar selection update failed:', syncError.message);
        }

        return {
          success: true,
          message: 'Calendriers mis à jour',
          connection: {
            id: connection._id.toString(),
            userId: connection.userId.toString(),
            provider: connection.provider,
            status: connection.status,
            accountEmail: connection.accountEmail,
            accountName: connection.accountName,
            selectedCalendars: connection.selectedCalendars,
            lastSyncAt: connection.lastSyncAt,
            lastSyncError: connection.lastSyncError,
            autoSync: connection.autoSync || false,
            createdAt: connection.createdAt,
            updatedAt: connection.updatedAt
          }
        };
      } catch (error) {
        logger.error('Erreur updateSelectedCalendars:', error);
        return { success: false, message: 'Erreur lors de la mise à jour des calendriers. Veuillez réessayer.', connection: null };
      }
    },

    syncCalendar: async (_, { connectionId }, { user }) => {
      if (!user) {
        return { success: false, message: 'Non authentifié', syncedCount: 0, connection: null };
      }

      try {
        const connection = await CalendarConnection.findOne({
          _id: connectionId,
          userId: user.id || user._id
        });

        if (!connection) {
          return { success: false, message: 'Connexion non trouvée', syncedCount: 0, connection: null };
        }

        const result = await syncConnection(connectionId);

        const updatedConnection = await CalendarConnection.findById(connectionId);

        return {
          success: true,
          message: `Synchronisation terminée: ${result.created} ajouté(s), ${result.updated} mis à jour, ${result.deleted} supprimé(s)`,
          syncedCount: result.total,
          connection: {
            id: updatedConnection._id.toString(),
            userId: updatedConnection.userId.toString(),
            provider: updatedConnection.provider,
            status: updatedConnection.status,
            accountEmail: updatedConnection.accountEmail,
            accountName: updatedConnection.accountName,
            selectedCalendars: updatedConnection.selectedCalendars,
            lastSyncAt: updatedConnection.lastSyncAt,
            lastSyncError: updatedConnection.lastSyncError,
            autoSync: updatedConnection.autoSync || false,
            createdAt: updatedConnection.createdAt,
            updatedAt: updatedConnection.updatedAt
          }
        };
      } catch (error) {
        logger.error('Erreur syncCalendar:', error);
        // L'erreur est déjà traduite par CalendarSyncService
        return { success: false, message: error.message || 'Erreur lors de la synchronisation du calendrier.', syncedCount: 0, connection: null };
      }
    },

    syncAllCalendars: async (_, __, { user }) => {
      if (!user) {
        return { success: false, message: 'Non authentifié', syncedCount: 0, connection: null };
      }

      try {
        const results = await syncAllForUser(user.id || user._id);
        const totalSynced = results.reduce((sum, r) => sum + (r.total || 0), 0);
        const successCount = results.filter(r => r.success).length;

        return {
          success: true,
          message: `${successCount}/${results.length} calendrier(s) synchronisé(s)`,
          syncedCount: totalSynced,
          connection: null
        };
      } catch (error) {
        logger.error('Erreur syncAllCalendars:', error);
        return { success: false, message: 'Erreur lors de la synchronisation des calendriers. Veuillez réessayer.', syncedCount: 0, connection: null };
      }
    },

    pushEventToCalendar: async (_, { input }, { user }) => {
      if (!user) {
        return { success: false, message: 'Non authentifié', connection: null };
      }

      try {
        // Verify the connection belongs to the user
        const connection = await CalendarConnection.findOne({
          _id: input.connectionId,
          userId: user.id || user._id
        });

        if (!connection) {
          return { success: false, message: 'Connexion non trouvée', connection: null };
        }

        await pushEventToCalendar(input.eventId, input.connectionId);

        return {
          success: true,
          message: `Événement envoyé vers ${connection.provider}`,
          connection: {
            id: connection._id.toString(),
            userId: connection.userId.toString(),
            provider: connection.provider,
            status: connection.status,
            accountEmail: connection.accountEmail,
            accountName: connection.accountName,
            selectedCalendars: connection.selectedCalendars,
            lastSyncAt: connection.lastSyncAt,
            lastSyncError: connection.lastSyncError,
            autoSync: connection.autoSync || false,
            createdAt: connection.createdAt,
            updatedAt: connection.updatedAt
          }
        };
      } catch (error) {
        logger.error('Erreur pushEventToCalendar:', error);
        return { success: false, message: 'Erreur lors de l\'envoi de l\'événement vers le calendrier externe.', connection: null };
      }
    },

    updateAutoSync: async (_, { input }, { user }) => {
      if (!user) {
        return { success: false, message: 'Non authentifié', connection: null };
      }

      try {
        const connection = await CalendarConnection.findOne({
          _id: input.connectionId,
          userId: user.id || user._id
        });

        if (!connection) {
          return { success: false, message: 'Connexion non trouvée', connection: null };
        }

        connection.autoSync = input.enabled;
        await connection.save();

        return {
          success: true,
          message: input.enabled ? 'Synchronisation automatique activée' : 'Synchronisation automatique désactivée',
          connection: {
            id: connection._id.toString(),
            userId: connection.userId.toString(),
            provider: connection.provider,
            status: connection.status,
            accountEmail: connection.accountEmail,
            accountName: connection.accountName,
            selectedCalendars: connection.selectedCalendars,
            lastSyncAt: connection.lastSyncAt,
            lastSyncError: connection.lastSyncError,
            autoSync: connection.autoSync,
            createdAt: connection.createdAt,
            updatedAt: connection.updatedAt
          }
        };
      } catch (error) {
        logger.error('Erreur updateAutoSync:', error);
        return { success: false, message: 'Erreur lors de la mise à jour de la synchronisation automatique.', connection: null };
      }
    }
  }
};

export default calendarConnectionResolvers;
