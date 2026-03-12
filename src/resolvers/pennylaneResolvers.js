import pennylaneService from "../services/pennylaneService.js";
import PennylaneAccount from "../models/PennylaneAccount.js";
import Invoice from "../models/Invoice.js";
import Expense from "../models/Expense.js";
import logger from "../utils/logger.js";

const pennylaneResolvers = {
  Query: {
    /**
     * Récupère le compte Pennylane de l'organisation active
     */
    myPennylaneAccount: async (_, args, { user, organizationId }) => {
      if (!user) {
        throw new Error("Vous devez être connecté pour accéder à cette ressource");
      }

      try {
        const account = await PennylaneAccount.findOne({ organizationId });
        return account || null;
      } catch (error) {
        logger.error("Erreur récupération compte Pennylane:", error);
        throw new Error(`Erreur: ${error.message}`);
      }
    },
  },

  Mutation: {
    /**
     * Teste la connexion à Pennylane avec un token API (sans sauvegarder)
     */
    testPennylaneConnection: async (_, { apiToken }, { user, organizationId, userRole }) => {
      if (!user) {
        throw new Error("Vous devez être connecté");
      }

      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      const normalizedRole = userRole?.toLowerCase();
      if (normalizedRole !== "owner" && normalizedRole !== "admin") {
        return {
          success: false,
          message: "Seuls les propriétaires et administrateurs peuvent tester la connexion Pennylane",
        };
      }

      return pennylaneService.testConnection(apiToken);
    },

    /**
     * Connecte Pennylane à l'organisation
     */
    connectPennylane: async (
      _,
      { apiToken, environment },
      { user, organizationId, userRole }
    ) => {
      if (!user) {
        throw new Error("Vous devez être connecté");
      }

      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      const normalizedRole = userRole?.toLowerCase();
      if (normalizedRole !== "owner" && normalizedRole !== "admin") {
        return {
          success: false,
          message: "Seuls les propriétaires et administrateurs peuvent connecter Pennylane",
        };
      }

      try {
        // Vérifier si déjà connecté
        const existing = await PennylaneAccount.findOne({ organizationId });
        if (existing) {
          return {
            success: false,
            message: "Un compte Pennylane est déjà connecté à cette organisation",
            account: existing,
          };
        }

        // Tester la connexion d'abord
        const testResult = await pennylaneService.testConnection(apiToken);
        if (!testResult.success) {
          return {
            success: false,
            message: testResult.message,
          };
        }

        // Sauvegarder le compte
        const account = new PennylaneAccount({
          organizationId,
          apiToken,
          isConnected: true,
          companyName: testResult.companyName,
          companyId: testResult.companyId,
          environment: environment || "production",
          syncStatus: "IDLE",
          connectedBy: user._id,
        });

        await account.save();

        logger.info("Pennylane connecté pour l'organisation:", {
          organizationId,
          companyName: testResult.companyName,
        });

        return {
          success: true,
          message: "Pennylane connecté avec succès",
          account,
        };
      } catch (error) {
        logger.error("Erreur connexion Pennylane:", error);
        return {
          success: false,
          message: `Erreur lors de la connexion: ${error.message}`,
        };
      }
    },

    /**
     * Déconnecte Pennylane de l'organisation
     */
    disconnectPennylane: async (_, args, { user, organizationId, userRole }) => {
      if (!user) {
        throw new Error("Vous devez être connecté");
      }

      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      const normalizedRole = userRole?.toLowerCase();
      if (normalizedRole !== "owner" && normalizedRole !== "admin") {
        return {
          success: false,
          message: "Seuls les propriétaires et administrateurs peuvent déconnecter Pennylane",
        };
      }

      try {
        const account = await PennylaneAccount.findOne({ organizationId });
        if (!account) {
          return {
            success: false,
            message: "Aucun compte Pennylane trouvé pour cette organisation",
          };
        }

        await PennylaneAccount.deleteOne({ organizationId });

        logger.info("Pennylane déconnecté pour l'organisation:", { organizationId });

        return {
          success: true,
          message: "Pennylane déconnecté avec succès",
        };
      } catch (error) {
        logger.error("Erreur déconnexion Pennylane:", error);
        return {
          success: false,
          message: `Erreur lors de la déconnexion: ${error.message}`,
        };
      }
    },

    /**
     * Met à jour les préférences de sync automatique
     */
    updatePennylaneAutoSync: async (
      _,
      { autoSync },
      { user, organizationId, userRole }
    ) => {
      if (!user) {
        throw new Error("Vous devez être connecté");
      }

      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      const normalizedRole = userRole?.toLowerCase();
      if (normalizedRole !== "owner" && normalizedRole !== "admin") {
        return {
          success: false,
          message: "Seuls les propriétaires et administrateurs peuvent modifier ces paramètres",
        };
      }

      try {
        const account = await PennylaneAccount.findOne({ organizationId });
        if (!account) {
          return {
            success: false,
            message: "Aucun compte Pennylane connecté",
          };
        }

        if (autoSync.invoices !== undefined) account.autoSync.invoices = autoSync.invoices;
        if (autoSync.expenses !== undefined) account.autoSync.expenses = autoSync.expenses;
        if (autoSync.clients !== undefined) account.autoSync.clients = autoSync.clients;

        await account.save();

        return {
          success: true,
          message: "Préférences de synchronisation mises à jour",
          account,
        };
      } catch (error) {
        logger.error("Erreur mise à jour autoSync Pennylane:", error);
        return {
          success: false,
          message: `Erreur: ${error.message}`,
        };
      }
    },

    /**
     * Synchronise une facture spécifique vers Pennylane
     */
    syncInvoiceToPennylane: async (_, { invoiceId }, { user, organizationId, userRole }) => {
      if (!user) {
        throw new Error("Vous devez être connecté");
      }

      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      try {
        const account = await PennylaneAccount.findOne({ organizationId });
        if (!account || !account.isConnected) {
          return { success: false, message: "Pennylane n'est pas connecté" };
        }

        const invoice = await Invoice.findOne({
          _id: invoiceId,
          workspaceId: organizationId,
        });

        if (!invoice) {
          return { success: false, message: "Facture non trouvée" };
        }

        const result = await pennylaneService.syncCustomerInvoice(
          account.apiToken,
          invoice
        );

        if (result.success) {
          invoice.pennylaneSyncStatus = "SYNCED";
          invoice.pennylaneId = result.pennylaneId;
          await invoice.save();

          account.stats.invoicesSynced += 1;
          await account.save();
        } else {
          invoice.pennylaneSyncStatus = "ERROR";
          await invoice.save();
        }

        return result;
      } catch (error) {
        logger.error("Erreur sync facture Pennylane:", error);
        return { success: false, message: error.message };
      }
    },

    /**
     * Synchronise une dépense spécifique vers Pennylane
     */
    syncExpenseToPennylane: async (_, { expenseId }, { user, organizationId, userRole }) => {
      if (!user) {
        throw new Error("Vous devez être connecté");
      }

      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      try {
        const account = await PennylaneAccount.findOne({ organizationId });
        if (!account || !account.isConnected) {
          return { success: false, message: "Pennylane n'est pas connecté" };
        }

        const expense = await Expense.findOne({
          _id: expenseId,
          workspaceId: organizationId,
        });

        if (!expense) {
          return { success: false, message: "Dépense non trouvée" };
        }

        const result = await pennylaneService.syncSupplierInvoice(
          account.apiToken,
          expense
        );

        if (result.success) {
          expense.pennylaneSyncStatus = "SYNCED";
          expense.pennylaneId = result.pennylaneId;
          await expense.save();

          account.stats.expensesSynced += 1;
          await account.save();
        } else {
          expense.pennylaneSyncStatus = "ERROR";
          await expense.save();
        }

        return result;
      } catch (error) {
        logger.error("Erreur sync dépense Pennylane:", error);
        return { success: false, message: error.message };
      }
    },

    /**
     * Lance une synchronisation complète vers Pennylane
     */
    syncAllToPennylane: async (_, args, { user, organizationId, userRole }) => {
      if (!user) {
        throw new Error("Vous devez être connecté");
      }

      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      const normalizedRole = userRole?.toLowerCase();
      if (normalizedRole !== "owner" && normalizedRole !== "admin") {
        return {
          success: false,
          message: "Seuls les propriétaires et administrateurs peuvent lancer une synchronisation complète",
        };
      }

      try {
        const result = await pennylaneService.syncAll(organizationId, {
          Invoice,
          Expense,
        });

        return {
          success: result.success,
          message: result.message,
          invoicesSynced: result.results?.invoices?.synced || 0,
          invoicesErrors: result.results?.invoices?.errors || 0,
          expensesSynced: result.results?.expenses?.synced || 0,
          expensesErrors: result.results?.expenses?.errors || 0,
          clientsSynced: result.results?.clients?.synced || 0,
          clientsErrors: result.results?.clients?.errors || 0,
          productsSynced: result.results?.products?.synced || 0,
          productsErrors: result.results?.products?.errors || 0,
        };
      } catch (error) {
        logger.error("Erreur syncAll Pennylane:", error);
        return { success: false, message: error.message };
      }
    },
  },
};

export default pennylaneResolvers;
