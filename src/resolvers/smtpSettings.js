import SmtpSettings from '../models/SmtpSettings.js';
import nodemailer from 'nodemailer';
import { AuthenticationError, UserInputError } from 'apollo-server-express';

const smtpSettingsResolvers = {
  Query: {
    /**
     * Récupérer les paramètres SMTP pour le workspace actuel
     */
    getSmtpSettings: async (_, __, { user, workspaceId }) => {
      if (!user) {
        throw new AuthenticationError('Non authentifié');
      }

      if (!workspaceId) {
        throw new UserInputError('Workspace ID requis');
      }

      let settings = await SmtpSettings.findOne({ workspaceId });

      // Si aucun paramètre n'existe, retourner des valeurs par défaut
      if (!settings) {
        return {
          workspaceId,
          enabled: false,
          smtpHost: '',
          smtpPort: 587,
          smtpSecure: false,
          smtpUser: '',
          fromEmail: '',
          fromName: '',
          lastTestStatus: 'PENDING',
        };
      }

      // Ne pas retourner le mot de passe
      const settingsObj = settings.toObject();
      delete settingsObj.smtpPassword;

      return settingsObj;
    },
  },

  Mutation: {
    /**
     * Mettre à jour les paramètres SMTP
     */
    updateSmtpSettings: async (_, { input }, { user, workspaceId }) => {
      if (!user) {
        throw new AuthenticationError('Non authentifié');
      }

      if (!workspaceId) {
        throw new UserInputError('Workspace ID requis');
      }

      // Validation des données
      if (input.enabled) {
        if (!input.smtpHost) {
          throw new UserInputError('Host SMTP requis');
        }
        if (!input.smtpUser) {
          throw new UserInputError('Utilisateur SMTP requis');
        }
        if (!input.fromEmail) {
          throw new UserInputError('Email expéditeur requis');
        }
        
        // Validation format email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(input.fromEmail)) {
          throw new UserInputError('Format d\'email expéditeur invalide');
        }
      }

      // Mettre à jour ou créer les paramètres
      let settings = await SmtpSettings.findOne({ workspaceId });

      if (settings) {
        // Mise à jour
        Object.keys(input).forEach(key => {
          if (input[key] !== undefined) {
            settings[key] = input[key];
          }
        });
        await settings.save();
      } else {
        // Création
        settings = await SmtpSettings.create({
          ...input,
          workspaceId,
        });
      }

      // Ne pas retourner le mot de passe
      const settingsObj = settings.toObject();
      delete settingsObj.smtpPassword;

      return settingsObj;
    },

    /**
     * Tester la connexion SMTP
     */
    testSmtpConnection: async (_, __, { user, workspaceId }) => {
      if (!user) {
        throw new AuthenticationError('Non authentifié');
      }

      if (!workspaceId) {
        throw new UserInputError('Workspace ID requis');
      }

      const settings = await SmtpSettings.findOne({ workspaceId });

      if (!settings) {
        throw new UserInputError('Aucune configuration SMTP trouvée');
      }

      try {
        // Créer un transporteur de test
        const transporter = nodemailer.createTransport({
          host: settings.smtpHost,
          port: settings.smtpPort,
          secure: settings.smtpSecure,
          auth: {
            user: settings.smtpUser,
            pass: settings.getDecryptedPassword(),
          },
        });

        // Vérifier la connexion
        await transporter.verify();

        // Mettre à jour le statut du test
        settings.lastTestedAt = new Date();
        settings.lastTestStatus = 'SUCCESS';
        settings.lastTestError = null;
        await settings.save();

        return {
          success: true,
          message: 'Connexion SMTP réussie',
        };
      } catch (error) {
        // Mettre à jour le statut du test
        settings.lastTestedAt = new Date();
        settings.lastTestStatus = 'FAILED';
        settings.lastTestError = error.message;
        await settings.save();

        return {
          success: false,
          message: 'Échec de la connexion SMTP',
          error: error.message,
        };
      }
    },
  },
};

export default smtpSettingsResolvers;
