import Redis from "ioredis";
import { RedisPubSub } from "graphql-redis-subscriptions";
import logger from "../utils/logger.js";

// Configuration Redis - supporte REDIS_URL (staging/production) ou REDIS_HOST/PORT (local)
const redisUrl = process.env.REDIS_URL;
const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB) || 0,
};

// Initialiser les clients Redis
let pubsub;

const initializeRedis = async () => {
  try {
    logger.info("🔄 [Redis] Initialisation en cours...");

    // Options au format ioredis (utilisé par graphql-redis-subscriptions)
    let ioredisOptions;

    if (redisUrl) {
      logger.info(
        `🔗 [Redis] Utilisation de REDIS_URL: ${redisUrl.replace(/\/\/.*@/, "//***@")}`,
      );
      ioredisOptions = redisUrl;
    } else {
      logger.info(
        `🔗 [Redis] Utilisation de REDIS_HOST: ${redisConfig.host}:${redisConfig.port}`,
      );
      ioredisOptions = {
        host: redisConfig.host,
        port: redisConfig.port,
        db: redisConfig.db,
        retryStrategy: (times) => Math.min(times * 50, 500),
      };

      if (redisConfig.password) {
        ioredisOptions.password = redisConfig.password;
      }
    }

    // Test de connexion avec ioredis
    const testClient = new Redis(ioredisOptions);
    await new Promise((resolve, reject) => {
      testClient.on("error", reject);
      testClient.on("ready", () => {
        testClient.quit();
        resolve();
      });
    });

    // Créer l'instance RedisPubSub avec des clients ioredis dédiés
    pubsub = new RedisPubSub({
      publisher: new Redis(ioredisOptions),
      subscriber: new Redis(ioredisOptions),
    });

    logger.info("🚀 [Redis] PubSub initialisé avec succès");
    return pubsub;
  } catch (error) {
    logger.error("❌ [Redis] Erreur d'initialisation:", error.message);

    // Fallback vers PubSub en mémoire en cas d'erreur Redis
    logger.warn("⚠️ [Redis] Fallback vers PubSub en mémoire");
    const { PubSub } = await import("graphql-subscriptions");
    pubsub = new PubSub();
    return pubsub;
  }
};

// Fonction de nettoyage
const closeRedis = async () => {
  try {
    if (pubsub && pubsub.close) {
      await pubsub.close();
    }
    logger.info("✅ [Redis] Connexions fermées proprement");
  } catch (error) {
    logger.error("❌ [Redis] Erreur lors de la fermeture:", error);
  }
};

// Fonction pour obtenir l'instance PubSub
const getPubSub = () => {
  if (!pubsub) {
    throw new Error(
      "Redis PubSub non initialisé. Appelez initializeRedis() d'abord.",
    );
  }
  return pubsub;
};

// Fonction pour vérifier la santé de Redis
const checkRedisHealth = async () => {
  try {
    if (pubsub) {
      // Test simple de publication pour vérifier la santé
      await pubsub.publish("HEALTH_CHECK", { timestamp: Date.now() });
      return { status: "healthy", message: "Redis PubSub connecté" };
    }
    return { status: "unhealthy", message: "Redis PubSub non initialisé" };
  } catch (error) {
    return { status: "unhealthy", message: error.message };
  }
};

export {
  initializeRedis,
  closeRedis,
  getPubSub,
  checkRedisHealth,
  redisConfig,
};
