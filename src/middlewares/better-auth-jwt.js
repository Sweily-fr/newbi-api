import jwt from "jsonwebtoken";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import User from "../models/User.js";
import { getJWKSValidator } from "../services/jwks-validator.js";

/**
 * Middleware d'authentification utilisant les sessions Better Auth
 * Valide les JWT avec vérification cryptographique JWKS complète
 */
const betterAuthJWTMiddleware = async (req) => {
  try {
    // Récupérer le token JWT depuis les headers
    const token = extractJWTToken(req.headers);
    if (!token) {
      logger.debug("Aucun token JWT trouvé dans les headers");
      return null;
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

    // Récupérer l'utilisateur depuis la base de données
    const user = await User.findById(decoded.sub);
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
        ERROR_CODES.UNAUTHENTICATED
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
        ERROR_CODES.UNAUTHENTICATED
      );
    }

    // Récupérer le workspaceId depuis les headers (source de confiance)
    const headerWorkspaceId =
      context.req?.headers["x-workspace-id"] ||
      context.req?.headers["x-organization-id"];

    // Récupérer le workspaceId depuis les arguments (fourni par le client)
    const argsWorkspaceId = args.workspaceId;

    // ✅ FIX: Valider que le workspaceId des arguments correspond au header
    // Évite qu'un utilisateur puisse accéder aux données d'une autre organisation
    if (argsWorkspaceId && headerWorkspaceId && argsWorkspaceId !== headerWorkspaceId) {
      throw new AppError(
        "Organisation invalide. Vous n'avez pas accès à cette organisation.",
        ERROR_CODES.FORBIDDEN
      );
    }

    // Utiliser le workspaceId des arguments ou du header, ou l'ID utilisateur en fallback
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
