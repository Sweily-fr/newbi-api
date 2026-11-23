import { EventEmitter } from "node:events";
import Redis from "ioredis";
import { RedisPubSub } from "graphql-redis-subscriptions";
import { PubSub, PubSubEngine } from "graphql-subscriptions";
import logger from "../utils/logger.js";
import {
  createRedisErrorReporter,
  watchRedisClient,
} from "../utils/redisConnectionLog.js";

// Configuration Redis - supporte REDIS_URL (staging/production) ou REDIS_HOST/PORT (local)
const redisUrl = process.env.REDIS_URL;
const redisConfig = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB) || 0,
};

// Attente maximale de Redis au démarrage. Au-delà, l'API démarre sans lui et
// s'y raccroche seule dès qu'il répond : plus besoin de la relancer après une
// panne de Redis (incidents du 27/10 et du 23/11/2026).
const STARTUP_WAIT_MS = 5000;

// Reconnexion sans fin, une tentative au plus toutes les 2 s
const retryStrategy = (times) => Math.min(times * 100, 2000);

/**
 * Client ioredis vers le Redis de l'API : reconnexion sans fin et journal
 * d'erreurs limité (voir redisConnectionLog.js). `options` complète les
 * réglages ioredis (ex. maxRetriesPerRequest, enableOfflineQueue).
 */
const createRedisClient = (label, options = {}) => {
  const settings = { retryStrategy, ...options };
  const client = redisUrl
    ? new Redis(redisUrl, settings)
    : new Redis({
        host: redisConfig.host,
        port: redisConfig.port,
        db: redisConfig.db,
        ...(redisConfig.password ? { password: redisConfig.password } : {}),
        ...settings,
      });
  return watchRedisClient(client, label);
};

const isReady = (client) => client?.status === "ready";

const waitForReady = (client, timeoutMs) =>
  new Promise((resolve) => {
    if (isReady(client)) {
      resolve(true);
      return;
    }
    let timer = null;
    const onReady = () => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      client.off("ready", onReady);
      resolve(false);
    }, timeoutMs);
    client.once("ready", onReady);
  });

// Ferme un client sans rester bloqué si Redis ne répond plus
const closeClient = async (client) => {
  if (!client || client.status === "end") return;
  if (isReady(client)) {
    try {
      await Promise.race([
        client.quit(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("délai dépassé")), 2000).unref();
        }),
      ]);
      return;
    } catch {
      // Fermeture immédiate ci-dessous
    }
  }
  client.disconnect();
};

/**
 * PubSub GraphQL qui survit aux coupures de Redis.
 *
 * Chaque abonnement est pris à la fois en mémoire (cette instance) et dans
 * Redis (toutes les instances PM2). Une publication passe par Redis quand il
 * répond, par la mémoire sinon : pendant une coupure, les messages restent
 * livrés sur l'instance qui les émet, et tout repasse par Redis à son retour,
 * abonnements compris (ceux demandés pendant la coupure partent à la
 * reconnexion). Avant, un démarrage sans Redis laissait l'instance en mémoire
 * jusqu'à son redémarrage suivant.
 */
class ResilientPubSub extends PubSubEngine {
  constructor({
    publisher = null,
    subscriber = null,
    redisPubSub = null,
  } = {}) {
    super();
    // Pas de plafond d'écouteurs : un même sujet peut avoir des dizaines
    // d'abonnés sur une instance (sinon avertissement de fuite mémoire)
    const eventEmitter = new EventEmitter();
    eventEmitter.setMaxListeners(0);
    this.memory = new PubSub({ eventEmitter });
    this.publisher = publisher;
    this.subscriber = subscriber;
    this.redis =
      redisPubSub ||
      (publisher && subscriber
        ? new RedisPubSub({ publisher, subscriber })
        : null);
    this.subscriptions = new Map();
    this.nextId = 0;
    this.publishErrors = createRedisErrorReporter("PubSub (envoi)");
  }

  isRedisReady() {
    return Boolean(this.redis) && isReady(this.publisher);
  }

  async publish(trigger, payload) {
    if (this.isRedisReady()) {
      try {
        await this.redis.publish(trigger, payload);
        // Abonnements de cette instance pas encore repris par Redis (juste
        // après une reconnexion) : livraison locale pour ne rien perdre
        if (!isReady(this.subscriber)) {
          await this.memory.publish(trigger, payload);
        }
        return;
      } catch (error) {
        this.publishErrors.onError(error);
      }
    }
    await this.memory.publish(trigger, payload);
  }

  async subscribe(trigger, onMessage, options = {}) {
    const memoryId = await this.memory.subscribe(trigger, onMessage);
    const id = ++this.nextId;
    const entry = { memoryId, redisId: null, closed: false };
    this.subscriptions.set(id, entry);

    if (this.redis) {
      // Sans attendre Redis : pendant une coupure, l'abonnement part à son retour
      Promise.resolve()
        .then(() => this.redis.subscribe(trigger, onMessage, options))
        .then((redisId) => {
          if (entry.closed) this.unsubscribeRedis(redisId);
          else entry.redisId = redisId;
        })
        .catch((error) => {
          logger.warn(
            `⚠️ [Redis] Abonnement PubSub « ${trigger} » impossible : ${error.message}`,
          );
        });
    }

    return id;
  }

