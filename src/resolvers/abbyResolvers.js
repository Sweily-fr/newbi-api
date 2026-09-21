import abbyService from "../services/abbyService.js";
import { importFromAbby } from "../services/abbyImportService.js";
import AbbyAccount from "../models/AbbyAccount.js";
import Invoice from "../models/Invoice.js";
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

const ROLE_DENIED = (action) => ({
  success: false,
  message: `Seuls les propriétaires et administrateurs peuvent ${action}`,
});

/**
 * Applique le résultat d'une sync unitaire sur le document + les stats du compte
 */
async function applySyncResult(doc, account, result, statKey) {
  if (result.success) {
    doc.abbySyncStatus = "SYNCED";
    doc.abbyId = result.abbyId;
    await doc.save();

    account.stats[statKey] += 1;
    account.lastSyncAt = new Date();
    await account.save();
  } else {
    doc.abbySyncStatus = "ERROR";
    await doc.save();
  }
  return result;
}

const abbyResolvers = {
  AbbyAccount: {
    // Dates stockées en Date, déclarées String dans le schéma → ISO explicite
    lastSyncAt: (account) => account.lastSyncAt?.toISOString() || null,
    lastImportAt: (account) => account.lastImportAt?.toISOString() || null,
    createdAt: (account) => account.createdAt?.toISOString() || null,
    updatedAt: (account) => account.updatedAt?.toISOString() || null,
    isTestMode: (account) => !!account.isTestMode,
    incomeProductType: (account) => account.incomeProductType || 2,
  },

  Query: {
    myAbbyAccount: async (_, args, { user, organizationId }) => {
      requireUser(user);
      try {
        const account = await AbbyAccount.findOne({ organizationId });
        return account || null;
      } catch (error) {
        logger.error("Erreur récupération compte Abby:", error);
        throw new Error(`Erreur: ${error.message}`);
      }
    },
  },

  Mutation: {
    /**
     * Teste la clé API Abby (sans sauvegarder)
     */
    testAbbyConnection: async (
      _,
      { apiKey },
      { user, organizationId, userRole },
    ) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("tester la connexion Abby");
      }
      return abbyService.testConnection(apiKey?.trim());
    },

    /**
     * Connecte Abby à l'organisation
     */
    connectAbby: async (_, { apiKey }, { user, organizationId, userRole }) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("connecter Abby");
      }

      try {
        const existing = await AbbyAccount.findOne({ organizationId });
        if (existing) {
          return {
            success: false,
            message: "Un compte Abby est déjà connecté à cette organisation",
            account: existing,
          };
        }

        const key = apiKey?.trim();
        const testResult = await abbyService.testConnection(key);
        if (!testResult.success) {
          return { success: false, message: testResult.message };
        }

        const account = new AbbyAccount({
          organizationId,
          apiKey: key,
          isConnected: true,
          companyName: testResult.companyName,
          abbyCompanyId: testResult.companyId,
          isTestMode: !!testResult.isTestMode,
          syncStatus: "IDLE",
          // L'import Abby → Newbi ne remonte que les documents émis après la
          // connexion : pas d'import de tout l'historique Abby dans Newbi.
          importCursors: { clientInvoices: new Date(), quotes: new Date() },
          connectedBy: user._id,
        });

        await account.save();

        logger.info("Abby connecté pour l'organisation:", {
          organizationId,
          companyName: testResult.companyName,
        });

        return { success: true, message: "Abby connecté avec succès", account };
      } catch (error) {
        logger.error("Erreur connexion Abby:", error);
        return {
          success: false,
          message: `Erreur lors de la connexion: ${error.message}`,
        };
      }
    },

    /**
     * Déconnecte Abby de l'organisation
     */
    disconnectAbby: async (_, args, { user, organizationId, userRole }) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("déconnecter Abby");
      }

      try {
        const account = await AbbyAccount.findOne({ organizationId });
        if (!account) {
          return {
            success: false,
            message: "Aucun compte Abby trouvé pour cette organisation",
          };
        }

        await AbbyAccount.deleteOne({ organizationId });
        logger.info("Abby déconnecté pour l'organisation:", { organizationId });

        return { success: true, message: "Abby déconnecté avec succès" };
      } catch (error) {
        logger.error("Erreur déconnexion Abby:", error);
        return {
          success: false,
          message: `Erreur lors de la déconnexion: ${error.message}`,
        };
      }
    },

    /**
     * Met à jour les préférences de sync automatique
     */
    updateAbbyAutoSync: async (
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
        const account = await AbbyAccount.findOne({ organizationId });
        if (!account) {
          return { success: false, message: "Aucun compte Abby connecté" };
        }

        for (const field of [
          "invoices",
          "quotes",
          "importClientInvoices",
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
        logger.error("Erreur mise à jour autoSync Abby:", error);
        return { success: false, message: `Erreur: ${error.message}` };
      }
    },

    /**
     * Type de produit Abby des recettes créées par Newbi
     */
    updateAbbyIncomeProductType: async (
      _,
      { productType },
      { user, organizationId, userRole },
    ) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("modifier ces paramètres");
      }
      if (![1, 2, 3, 4, 5].includes(Number(productType))) {
        return { success: false, message: "Type de produit Abby invalide" };
      }

      try {
        const account = await AbbyAccount.findOne({ organizationId });
        if (!account) {
          return { success: false, message: "Aucun compte Abby connecté" };
        }
        account.incomeProductType = Number(productType);
        await account.save();
        return {
          success: true,
          message: "Type de produit mis à jour",
          account,
        };
      } catch (error) {
        logger.error("Erreur mise à jour type de produit Abby:", error);
        return { success: false, message: `Erreur: ${error.message}` };
      }
    },

    /**
     * Enregistre une facture encaissée dans le livre des recettes Abby
     */
    syncInvoiceToAbby: async (_, { invoiceId }, { user, organizationId }) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      try {
        const account = await AbbyAccount.findOne({ organizationId });
        if (!account || !account.isConnected) {
          return { success: false, message: "Abby n'est pas connecté" };
        }

        const invoice = await Invoice.findOne({
          _id: invoiceId,
          workspaceId: organizationId,
        });
        if (!invoice) {
          return { success: false, message: "Facture non trouvée" };
        }

        const result = await abbyService.syncCustomerInvoice(
          account.getDecryptedApiKey(),
          invoice,
          { productType: account.incomeProductType },
        );
        return applySyncResult(invoice, account, result, "invoicesSynced");
      } catch (error) {
        logger.error("Erreur sync facture Abby:", error);
        return { success: false, message: error.message };
      }
    },

    /**
     * Crée un devis Newbi dans Abby
     */
    syncQuoteToAbby: async (_, { quoteId }, { user, organizationId }) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }

      try {
        const account = await AbbyAccount.findOne({ organizationId });
        if (!account || !account.isConnected) {
          return { success: false, message: "Abby n'est pas connecté" };
        }

        const quote = await Quote.findOne({
          _id: quoteId,
          workspaceId: organizationId,
        });
        if (!quote) {
          return { success: false, message: "Devis non trouvé" };
        }

        const result = await abbyService.syncQuote(
          account.getDecryptedApiKey(),
          quote,
        );
        return applySyncResult(quote, account, result, "quotesSynced");
      } catch (error) {
        logger.error("Erreur sync devis Abby:", error);
        return { success: false, message: error.message };
      }
    },

    /**
     * Importe maintenant les documents finalisés dans Abby vers Newbi
     */
    importFromAbby: async (_, args, { user, organizationId, userRole }) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("lancer un import depuis Abby");
      }

      try {
        const account = await AbbyAccount.findOne({ organizationId });
        if (!account || !account.isConnected) {
          return { success: false, message: "Abby n'est pas connecté" };
        }

        const result = await importFromAbby(account, String(user._id), {
          force: true,
        });
        const r = result.results || {};
        return {
          success: result.success,
          message: result.message,
          clientInvoicesImported: r.clientInvoices?.imported || 0,
          clientInvoicesUpdated: r.clientInvoices?.updated || 0,
          clientInvoicesErrors: r.clientInvoices?.errors || 0,
          quotesImported: r.quotes?.imported || 0,
          quotesUpdated: r.quotes?.updated || 0,
          quotesErrors: r.quotes?.errors || 0,
        };
      } catch (error) {
        logger.error("Erreur import Abby:", error);
        return { success: false, message: error.message };
      }
    },

    /**
     * Lance une synchronisation complète vers Abby
     */
    syncAllToAbby: async (_, args, { user, organizationId, userRole }) => {
      requireUser(user);
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!isOwnerOrAdmin(userRole)) {
        return ROLE_DENIED("lancer une synchronisation complète");
      }

      try {
        const result = await abbyService.syncAll(organizationId, {
          Invoice,
          Quote,
        });

        return {
          success: result.success,
          message: result.message,
          invoicesSynced: result.results?.invoices?.synced || 0,
          invoicesErrors: result.results?.invoices?.errors || 0,
          quotesSynced: result.results?.quotes?.synced || 0,
          quotesErrors: result.results?.quotes?.errors || 0,
        };
      } catch (error) {
        logger.error("Erreur syncAll Abby:", error);
        return { success: false, message: error.message };
      }
    },
  },
};

