import logger from "../utils/logger.js";
/**
 * Service de cache Redis pour l'OCR
 * Évite de retraiter les factures déjà extraites
 *
 * Fonctionnalités:
 * - Cache basé sur le hash SHA256 du document
 * - TTL de 30 jours par défaut
 * - Fallback gracieux si Redis indisponible
 */

import { createClient } from "redis";
import crypto from "crypto";
import dotenv from "dotenv";

dotenv.config();

class OcrCacheService {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.TTL = 30 * 24 * 60 * 60; // 30 jours en secondes
    this.prefix = "ocr:invoice:";

    // Stats
    this.stats = {
      hits: 0,
      misses: 0,
      errors: 0,
    };

    this.init();
  }

  /**
   * Initialise la connexion Redis
   */
  async init() {
    const redisUrl = process.env.REDIS_URL;
    const redisHost = process.env.REDIS_HOST;

    if (!redisUrl && !redisHost) {
      logger.debug("ℹ️ OCR Cache: Redis non configuré, cache désactivé");
      return;
    }

    try {
      let redisOptions;

      if (redisUrl) {
        // REDIS_URL (staging/production) — l'URL peut contenir l'auth
        redisOptions = {
          url: redisUrl,
          socket: {
            reconnectStrategy: (retries) => {
              if (retries > 5) return false; // Stop après 5 tentatives
              return Math.min(retries * 100, 500);
            },
          },
        };
      } else {
        // REDIS_HOST/PORT (local)
        redisOptions = {
          socket: {
            host: redisHost || "localhost",
            port: parseInt(process.env.REDIS_PORT || "6379"),
            reconnectStrategy: (retries) => {
              if (retries > 5) return false;
              return Math.min(retries * 100, 500);
            },
          },
          database: parseInt(process.env.REDIS_DB || "0"),
        };

        if (process.env.REDIS_PASSWORD) {
          redisOptions.password = process.env.REDIS_PASSWORD;
        }
      }

      this.client = createClient(redisOptions);

      this.client.on("error", (err) => {
        if (!this._errorLogged) {
          console.warn("⚠️ OCR Cache Redis error:", err.message);
          this._errorLogged = true;
        }
        this.isConnected = false;
      });

      this.client.on("connect", () => {
        logger.debug("✅ OCR Cache: Connecté à Redis");
        this.isConnected = true;
        this._errorLogged = false;
      });

      this.client.on("disconnect", () => {
        this.isConnected = false;
      });

      await this.client.connect();
    } catch (error) {
      console.warn(
        "⚠️ OCR Cache: Impossible de se connecter à Redis:",
        error.message,
      );
      this.client = null;
    }
  }

  /**
   * Génère un hash SHA256 pour un buffer
   */
  generateHash(buffer) {
    if (typeof buffer === "string") {
      // Si c'est du base64, on hash directement
      return crypto.createHash("sha256").update(buffer).digest("hex");
    }
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  /**
   * Récupère une entrée du cache
   * @param {string} hash - Hash du document
   * @returns {Object|null} - Données cachées ou null
   */
  async get(hash) {
    if (!this.client || !this.isConnected) {
      return null;
    }

    try {
      const key = `${this.prefix}${hash}`;
      const cached = await this.client.get(key);

      if (cached) {
        this.stats.hits++;
        return JSON.parse(cached);
      }

      this.stats.misses++;
      return null;
    } catch (error) {
      this.stats.errors++;
      console.warn("⚠️ OCR Cache get error:", error.message);
      return null;
    }
  }

  /**
   * Sauvegarde une entrée dans le cache
   * @param {string} hash - Hash du document
   * @param {Object} data - Données à cacher
   */
  async set(hash, data) {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = `${this.prefix}${hash}`;
      const value = JSON.stringify({
        ...data,
        cachedAt: Date.now(),
      });

      await this.client.setEx(key, this.TTL, value);
      return true;
    } catch (error) {
      this.stats.errors++;
      console.warn("⚠️ OCR Cache set error:", error.message);
      return false;
    }
  }

  /**
   * Supprime une entrée du cache
   */
  async delete(hash) {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = `${this.prefix}${hash}`;
      await this.client.del(key);
      return true;
    } catch (error) {
      console.warn("⚠️ OCR Cache delete error:", error.message);
      return false;
    }
  }

  /**
   * Vérifie si une entrée existe dans le cache
   */
  async has(hash) {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const key = `${this.prefix}${hash}`;
      const exists = await this.client.exists(key);
      return exists === 1;
    } catch (error) {
      return false;
    }
  }

  /**
   * Retourne les statistiques du cache
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate =
      total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) : 0;

    return {
      ...this.stats,
      total,
      hitRate: `${hitRate}%`,
      isConnected: this.isConnected,
    };
  }

  /**
   * Nettoie les anciennes entrées (maintenance)
   * Note: Redis gère automatiquement l'expiration avec TTL
   */
  async cleanup() {
    // Redis gère automatiquement avec SETEX
    return true;
  }

  /**
   * Vide tout le cache OCR
   */
  async flush() {
    if (!this.client || !this.isConnected) {
      return false;
    }

    try {
      const keys = await this.client.keys(`${this.prefix}*`);
      if (keys.length > 0) {
        await this.client.del(keys);
        logger.debug(`🗑️ OCR Cache: ${keys.length} entrées supprimées`);
      }
      return true;
    } catch (error) {
      console.warn("⚠️ OCR Cache flush error:", error.message);
      return false;
    }
  }

  /**
   * Compte le nombre d'entrées en cache
   */
  async count() {
    if (!this.client || !this.isConnected) {
      return 0;
    }

    try {
      const keys = await this.client.keys(`${this.prefix}*`);
      return keys.length;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Ferme la connexion Redis
   */
  async close() {
    if (this.client) {
      await this.client.quit();
      this.isConnected = false;
    }
  }
}

// Instance singleton
const ocrCacheService = new OcrCacheService();

export default ocrCacheService;
