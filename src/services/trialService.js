import User from '../models/User.js';
import logger from '../utils/logger.js';

/**
 * Service pour gérer les périodes d'essai des utilisateurs
 */
class TrialService {
  /**
   * Vérifier et mettre à jour le statut de la période d'essai d'un utilisateur
   * @param {string} userId - ID de l'utilisateur
   * @returns {Promise<Object>} - Statut de la période d'essai
   */
  static async checkAndUpdateTrialStatus(userId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('Utilisateur non trouvé');
      }

      const now = new Date();
      const isTrialExpired = user.subscription.trialEndDate && now > user.subscription.trialEndDate;

      // Si la période d'essai est expirée mais toujours active, la terminer
      if (isTrialExpired && user.subscription.isTrialActive) {
        await user.endTrial();
        logger.info(`Période d'essai expirée pour l'utilisateur ${userId}`);
      }

      return {
        isTrialActive: Boolean(user.subscription?.isTrialActive),
        trialEndDate: user.subscription?.trialEndDate || null,
        daysRemaining: user.getTrialDaysRemaining() || 0,
        hasPremiumAccess: Boolean(user.hasPremiumAccess()),
        hasUsedTrial: Boolean(user.subscription?.hasUsedTrial),
      };
    } catch (error) {
      logger.error('Erreur lors de la vérification du statut de la période d\'essai:', error);
      throw error;
    }
  }

  /**
   * Obtenir tous les utilisateurs dont la période d'essai expire bientôt
   * @param {number} daysBeforeExpiration - Nombre de jours avant expiration
   * @returns {Promise<Array>} - Liste des utilisateurs
   */
  static async getUsersWithExpiringTrial(daysBeforeExpiration = 3) {
    try {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + daysBeforeExpiration);

      const users = await User.find({
        'subscription.isTrialActive': true,
        'subscription.trialEndDate': {
          $lte: targetDate,
          $gte: new Date(),
        },
      }).select('email profile subscription');

      return users;
    } catch (error) {
      logger.error('Erreur lors de la récupération des utilisateurs avec période d\'essai expirante:', error);
      throw error;
    }
  }

  /**
   * Nettoyer les périodes d'essai expirées (tâche de maintenance)
   * @returns {Promise<number>} - Nombre d'utilisateurs mis à jour
   */
  static async cleanupExpiredTrials() {
    try {
      const now = new Date();
      const expiredUsers = await User.find({
        'subscription.isTrialActive': true,
        'subscription.trialEndDate': { $lt: now },
      });

      let updatedCount = 0;
      for (const user of expiredUsers) {
        await user.endTrial();
        updatedCount++;
      }

      logger.info(`${updatedCount} périodes d'essai expirées nettoyées`);
      return updatedCount;
    } catch (error) {
      logger.error('Erreur lors du nettoyage des périodes d\'essai expirées:', error);
      throw error;
    }
  }

  /**
   * Obtenir les statistiques des périodes d'essai
   * @returns {Promise<Object>} - Statistiques
   */
  static async getTrialStats() {
    try {
      const [activeTrials, expiredTrials, totalTrialsUsed] = await Promise.all([
        User.countDocuments({ 'subscription.isTrialActive': true }),
        User.countDocuments({
          'subscription.hasUsedTrial': true,
          'subscription.isTrialActive': false,
        }),
        User.countDocuments({ 'subscription.hasUsedTrial': true }),
      ]);

      return {
        activeTrials,
        expiredTrials,
        totalTrialsUsed,
        conversionRate: totalTrialsUsed > 0 ? ((totalTrialsUsed - expiredTrials) / totalTrialsUsed * 100).toFixed(2) : 0,
      };
    } catch (error) {
      logger.error('Erreur lors de la récupération des statistiques de période d\'essai:', error);
      throw error;
    }
  }
}

export default TrialService;
