import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import User from "../models/User.js";
import mongoose from "mongoose";

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
  const prefixes = ["better-auth.session_token=", "__Secure-better-auth.session_token="];

  for (const cookie of cookies) {
    const matchedPrefix = prefixes.find(p => cookie.startsWith(p));
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
 * ✅ FIX: Validation directe en MongoDB au lieu d'un appel HTTP vers le frontend
 *
 * L'ancien système faisait un fetch vers ${frontendUrl}/api/auth/get-session
 * ce qui causait :
 * - Des timeouts (cold start Vercel, latence réseau)
 * - Des problèmes de forwarding de cookies cross-origin
 * - Une dépendance circulaire backend→frontend pour valider une session
 *
 * La nouvelle approche cherche directement la session dans MongoDB (collection "session")
 * créée par Better Auth, ce qui est instantané et fiable.
 */
const validateSession = async (headers) => {
  if (!headers) return null;

  try {
    const cookieHeader = headers.cookie;
    if (!cookieHeader) {
      logger.debug("Aucun cookie trouvé");
      return null;
    }

    // Vérifier la présence du token better-auth
    const sessionToken = extractSessionToken(cookieHeader);
    if (!sessionToken) {
      logger.debug("Token de session better-auth non trouvé");
      return null;
    }

    // Validation directe en MongoDB
    const db = mongoose.connection.db;
    if (!db) {
      logger.error("Connexion MongoDB non disponible");
      return null;
    }

    const now = new Date();

    // Chercher la session dans la collection Better Auth
    const session = await db.collection("session").findOne({
      token: sessionToken,
      expiresAt: { $gt: now },
    });

    if (!session) {
      logger.debug("Session non trouvée ou expirée en MongoDB");
      return null;
    }

    // Récupérer l'utilisateur depuis la collection Better Auth
    const userId = session.userId;
    if (!userId) {
      logger.debug("Session sans userId");
      return null;
    }

    // Chercher l'utilisateur dans la collection Better Auth "user"
    const { ObjectId } = mongoose.Types;
    let userObjectId;
    try {
      userObjectId = new ObjectId(userId.toString());
    } catch {
      logger.warn("userId invalide dans la session:", userId);
      return null;
    }

    const betterAuthUser = await db.collection("user").findOne({
      _id: userObjectId,
    });

    if (!betterAuthUser) {
      logger.debug(`Utilisateur ${userId} non trouvé dans la collection user`);
      return null;
    }

    logger.debug(
      `Session validée directement en MongoDB pour: ${betterAuthUser.email}`
    );

    return betterAuthUser;
  } catch (error) {
    logger.error("Erreur lors de la validation de session:", error.message);
    return null;
  }
};

/**
 * Middleware d'authentification better-auth
 * Valide les sessions via les cookies et lookup direct MongoDB
 */
const betterAuthMiddleware = async (req) => {
  try {
    // Valider la session directement en MongoDB
    const sessionUser = await validateSession(req.headers);

    if (!sessionUser) {
      logger.debug("Session invalide ou utilisateur non authentifié");
      return null;
    }

    // Récupérer l'utilisateur complet depuis le modèle Mongoose
    // en utilisant l'email de la session validée
    const user = await User.findOne({
      email: sessionUser.email,
      isDisabled: { $ne: true },
    });

    if (!user) {
      logger.warn(
        `Utilisateur ${sessionUser.email} non trouvé ou désactivé en base de données`
      );
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
        ERROR_CODES.UNAUTHENTICATED
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
        ERROR_CODES.UNAUTHENTICATED
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
