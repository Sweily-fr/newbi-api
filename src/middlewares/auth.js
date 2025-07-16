import jwt from "jsonwebtoken";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import User from "../models/User.js";

const authMiddleware = async (token) => {
  // Vérifier si le token est présent
  if (!token) {
    console.log("Aucun token fourni");
    return null;
  }

  try {
    // Enlever "Bearer " du token
    const tokenContent = token.startsWith("Bearer ") ? token.slice(7) : token;
    console.log("Token reçu:", token.substring(0, 20) + "...");

    // Vérifier et décoder le token
    const decoded = jwt.verify(tokenContent, process.env.JWT_SECRET);
    console.log("Token décodé avec succès, userId:", decoded.id);

    // Vérifier si l'utilisateur existe et si son compte n'est pas désactivé
    const user = await User.findById(decoded.id);
    if (!user) {
      console.log(
        "Utilisateur non trouvé dans la base de données:",
        decoded.id
      );
      return null;
    }

    // Si le compte est désactivé, refuser l'accès
    if (user.isDisabled) {
      console.log("Compte utilisateur désactivé:", decoded.id);
      return null;
    }

    console.log("Authentification réussie pour l'utilisateur:", user.email);
    return user;
  } catch (error) {
    // Différencier les types d'erreurs JWT
    if (error instanceof jwt.TokenExpiredError) {
      console.log("Token expiré:", error.message);
    } else if (error instanceof jwt.JsonWebTokenError) {
      console.log("Token invalide:", error.message);
    } else {
      console.log("Erreur d'authentification:", error.message);
    }
    return null;
  }
};

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

export {
  authMiddleware,
  isAuthenticated
};
