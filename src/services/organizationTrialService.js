import mongoose from 'mongoose';
import logger from '../utils/logger.js';

/**
 * Service pour gérer les périodes d'essai au niveau organisation
 * Utilise MongoDB directement pour les opérations sur les organisations
 * Base de données: invoice-app (dev) / newbi (prod)
 */
class OrganizationTrialService {
  /**
   * Obtenir la collection organization de MongoDB
   */
  static getOrganizationCollection() {
    return mongoose.connection.db.collection('organization');
  }

  /**
   * Obtenir la collection member de MongoDB
   */
  static getMemberCollection() {
    return mongoose.connection.db.collection('member');
  }

  /**
   * Trouver l'organisation d'un utilisateur
   * @param {string} userId - ID de l'utilisateur
   * @returns {Promise<Object|null>} - Organisation ou null
   */
  static async getUserOrganization(userId) {
    try {
      const memberCollection = this.getMemberCollection();
      const organizationCollection = this.getOrganizationCollection();
      
      // Convertir userId en ObjectId si c'est une string
      const userObjectId = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;
      
      // Trouver le membership de l'utilisateur
      const membership = await memberCollection.findOne({ userId: userObjectId });

      if (!membership) {
        logger.debug(`Aucun membership trouvé pour l'utilisateur ${userId}`);
        return null;
      }

      // Récupérer l'organisation (organizationId est aussi un ObjectId)
      const organization = await organizationCollection.findOne({ 
        _id: membership.organizationId 
      });

      return organization;
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'organisation:', error);
      return null;
    }
  }

  /**
   * Créer les champs trial manquants pour une organisation
   * @param {string|ObjectId} organizationId - ID de l'organisation
   * @returns {Promise<void>}
   */
  static async createTrialFields(organizationId) {
    try {
      const organizationCollection = this.getOrganizationCollection();
      
      // Convertir en ObjectId si nécessaire
      const orgObjectId = typeof organizationId === 'string' ? 
        new mongoose.Types.ObjectId(organizationId) : organizationId;
      
      const updateResult = await organizationCollection.updateOne(
        { _id: orgObjectId },
        {
          $set: {
            isTrialActive: false,
            hasUsedTrial: false,
            trialStartDate: null,
            trialEndDate: null,
            updatedAt: new Date()
          }
        }
      );
      
      logger.info(`Champs trial créés pour l'organisation ${organizationId}: ${updateResult.modifiedCount} document(s) modifié(s)`);
    } catch (error) {
      logger.error('Erreur lors de la création des champs trial:', error);
      throw error;
    }
  }

  /**
   * Vérifier et mettre à jour le statut de la période d'essai d'une organisation
   * @param {string} userId - ID de l'utilisateur
   * @returns {Promise<Object>} - Statut de la période d'essai
   */
  static async checkAndUpdateTrialStatus(userId) {
    try {
      const organization = await this.getUserOrganization(userId);
      
      if (!organization) {
        throw new Error('Organisation non trouvée pour cet utilisateur');
      }

      const now = new Date();
      const isTrialExpired = organization.trialEndDate && now > new Date(organization.trialEndDate);

      // Si la période d'essai est expirée mais toujours active, la terminer
      if (isTrialExpired && organization.isTrialActive) {
        await this.endTrial(organization.id);
        logger.info(`Période d'essai expirée pour l'organisation ${organization.id}`);
        
        // Récupérer les données mises à jour
        const organizationCollection = this.getOrganizationCollection();
        const updatedOrganization = await organizationCollection.findOne({ 
          id: organization.id 
        });
        
        return this.formatTrialStatus(updatedOrganization);
      }

      return this.formatTrialStatus(organization);
    } catch (error) {
      logger.error('Erreur lors de la vérification du statut de la période d\'essai:', error);
      throw error;
    }
  }

  /**
   * Formater le statut de la période d'essai
   * @param {Object} organization - Organisation
   * @returns {Object} - Statut formaté
   */
  static formatTrialStatus(organization) {
    if (!organization) {
      return {
        isTrialActive: false,
        trialEndDate: null,
        daysRemaining: 0,
        hasPremiumAccess: false,
        hasUsedTrial: false,
      };
    }

    const now = new Date();
    const trialEndDate = organization.trialEndDate ? new Date(organization.trialEndDate) : null;
    
    let daysRemaining = 0;
    if (organization.isTrialActive && trialEndDate) {
      const diffTime = trialEndDate - now;
      daysRemaining = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    }

    const hasPremiumAccess = Boolean(
      organization.isTrialActive && trialEndDate && now < trialEndDate
    );

    return {
      isTrialActive: Boolean(organization.isTrialActive),
      trialEndDate: organization.trialEndDate || null,
      daysRemaining,
      hasPremiumAccess,
      hasUsedTrial: Boolean(organization.hasUsedTrial),
    };
  }

  /**
   * Démarrer une période d'essai pour une organisation
   * @param {string} userId - ID de l'utilisateur
   * @returns {Promise<Object>} - Statut de la période d'essai
   */
  static async startTrial(userId) {
    try {
      const organization = await this.getUserOrganization(userId);
      
      if (!organization) {
        throw new Error('Organisation non trouvée pour cet utilisateur');
      }

      if (organization.hasUsedTrial) {
        throw new Error('Cette organisation a déjà utilisé sa période d\'essai');
      }

      const now = new Date();
      const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 jours

      const organizationCollection = this.getOrganizationCollection();
      await organizationCollection.updateOne(
        { id: organization.id },
        {
          $set: {
            trialStartDate: now,
            trialEndDate: trialEnd,
            isTrialActive: true,
            hasUsedTrial: true,
            updatedAt: now
          }
        }
      );

      logger.info(`Période d'essai démarrée pour l'organisation ${organization.id}`);

      // Récupérer les données mises à jour
      const updatedOrganization = await organizationCollection.findOne({ 
        id: organization.id 
      });

      return this.formatTrialStatus(updatedOrganization);
    } catch (error) {
      logger.error('Erreur lors du démarrage de la période d\'essai:', error);
      throw error;
    }
  }

  /**
   * Terminer une période d'essai pour une organisation
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<void>}
   */
  static async endTrial(organizationId) {
    try {
      const organizationCollection = this.getOrganizationCollection();
      await organizationCollection.updateOne(
        { id: organizationId },
        {
          $set: {
            isTrialActive: false,
            updatedAt: new Date()
          }
        }
      );

      logger.info(`Période d'essai terminée pour l'organisation ${organizationId}`);
    } catch (error) {
      logger.error('Erreur lors de la fin de la période d\'essai:', error);
      throw error;
    }
  }

  /**
   * Obtenir toutes les organisations dont la période d'essai expire bientôt
   * @param {number} daysBeforeExpiration - Nombre de jours avant expiration
   * @returns {Promise<Array>} - Liste des organisations
   */
  static async getOrganizationsWithExpiringTrial(daysBeforeExpiration = 3) {
    try {
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + daysBeforeExpiration);

      const organizationCollection = this.getOrganizationCollection();
      const organizations = await organizationCollection.find({
        isTrialActive: true,
        trialEndDate: {
          $lte: targetDate,
          $gte: new Date(),
        },
      }).toArray();

      return organizations || [];
    } catch (error) {
      logger.error('Erreur lors de la récupération des organisations avec période d\'essai expirante:', error);
      throw error;
    }
  }

  /**
   * Nettoyer les périodes d'essai expirées (tâche de maintenance)
   * @returns {Promise<number>} - Nombre d'organisations mises à jour
   */
  static async cleanupExpiredTrials() {
    try {
      const now = new Date();
      const organizationCollection = this.getOrganizationCollection();
      
      const expiredOrganizations = await organizationCollection.find({
        isTrialActive: true,
        trialEndDate: { $lt: now },
      }).toArray();

      let updatedCount = 0;
      for (const org of expiredOrganizations || []) {
        await this.endTrial(org.id);
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
      const organizationCollection = this.getOrganizationCollection();
      
      const [activeTrials, expiredTrials, totalTrialsUsed] = await Promise.all([
        organizationCollection.countDocuments({
          isTrialActive: true
        }),
        organizationCollection.countDocuments({
          hasUsedTrial: true,
          isTrialActive: false,
        }),
        organizationCollection.countDocuments({
          hasUsedTrial: true
        }),
      ]);

      return {
        activeTrials: activeTrials || 0,
        expiredTrials: expiredTrials || 0,
        totalTrialsUsed: totalTrialsUsed || 0,
        conversionRate: totalTrialsUsed > 0 ? ((totalTrialsUsed - expiredTrials) / totalTrialsUsed * 100).toFixed(2) : 0,
      };
    } catch (error) {
      logger.error('Erreur lors de la récupération des statistiques de période d\'essai:', error);
      throw error;
    }
  }
}

export default OrganizationTrialService;
