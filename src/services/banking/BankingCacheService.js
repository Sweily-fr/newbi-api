import { createClient } from "redis";
import logger from "../../utils/logger.js";

/**
 * Service de cache spécifique pour les données bancaires Bridge
 * Utilise Redis pour un cache performant avec TTL automatique
 * Se connecte automatiquement au démarrage
 */
class BankingCacheService {
  constructor() {
    // Configuration des TTL (en secondes)
    this.TTL = {
      accounts: 5 * 60, // 5 minutes pour les comptes
      transactions: 5 * 60, // 5 minutes pour les transactions
      balances: 2 * 60, // 2 minutes pour les soldes (plus volatile)
      stats: 10 * 60, // 10 minutes pour les statistiques
    };

    // Préfixes des clés de cache
    this.PREFIX = {
      accounts: "banking:accounts",
      transactions: "banking:transactions",
      balances: "banking:balances",
      stats: "banking:stats",
    };

    // Client Redis dédié au cache banking
    this.client = null;
    this.isConnected = false;
    this._initPromise = this._initialize();
  }

  /**
   * Initialise la connexion Redis automatiquement
   */
  async _initialize() {
    try {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

      this.client = createClient({
        url: redisUrl,
        socket: {
          // Ne JAMAIS abandonner : un restart Redis (ex: auto-refresh snap)
          // peut durer plus longtemps que quelques tentatives, et un cache
          // mort jusqu'au prochain reload PM2 coûte plus cher qu'un retry.
          reconnectStrategy: (retries) => {
            if (retries % 10 === 0) {
              logger.warn(
                `⚠️ [BankingCache] Redis injoignable, nouvelle tentative (essai ${retries})`,
              );
            }
            return Math.min(retries * 100, 3000);
          },
        },
      });

      this.client.on("error", (err) => {
        if (this.isConnected) {
          logger.error("❌ [BankingCache] Redis Error:", err.message);
        }
        this.isConnected = false;
      });

      this.client.on("ready", () => {
        this.isConnected = true;
        logger.info("✅ [BankingCache] Redis connecté");
      });

      await this.client.connect();
      this.isConnected = true;
      logger.info("✅ [BankingCache] Redis initialisé pour le cache banking");
    } catch (error) {
      logger.warn(
        `⚠️ [BankingCache] Redis non disponible: ${error.message} - Cache désactivé`,
      );
      this.isConnected = false;
    }
  }

  /**
   * Attend que Redis soit prêt
   */
  async _ensureConnected() {
    await this._initPromise;
    return this.isConnected;
  }

  /**
   * Génère une clé de cache unique
   */
  _generateKey(type, workspaceId, suffix = "") {
    const base = `${this.PREFIX[type]}:${workspaceId}`;
    return suffix ? `${base}:${suffix}` : base;
  }

  /**
   * Vérifie si Redis est disponible
   */
  async isAvailable() {
    await this._ensureConnected();
    if (!this.isConnected || !this.client) return false;
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Méthodes internes pour get/set/delete
   */
  async _get(key) {
    await this._ensureConnected();
    if (!this.isConnected || !this.client) return null;
    try {
      const value = await this.client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.error("❌ [BankingCache] GET error:", error.message);
      return null;
    }
  }

  async _set(key, value, ttlSeconds) {
    await this._ensureConnected();
    if (!this.isConnected || !this.client) return false;
    try {
      await this.client.setEx(key, ttlSeconds, JSON.stringify(value));
      return true;
    } catch (error) {
      logger.error("❌ [BankingCache] SET error:", error.message);
      return false;
    }
  }

  async _delete(key) {
    await this._ensureConnected();
    if (!this.isConnected || !this.client) return false;
    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error("❌ [BankingCache] DELETE error:", error.message);
      return false;
    }
  }

  // ==================== COMPTES BANCAIRES ====================

  /**
   * Récupère les comptes depuis le cache
   */
  async getAccounts(workspaceId) {
    try {
      const key = this._generateKey("accounts", workspaceId);
      const cached = await this._get(key);

      if (cached) {
        logger.debug(`🎯 Cache HIT: comptes pour workspace ${workspaceId}`);
        return { data: cached, fromCache: true };
      }

      logger.debug(`❌ Cache MISS: comptes pour workspace ${workspaceId}`);
      return { data: null, fromCache: false };
    } catch (error) {
      logger.error("Erreur cache getAccounts:", error);
      return { data: null, fromCache: false };
    }
  }

