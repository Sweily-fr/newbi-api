import { bankingService } from "../services/banking/BankingService.js";
import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import Transaction from "../models/Transaction.js";
import AccountBanking from "../models/AccountBanking.js";
import ApiMetric from "../models/ApiMetric.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import cloudflareService from "../services/cloudflareService.js";
import { GraphQLUpload } from "graphql-upload";

const bankingResolvers = {
  Upload: GraphQLUpload,

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

        const transactions = await Transaction.find(query)
          .sort({ date: -1, createdAt: -1 })
          .limit(limit)
          .skip(offset)
          .lean();

        return transactions;
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
        expenseCategory: input.category,
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
        if (input.category) updateData.expenseCategory = input.category;
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

    // Upload de justificatif pour une transaction
    uploadTransactionReceipt: withWorkspace(
      async (parent, { transactionId, workspaceId, file }, { user }) => {
        try {
          console.log(
            `🧾 [RECEIPT] Upload justificatif pour transaction ${transactionId}, workspaceId: ${workspaceId}`
          );

          // Vérifier que la transaction existe dans le workspace
          const transaction = await Transaction.findOne({
            _id: transactionId,
            workspaceId,
          });

          if (!transaction) {
            throw new AppError(
              "Transaction non trouvée",
              ERROR_CODES.NOT_FOUND
            );
          }

          // Récupérer les informations du fichier
          const { createReadStream, filename, mimetype } = await file;

          // Lire le fichier en buffer
          const stream = createReadStream();
          const chunks = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          const fileBuffer = Buffer.concat(chunks);
          const fileSize = fileBuffer.length;

          // Valider la taille du fichier (10MB max)
          const maxSize = 10 * 1024 * 1024;
          if (fileSize > maxSize) {
            throw new AppError(
              `Fichier trop volumineux. Taille maximum: 10MB`,
              ERROR_CODES.BAD_REQUEST
            );
          }

          // Valider le type de fichier
          const allowedTypes = [
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/webp",
            "application/pdf",
          ];
          if (!allowedTypes.includes(mimetype)) {
            throw new AppError(
              "Type de fichier non supporté. Types acceptés: JPEG, PNG, WebP, PDF",
              ERROR_CODES.BAD_REQUEST
            );
          }

          // Upload vers Cloudflare R2 (bucket receipts)
          const uploadResult = await cloudflareService.uploadImage(
            fileBuffer,
            filename,
            user._id.toString(),
            "receipt", // Type "receipt" pour le bucket des justificatifs
            workspaceId // organizationId requis pour le type receipt
          );

          console.log(`✅ [RECEIPT] Upload réussi: ${uploadResult.url}`);

          // Mettre à jour la transaction avec le justificatif
          const receiptFile = {
            url: uploadResult.url,
            key: uploadResult.key,
            filename: filename,
            mimetype: mimetype,
            size: fileSize,
            uploadedAt: new Date(),
            uploadedBy: user._id.toString(),
          };

          // Utiliser findByIdAndUpdate pour éviter la validation complète du schéma
          const updatedTransaction = await Transaction.findByIdAndUpdate(
            transactionId,
            {
              $set: {
                receiptFile: receiptFile,
                receiptRequired: false,
              },
            },
            { new: true }
          );

          return {
            success: true,
            message: "Justificatif uploadé avec succès",
            receiptFile,
            transaction: updatedTransaction,
          };
        } catch (error) {
          console.error("❌ [RECEIPT] Erreur upload:", error);
          if (error instanceof AppError) {
            throw error;
          }
          throw new AppError(
            `Erreur lors de l'upload du justificatif: ${error.message}`,
            ERROR_CODES.INTERNAL_ERROR
          );
        }
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
  },

  // Résolveurs de types
  Transaction: {
    id: (parent) => parent._id?.toString() || parent.id,
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
    provider: (parent) => parent.provider?.toLowerCase() || "bridge",
    type: (parent) => parent.type?.toLowerCase() || "checking",
    status: (parent) => parent.status?.toLowerCase() || "active",
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
    bankName: (parent) => parent.bankName || parent.name || "Banque",
    accountHolder: (parent) => ({
      name: parent.accountHolder?.name || parent.name || "",
      email: parent.accountHolder?.email || "",
    }),
    workspaceId: (parent) => parent.workspaceId || "",
    userId: (parent) => parent.userId || null,
    lastSyncAt: (parent) => parent.lastSyncAt || parent.updatedAt || new Date(),
    createdAt: (parent) => parent.createdAt || new Date(),
    updatedAt: (parent) => parent.updatedAt || new Date(),
  },

  // Résolveurs d'enums
  BankingProvider: {
    BRIDGE: "bridge",
    STRIPE: "stripe",
    PAYPAL: "paypal",
    MOCK: "mock",
  },

  TransactionType: {
    PAYMENT: "payment",
    REFUND: "refund",
    TRANSFER: "transfer",
    WITHDRAWAL: "withdrawal",
    DEPOSIT: "deposit",
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
    BUSINESS: "business",
    INVESTMENT: "investment",
  },

  AccountStatus: {
    ACTIVE: "active",
    INACTIVE: "inactive",
    SUSPENDED: "suspended",
    CLOSED: "closed",
  },
};

export default bankingResolvers;
