import stripeConnectService from "../services/stripeConnectService.js";
import StripeConnectAccount from "../models/StripeConnectAccount.js";
import FileTransfer from "../models/FileTransfer.js";
import logger from "../utils/logger.js";
import { checkSubscriptionActive } from "../middlewares/rbac.js";

const stripeConnectResolvers = {
  Query: {
    /**
     * Récupère le compte Stripe Connect de l'organisation active
     */
    myStripeConnectAccount: async (_, args, { user, organizationId }) => {
      if (!user) {
        throw new Error(
          "Vous devez être connecté pour accéder à cette ressource",
        );
      }

      try {
        console.log(
          "🔍 Recherche compte Stripe Connect pour organizationId:",
          organizationId,
        );
        console.log("👤 User email:", user.email);

        // Essayer d'abord avec organizationId (nouveau système)
        let account = null;
        if (organizationId) {
          account = await StripeConnectAccount.findOne({ organizationId });
        }

        // Fallback: Si pas de compte trouvé avec organizationId, essayer avec userId (ancien système)
        if (!account) {
          console.log("⚠️ Fallback: Recherche par userId pour compatibilité");
          account = await StripeConnectAccount.findOne({ userId: user._id });
        }

        console.log("📊 Compte trouvé:", account ? "OUI" : "NON");
        if (account) {
          console.log("✅ Détails (avant mise à jour):", {
            accountId: account.accountId,
            isOnboarded: account.isOnboarded,
            chargesEnabled: account.chargesEnabled,
            organizationId: account.organizationId || "N/A",
            userId: account.userId ? account.userId.toString() : "N/A",
          });

          // Mettre à jour le statut depuis Stripe pour avoir les dernières informations
          console.log("🔄 Mise à jour du statut depuis Stripe...");
          const statusUpdate = await stripeConnectService.checkAccountStatus(
            account.accountId,
          );

          if (statusUpdate.success) {
            console.log("✅ Statut mis à jour:", {
              isOnboarded: statusUpdate.isOnboarded,
              chargesEnabled: statusUpdate.chargesEnabled,
            });

            // Récupérer le compte mis à jour
            account = await StripeConnectAccount.findOne({
              accountId: account.accountId,
            });
          }
        }

        return account;
      } catch (error) {
        logger.error(
          "Erreur lors de la récupération du compte Stripe Connect:",
          error,
        );
        throw new Error(
          `Erreur lors de la récupération du compte Stripe Connect: ${error.message}`,
        );
      }
    },
  },

  Mutation: {
    /**
     * Crée un compte Stripe Connect pour l'organisation
     * Réservé aux owners et admins
     */
    createStripeConnectAccount: async (
      _,
      args,
      { user, organizationId, userRole },
    ) => {
      if (!user) {
        throw new Error(
          "Vous devez être connecté pour créer un compte Stripe Connect",
        );
      }

      if (!organizationId) {
        return {
          success: false,
          message:
            "Aucune organisation active. Veuillez sélectionner une organisation.",
        };
      }

      // Vérifier les permissions (owner ou admin uniquement)
      const normalizedRole = userRole?.toLowerCase();
      if (normalizedRole !== "owner" && normalizedRole !== "admin") {
        return {
          success: false,
          message:
            "Seuls les propriétaires et administrateurs peuvent connecter Stripe Connect",
        };
      }

      try {
        return await stripeConnectService.createConnectAccount(
          organizationId,
          user._id,
        );
      } catch (error) {
        logger.error(
          "Erreur lors de la création du compte Stripe Connect:",
          error,
        );
        return {
          success: false,
          message: `Erreur lors de la création du compte Stripe Connect: ${error.message}`,
        };
      }
    },

    /**
     * Génère un lien d'onboarding pour un compte Stripe Connect
     * Réservé aux owners et admins
     */
    generateStripeOnboardingLink: async (
      _,
      { accountId, returnUrl },
      { user, organizationId, userRole },
    ) => {
      if (!user) {
        throw new Error(
          "Vous devez être connecté pour générer un lien d'onboarding",
        );
      }

      if (!organizationId) {
        return {
          success: false,
          message: "Aucune organisation active",
        };
      }

      // Vérifier les permissions (owner ou admin uniquement)
      const normalizedRole = userRole?.toLowerCase();
      if (normalizedRole !== "owner" && normalizedRole !== "admin") {
        return {
          success: false,
          message:
            "Seuls les propriétaires et administrateurs peuvent accéder à cette fonctionnalité",
        };
      }

      try {
        // Vérifier que le compte appartient bien à l'organisation
        const account = await StripeConnectAccount.findOne({
          accountId,
          organizationId,
        });

        // Fallback: vérifier avec userId pour compatibilité
        if (!account) {
          const accountByUser = await StripeConnectAccount.findOne({
            accountId,
            userId: user._id,
          });
          if (!accountByUser) {
            return {
              success: false,
              message:
                "Compte Stripe Connect non trouvé ou non autorisé pour cette organisation",
            };
          }
        }

        return await stripeConnectService.generateOnboardingLink(
          accountId,
          returnUrl,
        );
      } catch (error) {
        logger.error(
          "Erreur lors de la génération du lien d'onboarding:",
          error,
        );
        return {
          success: false,
          message: `Erreur lors de la génération du lien d'onboarding: ${error.message}`,
        };
      }
    },

    /**
     * Vérifie le statut d'un compte Stripe Connect
     * Réservé aux owners et admins
     */
    checkStripeConnectAccountStatus: async (
      _,
      { accountId },
      { user, organizationId, userRole },
    ) => {
      if (!user) {
        throw new Error(
          "Vous devez être connecté pour vérifier le statut d'un compte",
        );
      }

      if (!organizationId) {
        return {
          success: false,
          message: "Aucune organisation active",
        };
      }

      // Vérifier les permissions (owner ou admin uniquement)
      const normalizedRole = userRole?.toLowerCase();
      if (normalizedRole !== "owner" && normalizedRole !== "admin") {
        return {
          success: false,
          message:
            "Seuls les propriétaires et administrateurs peuvent vérifier le statut",
        };
      }

      try {
        logger.info("🔍 Vérification du statut Stripe Connect:", {
          accountId,
          organizationId,
          userId: user._id,
        });

        // Vérifier que le compte appartient bien à l'organisation
        const account = await StripeConnectAccount.findOne({
          accountId,
          organizationId,
        });

        // Fallback: vérifier avec userId pour compatibilité
        if (!account) {
          const accountByUser = await StripeConnectAccount.findOne({
            accountId,
            userId: user._id,
          });
          if (!accountByUser) {
            logger.warn("❌ Compte Stripe Connect non trouvé");
            return {
              success: false,
              message: "Compte Stripe Connect non trouvé ou non autorisé",
            };
          }
        }

        logger.info("✅ Appel du service checkAccountStatus");
        return await stripeConnectService.checkAccountStatus(accountId);
      } catch (error) {
        logger.error(
          "Erreur lors de la vérification du statut du compte:",
          error,
        );
        return {
          success: false,
          message: `Erreur lors de la vérification du statut du compte: ${error.message}`,
        };
      }
    },

    /**
     * Génère un lien de connexion au tableau de bord Stripe Express
     * Réservé aux owners et admins
     */
    generateStripeDashboardLink: async (
      _,
      { accountId },
      { user, organizationId, userRole },
    ) => {
      if (!user) {
        throw new Error("Vous devez être connecté");
      }

      if (!organizationId) {
        return {
          success: false,
          message: "Aucune organisation active",
        };
      }

      // Vérifier les permissions (owner ou admin uniquement)
      const normalizedRole = userRole?.toLowerCase();
      if (normalizedRole !== "owner" && normalizedRole !== "admin") {
        return {
          success: false,
          message:
            "Seuls les propriétaires et administrateurs peuvent accéder au tableau de bord",
        };
      }

      try {
        // Vérifier que le compte appartient bien à l'organisation
        const account = await StripeConnectAccount.findOne({
          accountId,
          organizationId,
        });

        // Fallback: vérifier avec userId pour compatibilité
        if (!account) {
          const accountByUser = await StripeConnectAccount.findOne({
            accountId,
            userId: user._id,
          });
          if (!accountByUser) {
            return {
              success: false,
              message: "Compte Stripe Connect non trouvé ou non autorisé",
            };
          }
        }

        return await stripeConnectService.generateDashboardLink(accountId);
      } catch (error) {
        logger.error(
          "Erreur lors de la génération du lien de tableau de bord:",
          error,
        );
        return {
          success: false,
          message: `Erreur lors de la génération du lien de tableau de bord: ${error.message}`,
        };
      }
    },

    /**
     * Déconnecte le compte Stripe Connect de l'organisation
     * Réservé aux owners et admins
     */
    disconnectStripe: async (_, args, { user, organizationId, userRole }) => {
      if (!user) {
        throw new Error("Vous devez être connecté");
      }

      if (!organizationId) {
        return {
          success: false,
          message: "Aucune organisation active",
        };
      }

      // Vérifier les permissions (owner ou admin uniquement)
      const normalizedRole = userRole?.toLowerCase();
      if (normalizedRole !== "owner" && normalizedRole !== "admin") {
        return {
          success: false,
          message:
            "Seuls les propriétaires et administrateurs peuvent déconnecter Stripe Connect",
        };
      }

      try {
        const account = await StripeConnectAccount.findOne({ organizationId });

        // Fallback: chercher par userId pour compatibilité
        if (!account) {
          const accountByUser = await StripeConnectAccount.findOne({
            userId: user._id,
          });
          if (!accountByUser) {
            return {
              success: false,
              message:
                "Aucun compte Stripe Connect trouvé pour cette organisation",
            };
          }
          // Supprimer le compte trouvé par userId
          await StripeConnectAccount.deleteOne({ userId: user._id });
        } else {
          // Supprimer le compte
          await StripeConnectAccount.deleteOne({ organizationId });
        }

        return {
          success: true,
          message: "Compte Stripe Connect déconnecté avec succès",
        };
      } catch (error) {
        logger.error("Erreur lors de la déconnexion:", error);
        return {
          success: false,
          message: `Erreur lors de la déconnexion: ${error.message}`,
        };
      }
    },

    /**
     * Crée une session de paiement pour un transfert de fichiers
     */
    createPaymentSessionForFileTransfer: async (
      _,
      { transferId },
      { origin },
    ) => {
      try {
        // Récupérer le transfert de fichiers
        const fileTransfer = await FileTransfer.findById(transferId);
        if (!fileTransfer) {
          return {
            success: false,
            message: "Transfert de fichiers non trouvé",
          };
        }

        if (!fileTransfer.isPaymentRequired || fileTransfer.isPaid) {
          return {
            success: false,
            message:
              "Ce transfert ne nécessite pas de paiement ou a déjà été payé",
          };
        }

        // Récupérer le compte Stripe Connect du propriétaire du transfert
        const stripeConnectAccount = await StripeConnectAccount.findOne({
          userId: fileTransfer.userId,
        });
        if (!stripeConnectAccount) {
          return {
            success: false,
            message:
              "Le propriétaire du transfert n'a pas de compte Stripe Connect configuré",
          };
        }

        // Construire les URLs de succès et d'annulation
        const baseUrl =
          origin || process.env.FRONTEND_URL || "http://localhost:3000";
        const successUrl = `${baseUrl}/transfer/${fileTransfer.shareLink}?key=${fileTransfer.accessKey}&payment_status=success`;
        const cancelUrl = `${baseUrl}/transfer/${fileTransfer.shareLink}?key=${fileTransfer.accessKey}&payment_status=canceled`;

        // Créer la session de paiement
        const result = await stripeConnectService.createPaymentSession(
          fileTransfer,
          stripeConnectAccount.accountId,
          successUrl,
          cancelUrl,
        );

        // Si la création de la session a réussi, mettre à jour le transfert avec l'ID de session
        if (result.success && result.sessionId) {
          fileTransfer.paymentSessionId = result.sessionId;
          fileTransfer.paymentSessionUrl = result.sessionUrl;
          await fileTransfer.save();
        }

        return result;
      } catch (error) {
        logger.error(
          "Erreur lors de la création de la session de paiement:",
          error,
        );
        return {
          success: false,
          message: `Erreur lors de la création de la session de paiement: ${error.message}`,
        };
      }
    },
  },
};

// ✅ Phase A.4 — Subscription check on Stripe Connect mutations (exclude disconnect/status/dashboard/payment)
const STRIPE_CONNECT_BLOCK = [
  "createStripeConnectAccount",
  "generateStripeOnboardingLink",
];
STRIPE_CONNECT_BLOCK.forEach((name) => {
  const original = stripeConnectResolvers.Mutation[name];
  if (original) {
    stripeConnectResolvers.Mutation[name] = async (
      parent,
      args,
      context,
      info,
    ) => {
      await checkSubscriptionActive(context);
      return original(parent, args, context, info);
    };
  }
});

export default stripeConnectResolvers;