  /**
   * Stocke les comptes dans le cache
   */
  async setAccounts(workspaceId, accounts) {
    try {
      const key = this._generateKey("accounts", workspaceId);
      await this._set(key, accounts, this.TTL.accounts);
      logger.debug(
        `💾 Cache SET: ${accounts.length} comptes pour workspace ${workspaceId}`,
      );
      return true;
    } catch (error) {
      logger.error("Erreur cache setAccounts:", error);
      return false;
    }
  }

  // ==================== TRANSACTIONS ====================

  /**
   * Récupère les transactions depuis le cache
   */
  async getTransactions(workspaceId, options = {}) {
    try {
      // Créer une clé unique basée sur les options de filtrage
      const suffix = this._hashOptions(options);
      const key = this._generateKey("transactions", workspaceId, suffix);
      const cached = await this._get(key);

      if (cached) {
        logger.debug(
          `🎯 Cache HIT: transactions pour workspace ${workspaceId}`,
        );
        return { data: cached, fromCache: true };
      }

      logger.debug(`❌ Cache MISS: transactions pour workspace ${workspaceId}`);
      return { data: null, fromCache: false };
    } catch (error) {
      logger.error("Erreur cache getTransactions:", error);
      return { data: null, fromCache: false };
    }
  }

  /**
   * Stocke les transactions dans le cache
   */
  async setTransactions(workspaceId, transactions, options = {}) {
    try {
      const suffix = this._hashOptions(options);
      const key = this._generateKey("transactions", workspaceId, suffix);
      await this._set(key, transactions, this.TTL.transactions);
      logger.debug(
        `💾 Cache SET: ${transactions.length} transactions pour workspace ${workspaceId}`,
      );
      return true;
    } catch (error) {
      logger.error("Erreur cache setTransactions:", error);
      return false;
    }
  }

  // ==================== SOLDES ====================

  /**
   * Récupère le solde total depuis le cache
   */
  async getBalances(workspaceId) {
    try {
      const key = this._generateKey("balances", workspaceId);
      const cached = await this._get(key);

      if (cached) {
        logger.debug(`🎯 Cache HIT: soldes pour workspace ${workspaceId}`);
        return { data: cached, fromCache: true };
      }

      logger.debug(`❌ Cache MISS: soldes pour workspace ${workspaceId}`);
      return { data: null, fromCache: false };
    } catch (error) {
      logger.error("Erreur cache getBalances:", error);
      return { data: null, fromCache: false };
    }
  }

  /**
   * Stocke les soldes dans le cache
   */
  async setBalances(workspaceId, balances) {
    try {
      const key = this._generateKey("balances", workspaceId);
      await this._set(key, balances, this.TTL.balances);
      logger.debug(`💾 Cache SET: soldes pour workspace ${workspaceId}`);
      return true;
    } catch (error) {
      logger.error("Erreur cache setBalances:", error);
      return false;
    }
  }

  // ==================== STATISTIQUES ====================

  /**
   * Récupère les statistiques depuis le cache
   */
  async getStats(workspaceId) {
    try {
      const key = this._generateKey("stats", workspaceId);
      const cached = await this._get(key);

      if (cached) {
        logger.debug(`🎯 Cache HIT: stats pour workspace ${workspaceId}`);
        return { data: cached, fromCache: true };
      }

      logger.debug(`❌ Cache MISS: stats pour workspace ${workspaceId}`);
      return { data: null, fromCache: false };
    } catch (error) {
      logger.error("Erreur cache getStats:", error);
      return { data: null, fromCache: false };
    }
  }

  /**
   * Stocke les statistiques dans le cache
   */
  async setStats(workspaceId, stats) {
    try {
      const key = this._generateKey("stats", workspaceId);
      await this._set(key, stats, this.TTL.stats);
      logger.debug(`💾 Cache SET: stats pour workspace ${workspaceId}`);
      return true;
    } catch (error) {
      logger.error("Erreur cache setStats:", error);
      return false;
    }
  }

