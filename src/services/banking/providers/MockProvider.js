import { BankingProvider } from '../interfaces/BankingProvider.js';

/**
 * Provider Mock pour les tests et le développement
 * Simule les réponses d'une API bancaire
 */
export class MockProvider extends BankingProvider {
  constructor(config) {
    super(config);
    this.providerName = 'mock';
    this.mockAccounts = new Map();
    this.mockTransactions = new Map();
    this.transactionCounter = 1;
  }

  async initialize() {
    console.log('✅ Mock Provider initialisé');
    this._seedMockData();
  }

  async processPayment(options) {
    await this._simulateDelay();
    
    if (this._shouldSimulateFailure()) {
      throw new Error('Simulation d\'échec de paiement');
    }

    const transactionId = `mock_tx_${this.transactionCounter++}`;
    const transaction = {
      id: transactionId,
      amount: options.amount * 100, // Centimes
      currency: options.currency,
      description: options.description,
      account_id: options.fromAccount,
      beneficiary: {
        iban: options.toAccount
      },
      status: 'processed',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: options.metadata
    };

    this.mockTransactions.set(transactionId, transaction);
    return transaction;
  }

  async processRefund(options) {
    await this._simulateDelay();
    
    const originalTransaction = this.mockTransactions.get(options.originalPaymentId);
    if (!originalTransaction) {
      throw new Error('Transaction originale non trouvée');
    }

    const refundId = `mock_refund_${this.transactionCounter++}`;
    const refund = {
      id: refundId,
      payment_id: options.originalPaymentId,
      amount: options.amount ? options.amount * 100 : originalTransaction.amount,
      reason: options.reason,
      status: 'processed',
      created_at: new Date().toISOString(),
      metadata: options.metadata
    };

    this.mockTransactions.set(refundId, refund);
    return refund;
  }

  async getAccountBalance(accountId) {
    await this._simulateDelay();
    
    const account = this.mockAccounts.get(accountId);
    if (!account) {
      throw new Error('Compte non trouvé');
    }

    return {
      id: accountId,
      balance: account.balance,
      currency_code: 'EUR'
    };
  }

  async getTransactionHistory(accountId, filters = {}) {
    await this._simulateDelay();
    
    const transactions = Array.from(this.mockTransactions.values())
      .filter(tx => tx.account_id === accountId)
      .slice(0, filters.limit || 50);

    return transactions;
  }

  async getAccountDetails(accountId) {
    await this._simulateDelay();
    
    const account = this.mockAccounts.get(accountId);
    if (!account) {
      throw new Error('Compte non trouvé');
    }

    return account;
  }

  async listAccounts(userId) {
    await this._simulateDelay();
    return Array.from(this.mockAccounts.values());
  }

  async getTransactionStatus(transactionId) {
    await this._simulateDelay();
    
    const transaction = this.mockTransactions.get(transactionId);
    if (!transaction) {
      throw new Error('Transaction non trouvée');
    }

    return transaction;
  }

  async createAccount(accountData) {
    await this._simulateDelay();
    
    const accountId = `mock_acc_${Date.now()}`;
    const account = {
      id: accountId,
      name: accountData.name,
      type: accountData.type || 'checking',
      balance: 100000, // 1000€ en centimes
      currency_code: 'EUR',
      iban: `FR76${Math.random().toString().substr(2, 20)}`,
      bank: {
        name: 'Mock Bank'
      },
      owner: {
        name: accountData.holderName,
        email: accountData.holderEmail
      },
      created_at: new Date().toISOString()
    };

    this.mockAccounts.set(accountId, account);
    return account;
  }

  async updateAccount(accountId, updateData) {
    await this._simulateDelay();
    
    const account = this.mockAccounts.get(accountId);
    if (!account) {
      throw new Error('Compte non trouvé');
    }

    Object.assign(account, updateData);
    return account;
  }

  async deleteAccount(accountId) {
    await this._simulateDelay();
    return this.mockAccounts.delete(accountId);
  }

  async handleWebhook(payload) {
    // Simulation de traitement de webhook
    return {
      type: 'transaction_updated',
      data: payload
    };
  }

  validateConfig() {
    return true; // Mock provider est toujours valide
  }

  mapToStandardFormat(apiResponse, type) {
    switch (type) {
      case 'transaction':
        return {
          externalId: apiResponse.id,
          type: 'payment',
          status: apiResponse.status === 'processed' ? 'completed' : 'pending',
          amount: apiResponse.amount / 100,
          currency: apiResponse.currency || 'EUR',
          description: apiResponse.description || 'Mock transaction',
          fromAccount: apiResponse.account_id,
          toAccount: apiResponse.beneficiary?.iban,
          processedAt: new Date(apiResponse.updated_at),
          metadata: apiResponse.metadata || {}
        };

      case 'account':
        return {
          externalId: apiResponse.id,
          type: apiResponse.type || 'checking',
          status: 'active',
          balance: {
            available: apiResponse.balance / 100,
            current: apiResponse.balance / 100,
            currency: apiResponse.currency_code
          },
          iban: apiResponse.iban,
          bankName: apiResponse.bank?.name || 'Mock Bank',
          accountHolder: {
            name: apiResponse.owner?.name || 'Mock User',
            email: apiResponse.owner?.email || 'mock@example.com'
          }
        };

      case 'balance':
        return {
          available: apiResponse.balance / 100,
          current: apiResponse.balance / 100,
          currency: apiResponse.currency_code
        };

      default:
        return apiResponse;
    }
  }

  // Méthodes privées

  async _simulateDelay() {
    const delay = this.config.simulateDelay || 500;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  _shouldSimulateFailure() {
    const failureRate = this.config.failureRate || 0.05; // 5% par défaut
    return Math.random() < failureRate;
  }

  _seedMockData() {
    // Création de comptes mock par défaut
    const mockAccount1 = {
      id: 'mock_acc_1',
      name: 'Compte Courant Principal',
      type: 'checking',
      balance: 250000, // 2500€
      currency_code: 'EUR',
      iban: 'FR7630001007941234567890185',
      bank: {
        name: 'Mock Bank France'
      },
      owner: {
        name: 'John Doe',
        email: 'john.doe@example.com'
      },
      created_at: new Date().toISOString()
    };

    const mockAccount2 = {
      id: 'mock_acc_2',
      name: 'Compte Épargne',
      type: 'savings',
      balance: 500000, // 5000€
      currency_code: 'EUR',
      iban: 'FR7630001007941234567890186',
      bank: {
        name: 'Mock Bank France'
      },
      owner: {
        name: 'John Doe',
        email: 'john.doe@example.com'
      },
      created_at: new Date().toISOString()
    };

    this.mockAccounts.set('mock_acc_1', mockAccount1);
    this.mockAccounts.set('mock_acc_2', mockAccount2);

    // Création de transactions mock
    const mockTransaction1 = {
      id: 'mock_tx_1',
      amount: 15000, // 150€
      currency: 'EUR',
      description: 'Paiement facture électricité',
      account_id: 'mock_acc_1',
      beneficiary: {
        iban: 'FR7630001007941234567890999'
      },
      status: 'processed',
      created_at: new Date(Date.now() - 86400000).toISOString(), // Hier
      updated_at: new Date(Date.now() - 86400000).toISOString(),
      category: 'payment'
    };

    this.mockTransactions.set('mock_tx_1', mockTransaction1);
    this.transactionCounter = 2;
  }
}

// Enregistrement du provider dans la factory
import { BankingProviderFactory } from '../factory/BankingProviderFactory.js';
BankingProviderFactory.registerProvider('mock', MockProvider);
