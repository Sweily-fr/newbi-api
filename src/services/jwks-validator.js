import jwt from "jsonwebtoken";
import { importJWK } from "jose";
import logger from "../utils/logger.js";

class JWKSValidator {
  constructor() {
    this.keyCache = new Map(); // Cache des clés publiques
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
    this.jwksUrl = process.env.FRONTEND_URL ? 
      `${process.env.FRONTEND_URL}/api/auth/jwks` : 
      'http://localhost:3000/api/auth/jwks';
    this.cacheHits = 0;
    this.cacheMisses = 0;
    
    // Protection DoS
    this.requestCount = new Map(); // Rate limiting par IP
    this.failedAttempts = new Map(); // Tentatives échouées
    this.suspiciousKids = new Set(); // Kids suspects
    this.maxRequestsPerMinute = 300; // Augmenté pour éviter les blocages
    this.maxFailedAttempts = 10;
    this.blockDuration = 15 * 60 * 1000; // 15 minutes
  }

  /**
   * Récupère les clés JWKS depuis l'endpoint Better Auth
   */
  async fetchJWKS() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(this.jwksUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'JWKS-Validator/1.0'
        },
        signal: controller.signal,
        redirect: 'error',
        referrerPolicy: 'no-referrer'
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`Erreur HTTP ${response.status} lors de la récupération JWKS`);
      }
      
      const jwks = await response.json();
      
      if (!jwks.keys || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
        throw new Error("Format JWKS invalide ou vide");
      }
      
      logger.info(` JWKS récupéré avec succès: ${jwks.keys.length} clé(s)`);
      return jwks;
      
    } catch (error) {
      logger.error("Erreur récupération JWKS:", error.message);
      throw error;
    }
  }

  /**
   * Récupère une clé publique par son kid (Key ID)
   */
  async getPublicKeyByKid(kid) {
    try {
      // Vérifier le cache d'abord
      const cacheKey = `jwks_${kid}`;
      const cached = this.keyCache.get(cacheKey);
      
      if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
        logger.info(`Clé récupérée depuis le cache pour kid: ${kid}`);
        this.cacheHits++;
        return cached.key;
      }

      this.cacheMisses++;

      // Récupérer les clés JWKS
      const jwks = await this.fetchJWKS();
      
      // Trouver la clé correspondant au kid
      const jwk = jwks.keys.find(key => key.kid === kid);
      
      if (!jwk) {
        logger.warn(`Aucune clé JWKS trouvée pour le kid: ${kid}`);
        return null;
      }

      // Importer la clé JWK avec jose
      const keyLike = await importJWK(jwk, jwk.alg || 'EdDSA');
      
      // Mettre en cache
      this.keyCache.set(cacheKey, {
        key: keyLike,
        timestamp: Date.now(),
        kid: kid,
        algorithm: jwk.alg || 'EdDSA'
      });
      
      logger.info(` Clé JWKS mise en cache pour kid: ${kid}`);
      return keyLike;
      
    } catch (error) {
      logger.error(` Erreur récupération clé publique pour kid ${kid}:`, error.message);
      return null;
    }
  }

  /**
   * Vérifie le rate limiting par IP
   */
  checkRateLimit(clientIP) {
    const now = Date.now();
    const windowStart = now - 60000; // 1 minute
    
    if (!this.requestCount.has(clientIP)) {
      this.requestCount.set(clientIP, []);
    }
    
    const requests = this.requestCount.get(clientIP);
    // Nettoyer les anciennes requêtes
    const recentRequests = requests.filter(time => time > windowStart);
    
    if (recentRequests.length >= this.maxRequestsPerMinute) {
      logger.warn(`Rate limit dépassé pour IP: ${clientIP}`);
      return false;
    }
    
    recentRequests.push(now);
    this.requestCount.set(clientIP, recentRequests);
    return true;
  }

  /**
   * Vérifie si une IP est bloquée pour tentatives suspectes
   */
  checkIPBlocked(clientIP) {
    const blocked = this.failedAttempts.get(clientIP);
    if (!blocked) return false;
    
    const { count, lastAttempt } = blocked;
    const now = Date.now();
    
    // Débloquer après la durée de blocage
    if (now - lastAttempt > this.blockDuration) {
      this.failedAttempts.delete(clientIP);
      return false;
    }
    
    return count >= this.maxFailedAttempts;
  }

  /**
   * Enregistre une tentative échouée
   */
  recordFailedAttempt(clientIP, reason) {
    const now = Date.now();
    const current = this.failedAttempts.get(clientIP) || { count: 0, lastAttempt: 0 };
    
    current.count++;
    current.lastAttempt = now;
    
    this.failedAttempts.set(clientIP, current);
    
    if (current.count >= this.maxFailedAttempts) {
      logger.error(`IP bloquée pour tentatives suspectes: ${clientIP} (${reason})`);
    }
  }

  /**
   * Valide un JWT avec vérification cryptographique complète
   */
  async validateJWT(token, clientIP) {
    try {
      // Protection contre les tokens trop longs (DoS)
      if (!token || token.length > 4096) {
        logger.warn("Token JWT trop long ou vide");
        this.recordFailedAttempt(clientIP, "Token trop long");
        return null;
      }

      // Vérifier le rate limiting
      if (!this.checkRateLimit(clientIP)) {
        logger.warn("Rate limit dépassé pour l'IP");
        this.recordFailedAttempt(clientIP, "Rate limit dépassé");
        return null;
      }

      // Vérifier si l'IP est bloquée
      if (this.checkIPBlocked(clientIP)) {
        logger.warn("IP bloquée pour tentatives suspectes");
        return null;
      }

      // 1. Décoder le header pour récupérer le kid
      const decoded = jwt.decode(token, { complete: true });
      
      if (!decoded || !decoded.header || !decoded.payload) {
        logger.warn("JWT invalide - structure malformée");
        this.recordFailedAttempt(clientIP, "JWT malformé");
        return null;
      }

      const { header, payload } = decoded;

      // 2. Vérifications de sécurité strictes
      if (!payload.sub || !payload.iss || !payload.exp || !payload.iat) {
        logger.warn("JWT malformé - champs requis manquants");
        this.recordFailedAttempt(clientIP, "JWT malformé");
        return null;
      }

      // 3. Vérifier l'algorithme
      if (header.alg !== 'EdDSA') {
        logger.warn(`Algorithme JWT non autorisé: ${header.alg}`);
        this.recordFailedAttempt(clientIP, "Algorithme non autorisé");
        return null;
      }

      // 4. Vérifier que le kid est présent
      if (!header.kid) {
        logger.warn("JWT sans kid (Key ID)");
        this.recordFailedAttempt(clientIP, "JWT sans kid");
        return null;
      }

      // 5. Récupérer la clé publique par kid
      const publicKey = await this.getPublicKeyByKid(header.kid);
      
      if (!publicKey) {
        logger.warn(`Aucune clé publique trouvée pour le kid: ${header.kid}`);
        this.recordFailedAttempt(clientIP, "Aucune clé publique trouvée");
        return null;
      }

      // 6. Vérification cryptographique avec jose
      try {
        const { jwtVerify } = await import('jose');
        
        const { payload: verifiedPayload } = await jwtVerify(token, publicKey, {
          algorithms: ['EdDSA'],
          issuer: process.env.FRONTEND_URL || 'http://localhost:3000',
          clockTolerance: '30s'
        });

        logger.info(`JWT validé avec succès pour l'utilisateur ${verifiedPayload.sub}`);
        return verifiedPayload;

      } catch (verifyError) {
        logger.warn("Échec de la vérification cryptographique JWT:", verifyError.message);
        this.recordFailedAttempt(clientIP, "Échec de la vérification cryptographique");
        return null;
      }

    } catch (error) {
      logger.error("Erreur validation JWT JWKS:", error.message);
      this.recordFailedAttempt(clientIP, "Erreur validation JWT");
      return null;
    }
  }

  /**
   * Nettoie le cache périodiquement
   */
  cleanCache() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [key, value] of this.keyCache.entries()) {
      if ((now - value.timestamp) > this.cacheExpiry) {
        this.keyCache.delete(key);
        cleanedCount++;
      }
    }
  }
}

// Instance singleton
let jwksValidatorInstance = null;

/**
 * Récupère l'instance singleton du validateur JWKS
 */
export async function getJWKSValidator() {
  if (!jwksValidatorInstance) {
    jwksValidatorInstance = new JWKSValidator();
  }
  return jwksValidatorInstance;
}

export default JWKSValidator;
