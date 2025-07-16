import Integration from '../models/Integration.js';
import { AuthenticationError, UserInputError } from 'apollo-server-express';
import stripe from 'stripe';

export default {
  Query: {
    /**
     * Récupérer toutes les intégrations de l'utilisateur connecté
     */
    integrations: async (_, __, { user }) => {
      if (!user) {
        throw new AuthenticationError('Vous devez être connecté pour accéder à vos intégrations');
      }

      try {
        const integrations = await Integration.find({ userId: user.id });
        return integrations.map(integration => ({
          id: integration._id,
          provider: integration.provider,
          isConnected: integration.isConnected,
          lastUpdated: integration.lastUpdated.toISOString()
        }));
      } catch (error) {
        console.error('Erreur lors de la récupération des intégrations:', error);
        throw new Error('Une erreur est survenue lors de la récupération des intégrations');
      }
    }
  },

  Mutation: {
    /**
     * Connecter un compte Stripe avec une clé API
     */
    connectStripe: async (_, { apiKey }, { user }) => {
      if (!user) {
        throw new AuthenticationError('Vous devez être connecté pour connecter Stripe');
      }

      // Vérifier si l'utilisateur a une licence premium
      if (!user.subscription || !user.subscription.licence) {
        throw new UserInputError('Vous devez avoir une licence premium pour utiliser cette fonctionnalité');
      }

      try {
        // Valider le format de la clé API Stripe
        Integration.validateApiKey('stripe', apiKey);
        
        // Valider la clé API Stripe en tentant de l'utiliser
        const stripeClient = stripe(apiKey);
        
        // Tester la clé en récupérant les informations du compte
        await stripeClient.account.retrieve();
        
        // Chiffrer la clé API avant de la stocker
        const encryptedCredentials = Integration.encryptApiKey(apiKey);
        
        // Rechercher une intégration Stripe existante pour cet utilisateur
        let integration = await Integration.findOne({ 
          userId: user.id, 
          provider: 'stripe' 
        });
        
        if (integration) {
          // Mettre à jour l'intégration existante
          integration.credentials = encryptedCredentials;
          integration.isConnected = true;
          integration.lastUpdated = new Date();
          await integration.save();
        } else {
          // Créer une nouvelle intégration
          integration = await Integration.create({
            userId: user.id,
            provider: 'stripe',
            credentials: encryptedCredentials,
            isConnected: true
          });
        }
        
        return {
          success: true,
          message: 'Compte Stripe connecté avec succès',
          integration: {
            id: integration._id,
            provider: integration.provider,
            isConnected: integration.isConnected,
            lastUpdated: integration.lastUpdated.toISOString()
          }
        };
      } catch (error) {
        console.error('Erreur lors de la connexion à Stripe:', error);
        
        // Gérer les erreurs de validation du format de la clé API
        if (error.message === 'Format de clé API Stripe invalide') {
          throw new UserInputError('Format de clé API Stripe invalide. La clé doit commencer par sk_test_, sk_live_, pk_test_ ou pk_live_ suivi de caractères alphanumériques.');
        }
        
        // Gérer les erreurs spécifiques à Stripe
        if (error.type === 'StripeAuthenticationError') {
          throw new UserInputError('Clé API Stripe invalide ou expirée');
        }
        
        throw new Error('Une erreur est survenue lors de la connexion à Stripe');
      }
    },

    /**
     * Déconnecter un compte Stripe
     */
    disconnectStripe: async (_, __, { user }) => {
      if (!user) {
        throw new AuthenticationError('Vous devez être connecté pour déconnecter Stripe');
      }

      try {
        // Rechercher l'intégration Stripe de l'utilisateur
        const integration = await Integration.findOne({ 
          userId: user.id, 
          provider: 'stripe' 
        });
        
        if (!integration) {
          throw new UserInputError('Aucune intégration Stripe trouvée');
        }
        
        // Marquer l'intégration comme déconnectée sans supprimer les informations
        integration.isConnected = false;
        integration.lastUpdated = new Date();
        await integration.save();
        
        return {
          success: true,
          message: 'Compte Stripe déconnecté avec succès',
          integration: {
            id: integration._id,
            provider: integration.provider,
            isConnected: integration.isConnected,
            lastUpdated: integration.lastUpdated.toISOString()
          }
        };
      } catch (error) {
        console.error('Erreur lors de la déconnexion de Stripe:', error);
        throw new Error('Une erreur est survenue lors de la déconnexion de Stripe');
      }
    }
  }
};
