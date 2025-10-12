import { createClient } from 'redis';
import { RedisPubSub } from 'graphql-redis-subscriptions';

class RedisService {
  constructor() {
    this.client = null;
    this.subscriber = null;
    this.publisher = null;
    this.pubsub = null;
    this.isConnected = false;
  }

  async connect() {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      
      // Client principal pour les opérations générales
      this.client = createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              console.error('❌ Redis: Trop de tentatives de reconnexion');
              return new Error('Trop de tentatives de reconnexion');
            }
            return Math.min(retries * 100, 3000);
          }
        }
      });

      // Client pour les publications
      this.publisher = createClient({
        url: redisUrl,
      });

      // Client pour les souscriptions
      this.subscriber = createClient({
        url: redisUrl,
      });

      // Gestion des erreurs
      this.client.on('error', (err) => console.error('❌ Redis Client Error:', err));
      this.publisher.on('error', (err) => console.error('❌ Redis Publisher Error:', err));
      this.subscriber.on('error', (err) => console.error('❌ Redis Subscriber Error:', err));

      // Connexion
      await Promise.all([
        this.client.connect(),
        this.publisher.connect(),
        this.subscriber.connect()
      ]);

      // Initialiser PubSub pour GraphQL Subscriptions
      this.pubsub = new RedisPubSub({
        publisher: this.publisher,
        subscriber: this.subscriber,
      });
      this.isConnected = true;
      // Redis connecté
      
      return true;
    } catch (error) {
      console.error('Redis: Erreur de connexion', error);
      this.isConnected = false;
      return false;
    }
  }

  async disconnect() {
    try {
      if (this.client) await this.client.quit();
      if (this.publishers) await this.publishers.quit();
      if (this.subscriber) await this.subscriber.quit();
      this.isConnected = false;
      console.log('✅ Redis déconnecté');
    } catch (error) {
      console.error('❌ Erreur lors de la déconnexion Redis:', error);
    }
  }
  async publish(channel, data) {
    try {
      if (!this.isConnected || !this.pubsub) {
        console.warn('⚠️ Redis non connecté, impossible de publier');
        return false;
      }
      
      await this.pubsub.publish(channel, data);
      // Événement publié
      return true;
    } catch (error) {
      console.error('❌ Erreur lors de la publication:', error);
      return false;
    }
  }

  // Obtenir l'instance PubSub pour les subscriptions GraphQL
  getPubSub() {
    return this.pubsub;
  }

  // Cache: Set
  async set(key, value, expirationInSeconds = null) {
    try {
      if (!this.isConnected) return false;
      
      const serializedValue = JSON.stringify(value);
      
      if (expirationInSeconds) {
        await this.client.setEx(key, expirationInSeconds, serializedValue);
      } else {
        await this.client.set(key, serializedValue);
      }
      
      return true;
    } catch (error) {
      console.error('❌ Erreur Redis SET:', error);
      return false;
    }
  }

  // Cache: Get
  async get(key) {
    try {
      if (!this.isConnected) return null;
      
      const value = await this.client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error('❌ Erreur Redis GET:', error);
      return null;
    }
  }

  // Cache: Delete
  async delete(key) {
    try {
      if (!this.isConnected) return false;
      
      await this.client.del(key);
      return true;
    } catch (error) {
      console.error('❌ Erreur Redis DELETE:', error);
      return false;
    }
  }

  // Vérifier la connexion
  async ping() {
    try {
      if (!this.isConnected) return false;
      await this.client.ping();
      return true;
    } catch (error) {
      console.error('❌ Redis PING failed:', error);
      return false;
    }
  }
}

// Instance singleton
const redisService = new RedisService();

export default redisService;
