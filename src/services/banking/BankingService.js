import { BankingProviderFactory } from "./factory/BankingProviderFactory.js";
import Transaction from "../../models/Transaction.js";
import AccountBanking from "../../models/AccountBanking.js";
import ApiMetric from "../../models/ApiMetric.js";
import { suggestPCGAccount } from "../../utils/pcg-mapping.js";

/**
 * Service principal pour la gestion bancaire
 * Orchestre les différents providers et gère le stockage unifié
 */
export class BankingService {
  constructor() {
    this.currentProvider = null;
    this.providers = new Map();
    this.initialized = false;
  }

  /**
   * Initialise le service banking
   * @param {string} defaultProvider - Provider par défaut
   */
  async initialize(defaultProvider = null) {
    try {
      await BankingProviderFactory.initialize();
      this.currentProvider =
        BankingProviderFactory.createProvider(defaultProvider);
      await this.currentProvider.initialize();
      this.initialized = true;
      console.log(
        `✅ BankingService initialisé avec le provider: ${this.currentProvider.providerName}`,
      );
    } catch (error) {
      console.error(
        "❌ Erreur lors de l'initialisation du BankingService:",
        error,
      );
      throw error;
    }
  }

  /**
   * Switch vers un autre provider (hot-swapping)
   * @param {string} providerName - Nom du nouveau provider
   */
  async switchProvider(providerName) {
    try {
      const newProvider = BankingProviderFactory.createProvider(providerName);
      await newProvider.initialize();

      const oldProviderName = this.currentProvider?.providerName || "none";
      this.currentProvider = newProvider;

      console.log(
        `🔄 Provider switché de ${oldProviderName} vers ${providerName}`,
      );
      return true;
    } catch (error) {
      console.error(`❌ Erreur lors du switch vers ${providerName}:`, error);
      throw error;
    }
  }

  /**
   * Traite un paiement avec métriques
   * @param {Object} paymentOptions - Options du paiement
   * @returns {Promise<Object>} Transaction créée
   */
  async processPayment(paymentOptions) {
    this._ensureInitialized();

    const startTime = Date.now();
    let success = false;
    let cost = 0;

    try {
      // Traitement du paiement via le provider
      const providerResponse =
        await this.currentProvider.processPayment(paymentOptions);

      // Mapping vers format standard
      const standardTransaction = this.currentProvider.mapToStandardFormat(
        providerResponse,
        "transaction",
      );

      // Pré-remplir le compte PCG
      const pcgSuggestion = suggestPCGAccount(standardTransaction);

      // Sauvegarde en base
      const transaction = new Transaction({
        ...standardTransaction,
        provider: this.currentProvider.providerName,
        workspaceId: paymentOptions.workspaceId,
        userId: paymentOptions.userId,
        pcgAccount: {
          numero: pcgSuggestion.numero,
          intitule: pcgSuggestion.intitule,
          confidence: pcgSuggestion.confidence,
          isManual: false,
        },
        raw: providerResponse,
      });

      await transaction.save();

      success = true;
      cost = this._calculateCost("processPayment", paymentOptions.amount);

      console.log(
        `✅ Paiement traité: ${transaction.id} (${paymentOptions.amount} ${paymentOptions.currency})`,
      );

      return transaction;
    } catch (error) {
      console.error("❌ Erreur lors du traitement du paiement:", error);
      throw this.currentProvider.handleProviderError(error);
    } finally {
      // Enregistrement des métriques
      await this._recordMetrics(
        "processPayment",
        "POST",
        paymentOptions.workspaceId,
        Date.now() - startTime,
        success,
        cost,
      );
    }
  }

