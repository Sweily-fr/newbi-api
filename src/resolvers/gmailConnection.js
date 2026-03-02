import GmailConnection from '../models/GmailConnection.js';
import ImportedInvoice from '../models/ImportedInvoice.js';
import { isAuthenticated } from '../middlewares/better-auth-jwt.js';
import { scanGmailConnection } from '../services/gmail/GmailScannerService.js';
import logger from '../utils/logger.js';

function formatConnection(c) {
  return {
    id: c._id.toString(),
    accountEmail: c.accountEmail,
    accountName: c.accountName,
    isActive: c.isActive,
    scanPeriodMonths: c.scanPeriodMonths,
    status: c.status,
    lastSyncAt: c.lastSyncAt?.toISOString() || null,
    lastSyncError: c.lastSyncError,
    totalEmailsScanned: c.totalEmailsScanned,
    totalInvoicesFound: c.totalInvoicesFound,
    createdAt: c.createdAt?.toISOString() || null,
  };
}

const gmailConnectionResolvers = {
  Query: {
    gmailConnection: isAuthenticated(async (_, { workspaceId }, { user }) => {
      try {
        const connection = await GmailConnection.findOne({
          userId: user.id || user._id,
          workspaceId,
          status: { $ne: 'disconnected' },
        });

        if (!connection) return null;
        return formatConnection(connection);
      } catch (error) {
        logger.error('Erreur gmailConnection query:', error);
        return null;
      }
    }),

    gmailSyncStats: isAuthenticated(async (_, { workspaceId }, { user }) => {
      try {
        const connection = await GmailConnection.findOne({
          userId: user.id || user._id,
          workspaceId,
          status: { $ne: 'disconnected' },
        });

        if (!connection) {
          return {
            totalEmailsScanned: 0,
            totalInvoicesFound: 0,
            pendingReview: 0,
            lastSyncAt: null,
          };
        }

        const pendingReview = await ImportedInvoice.countDocuments({
          workspaceId,
          source: 'GMAIL',
          status: 'PENDING_REVIEW',
        });

        return {
          totalEmailsScanned: connection.totalEmailsScanned,
          totalInvoicesFound: connection.totalInvoicesFound,
          pendingReview,
          lastSyncAt: connection.lastSyncAt?.toISOString() || null,
        };
      } catch (error) {
        logger.error('Erreur gmailSyncStats query:', error);
        return {
          totalEmailsScanned: 0,
          totalInvoicesFound: 0,
          pendingReview: 0,
          lastSyncAt: null,
        };
      }
    }),
  },

  Mutation: {
    disconnectGmail: isAuthenticated(async (_, { connectionId }, { user }) => {
      const connection = await GmailConnection.findOne({
        _id: connectionId,
        userId: user.id || user._id,
      });

      if (!connection) {
        throw new Error('Connexion Gmail introuvable');
      }

      connection.status = 'disconnected';
      connection.isActive = false;
      connection.accessToken = null;
      connection.refreshToken = null;
      await connection.save();

      logger.info(`Gmail déconnecté pour user ${user.id || user._id} (${connection.accountEmail})`);
      return formatConnection(connection);
    }),

    triggerGmailSync: isAuthenticated(async (_, { connectionId }, { user }) => {
      const connection = await GmailConnection.findOne({
        _id: connectionId,
        userId: user.id || user._id,
      });

      if (!connection) {
        throw new Error('Connexion Gmail introuvable');
      }

      if (connection.status === 'syncing') {
        return {
          success: false,
          scannedCount: 0,
          invoicesFound: 0,
          skippedCount: 0,
          message: 'Une synchronisation est déjà en cours',
        };
      }

      const result = await scanGmailConnection(connectionId);
      return result;
    }),

    updateGmailScanPeriod: isAuthenticated(async (_, { connectionId, scanPeriodMonths }, { user }) => {
      const connection = await GmailConnection.findOne({
        _id: connectionId,
        userId: user.id || user._id,
      });

      if (!connection) {
        throw new Error('Connexion Gmail introuvable');
      }

      connection.scanPeriodMonths = Math.min(Math.max(scanPeriodMonths, 1), 12);
      await connection.save();

      return formatConnection(connection);
    }),
  },
};

export default gmailConnectionResolvers;
