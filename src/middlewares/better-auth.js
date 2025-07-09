const { AppError, ERROR_CODES } = require('../utils/errors');
const logger = require('../utils/logger');
const User = require('../models/User');

/**
 * Extrait le token de session depuis les cookies
 * @param {string} cookieHeader - Header Cookie de la requête
 * @returns {string|null} - Token de session ou null
 */
const extractSessionToken = (cookieHeader) => {
  if (!cookieHeader) return null;
  
  // Chercher le cookie better-auth.session_token
  const cookies = cookieHeader.split(';').map(cookie => cookie.trim());
  
  for (const cookie of cookies) {
    if (cookie.startsWith('better-auth.session_token=')) {
      return cookie.split('=')[1];
    }
  }
  
  return null;
};

/**
 * Valide une session better-auth via l'API du frontend
 * @param {Object} headers - Headers de la requête
 * @returns {Object|null} - Données utilisateur ou null
 */
const validateSession = async (headers) => {
  if (!headers) return null;
  
  try {
    const cookieHeader = headers.cookie;
    if (!cookieHeader) {
      logger.debug('Aucun cookie trouvé');
      return null;
    }
    
    // Vérifier la présence du token better-auth
    const sessionToken = extractSessionToken(cookieHeader);
    if (!sessionToken) {
      logger.debug('Token de session better-auth non trouvé');
      return null;
    }
    
    // Valider la session via l'API better-auth du frontend
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const response = await fetch(`${frontendUrl}/api/auth/get-session`, {
      method: 'GET',
      headers: {
        'Cookie': cookieHeader,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      logger.debug(`Validation de session échouée: ${response.status}`);
      return null;
    }
    
    const sessionData = await response.json();
    
    if (!sessionData || !sessionData.user) {
      logger.debug('Session invalide ou utilisateur non trouvé');
      return null;
    }
    
    logger.debug(`Session validée pour l'utilisateur: ${sessionData.user.email}`);
    return sessionData.user;
    
  } catch (error) {
    logger.error('Erreur lors de la validation de session:', error.message);
    return null;
  }
};

/**
 * Middleware d'authentification better-auth
 * Valide les sessions via les cookies et l'API better-auth
 */
const betterAuthMiddleware = async (req) => {
  try {
    // Valider la session avec better-auth
    const sessionUser = await validateSession(req.headers);
    
    if (!sessionUser) {
      logger.debug('Session invalide ou utilisateur non authentifié');
      return null;
    }
    
    // Récupérer l'utilisateur complet depuis la base de données
    // en utilisant l'email ou l'ID de la session validée
    const user = await User.findOne({ 
      email: sessionUser.email,
      isDisabled: { $ne: true } 
    });
    
    if (!user) {
      logger.warn(`Utilisateur ${sessionUser.email} non trouvé ou désactivé en base de données`);
      return null;
    }
    
    logger.debug(`Authentification réussie pour: ${user.email}`);
    return user;
    
  } catch (error) {
    logger.error('Erreur dans le middleware better-auth:', error.message);
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
        'Vous devez être connecté pour effectuer cette action',
        ERROR_CODES.UNAUTHENTICATED
      );
    }
    return resolver(parent, args, context, info);
  };
};

module.exports = {
  betterAuthMiddleware,
  isAuthenticated
};
