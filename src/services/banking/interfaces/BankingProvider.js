/**
 * Interface Strategy pour les providers bancaires
 * Définit le contrat que tous les providers doivent implémenter
 */
export class BankingProvider {
  constructor(config) {
    this.config = config;
    this.providerName = 'base';
  }

  /**
   * Initialise la connexion avec l'API bancaire
   */
  async initialize() {
    throw new Error('initialize() must be implemented by provider');
  }

  /**
   * Traite un paiement
   * @param {Object} options - Options du paiement
   * @returns {Promise<Object>} Transaction standardisée
   */
  async processPayment(options) {
    throw new Error('processPayment() must be implemented by provider');
  }

  /**
   * Effectue un remboursement
   * @param {Object} options - Options du remboursement
   * @returns {Promise<Object>} Transaction de remboursement
   */
  async processRefund(options) {
    throw new Error('processRefund() must be implemented by provider');
  }

  /**
   * Récupère le solde d'un compte
   * @param {string} accountId - ID du compte
   * @returns {Promise<Object>} Solde du compte
   */
  async getAccountBalance(accountId) {
    throw new Error('getAccountBalance() must be implemented by provider');
  }

  /**
   * Récupère l'historique des transactions
   * @param {string} accountId - ID du compte
   * @param {Object} filters - Filtres (dates, montants, etc.)
   * @returns {Promise<Array>} Liste des transactions
   */
  async getTransactionHistory(accountId, filters = {}) {
    throw new Error('getTransactionHistory() must be implemented by provider');
  }

  /**
   * Récupère les détails d'un compte
   * @param {string} accountId - ID du compte
   * @returns {Promise<Object>} Détails du compte
   */
  async getAccountDetails(accountId) {
    throw new Error('getAccountDetails() must be implemented by provider');
  }

  /**
   * Liste tous les comptes de l'utilisateur
   * @param {string} userId - ID de l'utilisateur
   * @returns {Promise<Array>} Liste des comptes
   */
  async listAccounts(userId) {
    throw new Error('listAccounts() must be implemented by provider');
  }

  /**
   * Vérifie le statut d'une transaction
   * @param {string} transactionId - ID de la transaction
   * @returns {Promise<Object>} Statut de la transaction
   */
  async getTransactionStatus(transactionId) {
    throw new Error('getTransactionStatus() must be implemented by provider');
  }

  /**
   * Crée un compte bancaire
   * @param {Object} accountData - Données du compte
   * @returns {Promise<Object>} Compte créé
   */
  async createAccount(accountData) {
    throw new Error('createAccount() must be implemented by provider');
  }

  /**
   * Met à jour un compte bancaire
   * @param {string} accountId - ID du compte
   * @param {Object} updateData - Données à mettre à jour
   * @returns {Promise<Object>} Compte mis à jour
   */
  async updateAccount(accountId, updateData) {
    throw new Error('updateAccount() must be implemented by provider');
  }

  /**
   * Supprime un compte bancaire
   * @param {string} accountId - ID du compte
   * @returns {Promise<boolean>} Succès de la suppression
   */
  async deleteAccount(accountId) {
    throw new Error('deleteAccount() must be implemented by provider');
  }

  /**
   * Webhook handler pour les notifications du provider
   * @param {Object} payload - Payload du webhook
   * @returns {Promise<Object>} Réponse du webhook
   */
  async handleWebhook(payload) {
    throw new Error('handleWebhook() must be implemented by provider');
  }

  /**
   * Valide la configuration du provider
   * @returns {boolean} Configuration valide
   */
  validateConfig() {
    throw new Error('validateConfig() must be implemented by provider');
  }

  /**
   * Retourne les métriques de coût pour ce provider
   * @returns {Object} Métriques de coût
   */
  getCostMetrics() {
    return {
      provider: this.providerName,
      requestCount: 0,
      totalCost: 0,
      averageCostPerRequest: 0
    };
  }

  /**
   * Mappe une réponse API vers le format standard
   * @param {Object} apiResponse - Réponse de l'API
   * @param {string} type - Type de mapping (transaction, account, etc.)
   * @returns {Object} Objet mappé au format standard
   */
  mapToStandardFormat(apiResponse, type) {
    throw new Error('mapToStandardFormat() must be implemented by provider');
  }

  /**
   * Gère les erreurs spécifiques au provider
   * @param {Error} error - Erreur originale
   * @returns {Error} Erreur standardisée
   */
  handleProviderError(error) {
    return new Error(`${this.providerName} error: ${error.message}`);
  }
}
