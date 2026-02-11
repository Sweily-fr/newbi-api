import { BankingProvider } from "../interfaces/BankingProvider.js";
import axios from "axios";

/**
 * Provider GoCardless Bank Account Data (anciennement Nordigen)
 * API pour l'agrégation bancaire Open Banking
 * Documentation: https://bankaccountdata.gocardless.com/docs
 */
export class GoCardlessProvider extends BankingProvider {
  constructor() {
    super();
    this.name = "gocardless";
    this.secretId = process.env.GOCARDLESS_SECRET_ID;
    this.secretKey = process.env.GOCARDLESS_SECRET_KEY;
    this.config = {
      baseUrl:
        process.env.GOCARDLESS_BASE_URL ||
        "https://bankaccountdata.gocardless.com/api/v2",
      timeout: 30000,
      redirectUri:
        process.env.GOCARDLESS_REDIRECT_URI ||
        "http://localhost:3000/banking/callback",
    };
    this.accessToken = null;
    this.accessTokenExpiry = null;
    this.client = null;
  }

  /**
   * Initialise la connexion avec l'API GoCardless
   */
  async initialize() {
    try {
      this.client = axios.create({
        baseURL: this.config.baseUrl,
        timeout: this.config.timeout,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      // Vérifier que les credentials sont configurés
      if (!this.secretId || !this.secretKey) {
        throw new Error(
          "Credentials GoCardless non configurés (GOCARDLESS_SECRET_ID, GOCARDLESS_SECRET_KEY)"
        );
      }

      // Obtenir un access token
      await this._authenticate();
      this.isInitialized = true;
      console.log("✅ GoCardless provider initialisé");
    } catch (error) {
      console.error("❌ Erreur initialisation GoCardless:", error.message);
      throw error;
    }
  }

  /**
   * Authentification avec l'API GoCardless
   * Obtient un access token valide 24h
   */
  async _authenticate() {
    try {
      const response = await this.client.post("/token/new/", {
        secret_id: this.secretId,
        secret_key: this.secretKey,
      });

      this.accessToken = response.data.access;
      this.refreshToken = response.data.refresh;
      // Token valide 24h, on le rafraîchit 1h avant expiration
      this.accessTokenExpiry = Date.now() + 23 * 60 * 60 * 1000;

      // Mettre à jour le header Authorization
      this.client.defaults.headers.common["Authorization"] =
        `Bearer ${this.accessToken}`;

      console.log("✅ Authentification GoCardless réussie");
    } catch (error) {
      console.error(
        "❌ Erreur authentification GoCardless:",
        error.response?.data || error.message
      );
      throw new Error(`Authentification GoCardless échouée: ${error.message}`);
    }
  }

  /**
   * Vérifie et rafraîchit le token si nécessaire
   */
  async _ensureValidToken() {
    if (!this.accessToken || Date.now() >= this.accessTokenExpiry) {
      await this._authenticate();
    }
  }

  /**
   * Rafraîchit le token d'accès
   */
  async _refreshAccessToken() {
    try {
      const response = await this.client.post("/token/refresh/", {
        refresh: this.refreshToken,
      });

      this.accessToken = response.data.access;
      this.accessTokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
      this.client.defaults.headers.common["Authorization"] =
        `Bearer ${this.accessToken}`;

      console.log("✅ Token GoCardless rafraîchi");
    } catch (error) {
      // Si le refresh échoue, on se ré-authentifie
      await this._authenticate();
    }
  }

  /**
   * Liste les institutions bancaires disponibles pour un pays
   * @param {string} country - Code pays ISO (ex: "FR", "DE", "ES")
   */
  async listInstitutions(country = "FR") {
    await this._ensureValidToken();

    try {
      const response = await this.client.get("/institutions/", {
        params: { country },
      });

      return response.data.map((institution) => ({
        id: institution.id,
        name: institution.name,
        bic: institution.bic,
        logo: institution.logo,
        countries: institution.countries,
        transactionTotalDays: institution.transaction_total_days,
      }));
    } catch (error) {
      console.error(
        "❌ Erreur liste institutions:",
        error.response?.data || error.message
      );
      throw new Error(`Erreur récupération institutions: ${error.message}`);
    }
  }

  /**
   * Crée un End User Agreement (accord utilisateur)
   * Requis avant de créer une requisition
   */
  async createEndUserAgreement(institutionId, maxHistoricalDays = 90) {
    await this._ensureValidToken();

    try {
      const response = await this.client.post("/agreements/enduser/", {
        institution_id: institutionId,
        max_historical_days: maxHistoricalDays,
        access_valid_for_days: 90,
        access_scope: ["balances", "details", "transactions"],
      });

      return {
        id: response.data.id,
        institutionId: response.data.institution_id,
        maxHistoricalDays: response.data.max_historical_days,
        accessValidForDays: response.data.access_valid_for_days,
        accessScope: response.data.access_scope,
        accepted: response.data.accepted,
        createdAt: response.data.created,
      };
    } catch (error) {
      console.error(
        "❌ Erreur création agreement:",
        error.response?.data || error.message
      );
      throw new Error(`Erreur création agreement: ${error.message}`);
    }
  }

  /**
   * Crée une requisition (demande de connexion bancaire)
   * Retourne l'URL de redirection vers la banque
   */
  async createRequisition(institutionId, workspaceId, agreementId = null) {
    await this._ensureValidToken();

    try {
      const payload = {
        redirect: this.config.redirectUri,
        institution_id: institutionId,
        reference: workspaceId, // Référence unique pour identifier le workspace
        user_language: "FR",
      };

      // Ajouter l'agreement si fourni
      if (agreementId) {
        payload.agreement = agreementId;
      }

      const response = await this.client.post("/requisitions/", payload);

      return {
        id: response.data.id,
        status: response.data.status,
        institutionId: response.data.institution_id,
        reference: response.data.reference,
        link: response.data.link, // URL de redirection vers la banque
        accounts: response.data.accounts || [],
        createdAt: response.data.created,
      };
    } catch (error) {
      console.error(
        "❌ Erreur création requisition:",
        error.response?.data || error.message
      );
      throw new Error(`Erreur création requisition: ${error.message}`);
    }
  }

  /**
   * Génère l'URL de connexion bancaire
   * Workflow complet: Agreement + Requisition
   */
  async generateConnectUrl(userId, workspaceId, institutionId) {
    console.log(
      "🔍 generateConnectUrl GoCardless - workspaceId:",
      workspaceId,
      "institutionId:",
      institutionId
    );

    try {
      // 1. Créer un End User Agreement
      const agreement = await this.createEndUserAgreement(institutionId);
      console.log("✅ Agreement créé:", agreement.id);

      // 2. Créer une Requisition avec l'agreement
      const requisition = await this.createRequisition(
        institutionId,
        workspaceId,
        agreement.id
      );
      console.log("✅ Requisition créée:", requisition.id);

      // 3. Sauvegarder les infos pour le callback
      await this._saveRequisitionInfo(userId, workspaceId, {
        requisitionId: requisition.id,
        agreementId: agreement.id,
        institutionId,
        createdAt: new Date(),
      });

      return requisition.link;
    } catch (error) {
      console.error("❌ Erreur génération URL GoCardless:", error.message);
      throw new Error(`Génération URL GoCardless échouée: ${error.message}`);
    }
  }

  /**
   * Récupère le statut d'une requisition
   */
  async getRequisitionStatus(requisitionId) {
    await this._ensureValidToken();

    try {
      const response = await this.client.get(`/requisitions/${requisitionId}/`);

      return {
        id: response.data.id,
        status: response.data.status,
        institutionId: response.data.institution_id,
        reference: response.data.reference,
        accounts: response.data.accounts || [],
        link: response.data.link,
        createdAt: response.data.created,
      };
    } catch (error) {
      console.error(
        "❌ Erreur statut requisition:",
        error.response?.data || error.message
      );
      throw new Error(`Erreur récupération statut: ${error.message}`);
    }
  }

  /**
   * Traite le callback après connexion bancaire
   */
  async handleCallback(requisitionId, userId, workspaceId) {
    try {
      // Récupérer le statut de la requisition
      const requisition = await this.getRequisitionStatus(requisitionId);

      if (requisition.status !== "LN") {
        // LN = Linked (connecté avec succès)
        throw new Error(`Statut de connexion invalide: ${requisition.status}`);
      }

      // Synchroniser les comptes
      if (requisition.accounts && requisition.accounts.length > 0) {
        await this.syncUserAccounts(userId, workspaceId, requisition.accounts);
      }

      return {
        success: true,
        accountsCount: requisition.accounts.length,
      };
    } catch (error) {
      console.error("❌ Erreur callback GoCardless:", error.message);
      throw new Error(`Erreur traitement callback: ${error.message}`);
    }
  }

  /**
   * Récupère les détails d'un compte
   */
  async getAccountDetails(accountId) {
    await this._ensureValidToken();

    try {
      const response = await this.client.get(`/accounts/${accountId}/details/`);

      return {
        id: accountId,
        iban: response.data.account?.iban,
        name: response.data.account?.name || response.data.account?.ownerName,
        ownerName: response.data.account?.ownerName,
        currency: response.data.account?.currency,
        product: response.data.account?.product,
        resourceId: response.data.account?.resourceId,
      };
    } catch (error) {
      console.error(
        "❌ Erreur détails compte:",
        error.response?.data || error.message
      );
      throw new Error(`Erreur récupération détails compte: ${error.message}`);
    }
  }

  /**
   * Récupère le solde d'un compte
   */
  async getAccountBalance(accountId) {
    await this._ensureValidToken();

    try {
      const response = await this.client.get(
        `/accounts/${accountId}/balances/`
      );

      const balances = response.data.balances || [];
      // Prendre le solde "expected" ou "interimAvailable" en priorité
      const mainBalance =
        balances.find(
          (b) =>
            b.balanceType === "expected" || b.balanceType === "interimAvailable"
        ) || balances[0];

      return {
        accountId,
        balance: mainBalance ? parseFloat(mainBalance.balanceAmount.amount) : 0,
        currency: mainBalance?.balanceAmount?.currency || "EUR",
        balanceType: mainBalance?.balanceType,
        referenceDate: mainBalance?.referenceDate,
        allBalances: balances,
      };
    } catch (error) {
      console.error(
        "❌ Erreur solde compte:",
        error.response?.data || error.message
      );
      throw new Error(`Erreur récupération solde: ${error.message}`);
    }
  }

  /**
   * Récupère les transactions d'un compte
   */
  async getTransactions(accountId, userId, workspaceId, options = {}) {
    await this._ensureValidToken();

    try {
      const params = {};
      if (options.dateFrom) params.date_from = options.dateFrom;
      if (options.dateTo) params.date_to = options.dateTo;

      const response = await this.client.get(
        `/accounts/${accountId}/transactions/`,
        { params }
      );

      const bookedTransactions = response.data.transactions?.booked || [];
      const pendingTransactions = response.data.transactions?.pending || [];

      const transactions = [
        ...bookedTransactions.map((t) =>
          this._mapTransaction(t, accountId, workspaceId, "completed")
        ),
        ...pendingTransactions.map((t) =>
          this._mapTransaction(t, accountId, workspaceId, "pending")
        ),
      ];

      // Sauvegarder en base de données
      await this._saveTransactionsToDatabase(transactions, workspaceId);

      console.log(
        `✅ ${transactions.length} transactions synchronisées pour compte ${accountId}`
      );
      return transactions;
    } catch (error) {
      console.error(
        "❌ Erreur transactions:",
        error.response?.data || error.message
      );
      throw new Error(`Erreur récupération transactions: ${error.message}`);
    }
  }

  /**
   * Mappe une transaction GoCardless vers le format standard
   */
  _mapTransaction(transaction, accountId, workspaceId, status) {
    const amount = parseFloat(transaction.transactionAmount?.amount || 0);

    return {
      externalId:
        transaction.transactionId ||
        transaction.internalTransactionId ||
        `gc-${Date.now()}-${Math.random()}`,
      amount: Math.abs(amount),
      currency: transaction.transactionAmount?.currency || "EUR",
      description:
        transaction.remittanceInformationUnstructured ||
        transaction.remittanceInformationStructured ||
        transaction.creditorName ||
        transaction.debtorName ||
        "Transaction",
      date: new Date(
        transaction.bookingDate || transaction.valueDate || new Date()
      ),
      type: amount >= 0 ? "credit" : "debit",
      status,
      category: null,
      fromAccount: accountId,
      toAccount: null,
      workspaceId,
      processedAt: new Date(
        transaction.valueDate || transaction.bookingDate || new Date()
      ),
      metadata: {
        gocardlessTransactionId: transaction.transactionId,
        gocardlessInternalId: transaction.internalTransactionId,
        creditorName: transaction.creditorName,
        creditorIban: transaction.creditorAccount?.iban,
        debtorName: transaction.debtorName,
        debtorIban: transaction.debtorAccount?.iban,
        bankTransactionCode: transaction.bankTransactionCode,
        proprietaryBankTransactionCode:
          transaction.proprietaryBankTransactionCode,
      },
      fees: {
        amount: 0,
        currency: transaction.transactionAmount?.currency || "EUR",
        provider: "gocardless",
      },
      raw: transaction,
    };
  }

  /**
   * Synchronise les comptes utilisateur
   */
  async syncUserAccounts(userId, workspaceId, accountIds = null) {
    try {
      // Si pas d'accountIds fournis, récupérer depuis la requisition sauvegardée
      if (!accountIds) {
        const requisitionInfo = await this._getRequisitionInfo(
          userId,
          workspaceId
        );
        if (!requisitionInfo) {
          throw new Error("Aucune requisition trouvée pour ce workspace");
        }
        const requisition = await this.getRequisitionStatus(
          requisitionInfo.requisitionId
        );
        accountIds = requisition.accounts;
      }

      const accounts = [];

      for (const accountId of accountIds) {
        try {
          // Récupérer les détails du compte
          const details = await this.getAccountDetails(accountId);

          // Récupérer le solde
          const balanceInfo = await this.getAccountBalance(accountId);

          const accountData = {
            externalId: accountId,
            name:
              details.name ||
              details.ownerName ||
              `Compte ${accountId.slice(-4)}`,
            type: this._mapAccountType(details.product),
            status: "active",
            balance: balanceInfo.balance,
            currency: balanceInfo.currency || details.currency || "EUR",
            iban: details.iban,
            workspaceId,
            lastSyncAt: new Date(),
            raw: { details, balanceInfo },
          };

          if (userId !== "webhook-sync") {
            accountData.userId = userId;
          }

          accounts.push(accountData);
        } catch (error) {
          console.error(`❌ Erreur sync compte ${accountId}:`, error.message);
          // Continuer avec les autres comptes
        }
      }

      // Sauvegarder en base de données
      await this._saveAccountsToDatabase(accounts, workspaceId);

      console.log(
        `✅ ${accounts.length} comptes synchronisés pour workspace ${workspaceId}`
      );
      return accounts;
    } catch (error) {
      console.error("❌ Erreur synchronisation comptes:", error.message);
      throw new Error(`Erreur récupération comptes: ${error.message}`);
    }
  }

  /**
   * Synchronise toutes les transactions pour tous les comptes
   */
  async syncAllTransactions(userId, workspaceId, options = {}) {
    try {
      const accounts = await this.syncUserAccounts(userId, workspaceId);
      let totalTransactions = 0;

      for (const account of accounts) {
        try {
          const transactions = await this.getTransactions(
            account.externalId,
            userId,
            workspaceId,
            options
          );
          totalTransactions += transactions.length;
        } catch (error) {
          console.error(
            `❌ Erreur sync transactions compte ${account.name}:`,
            error.message
          );
        }
      }

      console.log(
        `✅ Synchronisation terminée: ${totalTransactions} transactions pour ${accounts.length} comptes`
      );
      return { accounts: accounts.length, transactions: totalTransactions };
    } catch (error) {
      console.error("❌ Erreur synchronisation complète:", error.message);
      throw new Error(`Erreur synchronisation complète: ${error.message}`);
    }
  }

  /**
   * Supprime une requisition et les données associées
   */
  async deleteRequisition(workspaceId) {
    try {
      const requisitionInfo = await this._getRequisitionInfo(null, workspaceId);

      if (requisitionInfo?.requisitionId) {
        await this._ensureValidToken();
        await this.client.delete(
          `/requisitions/${requisitionInfo.requisitionId}/`
        );
        console.log(
          `✅ Requisition ${requisitionInfo.requisitionId} supprimée`
        );
      }

      // Supprimer les comptes de la base de données
      const { default: AccountBanking } =
        await import("../../../models/AccountBanking.js");
      const deletedAccounts = await AccountBanking.deleteMany({
        workspaceId: workspaceId.toString(),
        provider: this.name,
      });

      // Supprimer les transactions
      const { default: Transaction } =
        await import("../../../models/Transaction.js");
      const deletedTransactions = await Transaction.deleteMany({
        workspaceId: workspaceId.toString(),
        provider: this.name,
      });

      return {
        success: true,
        deletedAccounts: deletedAccounts.deletedCount,
        deletedTransactions: deletedTransactions.deletedCount,
      };
    } catch (error) {
      console.error("❌ Erreur suppression requisition:", error.message);
      throw new Error(`Suppression échouée: ${error.message}`);
    }
  }

  /**
   * Mappe les types de comptes
   */
  _mapAccountType(product) {
    if (!product) return "checking";
    const productLower = product.toLowerCase();
    if (productLower.includes("saving") || productLower.includes("épargne"))
      return "savings";
    if (productLower.includes("credit") || productLower.includes("carte"))
      return "credit";
    if (productLower.includes("loan") || productLower.includes("prêt"))
      return "loan";
    return "checking";
  }

  /**
   * Sauvegarde les infos de requisition
   */
  async _saveRequisitionInfo(userId, workspaceId, info) {
    const { default: User } = await import("../../../models/User.js");
    await User.findByIdAndUpdate(userId, {
      $set: {
        [`gocardlessRequisitions.${workspaceId}`]: info,
      },
    });
  }

  /**
   * Récupère les infos de requisition
   */
  async _getRequisitionInfo(userId, workspaceId) {
    const { default: User } = await import("../../../models/User.js");

    if (userId) {
      const user = await User.findById(userId);
      return user?.gocardlessRequisitions?.[workspaceId];
    }

    // Rechercher par workspaceId dans tous les users
    const user = await User.findOne({
      [`gocardlessRequisitions.${workspaceId}`]: { $exists: true },
    });
    return user?.gocardlessRequisitions?.[workspaceId];
  }

  /**
   * Sauvegarde les comptes en base de données
   */
  async _saveAccountsToDatabase(accounts, workspaceId) {
    try {
      const { default: AccountBanking } =
        await import("../../../models/AccountBanking.js");
      const workspaceStringId = workspaceId.toString();

      // Récupérer les comptes explicitement déconnectés par l'utilisateur
      // pour ne pas les réactiver lors de la sync
      const disconnectedAccounts = await AccountBanking.find({
        workspaceId: workspaceStringId,
        provider: this.name,
        status: "disconnected",
      }).select("externalId");
      const disconnectedExternalIds = new Set(
        disconnectedAccounts.map((a) => a.externalId)
      );

      for (const accountData of accounts) {
        // Ne pas réactiver les comptes que l'utilisateur a déconnectés
        if (disconnectedExternalIds.has(accountData.externalId)) {
          continue;
        }

        await AccountBanking.findOneAndUpdate(
          {
            externalId: accountData.externalId,
            workspaceId: workspaceStringId,
            provider: this.name,
          },
          {
            ...accountData,
            workspaceId: workspaceStringId,
            provider: this.name,
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }
    } catch (error) {
      console.error("❌ Erreur sauvegarde comptes:", error.message);
      throw error;
    }
  }

  /**
   * Sauvegarde les transactions en base de données
   */
  async _saveTransactionsToDatabase(transactions, workspaceId) {
    try {
      const { default: Transaction } =
        await import("../../../models/Transaction.js");
      const workspaceStringId = workspaceId.toString();

      for (const transactionData of transactions) {
        await Transaction.findOneAndUpdate(
          {
            externalId: transactionData.externalId,
            workspaceId: workspaceStringId,
            provider: this.name,
          },
          {
            ...transactionData,
            workspaceId: workspaceStringId,
            provider: this.name,
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
      }
    } catch (error) {
      console.error("❌ Erreur sauvegarde transactions:", error.message);
      throw error;
    }
  }

  /**
   * Valide la configuration GoCardless
   */
  validateConfig() {
    const required = ["GOCARDLESS_SECRET_ID", "GOCARDLESS_SECRET_KEY"];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
      console.warn(
        `⚠️ Configuration GoCardless manquante: ${missing.join(", ")}`
      );
      return false;
    }

    return true;
  }
}

// Enregistrement du provider dans la factory
import { BankingProviderFactory } from "../factory/BankingProviderFactory.js";
BankingProviderFactory.registerProvider("gocardless", GoCardlessProvider);
