import jwt from "jsonwebtoken";
import { importJWK } from "jose";
import logger from "../utils/logger.js";

/**
 * Erreur levée quand l'endpoint JWKS est injoignable ET qu'aucune clé valide
 * n'est en cache. C'est une panne d'infrastructure (≠ token invalide) : elle ne
 * doit JAMAIS être comptée comme une "tentative suspecte" ni bloquer l'IP, sinon
 * une indispo transitoire du front auto-bloque des utilisateurs légitimes.
 */
class JWKSUnavailableError extends Error {
  constructor(kid, cause) {
    super(`JWKS injoignable pour le kid ${kid}: ${cause}`);
    this.name = "JWKSUnavailableError";
  }
}

/**
 * Détecte une IP loopback (dev/local). En dev, le backend redémarre souvent
 * (nodemon) → cache de clés vide → toute rafale pendant le cold-start du JWKS
 * échouait et auto-bloquait `::1`. On n'applique pas le blocage au loopback
 * hors production (en prod l'IP réelle vient de x-forwarded-for, pas du loopback).
 */
function isLoopbackIP(ip) {
  if (!ip) return false;
  return (
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "127.0.0.1" ||
    ip.startsWith("127.")
  );
}

const SKIP_LOOPBACK_BLOCK = process.env.NODE_ENV !== "production";