  /**
   * Effectue un remboursement
   * @param {Object} refundOptions - Options du remboursement
   * @returns {Promise<Object>} Transaction de remboursement
   */
  async processRefund(refundOptions) {
    this._ensureInitialized();

    const startTime = Date.now();
    let success = false;
    let cost = 0;

    try {
      // Récupération de la transaction originale
      const originalTransaction = await Transaction.findById(
        refundOptions.transactionId,
      );
      if (!originalTransaction) {
        throw new Error("Transaction originale non trouvée");
      }

      if (!originalTransaction.canBeRefunded()) {
        throw new Error("Cette transaction ne peut pas être remboursée");
      }

      // Traitement du remboursement
      const providerResponse =
        await this.currentProvider.processRefund(refundOptions);
      const standardTransaction = this.currentProvider.mapToStandardFormat(
        providerResponse,
        "transaction",
      );

      // Pré-remplir le compte PCG
      const pcgRefundSuggestion = suggestPCGAccount(standardTransaction);

      // Sauvegarde du remboursement
      const refundTransaction = new Transaction({
        ...standardTransaction,
        provider: this.currentProvider.providerName,
        type: "refund",
        workspaceId: refundOptions.workspaceId,
        userId: refundOptions.userId,
        pcgAccount: {
          numero: pcgRefundSuggestion.numero,
          intitule: pcgRefundSuggestion.intitule,
          confidence: pcgRefundSuggestion.confidence,
          isManual: false,
        },
        metadata: {
          ...standardTransaction.metadata,
          originalTransactionId: originalTransaction.id,
        },
        raw: providerResponse,
      });

      await refundTransaction.save();

      // Mise à jour de la transaction originale
      originalTransaction.status = "refunded";
      await originalTransaction.save();

      success = true;
      cost = this._calculateCost("processRefund", refundOptions.amount);

      console.log(`✅ Remboursement traité: ${refundTransaction.id}`);

      return refundTransaction;
    } catch (error) {
      console.error("❌ Erreur lors du remboursement:", error);
      throw this.currentProvider.handleProviderError(error);
    } finally {
      await this._recordMetrics(
        "processRefund",
        "POST",
        refundOptions.workspaceId,
        Date.now() - startTime,
        success,
        cost,
      );
    }
  }

  /**
   * Récupère le solde d'un compte
   * @param {string} accountId - ID du compte
   * @param {string} workspaceId - ID du workspace
   * @returns {Promise<Object>} Solde du compte
   */
  async getAccountBalance(accountId, workspaceId) {
    this._ensureInitialized();

    const startTime = Date.now();
    let success = false;

    try {
      // Récupération du compte en base
      const account = await AccountBanking.findOne({
        externalId: accountId,
        workspaceId,
        provider: this.currentProvider.providerName,
      });

      if (!account) {
        throw new Error("Compte non trouvé");
      }

      // Récupération du solde via le provider
      const providerBalance =
        await this.currentProvider.getAccountBalance(accountId);
      const standardBalance = this.currentProvider.mapToStandardFormat(
        providerBalance,
        "balance",
      );

      // Mise à jour du solde en base
      await account.updateBalance(standardBalance);

      success = true;

      return standardBalance;
    } catch (error) {
      console.error("❌ Erreur lors de la récupération du solde:", error);
      throw this.currentProvider.handleProviderError(error);
    } finally {
      await this._recordMetrics(
        "getAccountBalance",
        "GET",
        workspaceId,
        Date.now() - startTime,
        success,
        0.01,
      );
    }
  }

  /**
   * Récupère l'historique des transactions
   * @param {string} accountId - ID du compte
   * @param {string} workspaceId - ID du workspace
   * @param {Object} filters - Filtres de recherche
   * @returns {Promise<Array>} Liste des transactions
   */
  async getTransactionHistory(accountId, workspaceId, filters = {}) {
    this._ensureInitialized();

    const startTime = Date.now();
    let success = false;

    try {
      // Récupération depuis la base locale d'abord
      const localTransactions = await Transaction.findByWorkspace(workspaceId, {
        $or: [{ fromAccount: accountId }, { toAccount: accountId }],
        ...filters,
      });

      // Synchronisation avec le provider si nécessaire
      if (filters.sync !== false) {
        const providerTransactions =
          await this.currentProvider.getTransactionHistory(accountId, filters);

        // Mise à jour des transactions manquantes
        for (const providerTx of providerTransactions) {
          const existing = await Transaction.findByProvider(
            this.currentProvider.providerName,
            providerTx.externalId,
          );

          if (!existing) {
            const standardTx = this.currentProvider.mapToStandardFormat(
              providerTx,
              "transaction",
            );
            const pcgSyncSuggestion = suggestPCGAccount(standardTx);
            const newTransaction = new Transaction({
              ...standardTx,
              provider: this.currentProvider.providerName,
              workspaceId,
              pcgAccount: {
                numero: pcgSyncSuggestion.numero,
                intitule: pcgSyncSuggestion.intitule,
                confidence: pcgSyncSuggestion.confidence,
                isManual: false,
              },
              raw: providerTx,
            });
            await newTransaction.save();
          }
        }
      }

      success = true;

      return localTransactions;
    } catch (error) {
      console.error(
        "❌ Erreur lors de la récupération de l'historique:",
        error,
      );
      throw this.currentProvider.handleProviderError(error);
    } finally {
      await this._recordMetrics(
        "getTransactionHistory",
        "GET",
        workspaceId,
        Date.now() - startTime,
        success,
        0.05,
      );
    }
  }

