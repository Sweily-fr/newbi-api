import logger from "../../../utils/logger.js";
import { BankingProvider } from "../interfaces/BankingProvider.js";

/**
 * Factory Pattern pour l'instanciation dynamique des providers bancaires
 * Permet le hot-swapping en production via variables d'environnement
 */
export class BankingProviderFactory {
  static providers = new Map();
  static defaultProvider = null;

  /**
   * Enregistre un provider dans la factory
   * @param {string} name - Nom du provider
   * @param {Class} providerClass - Classe du provider
   */
  static registerProvider(name, providerClass) {
    this.providers.set(name, providerClass);
  }

  /**
   * Crée une instance de provider selon la configuration
   * @param {string} providerName - Nom du provider à instancier
   * @param {Object} config - Configuration du provider
   * @returns {BankingProvider} Instance du provider
   */
  static createProvider(providerName = null, config = {}) {
    const selectedProvider =
      providerName ||
      process.env.BANKING_PROVIDER ||
      process.env.DEFAULT_BANKING_PROVIDER ||
      "gocardless";

    logger.debug(`🏦 Création du provider banking: ${selectedProvider}`);

    const ProviderClass = this.providers.get(selectedProvider);

    if (!ProviderClass) {
      throw new Error(`Provider bancaire non supporté: ${selectedProvider}`);
    }

    // Merge de la configuration par défaut avec celle fournie
    const providerConfig = this.getProviderConfig(selectedProvider, config);

    const instance = new ProviderClass(providerConfig);

    // Validation de la configuration
    if (!instance.validateConfig()) {
      throw new Error(
        `Configuration invalide pour le provider: ${selectedProvider}`,
      );
    }

    return instance;
  }

  /**
   * Récupère la configuration pour un provider spécifique
   * @param {string} providerName - Nom du provider
   * @param {Object} customConfig - Configuration personnalisée
   * @returns {Object} Configuration complète
   */
  static getProviderConfig(providerName, customConfig = {}) {
    const baseConfig = {
      environment: process.env.NODE_ENV || "development",
      timeout: 30000,
      retries: 3,
      logRequests: process.env.LOG_BANKING_REQUESTS === "true",
    };

    const providerConfigs = {
      gocardless: {
        secretId: process.env.GOCARDLESS_SECRET_ID,
        secretKey: process.env.GOCARDLESS_SECRET_KEY,
        baseUrl:
          process.env.GOCARDLESS_BASE_URL ||
          "https://bankaccountdata.gocardless.com/api/v2",
        redirectUri: process.env.GOCARDLESS_REDIRECT_URI,
      },
      bridge: {
        clientId: process.env.BRIDGE_CLIENT_ID,
        clientSecret: process.env.BRIDGE_CLIENT_SECRET,
        baseUrl: process.env.BRIDGE_BASE_URL || "https://api.bridgeapi.io",
        version: process.env.BRIDGE_API_VERSION || "v2",
        webhookSecret: process.env.BRIDGE_WEBHOOK_SECRET,
      },
      stripe: {
        secretKey: process.env.STRIPE_SECRET_KEY,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
        apiVersion: process.env.STRIPE_API_VERSION || "2023-10-16",
      },
      paypal: {
        clientId: process.env.PAYPAL_CLIENT_ID,
        clientSecret: process.env.PAYPAL_CLIENT_SECRET,
        baseUrl: process.env.PAYPAL_BASE_URL || "https://api.paypal.com",
        webhookId: process.env.PAYPAL_WEBHOOK_ID,
      },
      mock: {
        enabled: true,
        simulateDelay: parseInt(process.env.MOCK_DELAY || "1000"),
        failureRate: parseFloat(process.env.MOCK_FAILURE_RATE || "0.1"),
      },
    };

    return {
      ...baseConfig,
      ...providerConfigs[providerName],
      ...customConfig,
    };
  }

  /**
   * Liste tous les providers disponibles
   * @returns {Array} Liste des providers enregistrés
   */
  static getAvailableProviders() {
    return Array.from(this.providers.keys());
  }

  /**
   * Vérifie si un provider est disponible
   * @param {string} providerName - Nom du provider
   * @returns {boolean} Provider disponible
   */
  static isProviderAvailable(providerName) {
    return this.providers.has(providerName);
  }

  /**
   * Crée plusieurs providers pour comparaison de coûts
   * @param {Array} providerNames - Liste des providers à créer
   * @returns {Map} Map des providers instanciés
   */
  static createMultipleProviders(providerNames) {
    const providers = new Map();

    for (const providerName of providerNames) {
      try {
        const provider = this.createProvider(providerName);
        providers.set(providerName, provider);
      } catch (error) {
        console.warn(
          `Impossible de créer le provider ${providerName}:`,
          error.message,
        );
      }
    }

    return providers;
  }

  /**
   * Hot-swap du provider par défaut
   * @param {string} newProviderName - Nouveau provider par défaut
   */
  static setDefaultProvider(newProviderName) {
    if (!this.isProviderAvailable(newProviderName)) {
      throw new Error(`Provider ${newProviderName} non disponible`);
    }

    this.defaultProvider = newProviderName;
    logger.debug(`🔄 Provider par défaut changé pour: ${newProviderName}`);
  }

  /**
   * Initialise la factory avec les providers par défaut
   */
  static async initialize() {
    // Les providers seront enregistrés lors de leur import
    logger.debug("🏭 Factory Banking initialisée");
    logger.debug(
      `📋 Providers disponibles: ${this.getAvailableProviders().join(", ")}`,
    );
  }
}
