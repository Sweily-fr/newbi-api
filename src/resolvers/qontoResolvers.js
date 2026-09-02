import qontoService from "../services/qontoService.js";
import { importFromQonto } from "../services/qontoImportService.js";
import QontoAccount from "../models/QontoAccount.js";
import Invoice from "../models/Invoice.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Quote from "../models/Quote.js";
import logger from "../utils/logger.js";
import {
  checkSubscriptionActive,
  withOrganization,
} from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";

function requireUser(user) {
  if (!user) {
    throw new AppError("Vous devez être connecté", ERROR_CODES.UNAUTHENTICATED);
  }
}

function isOwnerOrAdmin(userRole) {
  const normalized = userRole?.toLowerCase();
  return normalized === "owner" || normalized === "admin";
}

/**
 * Le sandbox Qonto (Developer Portal) n'a de sens que pour tester la prod
 * avec des données fictives : réservé à l'allowlist du back-office
 * (BACKOFFICE_ADMIN_USER_IDS, comme /admin) et au token staging serveur.
 */
function isBackofficeAdmin(userId) {
  const allowlist = (process.env.BACKOFFICE_ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowlist.length > 0 && allowlist.includes(String(userId));
}

function sandboxAvailableFor(user) {
  return !!process.env.QONTO_STAGING_TOKEN && isBackofficeAdmin(user?._id);
}

const SANDBOX_DENIED = {
  success: false,
  message: "Le sandbox Qonto est réservé aux administrateurs Newbi",
};

const ROLE_DENIED = (action) => ({
  success: false,
  message: `Seuls les propriétaires et administrateurs peuvent ${action}`,
});

/**
 * Applique le résultat d'une sync unitaire sur le document + les stats du compte
 */
async function applySyncResult(doc, account, result, statKey) {
  if (result.success) {
    doc.qontoSyncStatus = "SYNCED";
    doc.qontoId = result.qontoId;
    await doc.save();

    account.stats[statKey] += 1;
    account.lastSyncAt = new Date();
    await account.save();
  } else {
    doc.qontoSyncStatus = "ERROR";
    await doc.save();
  }
  return result;
}

const qontoResolvers = {
  QontoAccount: {
    // Dates stockées en Date, déclarées String dans le schéma → ISO explicite
    // (sinon la String scalar sérialise Date.valueOf() → "Invalid Date" côté client)
    lastSyncAt: (account) => account.lastSyncAt?.toISOString() || null,
    lastImportAt: (account) => account.lastImportAt?.toISOString() || null,
    createdAt: (account) => account.createdAt?.toISOString() || null,
    updatedAt: (account) => account.updatedAt?.toISOString() || null,
    bankAccounts: (account) => account.bankAccounts || [],
  },

  Query: {
    qontoSandboxAvailable: async (_, args, { user }) => {
      requireUser(user);
      return sandboxAvailableFor(user);
    },

    myQontoAccount: async (_, args, { user, organizationId }) => {
      requireUser(user);
      try {
        const account = await QontoAccount.findOne({ organizationId });
        return account || null;
      } catch (error) {
        logger.error("Erreur récupération compte Qonto:", error);
        throw new Error(`Erreur: ${error.message}`);
      }
    },
  },

  Mutation: {
    /**
     * Teste les identifiants Qonto (sans sauvegarder)
     */
    testQontoConnection: async (
      _,
      { login, secretKey, environment },
      { user, organizationId, userRole },
    ) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("tester la connexion Qonto");
      }
      if (environment === "sandbox" && !sandboxAvailableFor(user)) {
        return SANDBOX_DENIED;
      }

      return qontoService.testConnection({
        login: login?.trim(),
        secretKey: secretKey?.trim(),
        environment: environment === "sandbox" ? "sandbox" : "production",
      });
    },

    /**
     * Connecte Qonto à l'organisation
     */
    connectQonto: async (
      _,
      { login, secretKey, environment, bankAccountId },
      { user, organizationId, userRole },
    ) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("connecter Qonto");
      }
      if (environment === "sandbox" && !sandboxAvailableFor(user)) {
        return SANDBOX_DENIED;
      }

      try {
        const existing = await QontoAccount.findOne({ organizationId });
        if (existing) {
          return {
            success: false,
            message: "Un compte Qonto est déjà connecté à cette organisation",
            account: existing,
          };
        }

        const env = environment === "sandbox" ? "sandbox" : "production";
        const credentials = {
          login: login?.trim(),
          secretKey: secretKey?.trim(),
          environment: env,
        };

        const testResult = await qontoService.testConnection(credentials);
        if (!testResult.success) {
          return { success: false, message: testResult.message };
        }

        const bankAccounts = testResult.bankAccounts || [];
        // Un IBAN masqué (FRXXXX…) ne peut pas figurer sur une facture
        const usable = (a) =>
          a.status !== "closed" && !/X{4,}/i.test(a.iban || "");
        const selected =
          bankAccounts.find((a) => a.qontoId === bankAccountId) ||
          bankAccounts.find((a) => a.main && usable(a)) ||
          bankAccounts.find(usable) ||
          bankAccounts.find((a) => a.main && a.status !== "closed") ||
          bankAccounts[0];

        const account = new QontoAccount({
          organizationId,
          login: credentials.login,
          secretKey: credentials.secretKey,
          isConnected: true,
          organizationName: testResult.organizationName,
          qontoOrganizationId: testResult.organizationId,
          slug: testResult.slug,
          environment: env,
          bankAccounts,
          selectedBankAccountId: selected?.qontoId || null,
          syncStatus: "IDLE",
          // L'import Qonto → Newbi ne remonte que les documents créés après la
          // connexion : pas d'import de tout l'historique Qonto dans Newbi.
          importCursors: {
            clientInvoices: new Date(),
            supplierInvoices: new Date(),
            quotes: new Date(),
          },
          connectedBy: user._id,
        });

        await account.save();

        logger.info("Qonto connecté pour l'organisation:", {
          organizationId,
          organizationName: testResult.organizationName,
        });

        return {
          success: true,
          message: "Qonto connecté avec succès",
          account,
        };
      } catch (error) {
        logger.error("Erreur connexion Qonto:", error);
        return {
          success: false,
          message: `Erreur lors de la connexion: ${error.message}`,
        };
      }
    },

    /**
     * Déconnecte Qonto de l'organisation
     */
    disconnectQonto: async (_, args, { user, organizationId, userRole }) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("déconnecter Qonto");
      }

      try {
        const account = await QontoAccount.findOne({ organizationId });
        if (!account) {
          return {
            success: false,
            message: "Aucun compte Qonto trouvé pour cette organisation",
          };
        }

        await QontoAccount.deleteOne({ organizationId });
        logger.info("Qonto déconnecté pour l'organisation:", {
          organizationId,
        });

        return { success: true, message: "Qonto déconnecté avec succès" };
      } catch (error) {
        logger.error("Erreur déconnexion Qonto:", error);
        return {
          success: false,
          message: `Erreur lors de la déconnexion: ${error.message}`,
        };
      }
    },

    /**
     * Met à jour les préférences de sync automatique
     */
    updateQontoAutoSync: async (
      _,
      { autoSync },
      { user, organizationId, userRole },
    ) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("modifier ces paramètres");
      }

      try {
        const account = await QontoAccount.findOne({ organizationId });
        if (!account) {
          return { success: false, message: "Aucun compte Qonto connecté" };
        }

        for (const field of [
          "invoices",
          "supplierInvoices",
          "quotes",
          "importClientInvoices",
          "importSupplierInvoices",
          "importQuotes",
        ]) {
          if (autoSync[field] !== undefined) {
            account.autoSync[field] = autoSync[field];
          }
        }
        await account.save();

        return {
          success: true,
          message: "Préférences de synchronisation mises à jour",
          account,
        };
      } catch (error) {
        logger.error("Erreur mise à jour autoSync Qonto:", error);
        return { success: false, message: `Erreur: ${error.message}` };
      }
    },

    /**
     * Sélectionne le compte bancaire (IBAN) utilisé sur les factures
     */
    updateQontoBankAccount: async (
      _,
      { bankAccountId },
      { user, organizationId, userRole },
    ) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("modifier ces paramètres");
      }

      try {
        const account = await QontoAccount.findOne({ organizationId });
        if (!account) {
          return { success: false, message: "Aucun compte Qonto connecté" };
        }

        const target = (account.bankAccounts || []).find(
          (a) => a.qontoId === bankAccountId,
        );
        if (!target) {
          return {
            success: false,
            message: "Compte bancaire introuvable dans les comptes Qonto",
          };
        }

        account.selectedBankAccountId = target.qontoId;
        await account.save();

        return {
          success: true,
          message: "Compte bancaire mis à jour",
          account,
        };
      } catch (error) {
        logger.error("Erreur sélection compte bancaire Qonto:", error);
        return { success: false, message: `Erreur: ${error.message}` };
      }
    },

    /**
     * Rafraîchit la liste des comptes bancaires depuis Qonto
     */
    refreshQontoBankAccounts: async (
      _,
      args,
      { user, organizationId, userRole },
    ) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("modifier ces paramètres");
      }

      try {
        const account = await QontoAccount.findOne({ organizationId });
        if (!account) {
          return { success: false, message: "Aucun compte Qonto connecté" };
        }

        const result = await qontoService.refreshBankAccounts(account);
        if (!result.success) {
          return { success: false, message: result.message, account };
        }

        return {
          success: true,
          message: "Comptes bancaires rafraîchis",
          account,
        };
      } catch (error) {
        logger.error("Erreur refresh comptes Qonto:", error);
        return { success: false, message: `Erreur: ${error.message}` };
      }
    },

    /**
     * Synchronise une facture spécifique vers Qonto
     */
    syncInvoiceToQonto: async (_, { invoiceId }, { user, organizationId }) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      try {
        const account = await QontoAccount.findOne({ organizationId });
        if (!account || !account.isConnected) {
          return { success: false, message: "Qonto n'est pas connecté" };
        }

        const invoice = await Invoice.findOne({
          _id: invoiceId,
          workspaceId: organizationId,
        });
        if (!invoice) {
          return { success: false, message: "Facture non trouvée" };
        }

        const result = await qontoService.syncCustomerInvoice(
          account.getCredentials(),
          invoice,
          { iban: account.getInvoiceBankAccount()?.iban || null },
        );
        return applySyncResult(invoice, account, result, "invoicesSynced");
      } catch (error) {
        logger.error("Erreur sync facture Qonto:", error);
        return { success: false, message: error.message };
      }
    },

    /**
     * Synchronise une facture d'achat spécifique vers Qonto
     */
    syncPurchaseInvoiceToQonto: async (
      _,
      { purchaseInvoiceId },
      { user, organizationId },
    ) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      try {
        const account = await QontoAccount.findOne({ organizationId });
        if (!account || !account.isConnected) {
          return { success: false, message: "Qonto n'est pas connecté" };
        }

        const purchaseInvoice = await PurchaseInvoice.findOne({
          _id: purchaseInvoiceId,
          workspaceId: organizationId,
        });
        if (!purchaseInvoice) {
          return { success: false, message: "Facture d'achat non trouvée" };
        }

        const result = await qontoService.syncPurchaseInvoice(
          account.getCredentials(),
          purchaseInvoice,
        );
        return applySyncResult(
          purchaseInvoice,
          account,
          result,
          "expensesSynced",
        );
      } catch (error) {
        logger.error("Erreur sync facture d'achat Qonto:", error);
        return { success: false, message: error.message };
      }
    },

    /**
     * Synchronise un devis spécifique vers Qonto
     */
    syncQuoteToQonto: async (_, { quoteId }, { user, organizationId }) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      try {
        const account = await QontoAccount.findOne({ organizationId });
        if (!account || !account.isConnected) {
          return { success: false, message: "Qonto n'est pas connecté" };
        }

        const quote = await Quote.findOne({
          _id: quoteId,
          workspaceId: organizationId,
        });
        if (!quote) {
          return { success: false, message: "Devis non trouvé" };
        }

        const result = await qontoService.syncQuote(
          account.getCredentials(),
          quote,
        );
        return applySyncResult(quote, account, result, "quotesSynced");
      } catch (error) {
        logger.error("Erreur sync devis Qonto:", error);
        return { success: false, message: error.message };
      }
    },

    /**
     * Importe maintenant les documents créés dans Qonto vers Newbi
     */
    importFromQonto: async (_, args, { user, organizationId, userRole }) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("lancer un import depuis Qonto");
      }

      try {
        const account = await QontoAccount.findOne({ organizationId });
        if (!account || !account.isConnected) {
          return { success: false, message: "Qonto n'est pas connecté" };
        }

        const result = await importFromQonto(account, String(user._id), {
          force: true,
        });
        const r = result.results || {};
        return {
          success: result.success,
          message: result.message,
          clientInvoicesImported: r.clientInvoices?.imported || 0,
          clientInvoicesUpdated: r.clientInvoices?.updated || 0,
          clientInvoicesErrors: r.clientInvoices?.errors || 0,
          supplierInvoicesImported: r.supplierInvoices?.imported || 0,
          supplierInvoicesUpdated: r.supplierInvoices?.updated || 0,
          supplierInvoicesErrors: r.supplierInvoices?.errors || 0,
          quotesImported: r.quotes?.imported || 0,
          quotesUpdated: r.quotes?.updated || 0,
          quotesErrors: r.quotes?.errors || 0,
        };
      } catch (error) {
        logger.error("Erreur import Qonto:", error);
        return { success: false, message: error.message };
      }
    },

    /**
     * Lance une synchronisation complète vers Qonto
     */
    syncAllToQonto: async (_, args, { user, organizationId, userRole }) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("lancer une synchronisation complète");
      }

      try {
        const result = await qontoService.syncAll(organizationId, {
          Invoice,
          PurchaseInvoice,
          Quote,
        });

        return {
          success: result.success,
          message: result.message,
          invoicesSynced: result.results?.invoices?.synced || 0,
          invoicesErrors: result.results?.invoices?.errors || 0,
          expensesSynced: result.results?.expenses?.synced || 0,
          expensesErrors: result.results?.expenses?.errors || 0,
          quotesSynced: result.results?.quotes?.synced || 0,
          quotesErrors: result.results?.quotes?.errors || 0,
        };
      } catch (error) {
        logger.error("Erreur syncAll Qonto:", error);
        return { success: false, message: error.message };
      }
    },
  },
};