  /**
   * Liste les comptes d'un utilisateur
   * @param {string} userId - ID de l'utilisateur
   * @param {string} workspaceId - ID du workspace
   * @returns {Promise<Array>} Liste des comptes
   */
  async listAccounts(userId, workspaceId) {
    this._ensureInitialized();

    const startTime = Date.now();
    let success = false;

    try {
      // Récupération depuis la base locale
      const localAccounts = await AccountBanking.findByWorkspace(workspaceId);

      success = true;

      return localAccounts;
    } catch (error) {
      console.error("❌ Erreur lors de la récupération des comptes:", error);
      throw this.currentProvider.handleProviderError(error);
    } finally {
      await this._recordMetrics(
        "listAccounts",
        "GET",
        workspaceId,
        Date.now() - startTime,
        success,
        0.02,
      );
    }
  }

  /**
   * Gère les webhooks des providers
   * @param {string} providerName - Nom du provider
   * @param {Object} payload - Payload du webhook
   * @returns {Promise<Object>} Réponse du webhook
   */
  async handleWebhook(providerName, payload) {
    try {
      const provider = BankingProviderFactory.createProvider(providerName);
      const result = await provider.handleWebhook(payload);

      // Traitement du webhook selon le type
      if (result.type === "transaction_updated") {
        await this._updateTransactionFromWebhook(result.data, providerName);
      } else if (result.type === "account_updated") {
        await this._updateAccountFromWebhook(result.data, providerName);
      }

      return result;
    } catch (error) {
      console.error(
        `❌ Erreur lors du traitement du webhook ${providerName}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Récupère les métriques de coût par provider
   * @param {string} workspaceId - ID du workspace
   * @param {Date} startDate - Date de début
   * @param {Date} endDate - Date de fin
   * @returns {Promise<Array>} Métriques de coût
   */
  async getCostMetrics(workspaceId, startDate, endDate) {
    return await ApiMetric.getCostComparison(startDate, endDate);
  }

  // Méthodes privées

  _ensureInitialized() {
    if (!this.initialized || !this.currentProvider) {
      throw new Error("BankingService non initialisé");
    }
  }

  _calculateCost(operation, amount = 0) {
    // Simulation du calcul de coût basé sur l'opération et le montant
    const baseCosts = {
      processPayment: 0.3 + amount * 0.029, // 30 centimes + 2.9%
      processRefund: 0.15,
      getAccountBalance: 0.01,
      getTransactionHistory: 0.05,
      listAccounts: 0.02,
    };

    return baseCosts[operation] || 0.01;
  }

  async _recordMetrics(
    endpoint,
    method,
    workspaceId,
    responseTime,
    success,
    cost,
  ) {
    try {
      const metric = await ApiMetric.findOrCreate(
        this.currentProvider.providerName,
        endpoint,
        method,
        workspaceId,
      );

      await metric.addRequest(responseTime, success, cost);
    } catch (error) {
      console.error("❌ Erreur lors de l'enregistrement des métriques:", error);
    }
  }

  async _updateTransactionFromWebhook(transactionData, providerName) {
    const transaction = await Transaction.findByProvider(
      providerName,
      transactionData.externalId,
    );
    if (transaction) {
      transaction.status = transactionData.status;
      transaction.processedAt = transactionData.processedAt || new Date();
      if (transactionData.failureReason) {
        transaction.failureReason = transactionData.failureReason;
      }
      await transaction.save();
    }
  }

  async _updateAccountFromWebhook(accountData, providerName) {
    const account = await AccountBanking.findByProvider(
      providerName,
      accountData.externalId,
    );
    if (account) {
      await account.updateBalance(accountData.balance);
    }
  }
}

// Instance singleton
export const bankingService = new BankingService();
