import TrialService from '../services/trialService.js';
import logger from '../utils/logger.js';
import { AppError, ERROR_CODES } from '../utils/errors.js';

/**
 * Middleware pour vérifier et mettre à jour automatiquement le statut de la période d'essai
 * @param {Function} resolver - Resolver GraphQL à wrapper
 * @returns {Function} - Resolver wrappé avec vérification de la période d'essai
 */
export const withTrialCheck = (resolver) => {
  return async (parent, args, context, info) => {
    // Vérifier seulement si l'utilisateur est connecté
    if (context.user && (context.user.id || context.user._id)) {
      try {
        // Vérifier et mettre à jour le statut de la période d'essai
        const userId = context.user.id || context.user._id;
        await TrialService.checkAndUpdateTrialStatus(userId);
      } catch (error) {
        // Logger l'erreur mais ne pas bloquer la requête
        logger.warn(`Erreur lors de la vérification de la période d'essai pour l'utilisateur ${context.user.id || context.user._id}:`, error);
      }
    }

    // Exécuter le resolver original
    return resolver(parent, args, context, info);
  };
};

/**
 * Middleware pour vérifier si l'utilisateur a accès aux fonctionnalités premium
 * (abonnement payant OU période d'essai active)
 * @param {Function} resolver - Resolver GraphQL à wrapper
 * @returns {Function} - Resolver wrappé avec vérification d'accès premium
 */
export const requirePremiumAccess = (resolver) => {
  return async (parent, args, context, info) => {
    if (!context.user) {
      throw new AppError(
        'Vous devez être connecté pour effectuer cette action',
        ERROR_CODES.UNAUTHENTICATED
      );
    }

    const userId = context.user.id || context.user._id;

    try {
      // Vérifier le statut de la période d'essai
      const trialStatus = await TrialService.checkAndUpdateTrialStatus(userId);

      // Vérifier si l'utilisateur a accès aux fonctionnalités premium
      if (!trialStatus.hasPremiumAccess) {
        throw new Error('Cette fonctionnalité nécessite un abonnement premium ou une période d\'essai active');
      }

      // Ajouter les informations de période d'essai au contexte
      context.trialStatus = trialStatus;

    } catch (error) {
      if (error.message.includes('nécessite un abonnement premium')) {
        throw error;
      }

      logger.error(`Erreur lors de la vérification de l'accès premium pour l'utilisateur ${userId}:`, error);
      throw new Error('Erreur lors de la vérification de vos droits d\'accès');
    }

    // Exécuter le resolver original
    return resolver(parent, args, context, info);
  };
};

/**
 * Middleware pour vérifier si l'utilisateur peut encore utiliser sa période d'essai
 * (pour les actions qui consomment des ressources limitées)
 * @param {Function} resolver - Resolver GraphQL à wrapper
 * @returns {Function} - Resolver wrappé avec vérification de limite d'essai
 */
export const withTrialLimits = (resolver) => {
  return async (parent, args, context, info) => {
    if (!context.user) {
      throw new AppError(
        'Vous devez être connecté pour effectuer cette action',
        ERROR_CODES.UNAUTHENTICATED
      );
    }

    const userId = context.user.id || context.user._id;

    try {
      // Vérifier le statut de la période d'essai
      const trialStatus = await TrialService.checkAndUpdateTrialStatus(userId);

      // Si l'utilisateur est en période d'essai, vérifier les limites
      if (trialStatus.isTrialActive && trialStatus.daysRemaining <= 0) {
        throw new Error('Votre période d\'essai a expiré. Passez à un abonnement premium pour continuer.');
      }

      // Ajouter les informations de période d'essai au contexte
      context.trialStatus = trialStatus;

    } catch (error) {
      if (error.message.includes('période d\'essai a expiré')) {
        throw error;
      }

      logger.error(`Erreur lors de la vérification des limites d'essai pour l'utilisateur ${userId}:`, error);
      throw new Error('Erreur lors de la vérification de votre période d\'essai');
    }

    // Exécuter le resolver original
    return resolver(parent, args, context, info);
  };
};