class JWKSValidator {
  constructor() {
    this.keyCache = new Map(); // Cache des clés publiques
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes (hot cache)
    this.extendedCacheExpiry = 24 * 60 * 60 * 1000; // 24 hours (JWKS-down fallback, still crypto-strict)
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

      // redirect: "follow" — une redirection (apex↔www, migration de domaine)
      // ne doit pas faire tomber la validation des JWT de toute la prod.
      const response = await fetch(this.jwksUrl, {
        method: "GET",
        headers: headers,
        signal: controller.signal,
        redirect: "follow",
        referrerPolicy: "no-referrer",
      });

      clearTimeout(timeoutId);

      if (response.url && response.url !== this.jwksUrl) {
        logger.warn(
          `JWKS récupéré via redirection: ${this.jwksUrl} → ${response.url}. Mettre à jour FRONTEND_URL pour éviter ce détour.`,
        );
      }

      if (!response.ok) {
        throw new Error(
          `Erreur HTTP ${response.status} lors de la récupération JWKS (${this.jwksUrl})`,
        );
      }

      const jwks = await response.json();

      if (!jwks.keys || !Array.isArray(jwks.keys) || jwks.keys.length === 0) {
        throw new Error("Format JWKS invalide ou vide");
      }

      logger.info(` JWKS récupéré avec succès: ${jwks.keys.length} clé(s)`);
      return jwks;
    } catch (error) {
      logger.error(
        `Erreur récupération JWKS (${this.jwksUrl}) : ${error.message} — si cette erreur persiste, les utilisateurs paraîtront déconnectés (validation JWT impossible).`,
      );
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
      let jwks;
      try {
        jwks = await this.fetchJWKS();
      } catch (fetchError) {
        // JWKS endpoint unreachable — use extended cache (24h) if available
        if (
          cached &&
          Date.now() - cached.timestamp < this.extendedCacheExpiry
        ) {
          logger.warn(
            `JWKS fetch failed, using extended cache for kid: ${kid} (age: ${Math.round((Date.now() - cached.timestamp) / 60000)}min)`,
          );
          this.cacheHits++;
          return cached.key;
        }
        logger.error(
          `JWKS fetch failed and no valid cache for kid ${kid}:`,
          fetchError.message,
        );
        // Panne d'infra (≠ token invalide) : on propage une erreur dédiée pour
        // que validateJWT n'enregistre PAS de tentative suspecte / ne bloque pas.
        throw new JWKSUnavailableError(kid, fetchError.message);
      }

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

      logger.info(`Clé JWKS mise en cache pour kid: ${kid}`);
      return keyLike;
    } catch (error) {
      // Laisser remonter l'indispo JWKS (gérée sans blocage dans validateJWT)
      if (error instanceof JWKSUnavailableError) throw error;
      logger.error(
        `Erreur récupération clé publique pour kid ${kid}:`,
        error.message,
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
    // Ne jamais bloquer le loopback hors production (dev local)
    if (SKIP_LOOPBACK_BLOCK && isLoopbackIP(clientIP)) return false;

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
    // Ne pas comptabiliser le loopback hors production (dev local)
    if (SKIP_LOOPBACK_BLOCK && isLoopbackIP(clientIP)) return;

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
        `IP bloquée pour tentatives suspectes: ${clientIP} (${reason})`,
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

      // Vérifier le rate limiting (ne PAS compter comme tentative suspecte)
      if (!this.checkRateLimit(clientIP)) {
        logger.warn("Rate limit dépassé pour l'IP");
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

      logger.debug(
        `JWT Claims - iss: ${payload.iss}, aud: ${payload.aud}, exp: ${payload.exp}, sub: ${payload.sub}`,
      );

      // Vérifier que le kid est présent
      if (!header.kid) {
        logger.warn("JWT sans kid (Key ID)");
        this.recordFailedAttempt(clientIP, "JWT sans kid");
        return null;
      }

      // Récupérer la clé publique par kid.
      // Un JWKS injoignable est une panne d'infra, pas un token invalide : on ne
      // l'impute PAS à l'IP (sinon une indispo transitoire du front auto-bloque
      // des utilisateurs légitimes 15 min). On renvoie null → le front réessaie,
      // et le fetch JWKS réussira une fois le endpoint disponible (cache 24h).
      let publicKey;
      try {
        publicKey = await this.getPublicKeyByKid(header.kid);
      } catch (keyError) {
        if (keyError instanceof JWKSUnavailableError) {
          logger.warn(
            `JWKS injoignable — validation reportée sans blocage (kid ${header.kid})`,
          );
          return null;
        }
        throw keyError;
      }

      if (!publicKey) {
        // Ici le JWKS a bien été récupéré mais ne contient pas ce kid : c'est
        // anormal (token forgé ou clé révoquée) → on compte la tentative.
        logger.warn(`Aucune clé publique trouvée pour le kid: ${header.kid}`);
        this.recordFailedAttempt(clientIP, "Aucune clé publique trouvée");
        return null;
      }

      // Vérification cryptographique avec jose
      try {
        const { jwtVerify } = await import("jose");

        const expectedIssuer =
          process.env.FRONTEND_URL || "http://localhost:3000";
        logger.debug(
          `Expected issuer: ${expectedIssuer}, Token issuer: ${payload.iss}`,
        );

        const { payload: verifiedPayload } = await jwtVerify(token, publicKey, {
          algorithms: ["EdDSA"],
          issuer: expectedIssuer,
          clockTolerance: "60s", // Augmenté pour s'adapter à l'expiration de session d'1 heure
        });

        logger.info(
          `✓ JWT validé avec succès (crypto complète) pour l'utilisateur ${verifiedPayload.sub}`,
        );
        // Reset les tentatives échouées après une validation réussie
        this.failedAttempts.delete(clientIP);
        return verifiedPayload;
      } catch (verifyError) {
        // JWT expiré = cycle de vie normal (tokens de 5 min) : le front va
        // en redemander un et retenter. Ni erreur loguée, ni tentative
        // suspecte comptée (sinon 10 requêtes d'un onglet inactif suffisent
        // à bloquer l'IP 15 min).
        const isExpired =
          verifyError?.code === "ERR_JWT_EXPIRED" ||
          verifyError?.name === "JWTExpired";
        if (isExpired) {
          logger.debug(
            `JWT expiré pour ${payload?.sub || "?"} — refresh attendu côté client`,
          );
          return null;
        }

        logger.warn(
          `JWT crypto verification failed: ${verifyError?.name || "?"} — ${verifyError?.message || "?"} (code: ${verifyError?.code || "unknown"})`,
        );

        // Strict mode: no issuer-based bypass. If crypto fails, reject.
        // The JWKS key cache (5 min hot + 24h extended) ensures availability
        // even if the JWKS endpoint is temporarily unreachable.
        this.recordFailedAttempt(clientIP, "JWT crypto verification failed");
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
