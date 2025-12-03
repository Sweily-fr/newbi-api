import dotenv from "dotenv";
dotenv.config();

import Stripe from "stripe";
import logger from "../utils/logger.js";
import StripeConnectAccount from "../models/StripeConnectAccount.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Service pour gérer les interactions avec Stripe Connect
 */
const stripeConnectService = {
  /**
   * Crée un compte Stripe Connect Express pour une organisation
   * @param {string} organizationId - ID de l'organisation (Better Auth)
   * @param {string} userId - ID de l'utilisateur (pour fallback/compatibilité)
   * @returns {Promise<Object>} - Réponse avec l'ID du compte Stripe Connect
   */
  async createConnectAccount(organizationId, userId = null) {
    try {
      // Vérifier si l'organisation a déjà un compte Stripe Connect
      let existingAccount = null;
      if (organizationId) {
        existingAccount = await StripeConnectAccount.findOne({
          organizationId,
        });
      }

      // Fallback: vérifier avec userId pour compatibilité
      if (!existingAccount && userId) {
        existingAccount = await StripeConnectAccount.findOne({ userId });
      }

      if (existingAccount) {
        return {
          success: true,
          accountId: existingAccount.accountId,
          message:
            "Un compte Stripe Connect existe déjà pour cette organisation",
        };
      }

      // Créer un nouveau compte Stripe Connect Express
      const account = await stripe.accounts.create({
        type: "express",
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: "individual",
        metadata: {
          organizationId: organizationId || "N/A",
          userId: userId ? userId.toString() : "N/A",
        },
      });

      // Enregistrer le compte dans la base de données
      const stripeConnectAccount = new StripeConnectAccount({
        organizationId, // Nouveau: ID de l'organisation
        userId, // Ancien: gardé pour compatibilité
        accountId: account.id,
        isOnboarded: false,
        chargesEnabled: account.charges_enabled || false,
        payoutsEnabled: account.payouts_enabled || false,
      });

      await stripeConnectAccount.save();

      return {
        success: true,
        accountId: account.id,
        message: "Compte Stripe Connect créé avec succès",
      };
    } catch (error) {
      logger.error(
        "Erreur lors de la création du compte Stripe Connect:",
        error
      );
      return {
        success: false,
        message: `Erreur lors de la création du compte Stripe Connect: ${error.message}`,
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
          message: "Compte Stripe Connect non trouvé",
        };
      }

      // Générer un lien d'onboarding
      // Type "account_onboarding" pour permettre une configuration progressive
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: returnUrl,
        return_url: returnUrl,
        type: "account_onboarding",
      });

      return {
        success: true,
        url: accountLink.url,
        message: "Lien d'onboarding généré avec succès",
      };
    } catch (error) {
      logger.error("Erreur lors de la génération du lien d'onboarding:", error);
      return {
        success: false,
        message: `Erreur lors de la génération du lien d'onboarding: ${error.message}`,
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

      // Un compte est considéré comme "onboarded" seulement si :
      // 1. Les détails sont soumis (details_submitted)
      // 2. Les paiements sont activés (charges_enabled)
      const isFullyOnboarded =
        stripeAccount.details_submitted && stripeAccount.charges_enabled;

      logger.info("Statut Stripe récupéré:", {
        accountId,
        details_submitted: stripeAccount.details_submitted,
        charges_enabled: stripeAccount.charges_enabled,
        payouts_enabled: stripeAccount.payouts_enabled,
        isFullyOnboarded,
      });

      // Mettre à jour les informations dans notre base de données
      const account = await StripeConnectAccount.findOneAndUpdate(
        { accountId },
        {
          isOnboarded: isFullyOnboarded,
          chargesEnabled: stripeAccount.charges_enabled || false,
          payoutsEnabled: stripeAccount.payouts_enabled || false,
        },
        { new: true }
      );

      if (!account) {
        return {
          success: false,
          message:
            "Compte Stripe Connect non trouvé dans notre base de données",
        };
      }

      return {
        success: true,
        isOnboarded: account.isOnboarded,
        chargesEnabled: account.chargesEnabled,
        payoutsEnabled: account.payoutsEnabled,
        accountStatus: stripeAccount.details_submitted ? "complete" : "pending",
        message: "Statut du compte récupéré avec succès",
      };
    } catch (error) {
      logger.error(
        "Erreur lors de la vérification du statut du compte:",
        error
      );
      return {
        success: false,
        message: `Erreur lors de la vérification du statut du compte: ${error.message}`,
      };
    }
  },

  /**
   * Génère un lien de connexion au tableau de bord Stripe Express
   * @param {string} accountId - ID du compte Stripe Connect
   * @returns {Promise<Object>} - Réponse avec l'URL du tableau de bord
   */
  async generateDashboardLink(accountId) {
    try {
      // Créer un login link pour accéder au tableau de bord Express
      const loginLink = await stripe.accounts.createLoginLink(accountId);

      logger.info("Lien de tableau de bord généré:", {
        accountId,
        url: loginLink.url,
      });

      return {
        success: true,
        url: loginLink.url,
        message: "Lien de tableau de bord généré avec succès",
      };
    } catch (error) {
      logger.error(
        "Erreur lors de la génération du lien de tableau de bord:",
        error
      );
      return {
        success: false,
        message: `Erreur lors de la génération du lien de tableau de bord: ${error.message}`,
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
          message:
            "Le compte Stripe Connect n'est pas configuré pour recevoir des paiements",
        };
      }

      // Calculer la commission de la plateforme (10% par exemple)
      const amount = fileTransfer.paymentAmount * 100; // Convertir en centimes
      const applicationFee = Math.round(amount * 0.1); // 10% de commission

      // Créer une session de paiement Stripe Checkout
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: fileTransfer.paymentCurrency.toLowerCase(),
              product_data: {
                name: `Téléchargement de fichiers - ${fileTransfer.files.length} fichier(s)`,
                description: `Accès aux fichiers partagés par ${fileTransfer.userId}`,
              },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${successUrl}`,
        cancel_url: `${cancelUrl}`,
        payment_intent_data: {
          application_fee_amount: applicationFee,
          transfer_data: {
            destination: accountId,
          },
          metadata: {
            fileTransferId: fileTransfer.id.toString(),
            userId: fileTransfer.userId.toString(),
          },
        },
        metadata: {
          transferId: fileTransfer.id.toString(),
          fileTransferId: fileTransfer.id.toString(),
          userId: fileTransfer.userId.toString(),
        },
      });

      return {
        success: true,
        sessionId: session.id,
        sessionUrl: session.url,
        message: "Session de paiement créée avec succès",
      };
    } catch (error) {
      logger.error(
        "Erreur lors de la création de la session de paiement:",
        error
      );
      return {
        success: false,
        message: `Erreur lors de la création de la session de paiement: ${error.message}`,
      };
    }
  },

  /**
   * Effectue un virement depuis le solde Stripe de Newbi vers un compte Stripe Connect
   * @param {string} accountId - ID du compte Stripe Connect destinataire
   * @param {number} amount - Montant en centimes
   * @param {string} currency - Devise (ex: 'eur')
   * @param {Object} metadata - Métadonnées du transfert
   * @returns {Promise<Object>} - Résultat du transfert
   */
  async transferToStripeConnect(
    accountId,
    amount,
    currency = "eur",
    metadata = {}
  ) {
    try {
      // Vérifier si le compte existe et peut recevoir des paiements
      const account = await StripeConnectAccount.findOne({ accountId });
      if (!account || !account.payoutsEnabled) {
        return {
          success: false,
          error:
            "Le compte Stripe Connect n'est pas configuré pour recevoir des virements",
        };
      }

      // Effectuer le virement depuis le solde Stripe de Newbi vers le compte Connect
      // Utiliser un transfer avec source_transaction pour débiter le compte principal
      const transfer = await stripe.transfers.create({
        amount: amount,
        currency: currency,
        destination: accountId,
        description: metadata.description || "Paiement de parrainage Newbi",
        metadata: {
          ...metadata,
          source: "newbi_referral_payout",
          timestamp: new Date().toISOString(),
        },
      });

      logger.info("✅ Virement de parrainage effectué depuis le solde Newbi", {
        transferId: transfer.id,
        accountId,
        amount: amount / 100, // Afficher en euros
        currency,
        description: transfer.description,
      });

      return {
        success: true,
        transferId: transfer.id,
        amount: transfer.amount,
        currency: transfer.currency,
        destination: transfer.destination,
        description: transfer.description,
      };
    } catch (error) {
      logger.error(
        "❌ Erreur lors du virement de parrainage depuis Newbi:",
        error
      );

      // Messages d'erreur plus spécifiques
      let errorMessage = error.message;
      if (error.code === "insufficient_funds") {
        errorMessage =
          "Solde insuffisant sur le compte Stripe de Newbi pour effectuer le virement";
      } else if (error.code === "account_invalid") {
        errorMessage =
          "Compte Stripe Connect destinataire invalide ou non configuré";
      }

      return {
        success: false,
        error: errorMessage,
        stripeError: error.code,
      };
    }
  },
};

export default stripeConnectService;

// Export des fonctions individuelles pour faciliter l'import
export const {
  createConnectAccount,
  generateOnboardingLink,
  checkAccountStatus,
  createPaymentSession,
  transferToStripeConnect,
} = stripeConnectService;
