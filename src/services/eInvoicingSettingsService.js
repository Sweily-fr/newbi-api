import mongoose from "mongoose";
import logger from "../utils/logger.js";

/**
 * Service pour gérer les paramètres de facturation électronique (e-invoicing) au niveau organisation
 * Utilise MongoDB directement pour les opérations sur les organisations
 */
class EInvoicingSettingsService {
  /**
   * Obtenir la collection organization de MongoDB
   */
  static getOrganizationCollection() {
    return mongoose.connection.db.collection("organization");
  }

  /**
   * Obtenir la collection member de MongoDB
   */
  static getMemberCollection() {
    return mongoose.connection.db.collection("member");
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

      const userObjectId =
        typeof userId === "string"
          ? new mongoose.Types.ObjectId(userId)
          : userId;

      const membership = await memberCollection.findOne({
        userId: userObjectId,
      });

      if (!membership) {
        logger.debug(`Aucun membership trouvé pour l'utilisateur ${userId}`);
        return null;
      }

      const organization = await organizationCollection.findOne({
        _id: membership.organizationId,
      });

      return organization;
    } catch (error) {
      logger.error("Erreur lors de la récupération de l'organisation:", error);
      return null;
    }
  }

  /**
   * Obtenir une organisation par son ID
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<Object|null>} - Organisation ou null
   */
  static async getOrganizationById(organizationId) {
    try {
      const organizationCollection = this.getOrganizationCollection();

      const orgObjectId =
        typeof organizationId === "string"
          ? new mongoose.Types.ObjectId(organizationId)
          : organizationId;

      const organization = await organizationCollection.findOne({
        _id: orgObjectId,
      });
      return organization;
    } catch (error) {
      logger.error(
        "Erreur lors de la récupération de l'organisation par ID:",
        error,
      );
      return null;
    }
  }

  /**
   * Vérifier si la facturation électronique est activée pour une organisation
   * @param {string} organizationId - ID de l'organisation (workspaceId)
   * @returns {Promise<boolean>} - true si activée, false sinon
   */
  static async isEInvoicingEnabled(organizationId) {
    try {
      const organization = await this.getOrganizationById(organizationId);

      if (!organization) {
        logger.debug(`Organisation ${organizationId} non trouvée`);
        return false;
      }

      return Boolean(organization.eInvoicingEnabled);
    } catch (error) {
      logger.error(
        "Erreur lors de la vérification du statut e-invoicing:",
        error,
      );
      return false;
    }
  }

  /**
   * Obtenir les paramètres e-invoicing d'une organisation
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<Object>} - Paramètres e-invoicing
   */
  static async getEInvoicingSettings(organizationId) {
    try {
      const organization = await this.getOrganizationById(organizationId);

      if (!organization) {
        return {
          eInvoicingEnabled: false,
          superPdpConfigured: false,
          superPdpWebhookConfigured: false,
        };
      }

      return {
        eInvoicingEnabled: Boolean(organization.eInvoicingEnabled),
        superPdpConfigured: Boolean(
          organization.superPdpClientId && organization.superPdpClientSecret,
        ),
        superPdpWebhookConfigured: Boolean(organization.superPdpWebhookSecret),
        // Ne pas exposer les secrets
        superPdpClientId: organization.superPdpClientId
          ? "***configured***"
          : null,
        superPdpEnvironment: organization.superPdpEnvironment || "sandbox",
        // Le champ GraphQL est typé String : on renvoie une date ISO parsable
        // côté frontend. Sans ça, le scalar String sérialise l'objet Date via
        // Date.valueOf() → timestamp epoch ("1749376800000") que `new Date(str)`
        // interprète comme une date invalide ("Invalid Date").
        eInvoicingActivatedAt: organization.eInvoicingActivatedAt
          ? new Date(organization.eInvoicingActivatedAt).toISOString()
          : null,
      };
    } catch (error) {
      logger.error(
        "Erreur lors de la récupération des paramètres e-invoicing:",
        error,
      );
      throw error;
    }
  }

  /**
   * Activer la facturation électronique pour une organisation
   * @param {string} organizationId - ID de l'organisation
   * @param {Object} settings - Paramètres SuperPDP (optionnel si variables d'env globales)
   * @returns {Promise<Object>} - Paramètres mis à jour
   */
  static async enableEInvoicing(organizationId, settings = {}) {
    try {
      const organizationCollection = this.getOrganizationCollection();

      const orgObjectId =
        typeof organizationId === "string"
          ? new mongoose.Types.ObjectId(organizationId)
          : organizationId;

      const updateData = {
        eInvoicingEnabled: true,
        eInvoicingActivatedAt: new Date(),
        superPdpEnvironment: settings.environment || "sandbox",
        updatedAt: new Date(),
      };

      // Si des credentials spécifiques à l'organisation sont fournis
      if (settings.clientId) {
        updateData.superPdpClientId = settings.clientId;
      }
      if (settings.clientSecret) {
        updateData.superPdpClientSecret = settings.clientSecret;
      }
      if (settings.webhookSecret) {
        updateData.superPdpWebhookSecret = settings.webhookSecret;
      }

      await organizationCollection.updateOne(
        { _id: orgObjectId },
        { $set: updateData },
      );

      logger.info(
        `✅ E-invoicing activé pour l'organisation ${organizationId}`,
      );

      return await this.getEInvoicingSettings(organizationId);
    } catch (error) {
      logger.error("Erreur lors de l'activation de l'e-invoicing:", error);
      throw error;
    }
  }

  /**
   * Désactiver la facturation électronique pour une organisation
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<Object>} - Paramètres mis à jour
   */
  static async disableEInvoicing(organizationId) {
    try {
      const organizationCollection = this.getOrganizationCollection();

      const orgObjectId =
        typeof organizationId === "string"
          ? new mongoose.Types.ObjectId(organizationId)
          : organizationId;

      await organizationCollection.updateOne(
        { _id: orgObjectId },
        {
          $set: {
            eInvoicingEnabled: false,
            updatedAt: new Date(),
          },
        },
      );

      logger.info(
        `⚠️ E-invoicing désactivé pour l'organisation ${organizationId}`,
      );

      return await this.getEInvoicingSettings(organizationId);
    } catch (error) {
      logger.error("Erreur lors de la désactivation de l'e-invoicing:", error);
      throw error;
    }
  }

  /**
   * Mettre à jour les credentials SuperPDP d'une organisation
   * @param {string} organizationId - ID de l'organisation
   * @param {Object} credentials - Credentials SuperPDP
   * @returns {Promise<Object>} - Paramètres mis à jour
   */
  static async updateSuperPdpCredentials(organizationId, credentials) {
    try {
      const organizationCollection = this.getOrganizationCollection();

      const orgObjectId =
        typeof organizationId === "string"
          ? new mongoose.Types.ObjectId(organizationId)
          : organizationId;

      const updateData = {
        updatedAt: new Date(),
      };

      if (credentials.clientId !== undefined) {
        updateData.superPdpClientId = credentials.clientId;
      }
      if (credentials.clientSecret !== undefined) {
        updateData.superPdpClientSecret = credentials.clientSecret;
      }
      if (credentials.webhookSecret !== undefined) {
        updateData.superPdpWebhookSecret = credentials.webhookSecret;
      }
      if (credentials.environment !== undefined) {
        updateData.superPdpEnvironment = credentials.environment;
      }

      await organizationCollection.updateOne(
        { _id: orgObjectId },
        { $set: updateData },
      );

      logger.info(
        `🔑 Credentials SuperPDP mis à jour pour l'organisation ${organizationId}`,
      );

      return await this.getEInvoicingSettings(organizationId);
    } catch (error) {
      logger.error(
        "Erreur lors de la mise à jour des credentials SuperPDP:",
        error,
      );
      throw error;
    }
  }

  /**
   * Obtenir les credentials SuperPDP pour une organisation (usage interne uniquement)
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<Object|null>} - Credentials ou null
   */
  static async getSuperPdpCredentials(organizationId) {
    try {
      const organization = await this.getOrganizationById(organizationId);

      if (!organization) {
        return null;
      }

      // Utiliser les credentials de l'organisation ou les variables d'environnement globales
      return {
        clientId:
          organization.superPdpClientId || process.env.SUPERPDP_CLIENT_ID,
        clientSecret:
          organization.superPdpClientSecret ||
          process.env.SUPERPDP_CLIENT_SECRET,
        webhookSecret:
          organization.superPdpWebhookSecret ||
          process.env.SUPERPDP_WEBHOOK_SECRET,
        environment:
          organization.superPdpEnvironment ||
          process.env.SUPERPDP_ENVIRONMENT ||
          "sandbox",
      };
    } catch (error) {
      logger.error(
        "Erreur lors de la récupération des credentials SuperPDP:",
        error,
      );
      return null;
    }
  }

  /**
   * Stocker les tokens OAuth2 SuperPDP pour une organisation
   * @param {string} organizationId - ID de l'organisation
   * @param {Object} tokens - Tokens OAuth2
   * @returns {Promise<void>}
   */
  static async storeSuperPdpTokens(organizationId, tokens) {
    try {
      const organizationCollection = this.getOrganizationCollection();

      const orgObjectId =
        typeof organizationId === "string"
          ? new mongoose.Types.ObjectId(organizationId)
          : organizationId;

      const updateData = {
        superPdpAccessToken: tokens.accessToken,
        superPdpRefreshToken: tokens.refreshToken,
        superPdpTokenExpiresAt: new Date(
          Date.now() + (tokens.expiresIn || 3600) * 1000,
        ),
        superPdpTokenType: tokens.tokenType || "Bearer",
        updatedAt: new Date(),
      };

      await organizationCollection.updateOne(
        { _id: orgObjectId },
        { $set: updateData },
      );

      logger.info(
        `🔑 Tokens OAuth2 SuperPDP stockés pour l'organisation ${organizationId}`,
      );
    } catch (error) {
      logger.error("Erreur lors du stockage des tokens SuperPDP:", error);
      throw error;
    }
  }

  /**
   * Supprimer les tokens OAuth2 SuperPDP d'une organisation
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<void>}
   */
  static async removeSuperPdpTokens(organizationId) {
    try {
      const organizationCollection = this.getOrganizationCollection();

      const orgObjectId =
        typeof organizationId === "string"
          ? new mongoose.Types.ObjectId(organizationId)
          : organizationId;

      await organizationCollection.updateOne(
        { _id: orgObjectId },
        {
          $unset: {
            superPdpAccessToken: "",
            superPdpRefreshToken: "",
            superPdpTokenExpiresAt: "",
            superPdpTokenType: "",
          },
          $set: { updatedAt: new Date() },
        },
      );

      logger.info(
        `🗑️ Tokens OAuth2 SuperPDP supprimés pour l'organisation ${organizationId}`,
      );
    } catch (error) {
      logger.error("Erreur lors de la suppression des tokens SuperPDP:", error);
      throw error;
    }
  }

  /**
   * Obtenir les tokens OAuth2 SuperPDP d'une organisation
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<Object|null>} - Tokens ou null
   */
  static async getSuperPdpTokens(organizationId) {
    try {
      const organization = await this.getOrganizationById(organizationId);

      if (!organization || !organization.superPdpAccessToken) {
        return null;
      }

      return {
        accessToken: organization.superPdpAccessToken,
        refreshToken: organization.superPdpRefreshToken,
        expiresAt: organization.superPdpTokenExpiresAt,
        tokenType: organization.superPdpTokenType || "Bearer",
        isExpired: organization.superPdpTokenExpiresAt
          ? new Date(organization.superPdpTokenExpiresAt) < new Date()
          : true,
      };
    } catch (error) {
      logger.error(
        "Erreur lors de la récupération des tokens SuperPDP:",
        error,
      );
      return null;
    }
  }

  /**
   * Obtenir les statistiques e-invoicing
   * @returns {Promise<Object>} - Statistiques
   */
  static async getEInvoicingStats() {
    try {
      const organizationCollection = this.getOrganizationCollection();

      const [enabledCount, totalCount] = await Promise.all([
        organizationCollection.countDocuments({ eInvoicingEnabled: true }),
        organizationCollection.countDocuments({}),
      ]);

      return {
        enabledOrganizations: enabledCount || 0,
        totalOrganizations: totalCount || 0,
        adoptionRate:
          totalCount > 0 ? ((enabledCount / totalCount) * 100).toFixed(2) : 0,
      };
    } catch (error) {
      logger.error(
        "Erreur lors de la récupération des statistiques e-invoicing:",
        error,
      );
      throw error;
    }
  }
}

export default EInvoicingSettingsService;
