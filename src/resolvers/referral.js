import User from '../models/User.js';
import ReferralEvent from '../models/ReferralEvent.js';
import logger from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { createConnectAccount, generateOnboardingLink } from '../services/stripeConnectService.js';

const referralResolvers = {
  Mutation: {
    // Générer un code de parrainage unique pour l'utilisateur
    generateReferralCode: async (_, __, { user }) => {
      try {
        if (!user) {
          throw new Error('Utilisateur non authentifié');
        }

        // Vérifier que l'utilisateur a un abonnement actif
        if (!user.subscription || !user.subscription.licence) {
          throw new Error('Un abonnement actif est requis pour parrainer');
        }

        // Vérifier si l'utilisateur a déjà un code de parrainage
        if (user.referralCode) {
          return {
            success: true,
            message: 'Code de parrainage récupéré',
            referralCode: user.referralCode
          };
        }

        // Générer un code unique
        let referralCode;
        let isUnique = false;
        let attempts = 0;
        const maxAttempts = 10;

        while (!isUnique && attempts < maxAttempts) {
          // Générer un code court et lisible
          referralCode = uuidv4().substring(0, 8).toUpperCase();
          
          // Vérifier l'unicité
          const existingUser = await User.findOne({ referralCode });
          if (!existingUser) {
            isUnique = true;
          }
          attempts++;
        }

        if (!isUnique) {
          throw new Error('Impossible de générer un code unique, veuillez réessayer');
        }

        // Sauvegarder le code
        await User.findByIdAndUpdate(user._id, { referralCode });

        logger.info('✅ Code de parrainage généré', {
          userId: user._id,
          referralCode,
          userEmail: user.email
        });

        return {
          success: true,
          message: 'Code de parrainage généré avec succès',
          referralCode,
          referralLink: null
        };

      } catch (error) {
        logger.error('❌ Erreur génération code parrainage:', error);
        return {
          success: false,
          message: error.message || 'Erreur lors de la génération du code de parrainage',
          referralCode: null,
          referralLink: null
        };
      }
    },

    // Générer un lien de parrainage complet
    generateReferralLink: async (_, __, { user }) => {
      try {
        if (!user) {
          throw new Error('Utilisateur non authentifié');
        }

        // Vérifier que l'utilisateur a un abonnement actif
        if (!user.subscription || !user.subscription.licence) {
          throw new Error('Un abonnement actif est requis pour parrainer');
        }

        // Générer ou récupérer le code de parrainage
        let referralCode = user.referralCode;
        
        if (!referralCode) {
          // Générer un code unique
          let isUnique = false;
          let attempts = 0;
          const maxAttempts = 10;

          while (!isUnique && attempts < maxAttempts) {
            referralCode = uuidv4().substring(0, 8).toUpperCase();
            
            const existingUser = await User.findOne({ referralCode });
            if (!existingUser) {
              isUnique = true;
            }
            attempts++;
          }

          if (!isUnique) {
            throw new Error('Impossible de générer un code unique, veuillez réessayer');
          }

          // Sauvegarder le code
          await User.findByIdAndUpdate(user._id, { referralCode });
        }

        // Générer le lien complet
        const baseUrl = process.env.FRONTEND_URL || 'https://newbi.fr';
        const referralLink = `${baseUrl}/register?ref=${referralCode}`;

        logger.info('✅ Lien de parrainage généré', {
          userId: user._id,
          referralCode,
          referralLink,
          userEmail: user.email
        });

        return {
          success: true,
          message: 'Lien de parrainage généré avec succès',
          referralCode,
          referralLink
        };

      } catch (error) {
        logger.error('❌ Erreur génération lien parrainage:', error);
        return {
          success: false,
          message: error.message || 'Erreur lors de la génération du lien de parrainage',
          referralCode: null,
          referralLink: null
        };
      }
    },

    // Vérifier le statut Stripe Connect pour le parrainage
    checkStripeConnectForReferral: async (_, __, { user }) => {
      logger.info('🔍 Début checkStripeConnectForReferral', { userId: user?._id });
      try {
        if (!user) {
          return {
            success: false,
            message: 'Utilisateur non authentifié',
            isConnected: false,
            canReceivePayments: false,
            onboardingUrl: null
          };
        }

        // Vérifier que l'utilisateur a un abonnement actif
        if (!user.subscription || !user.subscription.licence) {
          return {
            success: false,
            message: 'Un abonnement actif est requis pour parrainer',
            isConnected: false,
            canReceivePayments: false,
            onboardingUrl: null
          };
        }

        // Vérifier si l'utilisateur a déjà un compte Stripe Connect
        const stripeAccount = user.stripeConnectAccount;
        
        if (!stripeAccount || !stripeAccount.accountId) {
          // Créer un compte Stripe Connect
          const accountResult = await createConnectAccount(user._id);
          
          if (!accountResult.success) {
            return {
              success: false,
              message: accountResult.message || 'Erreur lors de la création du compte Stripe',
              isConnected: false,
              canReceivePayments: false,
              onboardingUrl: null
            };
          }

          // Générer le lien d'onboarding
          const returnUrl = `${process.env.FRONTEND_URL || 'https://newbi.fr'}/dashboard?stripe_success=true`;
          const onboardingResult = await generateOnboardingLink(
            accountResult.accountId,
            returnUrl
          );

          if (!onboardingResult.success) {
            return {
              success: false,
              message: onboardingResult.message || 'Erreur lors de la génération du lien Stripe',
              isConnected: false,
              canReceivePayments: false,
              onboardingUrl: null
            };
          }

          return {
            success: true,
            message: 'Configuration Stripe requise',
            isConnected: false,
            canReceivePayments: false,
            onboardingUrl: onboardingResult.url
          };
        }

        // Vérifier le statut du compte existant
        const isConnected = !!stripeAccount.accountId;
        const canReceivePayments = stripeAccount.chargesEnabled || false;

        if (isConnected && !canReceivePayments) {
          // Générer un nouveau lien d'onboarding pour finaliser la configuration
          const returnUrl = `${process.env.FRONTEND_URL || 'https://newbi.fr'}/dashboard?stripe_success=true`;
          const onboardingResult = await generateOnboardingLink(
            stripeAccount.accountId,
            returnUrl
          );

          return {
            success: true,
            message: 'Finalisation de la configuration Stripe requise',
            isConnected: true,
            canReceivePayments: false,
            onboardingUrl: onboardingResult.success ? onboardingResult.url : null
          };
        }

        return {
          success: true,
          message: canReceivePayments ? 'Stripe Connect configuré' : 'Configuration Stripe incomplète',
          isConnected,
          canReceivePayments,
          onboardingUrl: null
        };

      } catch (error) {
        logger.error('❌ Erreur vérification Stripe Connect parrainage:', error);
        logger.error('❌ Stack trace:', error.stack);
        
        // S'assurer qu'on retourne toujours une réponse valide
        return {
          success: false,
          message: error.message || 'Erreur lors de la vérification Stripe Connect',
          isConnected: false,
          canReceivePayments: false,
          onboardingUrl: null
        };
      }
    },

    // Traiter le virement de parrainage (appelé par le webhook)
    processReferralPayment: async (_, { referralId, amount }) => {
      try {
        // Cette mutation sera appelée par le système webhook
        // Pour l'instant, juste un placeholder
        logger.info('🔄 Traitement virement parrainage', {
          referralId,
          amount
        });

        return {
          success: true,
          message: 'Virement de parrainage traité',
          transferId: null
        };

      } catch (error) {
        logger.error('❌ Erreur traitement virement parrainage:', error);
        return {
          success: false,
          message: error.message || 'Erreur lors du traitement du virement',
          transferId: null
        };
      }
    }
  },

  Query: {
    // Récupérer les statistiques de parrainage de l'utilisateur
    getReferralStats: async (_, __, { user }) => {
      try {
        if (!user) {
          throw new Error('Utilisateur non authentifié');
        }

        // Compter les filleuls
        const referredUsers = await User.countDocuments({ 
          idParrain: user.referralCode 
        });

        // Compter les filleuls avec abonnement actif
        const activeReferrals = await User.countDocuments({ 
          referredBy: user.referralCode,
          'subscription.status': 'active'
        });

        // Calculer les gains via les événements de parrainage
        const referralEvents = await ReferralEvent.aggregate([
          { $match: { referrerId: user._id } },
          {
            $group: {
              _id: '$paymentStatus',
              totalAmount: { $sum: '$amount' },
              count: { $sum: 1 }
            }
          }
        ]);

        let totalEarnings = 0;
        let pendingEarnings = 0;

        referralEvents.forEach(event => {
          if (event._id === 'COMPLETED') {
            totalEarnings += event.totalAmount;
          } else if (event._id === 'PENDING' || event._id === 'PROCESSING') {
            pendingEarnings += event.totalAmount;
          }
        });

        return {
          totalReferrals: referredUsers,
          activeReferrals: activeReferrals,
          totalEarnings,
          pendingEarnings,
          referralCode: user.referralCode || null
        };

      } catch (error) {
        logger.error('❌ Erreur récupération stats parrainage:', error);
        throw new Error('Erreur lors de la récupération des statistiques');
      }
    }
  }
};

export default referralResolvers;
