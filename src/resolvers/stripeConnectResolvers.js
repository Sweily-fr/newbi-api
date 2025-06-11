const stripeConnectService = require('../services/stripeConnectService');
const StripeConnectAccount = require('../models/StripeConnectAccount');
const FileTransfer = require('../models/FileTransfer');
const logger = require('../utils/logger');

const stripeConnectResolvers = {
  Query: {
    /**
     * Récupère le compte Stripe Connect de l'utilisateur connecté
     */
    myStripeConnectAccount: async (_, args, { user }) => {
      if (!user) {
        throw new Error('Vous devez être connecté pour accéder à cette ressource');
      }

      try {
        return await StripeConnectAccount.findOne({ userId: user._id });
      } catch (error) {
        logger.error('Erreur lors de la récupération du compte Stripe Connect:', error);
        throw new Error(`Erreur lors de la récupération du compte Stripe Connect: ${error.message}`);
      }
    }
  },
  
  Mutation: {
    /**
     * Crée un compte Stripe Connect pour l'utilisateur connecté
     */
    createStripeConnectAccount: async (_, args, { user }) => {
      if (!user) {
        throw new Error('Vous devez être connecté pour créer un compte Stripe Connect');
      }

      try {
        return await stripeConnectService.createConnectAccount(user._id);
      } catch (error) {
        logger.error('Erreur lors de la création du compte Stripe Connect:', error);
        return {
          success: false,
          message: `Erreur lors de la création du compte Stripe Connect: ${error.message}`
        };
      }
    },

    /**
     * Génère un lien d'onboarding pour un compte Stripe Connect
     */
    generateStripeOnboardingLink: async (_, { accountId, returnUrl }, { user }) => {
      if (!user) {
        throw new Error('Vous devez être connecté pour générer un lien d\'onboarding');
      }

      try {
        // Vérifier que le compte appartient bien à l'utilisateur connecté
        const account = await StripeConnectAccount.findOne({ accountId, userId: user._id });
        if (!account) {
          return {
            success: false,
            message: 'Compte Stripe Connect non trouvé ou non autorisé'
          };
        }

        return await stripeConnectService.generateOnboardingLink(accountId, returnUrl);
      } catch (error) {
        logger.error('Erreur lors de la génération du lien d\'onboarding:', error);
        return {
          success: false,
          message: `Erreur lors de la génération du lien d'onboarding: ${error.message}`
        };
      }
    },

    /**
     * Vérifie le statut d'un compte Stripe Connect
     */
    checkStripeConnectAccountStatus: async (_, { accountId }, { user }) => {
      if (!user) {
        throw new Error('Vous devez être connecté pour vérifier le statut d\'un compte');
      }

      try {
        // Vérifier que le compte appartient bien à l'utilisateur connecté
        const account = await StripeConnectAccount.findOne({ accountId, userId: user._id });
        if (!account) {
          return {
            success: false,
            message: 'Compte Stripe Connect non trouvé ou non autorisé'
          };
        }

        return await stripeConnectService.checkAccountStatus(accountId);
      } catch (error) {
        logger.error('Erreur lors de la vérification du statut du compte:', error);
        return {
          success: false,
          message: `Erreur lors de la vérification du statut du compte: ${error.message}`
        };
      }
    },

    /**
     * Crée une session de paiement pour un transfert de fichiers
     */
    createPaymentSessionForFileTransfer: async (_, { transferId }, { origin }) => {
      try {
        // Récupérer le transfert de fichiers
        const fileTransfer = await FileTransfer.findById(transferId);
        if (!fileTransfer) {
          return {
            success: false,
            message: 'Transfert de fichiers non trouvé'
          };
        }

        // Vérifier que le paiement est requis et n'a pas déjà été effectué
        console.log('Vérification du paiement:', {
          isPaymentRequired: fileTransfer.isPaymentRequired,
          isPaid: fileTransfer.isPaid
        });
        
        if (!fileTransfer.isPaymentRequired || fileTransfer.isPaid) {
          return {
            success: false,
            message: 'Ce transfert ne nécessite pas de paiement ou a déjà été payé'
          };
        }

        // Récupérer le compte Stripe Connect du propriétaire du transfert
        const stripeConnectAccount = await StripeConnectAccount.findOne({ userId: fileTransfer.userId });
        if (!stripeConnectAccount) {
          return {
            success: false,
            message: 'Le propriétaire du transfert n\'a pas de compte Stripe Connect configuré'
          };
        }

        // Construire les URLs de succès et d'annulation
        const baseUrl = origin || process.env.FRONTEND_URL || 'http://localhost:3000';
        const successUrl = `${baseUrl}/file-transfer/download?link=${fileTransfer.shareLink}&key=${fileTransfer.accessKey}&payment_status=success`;
        const cancelUrl = `${baseUrl}/file-transfer/download?link=${fileTransfer.shareLink}&key=${fileTransfer.accessKey}&payment_status=canceled`;

        // Créer la session de paiement
        const result = await stripeConnectService.createPaymentSession(
          fileTransfer,
          stripeConnectAccount.accountId,
          successUrl,
          cancelUrl
        );

        // Si la création de la session a réussi, mettre à jour le transfert avec l'ID de session
        if (result.success && result.sessionId) {
          fileTransfer.paymentSessionId = result.sessionId;
          fileTransfer.paymentSessionUrl = result.sessionUrl;
          await fileTransfer.save();
        }

        return result;
      } catch (error) {
        logger.error('Erreur lors de la création de la session de paiement:', error);
        return {
          success: false,
          message: `Erreur lors de la création de la session de paiement: ${error.message}`
        };
      }
    }
  }
};

module.exports = stripeConnectResolvers;
