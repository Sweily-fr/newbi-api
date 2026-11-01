import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import User from "../models/User.js";
import { getJWKSValidator } from "../services/jwks-validator.js";
import { betterAuthMiddleware } from "./better-auth.js";
import { getActiveOrganizationCached } from "./org-cache.js";

// Cache LRU user partagé avec le chemin cookie (voir user-cache.js) :
// une invalidation couvre les deux chemins d'authentification.
import {
  loadCachedUser,
  invalidateUserCache,
  isUserAccessDenied,
} from "./user-cache.js";

export { invalidateUserCache };

/**
 * IP du client, pour la limite de débit et le blocage du validateur JWT.
 *
 * Requêtes HTTP : req.ip, calculé par Express (trust proxy 1) d'après
 * l'entrée de x-forwarded-for ajoutée par le proxy de l'API, jamais une
 * valeur choisie par le client. Connexions WebSocket (requête d'upgrade, hors
 * Express) : même règle, dernière entrée de x-forwarded-for, sinon l'adresse
 * de la socket. « unknown » si rien ne l'indique (jamais bloquée).
 */
export function clientIpOf(req) {
  if (req?.ip) return req.ip;
  const forwarded = req?.headers?.["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwarded)
    ? forwarded.join(",")
    : forwarded;
  if (typeof forwardedValue === "string") {
    const entries = forwardedValue
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (entries.length) return entries[entries.length - 1];
  }
  return (
    req?.socket?.remoteAddress || req?.connection?.remoteAddress || "unknown"
  );
}

/**
 * Middleware d'authentification unifié
 * 1. Essaie le JWT (Authorization: Bearer) si présent — nécessaire pour WebSocket
 * 2. Fallback sur le cookie session (better-auth.session_token) — auth principale
 */
const betterAuthJWTMiddleware = async (req) => {
  try {
    // Récupérer le token JWT depuis les headers
    const token = extractJWTToken(req.headers);
    if (!token) {
      // Pas de JWT → essayer l'auth par cookie session
      logger.debug("Pas de JWT, tentative auth par cookie session");
      return await betterAuthMiddleware(req);
    }

    logger.debug(`Token JWT extrait: ${token.substring(0, 20)}...`);

    // IP client pour les protections du validateur (voir clientIpOf)
    const clientIP = clientIpOf(req);

    // Validation JWKS complète avec vérification cryptographique
    let decoded;
    try {
      logger.debug(`Validation JWT pour IP: ${clientIP}`);
      const jwksValidator = await getJWKSValidator();
      decoded = await jwksValidator.validateJWT(token, clientIP);

      if (!decoded) {
        // JWT expiré ou invalide : tenter le fallback cookie avant d'abandonner
        // (cas attendu — le front rafraîchira son JWT et retentera).
        logger.debug("JWT non valide — tentative fallback cookie session");
        return await betterAuthMiddleware(req);
      }
      logger.debug(`JWT validé avec succès pour utilisateur: ${decoded.sub}`);
    } catch (jwtError) {
      logger.debug(
        `JWT invalide ou malformé (${jwtError.message}) — tentative fallback cookie session`,
      );
      return await betterAuthMiddleware(req);
    }

    if (!decoded || !decoded.sub) {
      return null;
    }

    // Récupérer l'utilisateur (cache LRU 30s → évite 1 query DB par requête)
    const user = await loadCachedUser(decoded.sub, () =>
      User.findById(decoded.sub),
    );
    if (isUserAccessDenied(user)) {
      return null;
    }

    // Vérification supplémentaire : l'email du token doit correspondre à l'utilisateur
    if (decoded.email && user.email !== decoded.email) {
      logger.warn("Mismatch email entre JWT et utilisateur en base");
      return null;
    }

    return user;
  } catch (error) {
    logger.error("Erreur validation JWT:", error.message);
    return null;
  }
};

/**
 * Extrait le token JWT depuis les headers
 */
const extractJWTToken = (headers) => {
  // Priorité 1: Header Authorization Bearer
  const authHeader = headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Priorité 2: Header personnalisé
  return headers["x-jwt-token"];
};

/**
 * Middleware Express pour validation JWT
 */
const validateJWT = async (req, res, next) => {
  try {
    const user = await betterAuthJWTMiddleware(req);

    if (!user) {
      return res.status(401).json({
        error: "Token invalide",
        message: "Vous devez être connecté pour effectuer cette action",
      });
    }

    req.user = user._id.toString();
    next();
  } catch (error) {
    logger.error("Erreur validation JWT middleware:", error.message);
    return res.status(500).json({
      error: "Erreur serveur",
      message: "Erreur lors de la validation du token",
    });
  }
};

/**
 * Wrapper pour les resolvers nécessitant une authentification
 */
const isAuthenticated = (resolver) => {
  return (parent, args, context, info) => {
    if (!context.user) {
      throw new AppError(
        "Vous devez être connecté pour effectuer cette action",
        ERROR_CODES.UNAUTHENTICATED,
      );
    }
    return resolver(parent, args, context, info);
  };
};

/**
 * Wrapper pour les resolvers nécessitant une authentification et un workspace
 */
const withWorkspace = (resolver) => {
  return async (parent, args, context, info) => {
    if (!context.user) {
      throw new AppError(
        "Vous devez être connecté pour effectuer cette action",
        ERROR_CODES.UNAUTHENTICATED,
      );
    }

    const userId = context.user._id.toString();

    const requestedOrgId =
      args.workspaceId ||
      context.req?.headers?.["x-workspace-id"] ||
      context.req?.headers?.["x-organization-id"];

    let organization;

    if (requestedOrgId) {
      // Explicit org request: verify membership
      organization = await getActiveOrganizationCached(userId, requestedOrgId);

      if (!organization) {
        logger.warn(
          `withWorkspace: user ${userId} requested org ${requestedOrgId} without membership`,
        );
        throw new AppError(
          "Accès non autorisé à cette organisation",
          ERROR_CODES.FORBIDDEN,
        );
      }
    } else {
      // No org explicitly requested: use user's default org
      organization = await getActiveOrganizationCached(userId, null);

      if (!organization) {
        throw new AppError(
          "Aucune organisation active trouvée",
          ERROR_CODES.FORBIDDEN,
        );
      }
    }

    const enhancedContext = {
      ...context,
      workspaceId: organization.id,
    };

    return resolver(parent, args, enhancedContext, info);
  };
};

export { betterAuthJWTMiddleware, validateJWT, isAuthenticated, withWorkspace };
