const { AppError, ERROR_CODES } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Middleware d'authentification temporaire pour better-auth
 * 
 * ATTENTION: Cette implémentation est temporaire pour les tests.
 * Elle simule un utilisateur authentifié pour permettre de tester le système Kanban.
 * 
 * TODO: Implémenter la vraie validation better-auth avec les cookies de session
 */
const betterAuthMiddleware = async (req) => {
  try {
    // Vérifier si des cookies sont présents
    const cookies = req.headers.cookie;
    
    if (!cookies) {
      logger.info('Aucun cookie trouvé - utilisateur non authentifié');
      return null;
    }

    // TEMPORAIRE: Simuler un utilisateur authentifié pour les tests
    // Dans une vraie implémentation, on validerait la session better-auth
    logger.info('TEMPORAIRE: Simulation d\'un utilisateur authentifié pour les tests');
    
    // Retourner un utilisateur factice pour les tests
    // Utilisation d'un ObjectId MongoDB valide pour éviter les erreurs de cast
    return {
      id: '507f1f77bcf86cd799439011', // ObjectId valide pour les tests
      email: 'test@example.com',
      name: 'Test User'
    };
    
  } catch (error) {
    logger.error('Erreur dans le middleware d\'authentification:', error.message);
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
