import { bankingService } from "../services/banking/BankingService.js";
import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import Transaction from "../models/Transaction.js";
import AccountBanking from "../models/AccountBanking.js";
import ApiMetric from "../models/ApiMetric.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";

const bankingResolvers = {
  Query: {
    // Transactions - workspaceId passé en argument (comme les factures)
    transactions: withWorkspace(
      async (
        parent,
        { workspaceId, filters = {}, limit = 50, offset = 0 },
        { user }
      ) => {
        const query = { workspaceId };

        // Appliquer les filtres
        if (filters.type) query.type = filters.type;
        if (filters.status) query.status = filters.status;
        if (filters.minAmount)
          query.amount = { ...query.amount, $gte: filters.minAmount };
        if (filters.maxAmount)
          query.amount = { ...query.amount, $lte: filters.maxAmount };
        if (filters.startDate || filters.endDate) {
          query.date = {};
          if (filters.startDate) query.date.$gte = new Date(filters.startDate);
          if (filters.endDate) query.date.$lte = new Date(filters.endDate);
        }
        if (filters.accountId) query.fromAccount = filters.accountId;

        return await Transaction.find(query)
          .sort({ date: -1, createdAt: -1 })
          .limit(limit)
          .skip(offset)
          .lean();
      }
    ),

    transaction: withWorkspace(
      async (parent, { id }, { user, workspaceId }) => {
        const transaction = await Transaction.findOne({
          _id: id,
          workspaceId,
        }).populate("userId");
        if (!transaction) {
          throw new AppError("Transaction non trouvée", ERROR_CODES.NOT_FOUND);
        }
        return transaction;
      }
    ),

    transactionByExternalId: withWorkspace(
      async (parent, { provider, externalId }, { user, workspaceId }) => {
        const transaction = await Transaction.findOne({
          provider,
          externalId,
          workspaceId,
        }).populate("userId");

        if (!transaction) {
          throw new AppError("Transaction non trouvée", ERROR_CODES.NOT_FOUND);
        }
        return transaction;
      }
    ),

    // Comptes bancaires - workspaceId passé en argument
    bankingAccounts: withWorkspace(
      async (parent, { workspaceId }, { user }) => {
        return await AccountBanking.findByWorkspace(workspaceId);
      }
    ),

    bankingAccount: withWorkspace(
      async (parent, { id }, { user, workspaceId }) => {
        const account = await AccountBanking.findOne({ _id: id, workspaceId });
        if (!account) {
          throw new AppError(
            "Compte bancaire non trouvé",
            ERROR_CODES.NOT_FOUND
          );
        }
        return account;
      }
    ),

    accountBalance: withWorkspace(
      async (parent, { accountId }, { user, workspaceId }) => {
        try {
          await bankingService.initialize();
          return await bankingService.getAccountBalance(accountId, workspaceId);
        } catch (error) {
          throw new AppError(
            `Erreur lors de la récupération du solde: ${error.message}`,
            ERROR_CODES.EXTERNAL_API_ERROR
          );
        }
      }
    ),

    // Métriques
    apiMetrics: withWorkspace(
      async (parent, { filters }, { user, workspaceId }) => {
        const query = { workspaceId };

        if (filters.provider) query.provider = filters.provider.toLowerCase();
        if (filters.startDate && filters.endDate) {
          query.date = { $gte: filters.startDate, $lte: filters.endDate };
        }

        return await ApiMetric.find(query).sort({ date: -1 });
      }
    ),

    providerStats: withWorkspace(
      async (
        parent,
        { provider, startDate, endDate },
        { user, workspaceId }
      ) => {
        const stats = await ApiMetric.getProviderStats(
          provider.toLowerCase(),
          startDate,
          endDate
        );
        return (
          stats[0] || {
            provider: provider.toUpperCase(),
            totalRequests: 0,
            totalCost: 0,
            avgResponseTime: 0,
            successRate: 0,
          }
        );
      }
    ),

    costComparison: withWorkspace(
      async (parent, { startDate, endDate }, { user, workspaceId }) => {
        const comparison = await ApiMetric.getCostComparison(
          startDate,
          endDate
        );
        return comparison.map((item) => ({
          ...item,
          provider: item._id.toUpperCase(),
        }));
      }
    ),

    // Historique des transactions
    transactionHistory: withWorkspace(
      async (parent, { accountId, filters = {} }, { user, workspaceId }) => {
        try {
          await bankingService.initialize();
          return await bankingService.getTransactionHistory(
            accountId,
            workspaceId,
            filters
          );
        } catch (error) {
          throw new AppError(
            `Erreur lors de la récupération de l'historique: ${error.message}`,
            ERROR_CODES.EXTERNAL_API_ERROR
          );
        }
      }
    ),
  },

  Mutation: {
    // Créer une transaction manuelle
    createTransaction: withWorkspace(async (parent, { input }, { user }) => {
      const { v4: uuidv4 } = await import("uuid");

      // Normaliser la catégorie (fallback "OTHER" si non spécifiée)
      const category = input.category || "OTHER";

      const transaction = new Transaction({
        externalId: `manual-${uuidv4()}`,
        provider: "manual",
        type: input.type?.toLowerCase() || "debit",
        status: "completed",
        amount: input.amount,
        currency: input.currency || "EUR",
        description: input.description,
        workspaceId: input.workspaceId,
        userId: user._id,
        date: input.date || new Date(),
        category: category,          // Catégorie pour l'affichage
        expenseCategory: category,   // Catégorie pour le reporting
        metadata: {
          vendor: input.vendor,
          notes: input.notes,
          tags: input.tags,
          source: "MANUAL",
        },
      });

      await transaction.save();
      return transaction;
    }),

    // Mettre à jour une transaction
    updateTransaction: withWorkspace(
      async (parent, { id, input }, { user, workspaceId }) => {
        const updateData = {};

        if (input.amount !== undefined) updateData.amount = input.amount;
        if (input.currency) updateData.currency = input.currency;
        if (input.description) updateData.description = input.description;
        if (input.type) updateData.type = input.type.toLowerCase();
        if (input.date) updateData.date = input.date;
        if (input.category) {
          updateData.category = input.category;         // Catégorie pour l'affichage
          updateData.expenseCategory = input.category;  // Catégorie pour le reporting
        }
        if (input.vendor) updateData["metadata.vendor"] = input.vendor;
        if (input.notes) updateData["metadata.notes"] = input.notes;
        if (input.tags) updateData["metadata.tags"] = input.tags;

        const transaction = await Transaction.findOneAndUpdate(
          { _id: id, workspaceId },
          { $set: updateData },
          { new: true }
        );

        if (!transaction) {
          throw new AppError("Transaction non trouvée", ERROR_CODES.NOT_FOUND);
        }

        return transaction;
      }
    ),

    // Supprimer une transaction
    deleteTransaction: withWorkspace(
      async (parent, { id }, { user, workspaceId }) => {
        const transaction = await Transaction.findOneAndDelete({
          _id: id,
          workspaceId,
          provider: "manual", // Seules les transactions manuelles peuvent être supprimées
        });

        if (!transaction) {
          throw new AppError(
            "Transaction non trouvée ou non supprimable",
            ERROR_CODES.NOT_FOUND
          );
        }

        return true;
      }
    ),

    // Traitement des paiements
    processPayment: withWorkspace(
      async (parent, { input }, { user, workspaceId }) => {
        try {
          await bankingService.initialize();

          const paymentOptions = {
            ...input,
            workspaceId,
            userId: user._id,
          };

          const transaction =
            await bankingService.processPayment(paymentOptions);

          return {
            transaction,
            success: true,
            message: "Paiement traité avec succès",
          };
        } catch (error) {
          console.error("Erreur lors du traitement du paiement:", error);
          return {
            transaction: null,
            success: false,
            message: error.message,
          };
        }
      }
    ),

    // Traitement des remboursements
    processRefund: withWorkspace(
      async (parent, { input }, { user, workspaceId }) => {
        try {
          await bankingService.initialize();

          const refundOptions = {
            ...input,
            workspaceId,
            userId: user._id,
          };

          const transaction = await bankingService.processRefund(refundOptions);

          return {
            transaction,
            success: true,
            message: "Remboursement traité avec succès",
          };
        } catch (error) {
          console.error("Erreur lors du traitement du remboursement:", error);
          return {
            transaction: null,
            success: false,
            message: error.message,
          };
        }
      }
    ),

    // Gestion des comptes
    createBankingAccount: withWorkspace(
      async (parent, { input }, { user, workspaceId }) => {
        // Vérifier que l'email est vérifié
        if (!user.isEmailVerified && !user.emailVerified) {
          throw new AppError(
            "Veuillez vérifier votre adresse email avant de connecter un compte bancaire",
            ERROR_CODES.EMAIL_NOT_VERIFIED
          );
        }

        try {
          await bankingService.initialize();

          const accountData = {
            ...input,
            workspaceId,
            userId: user._id,
          };

          // Création via le provider actuel
          const providerAccount =
            await bankingService.currentProvider.createAccount(accountData);
          const standardAccount =
            bankingService.currentProvider.mapToStandardFormat(
              providerAccount,
              "account"
            );

          // Sauvegarde en base
          const account = new AccountBanking({
            ...standardAccount,
            provider: bankingService.currentProvider.providerName,
            workspaceId,
            userId: user._id,
            raw: providerAccount,
          });

          await account.save();
          return account;
        } catch (error) {
          throw new AppError(
            `Erreur lors de la création du compte: ${error.message}`,
            ERROR_CODES.EXTERNAL_API_ERROR
          );
        }
      }
    ),

    updateBankingAccount: withWorkspace(
      async (parent, { id, input }, { user, workspaceId }) => {
        const account = await AccountBanking.findOne({ _id: id, workspaceId });
        if (!account) {
          throw new AppError(
            "Compte bancaire non trouvé",
            ERROR_CODES.NOT_FOUND
          );
        }

        // Mise à jour des champs locaux
        if (input.notifications) {
          account.notifications = {
            ...account.notifications,
            ...input.notifications,
          };
        }
        if (input.limits) {
          account.limits = { ...account.limits, ...input.limits };
        }

        await account.save();
        return account;
      }
    ),

    deleteBankingAccount: withWorkspace(
      async (parent, { id }, { user, workspaceId }) => {
        const account = await AccountBanking.findOne({ _id: id, workspaceId });
        if (!account) {
          throw new AppError(
            "Compte bancaire non trouvé",
            ERROR_CODES.NOT_FOUND
          );
        }

        try {
          await bankingService.initialize();

          // Suppression via le provider si supporté
          try {
            await bankingService.currentProvider.deleteAccount(
              account.externalId
            );
          } catch (error) {
            console.warn("Suppression côté provider échouée:", error.message);
          }

          // Suppression locale
          await AccountBanking.deleteOne({ _id: id });
          return true;
        } catch (error) {
          throw new AppError(
            `Erreur lors de la suppression du compte: ${error.message}`,
            ERROR_CODES.EXTERNAL_API_ERROR
          );
        }
      }
    ),

    syncAccountBalance: withWorkspace(
      async (parent, { accountId }, { user, workspaceId }) => {
        try {
          await bankingService.initialize();
          return await bankingService.getAccountBalance(accountId, workspaceId);
        } catch (error) {
          throw new AppError(
            `Erreur lors de la synchronisation: ${error.message}`,
            ERROR_CODES.EXTERNAL_API_ERROR
          );
        }
      }
    ),

    // Administration
    switchBankingProvider: withWorkspace(
      async (parent, { provider }, { user, workspaceId }) => {
        try {
          await bankingService.switchProvider(provider.toLowerCase());
          return true;
        } catch (error) {
          throw new AppError(
            `Erreur lors du changement de provider: ${error.message}`,
            ERROR_CODES.EXTERNAL_API_ERROR
          );
        }
      }
    ),

    syncTransactionHistory: withWorkspace(
      async (parent, { accountId }, { user, workspaceId }) => {
        try {
          await bankingService.initialize();
          return await bankingService.getTransactionHistory(
            accountId,
            workspaceId,
            { sync: true }
          );
        } catch (error) {
          throw new AppError(
            `Erreur lors de la synchronisation: ${error.message}`,
            ERROR_CODES.EXTERNAL_API_ERROR
          );
        }
      }
    ),

    /**
     * Synchronisation complète des transactions avec options avancées
     * @param {Object} input - Options de synchronisation
     * @param {string} input.accountId - ID du compte (optionnel, tous les comptes si non spécifié)
     * @param {string} input.since - Date de début YYYY-MM-DD (optionnel, défaut 90 jours)
     * @param {string} input.until - Date de fin YYYY-MM-DD (optionnel, défaut aujourd'hui)
     * @param {boolean} input.fullSync - Force sync complète sans limite de pages
     */
    syncAllTransactions: withWorkspace(
      async (parent, { input = {} }, { user, workspaceId }) => {
        try {
          await bankingService.initialize("bridge");
          const provider = bankingService.currentProvider;

          let result;
          if (input.accountId) {
            // Sync d'un compte spécifique
            const transactions = await provider.getTransactions(
              input.accountId,
              user._id.toString(),
              workspaceId,
              {
                since: input.since,
                until: input.until,
                fullSync: input.fullSync,
              }
            );
            result = {
              success: true,
              accounts: 1,
              transactions: transactions.length,
              successfulAccounts: 1,
              failedAccounts: 0,
              failedAccountNames: [],
              period: {
                since: input.since || provider._getDefaultDateRange().since,
                until: input.until || provider._getDefaultDateRange().until,
              },
            };
          } else {
            // Sync de tous les comptes
            result = await provider.syncAllTransactions(
              user._id.toString(),
              workspaceId,
              {
                since: input.since,
                until: input.until,
                fullSync: input.fullSync,
              }
            );
            result.success = true;
          }

          return result;
        } catch (error) {
          throw new AppError(
            `Erreur lors de la synchronisation: ${error.message}`,
            ERROR_CODES.EXTERNAL_API_ERROR
          );
        }
      }
    ),
  },

  // Résolveurs de types
  Transaction: {
    id: (parent) => parent._id?.toString() || parent.id,
    // Les enum resolvers gèrent la conversion - garder en minuscules
    status: (parent) => (parent.status || "pending").toLowerCase(),
    type: (parent) => (parent.type || "debit").toLowerCase(),
    provider: (parent) => (parent.provider || "bridge").toLowerCase(),
    // Champ date pour le tri et l'affichage
    date: (parent) => parent.date || parent.createdAt,
    // Champs avec valeurs par défaut pour éviter les erreurs non-null
    externalId: (parent) => parent.externalId || "",
    amount: (parent) => parent.amount ?? 0,
    currency: (parent) => parent.currency || "EUR",
    description: (parent) => parent.description || "",
    // Fees avec valeurs par défaut pour éviter null sur les champs non-null
    fees: (parent) => {
      if (!parent.fees) return null;
      return {
        amount: parent.fees.amount ?? 0,
        currency: parent.fees.currency || "EUR",
        provider: parent.fees.provider || null,
      };
    },
    // Champs de rapprochement
    linkedInvoiceId: (parent) => parent.linkedInvoiceId?.toString() || null,
    linkedExpenseId: (parent) => parent.linkedExpenseId?.toString() || null,
    reconciliationStatus: (parent) => {
      const status = parent.reconciliationStatus || "unmatched";
      return status.toUpperCase();
    },
    reconciliationDate: (parent) => parent.reconciliationDate || null,
    // Resolver pour la facture liée (charge les détails de la facture)
    linkedInvoice: async (parent) => {
      if (!parent.linkedInvoiceId) return null;
      try {
        const Invoice = (await import("../models/Invoice.js")).default;
        const invoice = await Invoice.findById(parent.linkedInvoiceId).lean();
        if (!invoice) return null;
        return {
          id: invoice._id.toString(),
          number: invoice.number,
          status: invoice.status,
          clientName: invoice.client?.name ||
            `${invoice.client?.firstName || ""} ${invoice.client?.lastName || ""}`.trim() ||
            "Client inconnu",
          totalTTC: invoice.finalTotalTTC || invoice.totalTTC || 0,
          issueDate: invoice.issueDate,
          dueDate: invoice.dueDate,
        };
      } catch (error) {
        console.error("[BANKING] Erreur chargement facture liée:", error);
        return null;
      }
    },
    userId: async (transaction) => {
      if (transaction.userId && typeof transaction.userId === "object") {
        return transaction.userId; // Déjà populé
      }
      // Charger l'utilisateur si nécessaire
      const User = (await import("../models/User.js")).default;
      return await User.findById(transaction.userId);
    },
  },

  AccountBanking: {
    id: (parent) => parent._id?.toString() || parent.id,
    externalId: (parent) => parent.externalId || "",
    // Les enum resolvers gèrent la conversion - garder en minuscules
    provider: (parent) => (parent.provider || "bridge").toLowerCase(),
    type: (parent) => (parent.type || "checking").toLowerCase(),
    status: (parent) => (parent.status || "active").toLowerCase(),
    balance: (parent) => ({
      available:
        typeof parent.balance === "number"
          ? parent.balance
          : (parent.balance?.available ?? 0),
      current:
        typeof parent.balance === "number"
          ? parent.balance
          : (parent.balance?.current ?? 0),
      currency: parent.currency || parent.balance?.currency || "EUR",
    }),
    name: (parent) => parent.name || parent.institutionName || "Compte",
    bankName: (parent) => parent.bankName || parent.institutionName || parent.name || "Banque",
    institutionName: (parent) => parent.institutionName || null,
    institutionLogo: (parent) => parent.institutionLogo || null,
    accountHolder: (parent) => ({
      name: parent.accountHolder?.name || parent.name || "",
      email: parent.accountHolder?.email || "",
    }),
    workspaceId: (parent) => parent.workspaceId || "",
    userId: (parent) => parent.userId || null,
    lastSyncAt: (parent) => parent.lastSyncAt || parent.updatedAt || new Date(),
    createdAt: (parent) => parent.createdAt || new Date(),
    updatedAt: (parent) => parent.updatedAt || new Date(),
    // Nouveau: statut de synchronisation des transactions
    transactionSync: (parent) => {
      const sync = parent.transactionSync || {};
      // Mapping des valeurs DB vers GraphQL enum
      const statusMap = {
        pending: "PENDING",
        in_progress: "IN_PROGRESS",
        complete: "COMPLETE",
        partial: "PARTIAL",
        failed: "FAILED",
      };
      const rawStatus = (sync.status || "pending").toLowerCase();
      return {
        lastSyncAt: sync.lastSyncAt || null,
        status: statusMap[rawStatus] || "PENDING",
        totalTransactions: sync.totalTransactions || 0,
        oldestTransactionDate: sync.oldestTransactionDate || null,
        newestTransactionDate: sync.newestTransactionDate || null,
        lastError: sync.lastError || null,
        history: (sync.history || []).map((h) => ({
          date: h.date,
          status: h.status,
          transactionsCount: h.transactionsCount || 0,
          duration: h.duration || 0,
          error: h.error || null,
        })),
      };
    },
  },

  // Résolveurs d'enums
  BankingProvider: {
    BRIDGE: "bridge",
    STRIPE: "stripe",
    PAYPAL: "paypal",
    MOCK: "mock",
    MANUAL: "manual",
  },

  TransactionType: {
    PAYMENT: "payment",
    REFUND: "refund",
    TRANSFER: "transfer",
    WITHDRAWAL: "withdrawal",
    DEPOSIT: "deposit",
    CREDIT: "credit",
    DEBIT: "debit",
  },

  TransactionStatus: {
    PENDING: "pending",
    COMPLETED: "completed",
    FAILED: "failed",
    CANCELLED: "cancelled",
    REFUNDED: "refunded",
  },

  AccountType: {
    CHECKING: "checking",
    SAVINGS: "savings",
    CREDIT: "credit",
    LOAN: "loan",
    BUSINESS: "business",
    INVESTMENT: "investment",
    OTHER: "other",
  },

  AccountStatus: {
    ACTIVE: "active",
    INACTIVE: "inactive",
    SUSPENDED: "suspended",
    CLOSED: "closed",
  },
};

export default bankingResolvers;
