const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const StripeConnectAccount = require('../models/StripeConnectAccount');
const logger = require('../utils/logger');

/**
 * Service pour gérer les interactions avec Stripe Connect
 */
const stripeConnectService = {
  /**
   * Crée un compte Stripe Connect Express pour un utilisateur
   * @param {string} userId - ID de l'utilisateur
   * @returns {Promise<Object>} - Réponse avec l'ID du compte Stripe Connect
   */
  async createConnectAccount(userId) {
    try {
      // Vérifier si l'utilisateur a déjà un compte Stripe Connect
      const existingAccount = await StripeConnectAccount.findOne({ userId });
      if (existingAccount) {
        return {
          success: true,
          accountId: existingAccount.accountId,
          message: 'Un compte Stripe Connect existe déjà pour cet utilisateur'
        };
      }

      // Créer un nouveau compte Stripe Connect Express
      const account = await stripe.accounts.create({
        type: 'express',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        },
        business_type: 'individual',
        metadata: {
          userId: userId.toString() // Convertir l'ObjectId en string pour Stripe
        }
      });

      // Enregistrer le compte dans la base de données
      const stripeConnectAccount = new StripeConnectAccount({
        userId,
        accountId: account.id,
        isOnboarded: false,
        chargesEnabled: account.charges_enabled || false,
        payoutsEnabled: account.payouts_enabled || false
      });

      await stripeConnectAccount.save();

      return {
        success: true,
        accountId: account.id,
        message: 'Compte Stripe Connect créé avec succès'
      };
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
   * @param {string} accountId - ID du compte Stripe Connect
   * @param {string} returnUrl - URL de retour après l'onboarding
   * @returns {Promise<Object>} - Réponse avec l'URL d'onboarding
   */
  async generateOnboardingLink(accountId, returnUrl) {
    try {
      // Vérifier si le compte existe dans notre base de données
      const account = await StripeConnectAccount.findOne({ accountId });
      if (!account) {
        return {
          success: false,
          message: 'Compte Stripe Connect non trouvé'
        };
      }

      // Générer un lien d'onboarding
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: returnUrl,
        return_url: returnUrl,
        type: 'account_onboarding'
      });

      return {
        success: true,
        url: accountLink.url,
        message: 'Lien d\'onboarding généré avec succès'
      };
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
   * @param {string} accountId - ID du compte Stripe Connect
   * @returns {Promise<Object>} - Statut du compte
   */
  async checkAccountStatus(accountId) {
    try {
      // Récupérer les informations du compte depuis Stripe
      const stripeAccount = await stripe.accounts.retrieve(accountId);
      
      // Mettre à jour les informations dans notre base de données
      const account = await StripeConnectAccount.findOneAndUpdate(
        { accountId },
        {
          isOnboarded: stripeAccount.details_submitted || false,
          chargesEnabled: stripeAccount.charges_enabled || false,
          payoutsEnabled: stripeAccount.payouts_enabled || false
        },
        { new: true }
      );

      if (!account) {
        return {
          success: false,
          message: 'Compte Stripe Connect non trouvé dans notre base de données'
        };
      }

      return {
        success: true,
        isOnboarded: account.isOnboarded,
        chargesEnabled: account.chargesEnabled,
        payoutsEnabled: account.payoutsEnabled,
        accountStatus: stripeAccount.details_submitted ? 'complete' : 'pending',
        message: 'Statut du compte récupéré avec succès'
      };
    } catch (error) {
      logger.error('Erreur lors de la vérification du statut du compte:', error);
      return {
        success: false,
        message: `Erreur lors de la vérification du statut du compte: ${error.message}`
      };
    }
  },

  /**
   * Crée une session de paiement Stripe Checkout pour un transfert de fichiers
   * @param {Object} fileTransfer - Transfert de fichiers
   * @param {string} accountId - ID du compte Stripe Connect du destinataire
   * @param {string} successUrl - URL de succès après le paiement
   * @param {string} cancelUrl - URL d'annulation du paiement
   * @returns {Promise<Object>} - Réponse avec l'URL de la session de paiement
   */
  async createPaymentSession(fileTransfer, accountId, successUrl, cancelUrl) {
    try {
      // Vérifier si le compte existe et est configuré pour les paiements
      const account = await StripeConnectAccount.findOne({ accountId });
      if (!account || !account.chargesEnabled) {
        return {
          success: false,
          message: 'Le compte Stripe Connect n\'est pas configuré pour recevoir des paiements'
        };
      }

      // Calculer la commission de la plateforme (10% par exemple)
      const amount = fileTransfer.paymentAmount * 100; // Convertir en centimes
      const applicationFee = Math.round(amount * 0.10); // 10% de commission

      // Créer une session de paiement Stripe Checkout
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: fileTransfer.paymentCurrency.toLowerCase(),
              product_data: {
                name: `Téléchargement de fichiers - ${fileTransfer.files.length} fichier(s)`,
                description: `Accès aux fichiers partagés par ${fileTransfer.userId}`
              },
              unit_amount: amount
            },
            quantity: 1
          }
        ],
        mode: 'payment',
        success_url: `${successUrl}`,
        cancel_url: `${cancelUrl}`,
        payment_intent_data: {
          application_fee_amount: applicationFee,
          transfer_data: {
            destination: accountId
          },
          metadata: {
            fileTransferId: fileTransfer.id.toString(),
            userId: fileTransfer.userId.toString()
          }
        },
        metadata: {
          fileTransferId: fileTransfer.id.toString(),
          userId: fileTransfer.userId.toString()
        }
      });

      return {
        success: true,
        sessionId: session.id,
        sessionUrl: session.url,
        message: 'Session de paiement créée avec succès'
      };
    } catch (error) {
      logger.error('Erreur lors de la création de la session de paiement:', error);
      return {
        success: false,
        message: `Erreur lors de la création de la session de paiement: ${error.message}`
      };
    }
  }
};

module.exports = stripeConnectService;
