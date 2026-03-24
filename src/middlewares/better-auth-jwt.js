import jwt from "jsonwebtoken";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import User from "../models/User.js";
import { getJWKSValidator } from "../services/jwks-validator.js";
import { betterAuthMiddleware } from "./better-auth.js";

// Cache LRU en mémoire pour User.findById — évite une query DB par requête authentifiée
const USER_CACHE_TTL = 30_000; // 30 secondes
const USER_CACHE_MAX = 500;
const _userCache = new Map();

function getCachedUser(userId) {
  const entry = _userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > USER_CACHE_TTL) {
    _userCache.delete(userId);
    return null;
  }
  return entry.user;
}

function setCachedUser(userId, user) {
  // Eviction LRU simple : supprimer la plus ancienne entrée si la taille max est atteinte
  if (_userCache.size >= USER_CACHE_MAX) {
    const oldestKey = _userCache.keys().next().value;
    _userCache.delete(oldestKey);
  }
  _userCache.set(userId, { user, ts: Date.now() });
}

// Permet d'invalider le cache depuis l'extérieur (ex: après updateUser)
export function invalidateUserCache(userId) {
  if (userId) _userCache.delete(userId);
  else _userCache.clear();
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

    // Récupérer l'IP client pour les protections de sécurité
    // Prioriser les headers proxy pour obtenir la vraie IP client
    const clientIP =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.headers["x-real-ip"] ||
      req.ip ||
      req.connection?.remoteAddress ||
      req.socket?.remoteAddress ||
      "unknown";

    // Validation JWKS complète avec vérification cryptographique
    let decoded;
    try {
      logger.debug(`Validation JWT pour IP: ${clientIP}`);
      const jwksValidator = await getJWKSValidator();
      decoded = await jwksValidator.validateJWT(token, clientIP);

      if (!decoded) {
        logger.warn("JWT validation failed - decoded is null");
        return null;
      }
      logger.debug(`JWT validé avec succès pour utilisateur: ${decoded.sub}`);
    } catch (jwtError) {
      logger.warn("JWT invalide ou malformé:", jwtError.message);
      return null;
    }

    if (!decoded || !decoded.sub) {
      return null;
    }

    // Récupérer l'utilisateur (cache LRU 30s → évite 1 query DB par requête)
    let user = getCachedUser(decoded.sub);
    if (!user) {
      user = await User.findById(decoded.sub);
      if (user && !user.isDisabled) {
        setCachedUser(decoded.sub, user);
      }
    }
    if (!user || user.isDisabled) {
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

    // Récupérer le workspaceId depuis les headers (source de confiance)
    const headerWorkspaceId =
      context.req?.headers["x-workspace-id"] ||
      context.req?.headers["x-organization-id"];

    // Récupérer le workspaceId depuis les arguments (fourni par le client)
    const argsWorkspaceId = args.workspaceId;

    // En cas de mismatch entre header et args (ex: switch de compte, cache stale),
    // privilégier args.workspaceId qui vient du composant React avec l'org à jour.
    // La vérification d'appartenance est faite par le RBAC en aval.
    if (
      argsWorkspaceId &&
      headerWorkspaceId &&
      argsWorkspaceId !== headerWorkspaceId
    ) {
      logger.warn(
        `⚠️ withWorkspace: mismatch header=${headerWorkspaceId} vs args=${argsWorkspaceId}, utilisation de args`,
      );
    }

    // Priorité: args (source explicite du composant) > header (hint frontend)
    let workspaceId = argsWorkspaceId || headerWorkspaceId;

    // Si aucun workspaceId n'est fourni, utiliser l'ID utilisateur comme workspace
    if (!workspaceId) {
      workspaceId = context.user._id.toString();
    }

    const enhancedContext = {
      ...context,
      workspaceId,
    };

    return resolver(parent, args, enhancedContext, info);
  };
};

export { betterAuthJWTMiddleware, validateJWT, isAuthenticated, withWorkspace };
