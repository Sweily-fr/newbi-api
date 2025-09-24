import OrganizationTrialService from '../services/organizationTrialService.js';
import { isAuthenticated } from '../middlewares/better-auth.js';
import logger from '../utils/logger.js';

const trialResolvers = {
  Query: {
    /**
     * Obtenir le statut de la période d'essai de l'utilisateur connecté
     */
    getTrialStatus: isAuthenticated(async (parent, args, context) => {
      try {
        // Utiliser le nouveau service basé sur l'organisation
        const trialStatus = await OrganizationTrialService.checkAndUpdateTrialStatus(context.user.id);
        
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

        // Utiliser le nouveau service basé sur l'organisation
        const stats = await OrganizationTrialService.getTrialStats();
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
        // Utiliser le nouveau service basé sur l'organisation
        const trialStatus = await OrganizationTrialService.startTrial(context.user.id);

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