// Abonnement actif requis (fail-closed) sur toutes les mutations sauf la déconnexion
const QONTO_BLOCK = [
  "testQontoConnection",
  "connectQonto",
  "updateQontoAutoSync",
  "updateQontoBankAccount",
  "refreshQontoBankAccounts",
  "syncInvoiceToQonto",
  "syncPurchaseInvoiceToQonto",
  "syncQuoteToQonto",
  "syncAllToQonto",
  "importFromQonto",
];
QONTO_BLOCK.forEach((name) => {
  const original = qontoResolvers.Mutation[name];
  if (original) {
    qontoResolvers.Mutation[name] = async (parent, args, context, info) => {
      await checkSubscriptionActive(context, { failClosed: true });
      return original(parent, args, context, info);
    };
  }
});

// organizationId / userRole vérifiés en base par RBAC (withOrganization en position
// externe), jamais lus depuis les headers client. Même schéma que Pennylane.
const QONTO_ORG_SCOPED_QUERIES = ["myQontoAccount"];
const QONTO_ORG_SCOPED_MUTATIONS = [...QONTO_BLOCK, "disconnectQonto"];
QONTO_ORG_SCOPED_QUERIES.forEach((name) => {
  const original = qontoResolvers.Query[name];
  if (original) qontoResolvers.Query[name] = withOrganization(original);
});
QONTO_ORG_SCOPED_MUTATIONS.forEach((name) => {
  const original = qontoResolvers.Mutation[name];
  if (original) qontoResolvers.Mutation[name] = withOrganization(original);
});

export default qontoResolvers;
