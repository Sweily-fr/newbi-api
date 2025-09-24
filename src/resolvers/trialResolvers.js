import TrialService from '../services/trialService.js';
import { isAuthenticated } from '../middlewares/better-auth.js';
import User from '../models/User.js';
import logger from '../utils/logger.js';

const trialResolvers = {
  Query: {
    /**
     * Obtenir le statut de la période d'essai de l'utilisateur connecté
     */
    getTrialStatus: isAuthenticated(async (parent, args, context) => {
      try {
        const trialStatus = await TrialService.checkAndUpdateTrialStatus(context.user.id);
        
        return {
          success: true,
          data: trialStatus,
        };
      } catch (error) {
        logger.error('Erreur lors de la récupération du statut de la période d\'essai:', error);
        return {
          success: false,
          message: error.message,
          data: null,
        };
      }
    }),

    /**
     * Obtenir les statistiques des périodes d'essai (admin uniquement)
     */
    getTrialStats: isAuthenticated(async (parent, args, context) => {
      try {
        // Vérifier si l'utilisateur est admin (à adapter selon votre système de rôles)
        if (!context.user.isAdmin) {
          throw new Error('Accès non autorisé');
        }

        const stats = await TrialService.getTrialStats();
        return {
          success: true,
          data: stats,
        };
      } catch (error) {
        logger.error('Erreur lors de la récupération des statistiques de période d\'essai:', error);
        return {
          success: false,
          message: error.message,
          data: null,
        };
      }
    }),
  },

  Mutation: {
    /**
     * Démarrer manuellement une période d'essai (si pas déjà utilisée)
     */
    startTrial: isAuthenticated(async (parent, args, context) => {
      try {
        const user = await User.findById(context.user.id);
        if (!user) {
          throw new Error('Utilisateur non trouvé');
        }

        if (user.subscription.hasUsedTrial) {
          throw new Error('Vous avez déjà utilisé votre période d\'essai gratuite');
        }

        await user.startTrial();
        const trialStatus = await TrialService.checkAndUpdateTrialStatus(context.user.id);

        logger.info(`Période d'essai démarrée pour l'utilisateur ${context.user.id}`);

        return {
          success: true,
          message: 'Période d\'essai de 14 jours démarrée avec succès',
          data: trialStatus,
        };
      } catch (error) {
        logger.error('Erreur lors du démarrage de la période d\'essai:', error);
        return {
          success: false,
          message: error.message,
          data: null,
        };
      }
    }),
  },
};

export default trialResolvers;