  // ==================== INVALIDATION ====================

  /**
   * Invalide le cache des comptes pour un workspace
   */
  async invalidateAccounts(workspaceId) {
    try {
      const key = this._generateKey("accounts", workspaceId);
      await this._delete(key);
      logger.info(`🗑️ Cache invalidé: comptes pour workspace ${workspaceId}`);
      return true;
    } catch (error) {
      logger.error("Erreur invalidation comptes:", error);
      return false;
    }
  }

  /**
   * Invalide le cache des transactions pour un workspace
   * Note: Invalide toutes les variantes (avec différents filtres)
   */
  async invalidateTransactions(workspaceId) {
    try {
      // Invalider la clé de base et les variantes communes
      const baseKey = this._generateKey("transactions", workspaceId);
      await this._delete(baseKey);

      // Invalider les variantes avec options courantes
      const commonOptions = [
        { limit: 50 },
        { limit: 100 },
        { limit: 500 },
        { limit: 50, page: 1 },
        { limit: 100, page: 1 },
      ];

      for (const options of commonOptions) {
        const suffix = this._hashOptions(options);
        const key = this._generateKey("transactions", workspaceId, suffix);
        await this._delete(key);
      }

      logger.info(
        `🗑️ Cache invalidé: transactions pour workspace ${workspaceId}`,
      );
      return true;
    } catch (error) {
      logger.error("Erreur invalidation transactions:", error);
      return false;
    }
  }

  /**
   * Invalide le cache des soldes pour un workspace
   */
  async invalidateBalances(workspaceId) {
    try {
      const key = this._generateKey("balances", workspaceId);
      await this._delete(key);
      logger.info(`🗑️ Cache invalidé: soldes pour workspace ${workspaceId}`);
      return true;
    } catch (error) {
      logger.error("Erreur invalidation soldes:", error);
      return false;
    }
  }

  /**
   * Invalide le cache des statistiques pour un workspace
   */
  async invalidateStats(workspaceId) {
    try {
      const key = this._generateKey("stats", workspaceId);
      await this._delete(key);
      logger.info(`🗑️ Cache invalidé: stats pour workspace ${workspaceId}`);
      return true;
    } catch (error) {
      logger.error("Erreur invalidation stats:", error);
      return false;
    }
  }

  /**
   * Invalide tout le cache bancaire pour un workspace
   */
  async invalidateAll(workspaceId) {
    try {
      await Promise.all([
        this.invalidateAccounts(workspaceId),
        this.invalidateTransactions(workspaceId),
        this.invalidateBalances(workspaceId),
        this.invalidateStats(workspaceId),
      ]);
      logger.info(`🗑️ Cache COMPLET invalidé pour workspace ${workspaceId}`);
      return true;
    } catch (error) {
      logger.error("Erreur invalidation complète:", error);
      return false;
    }
  }

  // ==================== UTILITAIRES ====================

  /**
   * Génère un hash simple des options pour créer des clés uniques
   */
  _hashOptions(options) {
    if (!options || Object.keys(options).length === 0) return "";

    // Trier les clés pour garantir la cohérence
    const sorted = Object.keys(options)
      .sort()
      .map((key) => `${key}:${options[key]}`)
      .join("_");

    return sorted;
  }

  /**
   * Obtient les informations sur le cache d'un workspace
   */
  async getCacheInfo(workspaceId) {
    const info = {
      workspaceId,
      available: await this.isAvailable(),
      ttl: this.TTL,
      cached: {
        accounts: false,
        transactions: false,
        balances: false,
        stats: false,
      },
    };

    if (info.available) {
      const [accounts, transactions, balances, stats] = await Promise.all([
        this.getAccounts(workspaceId),
        this.getTransactions(workspaceId),
        this.getBalances(workspaceId),
        this.getStats(workspaceId),
      ]);

      info.cached = {
        accounts: accounts.fromCache,
        transactions: transactions.fromCache,
        balances: balances.fromCache,
        stats: stats.fromCache,
      };
    }

    return info;
  }
}

// Instance singleton
export const bankingCacheService = new BankingCacheService();
export default bankingCacheService;
