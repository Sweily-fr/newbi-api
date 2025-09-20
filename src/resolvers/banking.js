import { bankingService } from '../services/banking/BankingService.js';
import { withWorkspace } from '../middlewares/better-auth-bearer.js';
import Transaction from '../models/Transaction.js';
import AccountBanking from '../models/AccountBanking.js';
import ApiMetric from '../models/ApiMetric.js';
import { AppError, ERROR_CODES } from '../utils/errors.js';

const bankingResolvers = {
  Query: {
    // Transactions
    transactions: withWorkspace(async (parent, { filters = {}, limit = 50, offset = 0 }, { user, workspaceId }) => {
      const query = { workspaceId, ...filters };
      return await Transaction.find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(offset)
        .populate('userId');
    }),

    transaction: withWorkspace(async (parent, { id }, { user, workspaceId }) => {
      const transaction = await Transaction.findOne({ _id: id, workspaceId }).populate('userId');
      if (!transaction) {
        throw new AppError('Transaction non trouvée', ERROR_CODES.NOT_FOUND);
      }
      return transaction;
    }),

    transactionByExternalId: withWorkspace(async (parent, { provider, externalId }, { user, workspaceId }) => {
      const transaction = await Transaction.findOne({ 
        provider, 
        externalId, 
        workspaceId 
      }).populate('userId');
      
      if (!transaction) {
        throw new AppError('Transaction non trouvée', ERROR_CODES.NOT_FOUND);
      }
      return transaction;
    }),

    // Comptes bancaires
    bankingAccounts: withWorkspace(async (parent, args, { user, workspaceId }) => {
      return await AccountBanking.findByWorkspace(workspaceId);
    }),

    bankingAccount: withWorkspace(async (parent, { id }, { user, workspaceId }) => {
      const account = await AccountBanking.findOne({ _id: id, workspaceId });
      if (!account) {
        throw new AppError('Compte bancaire non trouvé', ERROR_CODES.NOT_FOUND);
      }
      return account;
    }),

    accountBalance: withWorkspace(async (parent, { accountId }, { user, workspaceId }) => {
      try {
        await bankingService.initialize();
        return await bankingService.getAccountBalance(accountId, workspaceId);
      } catch (error) {
        throw new AppError(`Erreur lors de la récupération du solde: ${error.message}`, ERROR_CODES.EXTERNAL_API_ERROR);
      }
    }),

    // Métriques
    apiMetrics: withWorkspace(async (parent, { filters }, { user, workspaceId }) => {
      const query = { workspaceId };
      
      if (filters.provider) query.provider = filters.provider.toLowerCase();
      if (filters.startDate && filters.endDate) {
        query.date = { $gte: filters.startDate, $lte: filters.endDate };
      }
      
      return await ApiMetric.find(query).sort({ date: -1 });
    }),

    providerStats: withWorkspace(async (parent, { provider, startDate, endDate }, { user, workspaceId }) => {
      const stats = await ApiMetric.getProviderStats(provider.toLowerCase(), startDate, endDate);
      return stats[0] || {
        provider: provider.toUpperCase(),
        totalRequests: 0,
        totalCost: 0,
        avgResponseTime: 0,
        successRate: 0
      };
    }),

    costComparison: withWorkspace(async (parent, { startDate, endDate }, { user, workspaceId }) => {
      const comparison = await ApiMetric.getCostComparison(startDate, endDate);
      return comparison.map(item => ({
        ...item,
        provider: item._id.toUpperCase()
      }));
    }),

    // Historique des transactions
    transactionHistory: withWorkspace(async (parent, { accountId, filters = {} }, { user, workspaceId }) => {
      try {
        await bankingService.initialize();
        return await bankingService.getTransactionHistory(accountId, workspaceId, filters);
      } catch (error) {
        throw new AppError(`Erreur lors de la récupération de l'historique: ${error.message}`, ERROR_CODES.EXTERNAL_API_ERROR);
      }
    }),
  },

  Mutation: {
    // Traitement des paiements
    processPayment: withWorkspace(async (parent, { input }, { user, workspaceId }) => {
      try {
        await bankingService.initialize();
        
        const paymentOptions = {
          ...input,
          workspaceId,
          userId: user._id
        };
        
        const transaction = await bankingService.processPayment(paymentOptions);
        
        return {
          transaction,
          success: true,
          message: 'Paiement traité avec succès'
        };
      } catch (error) {
        console.error('Erreur lors du traitement du paiement:', error);
        return {
          transaction: null,
          success: false,
          message: error.message
        };
      }
    }),

    // Traitement des remboursements
    processRefund: withWorkspace(async (parent, { input }, { user, workspaceId }) => {
      try {
        await bankingService.initialize();
        
        const refundOptions = {
          ...input,
          workspaceId,
          userId: user._id
        };
        
        const transaction = await bankingService.processRefund(refundOptions);
        
        return {
          transaction,
          success: true,
          message: 'Remboursement traité avec succès'
        };
      } catch (error) {
        console.error('Erreur lors du traitement du remboursement:', error);
        return {
          transaction: null,
          success: false,
          message: error.message
        };
      }
    }),

    // Gestion des comptes
    createBankingAccount: withWorkspace(async (parent, { input }, { user, workspaceId }) => {
      try {
        await bankingService.initialize();
        
        const accountData = {
          ...input,
          workspaceId,
          userId: user._id
        };
        
        // Création via le provider actuel
        const providerAccount = await bankingService.currentProvider.createAccount(accountData);
        const standardAccount = bankingService.currentProvider.mapToStandardFormat(providerAccount, 'account');
        
        // Sauvegarde en base
        const account = new AccountBanking({
          ...standardAccount,
          provider: bankingService.currentProvider.providerName,
          workspaceId,
          userId: user._id,
          raw: providerAccount
        });
        
        await account.save();
        return account;
        
      } catch (error) {
        throw new AppError(`Erreur lors de la création du compte: ${error.message}`, ERROR_CODES.EXTERNAL_API_ERROR);
      }
    }),

    updateBankingAccount: withWorkspace(async (parent, { id, input }, { user, workspaceId }) => {
      const account = await AccountBanking.findOne({ _id: id, workspaceId });
      if (!account) {
        throw new AppError('Compte bancaire non trouvé', ERROR_CODES.NOT_FOUND);
      }
      
      // Mise à jour des champs locaux
      if (input.notifications) {
        account.notifications = { ...account.notifications, ...input.notifications };
      }
      if (input.limits) {
        account.limits = { ...account.limits, ...input.limits };
      }
      
      await account.save();
      return account;
    }),

    deleteBankingAccount: withWorkspace(async (parent, { id }, { user, workspaceId }) => {
      const account = await AccountBanking.findOne({ _id: id, workspaceId });
      if (!account) {
        throw new AppError('Compte bancaire non trouvé', ERROR_CODES.NOT_FOUND);
      }
      
      try {
        await bankingService.initialize();
        
        // Suppression via le provider si supporté
        try {
          await bankingService.currentProvider.deleteAccount(account.externalId);
        } catch (error) {
          console.warn('Suppression côté provider échouée:', error.message);
        }
        
        // Suppression locale
        await AccountBanking.deleteOne({ _id: id });
        return true;
        
      } catch (error) {
        throw new AppError(`Erreur lors de la suppression du compte: ${error.message}`, ERROR_CODES.EXTERNAL_API_ERROR);
      }
    }),

    syncAccountBalance: withWorkspace(async (parent, { accountId }, { user, workspaceId }) => {
      try {
        await bankingService.initialize();
        return await bankingService.getAccountBalance(accountId, workspaceId);
      } catch (error) {
        throw new AppError(`Erreur lors de la synchronisation: ${error.message}`, ERROR_CODES.EXTERNAL_API_ERROR);
      }
    }),

    // Administration
    switchBankingProvider: withWorkspace(async (parent, { provider }, { user, workspaceId }) => {
      try {
        await bankingService.switchProvider(provider.toLowerCase());
        return true;
      } catch (error) {
        throw new AppError(`Erreur lors du changement de provider: ${error.message}`, ERROR_CODES.EXTERNAL_API_ERROR);
      }
    }),

    syncTransactionHistory: withWorkspace(async (parent, { accountId }, { user, workspaceId }) => {
      try {
        await bankingService.initialize();
        return await bankingService.getTransactionHistory(accountId, workspaceId, { sync: true });
      } catch (error) {
        throw new AppError(`Erreur lors de la synchronisation: ${error.message}`, ERROR_CODES.EXTERNAL_API_ERROR);
      }
    }),
  },

  // Résolveurs de types
  Transaction: {
    userId: async (transaction) => {
      if (transaction.userId && typeof transaction.userId === 'object') {
        return transaction.userId; // Déjà populé
      }
      // Charger l'utilisateur si nécessaire
      const User = (await import('../models/User.js')).default;
      return await User.findById(transaction.userId);
    }
  },

  AccountBanking: {
    userId: async (account) => {
      if (account.userId && typeof account.userId === 'object') {
        return account.userId; // Déjà populé
      }
      const User = (await import('../models/User.js')).default;
      return await User.findById(account.userId);
    }
  },

  // Résolveurs d'enums
  BankingProvider: {
    BRIDGE: 'bridge',
    STRIPE: 'stripe',
    PAYPAL: 'paypal',
    MOCK: 'mock'
  },

  TransactionType: {
    PAYMENT: 'payment',
    REFUND: 'refund',
    TRANSFER: 'transfer',
    WITHDRAWAL: 'withdrawal',
    DEPOSIT: 'deposit'
  },

  TransactionStatus: {
    PENDING: 'pending',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    REFUNDED: 'refunded'
  },

  AccountType: {
    CHECKING: 'checking',
    SAVINGS: 'savings',
    CREDIT: 'credit',
    BUSINESS: 'business',
    INVESTMENT: 'investment'
  },

  AccountStatus: {
    ACTIVE: 'active',
    INACTIVE: 'inactive',
    SUSPENDED: 'suspended',
    CLOSED: 'closed'
  }
};

export default bankingResolvers;
