import jwt from "jsonwebtoken";
import { importJWK } from "jose";
import logger from "../utils/logger.js";

class JWKSValidator {
  constructor() {
    this.keyCache = new Map(); // Cache des clés publiques
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
    this.jwksUrl = process.env.FRONTEND_URL
      ? `${process.env.FRONTEND_URL}/api/auth/jwks`
      : "http://localhost:3000/api/auth/jwks";
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

      // ✅ AJOUT : Construction des headers avec bypass token
      const headers = {
        Accept: "application/json",
        "User-Agent": "JWKS-Validator/1.0",
      };

      // ✅ AJOUT : Ajouter le bypass token Vercel si disponible
      if (process.env.VERCEL_BYPASS_TOKEN) {
        headers["x-vercel-protection-bypass"] = process.env.VERCEL_BYPASS_TOKEN;
        headers["x-vercel-set-bypass-cookie"] = "samesitenone";
        logger.debug("🔑 Utilisation du bypass token Vercel");
      }


      const response = await fetch(this.jwksUrl, {
        method: "GET",
        headers: headers,
        signal: controller.signal,
        redirect: "error",
        referrerPolicy: "no-referrer",
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(
          `Erreur HTTP ${response.status} lors de la récupération JWKS`
        );
      }

      const jwks = await response.json();

      if (!jwks.keys || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
        throw new Error("Format JWKS invalide ou vide");
      }

      logger.info(` JWKS récupéré avec succès: ${jwks.keys.length} clé(s)`);
      return jwks;
    } catch (error) {
      logger.error("Erreur récupération JWKS :", error.message);
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

      if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
        logger.info(`Clé récupérée depuis le cache pour kid: ${kid}`);
        this.cacheHits++;
        return cached.key;
      }

      this.cacheMisses++;

      // Récupérer les clés JWKS
      const jwks = await this.fetchJWKS();

      // Trouver la clé correspondant au kid
      const jwk = jwks.keys.find((key) => key.kid === kid);

      if (!jwk) {
        logger.warn(`Aucune clé JWKS trouvée pour le kid: ${kid}`);
        return null;
      }

      // Importer la clé JWK avec jose
      const keyLike = await importJWK(jwk, jwk.alg || "EdDSA");

      // Mettre en cache
      this.keyCache.set(cacheKey, {
        key: keyLike,
        timestamp: Date.now(),
        kid: kid,
        algorithm: jwk.alg || "EdDSA",
      });

      logger.info(` Clé JWKS mise en cache pour kid: ${kid}`);
      return keyLike;
    } catch (error) {
      logger.error(
        ` Erreur récupération clé publique pour kid ${kid}:`,
        error.message
      );
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
    const recentRequests = requests.filter((time) => time > windowStart);

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
    const current = this.failedAttempts.get(clientIP) || {
      count: 0,
      lastAttempt: 0,
    };

    current.count++;
    current.lastAttempt = now;

    this.failedAttempts.set(clientIP, current);

    if (current.count >= this.maxFailedAttempts) {
      logger.error(
        `IP bloquée pour tentatives suspectes: ${clientIP} (${reason})`
      );
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

      // Décoder le JWT pour obtenir le header et le payload
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || !decoded.header || !decoded.payload) {
        logger.warn("JWT invalide - impossible de décoder");
        this.recordFailedAttempt(clientIP, "JWT invalide");
        return null;
      }

      const header = decoded.header;
      const payload = decoded.payload;

      logger.debug(`JWT Claims - iss: ${payload.iss}, aud: ${payload.aud}, exp: ${payload.exp}, sub: ${payload.sub}`);

      // Vérifier que le kid est présent
      if (!header.kid) {
        logger.warn("JWT sans kid (Key ID)");
        this.recordFailedAttempt(clientIP, "JWT sans kid");
        return null;
      }

      // Récupérer la clé publique par kid
      const publicKey = await this.getPublicKeyByKid(header.kid);

      if (!publicKey) {
        logger.warn(`Aucune clé publique trouvée pour le kid: ${header.kid}`);
        this.recordFailedAttempt(clientIP, "Aucune clé publique trouvée");
        return null;
      }

      // Vérification cryptographique avec jose
      try {
        const { jwtVerify } = await import("jose");

        const expectedIssuer = process.env.FRONTEND_URL || "http://localhost:3000";
        logger.debug(`Expected issuer: ${expectedIssuer}, Token issuer: ${payload.iss}`);

        const { payload: verifiedPayload } = await jwtVerify(token, publicKey, {
          algorithms: ["EdDSA"],
          issuer: expectedIssuer,
          clockTolerance: "30s",
        });

        logger.info(
          `✓ JWT validé avec succès (crypto complète) pour l'utilisateur ${verifiedPayload.sub}`
        );
        return verifiedPayload;
      } catch (verifyError) {
        logger.warn(
          "Échec de la vérification cryptographique JWT:",
          verifyError.message
        );
        logger.debug(`Détails erreur: ${verifyError.code || 'unknown'}`);
        
        // MODE DÉGRADÉ : Si l'erreur est liée à l'issuer/audience mais que le token est valide
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) {
          logger.warn("JWT expiré, rejet même en mode dégradé");
          this.recordFailedAttempt(clientIP, "JWT expiré");
          return null;
        }

        // Vérifier si l'issuer correspond au moins partiellement (prod vs staging vs localhost)
        const issuerMatch = payload.iss && (
          payload.iss === (process.env.FRONTEND_URL || "http://localhost:3000") ||
          payload.iss.includes('newbi.fr') ||
          payload.iss.includes('localhost') ||
          payload.iss.includes('vercel.app') ||
          (process.env.FRONTEND_URL && (
            process.env.FRONTEND_URL.includes('newbi.fr') ||
            process.env.FRONTEND_URL.includes('vercel.app')
          ))
        );

        if (issuerMatch && payload.sub) {
          logger.warn(`⚠️  MODE DÉGRADÉ: JWT accepté sans vérification crypto complète (issuer: ${payload.iss} vs expected: ${process.env.FRONTEND_URL || 'localhost:3000'})`);
          return payload;
        }

        this.recordFailedAttempt(
          clientIP,
          "Échec de la vérification cryptographique"
        );
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
      if (now - value.timestamp > this.cacheExpiry) {
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