// Abonnement actif requis (fail-closed) sur toutes les mutations sauf la déconnexion
const ABBY_BLOCK = [
  "testAbbyConnection",
  "connectAbby",
  "updateAbbyAutoSync",
  "updateAbbyIncomeProductType",
  "syncInvoiceToAbby",
  "syncQuoteToAbby",
  "syncAllToAbby",
  "importFromAbby",
];
ABBY_BLOCK.forEach((name) => {
  const original = abbyResolvers.Mutation[name];
  if (original) {
    abbyResolvers.Mutation[name] = async (parent, args, context, info) => {
      await checkSubscriptionActive(context, { failClosed: true });
      return original(parent, args, context, info);
    };
  }
});

// organizationId / userRole vérifiés en base par RBAC (withOrganization en position
// externe), jamais lus depuis les headers client. Même schéma que Qonto.
const ABBY_ORG_SCOPED_QUERIES = ["myAbbyAccount"];
const ABBY_ORG_SCOPED_MUTATIONS = [...ABBY_BLOCK, "disconnectAbby"];
ABBY_ORG_SCOPED_QUERIES.forEach((name) => {
  const original = abbyResolvers.Query[name];
  if (original) abbyResolvers.Query[name] = withOrganization(original);
});
ABBY_ORG_SCOPED_MUTATIONS.forEach((name) => {
  const original = abbyResolvers.Mutation[name];
  if (original) abbyResolvers.Mutation[name] = withOrganization(original);
});

export default abbyResolvers;
