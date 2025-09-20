import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import User from "../models/User.js";

/**
 * Extrait le Bearer token depuis les headers
 */
const extractBearerToken = (headers) => {
  const authHeader = headers.authorization;
  console.log("🔍 [Bearer Middleware] Header Authorization reçu:", authHeader);

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    console.log(
      "✅ [Bearer Middleware] Bearer token extrait:",
      token ? `présent (${token.substring(0, 20)}...)` : "absent"
    );
    return token;
  }

  console.log(
    "❌ [Bearer Middleware] Aucun Bearer token trouvé dans les headers"
  );
  return null;
};

/**
 * Valide un Bearer token via l'API Better Auth du frontend
 */
const validateBearerToken = async (token) => {
  if (!token) return null;

  try {
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    console.log(
      "🔍 [Bearer Middleware] Validation via:",
      `${frontendUrl}/api/auth/get-session`
    );

    const response = await fetch(`${frontendUrl}/api/auth/get-session`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    console.log("🔍 [Bearer Middleware] Réponse validation:", response.status);

    if (!response.ok) {
      console.log(
        `❌ [Bearer Middleware] Validation échouée: ${response.status}`
      );
      return null;
    }

    const sessionData = await response.json();
    console.log(
      "🔍 [Bearer Middleware] Session data:",
      sessionData?.user?.email || "pas d'utilisateur"
    );

    if (!sessionData || !sessionData.user) {
      console.log(
        "❌ [Bearer Middleware] Session invalide ou utilisateur non trouvé"
      );
      return null;
    }

    console.log(
      `✅ [Bearer Middleware] Session validée pour: ${sessionData.user.email}`
    );
    return sessionData.user;
  } catch (error) {
    console.error(
      "❌ [Bearer Middleware] Erreur validation Bearer token:",
      error.message
    );
    return null;
  }
};

/**
 * Middleware d'authentification Bearer Token Better Auth
 */
const betterAuthBearerMiddleware = async (req) => {
  try {
    console.log("🔍 [Bearer Middleware] Début validation Bearer token");

    // Extraire le Bearer token
    const token = extractBearerToken(req.headers);
    if (!token) {
      console.log("❌ [Bearer Middleware] Aucun Bearer token trouvé");
      return null;
    }

    // Valider le token via Better Auth
    const sessionUser = await validateBearerToken(token);
    if (!sessionUser) {
      console.log("❌ [Bearer Middleware] Token Bearer invalide");
      return null;
    }

    // Récupérer l'utilisateur complet depuis la base de données
    const user = await User.findOne({
      email: sessionUser.email,
      isDisabled: { $ne: true },
    });

    if (!user) {
      console.warn(
        `❌ [Bearer Middleware] Utilisateur ${sessionUser.email} non trouvé ou désactivé`
      );
      return null;
    }

    console.log(
      `✅ [Bearer Middleware] Authentification réussie pour: ${user.email}`
    );
    return user;
  } catch (error) {
    console.error(
      "❌ [Bearer Middleware] Erreur dans le middleware Bearer:",
      error.message
    );
    return null;
  }
};

/**
 * Wrapper pour les resolvers nécessitant une authentification Bearer
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

export { betterAuthBearerMiddleware, isAuthenticated, withWorkspace };