  unsubscribe(id) {
    const entry = this.subscriptions.get(id);
    if (!entry) return;
    this.subscriptions.delete(id);
    entry.closed = true;
    this.memory.unsubscribe(entry.memoryId);
    if (entry.redisId !== null) this.unsubscribeRedis(entry.redisId);
  }

  unsubscribeRedis(redisId) {
    try {
      this.redis.unsubscribe(redisId);
    } catch (error) {
      logger.debug(`[Redis] Désabonnement PubSub : ${error.message}`);
    }
  }

  // Ancien nom de l'itérateur (graphql-subscriptions 2), gardé par prudence
  asyncIterator(triggers) {
    return this.asyncIterableIterator(triggers);
  }

  async close() {
    await Promise.all([
      closeClient(this.publisher),
      closeClient(this.subscriber),
    ]);
  }
}

let pubsub = null;
let cacheClient = null;

/**
 * Crée le PubSub et le client de cache. Ne lève jamais : si Redis ne répond
 * pas dans les 5 s, l'API démarre en mode dégradé (temps réel limité à
 * l'instance, cache coupé) et se reconnecte seule à son retour.
 */
const initializeRedis = async ({ startupWaitMs = STARTUP_WAIT_MS } = {}) => {
  if (pubsub) return pubsub;

  logger.info("🔄 [Redis] Initialisation en cours...");
  if (redisUrl) {
    logger.info(
      `🔗 [Redis] Utilisation de REDIS_URL: ${redisUrl.replace(/\/\/.*@/, "//***@")}`,
    );
  } else {
    logger.info(
      `🔗 [Redis] Utilisation de REDIS_HOST: ${redisConfig.host}:${redisConfig.port}`,
    );
  }

  // Publication et cache : échec immédiat quand Redis est absent, l'appelant
  // se replie (mémoire, pas de cache) au lieu d'attendre ~10 s par commande
  const publisher = createRedisClient("PubSub (publication)", {
    enableOfflineQueue: false,
  });
  // Abonnements : ils attendent le retour de Redis au lieu d'échouer pour de bon
  const subscriber = createRedisClient("PubSub (abonnements)", {
    maxRetriesPerRequest: null,
  });
  cacheClient = createRedisClient("Cache", { enableOfflineQueue: false });
  pubsub = new ResilientPubSub({ publisher, subscriber });

  const ready = await Promise.all(
    [publisher, subscriber, cacheClient].map((client) =>
      waitForReady(client, startupWaitMs),
    ),
  );
  if (ready.every(Boolean)) {
    logger.info("🚀 [Redis] PubSub + Cache initialisés avec succès");
  } else {
    logger.warn(
      "⚠️ [Redis] Injoignable au démarrage : temps réel limité à cette instance et cache coupé jusqu'à son retour (reconnexion automatique)",
    );
  }

  return pubsub;
};

// Fonction de nettoyage
const closeRedis = async () => {
  try {
    await Promise.all([closeClient(cacheClient), pubsub?.close()]);
    logger.info("✅ [Redis] Connexions fermées proprement");
  } catch (error) {
    logger.debug(`[Redis] Fermeture : ${error.message}`);
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
  if (!pubsub) {
    return { status: "unhealthy", message: "Redis PubSub non initialisé" };
  }
  if (!pubsub.isRedisReady()) {
    return {
      status: "unhealthy",
      message:
        "Redis injoignable : temps réel limité à cette instance, reconnexion en cours",
    };
  }
  return { status: "healthy", message: "Redis PubSub connecté" };
};

// Client ioredis brut (hash, expire…) pour les usages qui dépassent get/set.
// Retourne null tant que Redis est indisponible (démarrage, coupure) :
// l'appelant doit prévoir un repli. Redevient disponible seul à son retour.
const getCacheClient = () => (isReady(cacheClient) ? cacheClient : null);

// --- Cache helpers ---
// Lecture depuis le cache Redis, retourne null si indisponible
const cacheGet = async (key) => {
  const client = getCacheClient();
  if (!client) return null;
  try {
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
};

// Écriture dans le cache Redis avec TTL en secondes
const cacheSet = async (key, value, ttlSeconds = 30) => {
  const client = getCacheClient();
  if (!client) return;
  try {
    await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // Silencieux - le cache est optionnel
  }
};

// Invalidation d'un pattern de clés
const cacheDel = async (...keys) => {
  const client = getCacheClient();
  if (!client) return;
  try {
    await client.del(...keys);
  } catch {
    // Silencieux
  }
};

export {
  initializeRedis,
  closeRedis,
  getPubSub,
  checkRedisHealth,
  redisConfig,
  cacheGet,
  cacheSet,
  cacheDel,
  getCacheClient,
  createRedisClient,
  ResilientPubSub,
};
