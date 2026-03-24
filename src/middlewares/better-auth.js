import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import User from "../models/User.js";
import mongoose from "mongoose";

// ✅ Cache LRU partagé pour éviter User.findById à chaque requête cookie
const USER_CACHE_TTL = 30_000; // 30 secondes
const USER_CACHE_MAX = 500;
const _cookieUserCache = new Map();

function getCachedUser(userId) {
  const entry = _cookieUserCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > USER_CACHE_TTL) {
    _cookieUserCache.delete(userId);
    return null;
  }
  return entry.user;
}

function setCachedUser(userId, user) {
  if (_cookieUserCache.size >= USER_CACHE_MAX) {
    const oldestKey = _cookieUserCache.keys().next().value;
    _cookieUserCache.delete(oldestKey);
  }
  _cookieUserCache.set(userId, { user, ts: Date.now() });
}

/**
 * Extrait le token de session depuis les cookies
 *
 * Better Auth signe ses cookies avec HMAC-SHA256 via better-call.
 * Le format du cookie est : rawToken.base64HmacSignature (URL-encodé).
 * MongoDB stocke uniquement le rawToken, il faut donc retirer la signature.
 *
 * @param {string} cookieHeader - Header Cookie de la requête
 * @returns {string|null} - Token de session brut ou null
 */
const extractSessionToken = (cookieHeader) => {
  if (!cookieHeader) return null;

  // Chercher le cookie better-auth.session_token
  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());
  const prefixes = [
    "better-auth.session_token=",
    "__Secure-better-auth.session_token=",
  ];

  for (const cookie of cookies) {
    const matchedPrefix = prefixes.find((p) => cookie.startsWith(p));
    if (matchedPrefix) {
      // Extraire la valeur complète (après le nom du cookie)
      const rawValue = cookie.substring(matchedPrefix.length);

      // URL-décoder la valeur (Better Auth URL-encode les cookies signés)
      let decodedValue;
      try {
        decodedValue = decodeURIComponent(rawValue);
      } catch {
        decodedValue = rawValue;
      }

      // Better Auth signe les cookies : rawToken.base64HmacSignature
      // La signature HMAC-SHA256 en base64 fait toujours 44 caractères et finit par '='
      const lastDotIndex = decodedValue.lastIndexOf(".");
      if (lastDotIndex > 0) {
        const signature = decodedValue.substring(lastDotIndex + 1);
        if (signature.length === 44 && signature.endsWith("=")) {
          // Cookie signé : retourner uniquement le token brut (avant la signature)
          return decodedValue.substring(0, lastDotIndex);
        }
      }

      // Fallback : cookie non signé (ancien format ou test), retourner tel quel
      return decodedValue;
    }
  }

  return null;
};

/**
 * Middleware d'authentification better-auth
 * Valide les sessions via les cookies et lookup direct MongoDB
 *
 * ✅ Optimisé : utilise le userId de la session pour un findById direct
 * au lieu de 2 queries (user collection Better Auth + User.findOne par email)
 */
const betterAuthMiddleware = async (req) => {
  try {
    const cookieHeader = req.headers?.cookie;
    if (!cookieHeader) {
      logger.debug("Aucun cookie trouvé");
      return null;
    }

    const sessionToken = extractSessionToken(cookieHeader);
    if (!sessionToken) {
      logger.debug("Token de session better-auth non trouvé");
      return null;
    }

    // Validation directe en MongoDB — une seule query pour la session
    const db = mongoose.connection.db;
    if (!db) {
      logger.error("Connexion MongoDB non disponible");
      return null;
    }

    const session = await db.collection("session").findOne({
      token: sessionToken,
      expiresAt: { $gt: new Date() },
    });

    if (!session) {
      logger.debug("Session non trouvée ou expirée en MongoDB");
      return null;
    }

    if (!session.userId) {
      logger.debug("Session sans userId");
      return null;
    }

    // ✅ findById avec cache LRU (0 query si cache hit)
    const userIdStr = session.userId.toString();
    let user = getCachedUser(userIdStr);
    if (!user) {
      user = await User.findById(session.userId);
      if (user && !user.isDisabled) {
        setCachedUser(userIdStr, user);
      }
    }

    if (!user || user.isDisabled) {
      logger.warn(`Utilisateur ${session.userId} non trouvé ou désactivé`);
      return null;
    }

    logger.debug(`Authentification réussie pour: ${user.email}`);

    return user;
  } catch (error) {
    logger.error("Erreur dans le middleware better-auth:", error.message);
    return null;
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
 * Extrait le workspaceId depuis les headers ou les arguments
 */
const withWorkspace = (resolver) => {
  return async (parent, args, context, info) => {
    if (!context.user) {
      throw new AppError(
        "Vous devez être connecté pour effectuer cette action",
        ERROR_CODES.UNAUTHENTICATED,
      );
    }

    // Extraire le workspaceId depuis les headers ou les arguments
    let workspaceId =
      args.workspaceId || context.req?.headers["x-workspace-id"];

    if (!workspaceId) {
      throw new AppError("WorkspaceId requis", ERROR_CODES.VALIDATION_ERROR);
    }

    // Ajouter le workspaceId au contexte
    const enhancedContext = {
      ...context,
      workspaceId,
    };

    return resolver(parent, args, enhancedContext, info);
  };
};

export { betterAuthMiddleware, isAuthenticated, withWorkspace };
