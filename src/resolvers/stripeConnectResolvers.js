import crypto from "crypto";
import mongoose from "mongoose";
import stripeConnectService, {
  deauthorizeStripeAccount,
  isDirectStripeAccount,
} from "../services/stripeConnectService.js";
import StripeConnectAccount from "../models/StripeConnectAccount.js";
import PaypalMerchantAccount from "../models/PaypalMerchantAccount.js";
import FileTransfer from "../models/FileTransfer.js";
import logger from "../utils/logger.js";
import {
  checkSubscriptionActive,
  withOrganization,
} from "../middlewares/rbac.js";
import { levelsAllowLevel } from "../config/rolePermissions.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import { isFeatureEnabled } from "../utils/featureAccess.js";
import { isPaypalConfigured } from "../services/paypalService.js";
import {
  declareBankTransfer,
  getPaymentConnections,
  refreshTransferPayment,
  startOnlinePayment,
} from "../services/transferPaymentService.js";

// Adresse PayPal : forme simple (PayPal vérifie le compte au paiement)
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Moyens d'encaissement : visibles par qui voit les applications ou crée
// des transferts (le formulaire de création en a besoin)
function canSeePaymentConnections(permissionLevels) {
  return (
    levelsAllowLevel(permissionLevels, "integrations", "read") ||
    levelsAllowLevel(permissionLevels, "fileTransfers", "read")
  );
}

const NO_PAYMENT_CONNECTIONS = {
  stripe: {
    connected: false,
    ready: false,
    legacy: false,
    oauthAvailable: false,
    chargesEnabled: false,
    displayName: null,
    accountEmail: null,
  },
  paypal: { available: false, connected: false, email: null },
  bankTransfer: { available: false, ibanLast4: null },
};

// In-memory rate limit for payment session creation
const RATE_LIMIT_IP_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_IP_MAX = 10;
const RATE_LIMIT_TRANSFER_WINDOW = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_TRANSFER_MAX = 5;
const rateLimitIpMap = new Map();
const rateLimitTransferMap = new Map();

// Annonces de virement (« J'ai fait le virement ») : compteurs à part, pour
// ne pas consommer ceux du paiement en ligne
const DECLARATION_TRANSFER_MAX = 10;
const declarationIpMap = new Map();
const declarationTransferMap = new Map();

// Periodic cleanup of expired rate limit entries (every 5 min)
setInterval(
  () => {
    const now = Date.now();
    for (const map of [rateLimitIpMap, declarationIpMap]) {
      for (const [key, entry] of map) {
        if (now - entry.windowStart > RATE_LIMIT_IP_WINDOW) map.delete(key);
      }
    }
    for (const map of [rateLimitTransferMap, declarationTransferMap]) {
      for (const [key, entry] of map) {
        if (now - entry.windowStart > RATE_LIMIT_TRANSFER_WINDOW) {
          map.delete(key);
        }
      }
    }
  },
  5 * 60 * 1000,
).unref();

/**
 * Transfert désigné par la page publique (identifiant + clé d'accès). Null si
 * la clé manque ou ne correspond pas, si l'identifiant est mal formé ou si le
 * transfert n'existe pas : l'appelant répond de la même façon, sans rien
 * révéler.
 */
async function findTransferWithKey(transferId, accessKey) {
  if (!accessKey || typeof accessKey !== "string") return null;
  if (!mongoose.isValidObjectId(transferId)) return null;
  const fileTransfer = await FileTransfer.findById(transferId);
  if (!fileTransfer || !fileTransfer.accessKey) return null;
  // Comparaison à temps constant
  const provided = Buffer.from(accessKey);
  const expected = Buffer.from(fileTransfer.accessKey);
  if (
    provided.length !== expected.length ||
    !crypto.timingSafeEqual(provided, expected)
  ) {
    logger.warn("accessKey mismatch", { transferId });
    return null;
  }
  return fileTransfer;
}

// Connecter, configurer ou synchroniser une application : module
// « Applications et banques » (rôle prédéfini ou personnalisé)
function canManageIntegrations(permissionLevels) {
  return levelsAllowLevel(permissionLevels, "integrations", "write");
}

// Repli de compatibilité par userId : seulement les anciens comptes créés
// avant le rattachement aux espaces (sans organizationId). Un compte rattaché
// à un autre espace, que l'utilisateur a pu quitter, reste hors d'atteinte.
// Même règle que le site (src/lib/stripe-connect-account.js).
function legacyAccountFilter(userId) {
  return { userId, organizationId: { $in: [null, ""] } };
}

function isRateLimited(map, key, windowMs, max) {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    map.set(key, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

function getClientIp(req) {
  if (!req) return "unknown";
  return (
    req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers?.["x-real-ip"] ||
    req.ip ||
    req.connection?.remoteAddress ||
    "unknown"
  );
}

const stripeConnectResolvers = {
  Query: {
    /**
     * Récupère le compte Stripe Connect de l'organisation active
     */
    myStripeConnectAccount: async (_, args, { user, organizationId }) => {
      if (!user) {
        throw new AppError(
          "Vous devez être connecté pour accéder à cette ressource",
          ERROR_CODES.UNAUTHENTICATED,
        );
      }

      try {
        logger.debug(
          `🔍 Recherche compte Stripe Connect pour organizationId: ${organizationId}`,
        );

        // Essayer d'abord avec organizationId (nouveau système)
        let account = null;
        if (organizationId) {
          account = await StripeConnectAccount.findOne({ organizationId });
        }

        // Fallback: ancien système par userId, réservé aux comptes sans
        // organizationId (le compte d'un autre espace reste hors d'atteinte)
        if (!account) {
          logger.debug("⚠️ Fallback: Recherche par userId pour compatibilité");
          account = await StripeConnectAccount.findOne(
            legacyAccountFilter(user._id),
          );
        }

        logger.debug(`📊 Compte trouvé: ${account ? "OUI" : "NON"}`);
        if (account) {
          logger.debug("✅ Détails (avant mise à jour):", {
            accountId: account.accountId,
            isOnboarded: account.isOnboarded,
            chargesEnabled: account.chargesEnabled,
            organizationId: account.organizationId || "N/A",
            userId: account.userId ? account.userId.toString() : "N/A",
          });

          // Mettre à jour le statut depuis Stripe pour avoir les dernières informations
          logger.debug("🔄 Mise à jour du statut depuis Stripe...");
          const statusUpdate = await stripeConnectService.checkAccountStatus(
            account.accountId,
          );

          if (statusUpdate.success) {
            logger.debug("✅ Statut mis à jour:", {
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

    /**
     * Moyens d'encaissement de l'espace actif : compte Stripe, compte
     * PayPal, IBAN (réglages des applications, transferts payants).
     */
    paymentConnections: async (
      _,
      args,
      { user, organizationId, permissionLevels },
    ) => {
      if (!user) {
        throw new AppError(
          "Vous devez être connecté pour accéder à cette ressource",
          ERROR_CODES.UNAUTHENTICATED,
        );
      }
      if (!organizationId) return NO_PAYMENT_CONNECTIONS;
      if (!canSeePaymentConnections(permissionLevels)) {
        throw new AppError(
          "Votre rôle ne permet pas de voir les moyens d'encaissement",
          ERROR_CODES.FORBIDDEN,
        );
      }
      return getPaymentConnections(organizationId);
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
      { user, organizationId, permissionLevels },
    ) => {
      if (!user) {
        throw new AppError(
          "Vous devez être connecté pour créer un compte Stripe Connect",
          ERROR_CODES.UNAUTHENTICATED,
        );
      }

      if (!organizationId) {
        return {
          success: false,
          message:
            "Aucune organisation active. Veuillez sélectionner une organisation.",
        };
      }

      if (!canManageIntegrations(permissionLevels)) {
        return {
          success: false,
          message: "Votre rôle ne permet pas de connecter Stripe Connect",
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
      { user, organizationId, permissionLevels },
    ) => {
      if (!user) {
        throw new AppError(
          "Vous devez être connecté pour générer un lien d'onboarding",
          ERROR_CODES.UNAUTHENTICATED,
        );
      }

      if (!organizationId) {
        return {
          success: false,
          message: "Aucune organisation active",
        };
      }

      if (!canManageIntegrations(permissionLevels)) {
        return {
          success: false,
          message: "Votre rôle ne permet pas d'accéder à cette fonctionnalité",
        };
      }

      try {
        // Vérifier que le compte appartient bien à l'organisation
        const account = await StripeConnectAccount.findOne({
          accountId,
          organizationId,
        });

        // Fallback: ancien compte sans organizationId créé par l'utilisateur
        if (!account) {
          const accountByUser = await StripeConnectAccount.findOne({
            accountId,
            ...legacyAccountFilter(user._id),
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
      { user, organizationId, permissionLevels },
    ) => {
      if (!user) {
        throw new AppError(
          "Vous devez être connecté pour vérifier le statut d'un compte",
          ERROR_CODES.UNAUTHENTICATED,
        );
      }

      if (!organizationId) {
        return {
          success: false,
          message: "Aucune organisation active",
        };
      }

      if (!canManageIntegrations(permissionLevels)) {
        return {
          success: false,
          message: "Votre rôle ne permet pas de vérifier le statut",
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

        // Fallback: ancien compte sans organizationId créé par l'utilisateur
        if (!account) {
          const accountByUser = await StripeConnectAccount.findOne({
            accountId,
            ...legacyAccountFilter(user._id),
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
      { user, organizationId, permissionLevels },
    ) => {
      if (!user) {
        throw new AppError(
          "Vous devez être connecté",
          ERROR_CODES.UNAUTHENTICATED,
        );
      }

      if (!organizationId) {
        return {
          success: false,
          message: "Aucune organisation active",
        };
      }

      if (!canManageIntegrations(permissionLevels)) {
        return {
          success: false,
          message: "Votre rôle ne permet pas d'accéder au tableau de bord",
        };
      }

      try {
        // Vérifier que le compte appartient bien à l'organisation
        const account = await StripeConnectAccount.findOne({
          accountId,
          organizationId,
        });

        // Fallback: ancien compte sans organizationId créé par l'utilisateur
        if (!account) {
          const accountByUser = await StripeConnectAccount.findOne({
            accountId,
            ...legacyAccountFilter(user._id),
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
    disconnectStripe: async (
      _,
      args,
      { user, organizationId, permissionLevels },
    ) => {
      if (!user) {
        throw new AppError(
          "Vous devez être connecté",
          ERROR_CODES.UNAUTHENTICATED,
        );
      }

      if (!organizationId) {
        return {
          success: false,
          message: "Aucune organisation active",
        };
      }

      if (!canManageIntegrations(permissionLevels)) {
        return {
          success: false,
          message: "Votre rôle ne permet pas de déconnecter Stripe Connect",
        };
      }

      try {
        const account = await StripeConnectAccount.findOne({ organizationId });

        // Fallback: ancien compte sans organizationId créé par l'utilisateur
        if (!account) {
          const accountByUser = await StripeConnectAccount.findOne(
            legacyAccountFilter(user._id),
          );
          if (!accountByUser) {
            return {
              success: false,
              message:
                "Aucun compte Stripe Connect trouvé pour cette organisation",
            };
          }
          // Supprimer ce seul compte (pas tous ceux de l'utilisateur)
          await StripeConnectAccount.deleteOne({ _id: accountByUser._id });
        } else {
          // Supprimer le compte
          await StripeConnectAccount.deleteOne({ organizationId });
          // Compte du client connecté par OAuth : Newbi n'y a plus accès
          if (isDirectStripeAccount(account)) {
            await deauthorizeStripeAccount(account.accountId);
          }
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
      { transferId, accessKey, provider },
      { req },
    ) => {
      try {
        // Rate limit: per-IP and per-transfer
        const clientIp = getClientIp(req);
        if (
          isRateLimited(
            rateLimitIpMap,
            clientIp,
            RATE_LIMIT_IP_WINDOW,
            RATE_LIMIT_IP_MAX,
          )
        ) {
          return {
            success: false,
            message: "Too many requests, try again later",
          };
        }
        if (
          isRateLimited(
            rateLimitTransferMap,
            transferId,
            RATE_LIMIT_TRANSFER_WINDOW,
            RATE_LIMIT_TRANSFER_MAX,
          )
        ) {
          return {
            success: false,
            message: "Too many requests, try again later",
          };
        }

        // Clé d'accès exigée : le jeton de retour placé dans les URL de
        // Stripe ramène au transfert (lien et clé), il ne doit être remis
        // qu'à qui détient déjà le lien complet. Transfert absent, identifiant
        // mal formé ou mauvaise clé : même réponse, pour ne rien révéler.
        const fileTransfer = await findTransferWithKey(transferId, accessKey);
        if (!fileTransfer) {
          return { success: false, message: "Invalid credentials" };
        }

        // Transfert expiré ou supprimé : plus payable
        if (fileTransfer.isExpired() || fileTransfer.status !== "active") {
          return {
            success: false,
            message: "Transfer expired",
          };
        }

        if (!fileTransfer.isPaymentRequired || fileTransfer.isPaid) {
          return {
            success: false,
            message:
              "Ce transfert ne nécessite pas de paiement ou a déjà été payé",
          };
        }

        // Paiement créé sur le compte du vendeur (compte Stripe de l'espace
        // connecté par OAuth, ou son compte PayPal) : jeton de retour opaque,
        // le lien et la clé du transfert restent hors des journaux des
        // prestataires
        return await startOnlinePayment(fileTransfer, provider || "stripe", {
          returnOrigin: req?.headers?.origin,
        });
      } catch (error) {
        logger.error(
          "Erreur lors de la création de la session de paiement:",
          error,
        );
        return {
          success: false,
          message:
            "Le paiement n'a pas pu être lancé. Réessayez dans quelques instants.",
        };
      }
    },

    /**
     * « J'ai fait le virement » (page publique, clé d'accès exigée) : le
     * vendeur est prévenu, le payeur peut laisser son e-mail pour recevoir
     * le lien au déblocage. cancel : retire l'annonce.
     */
    declareTransferBankPayment: async (
      _,
      { transferId, accessKey, email, cancel },
      { req },
    ) => {
      const tooMany = {
        success: false,
        message: "Trop de tentatives, réessayez dans quelques minutes.",
      };
      try {
        if (
          isRateLimited(
            declarationIpMap,
            getClientIp(req),
            RATE_LIMIT_IP_WINDOW,
            RATE_LIMIT_IP_MAX,
          ) ||
          isRateLimited(
            declarationTransferMap,
            String(transferId),
            RATE_LIMIT_TRANSFER_WINDOW,
            DECLARATION_TRANSFER_MAX,
          )
        ) {
          return tooMany;
        }

        const fileTransfer = await findTransferWithKey(transferId, accessKey);
        if (!fileTransfer) {
          return { success: false, message: "Lien de transfert invalide." };
        }
        if (fileTransfer.isExpired() || fileTransfer.status !== "active") {
          return { success: false, message: "Ce transfert a expiré." };
        }
        if (!fileTransfer.isPaymentRequired) {
          return {
            success: false,
            message: "Ce transfert ne nécessite pas de paiement.",
          };
        }
        return await declareBankTransfer(fileTransfer, {
          email,
          cancel: cancel === true,
        });
      } catch (error) {
        logger.error("Erreur lors de l'annonce d'un virement:", error);
        return {
          success: false,
          message:
            "Impossible d'enregistrer votre virement. Réessayez dans quelques instants.",
        };
      }
    },

    /**
     * Retour du payeur (Stripe ou PayPal) : paiement vérifié auprès du
     * prestataire, transfert débloqué s'il est payé, lien et clé du
     * transfert renvoyés pour y revenir. Le jeton reste valable jusqu'à son
     * expiration (rechargement de la page de retour).
     */
    confirmTransferPayment: async (
      _,
      { token, provider, sessionId, orderId },
    ) => {
      const invalid = {
        success: false,
        message: "Lien de retour invalide ou expiré",
      };
      try {
        if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token)) {
          return invalid;
        }
        const fileTransfer = await FileTransfer.findOne({
          paymentReturnToken: token,
        });
        if (
          !fileTransfer ||
          (fileTransfer.paymentReturnTokenExpiresAt &&
            new Date() > fileTransfer.paymentReturnTokenExpiresAt)
        ) {
          return invalid;
        }
        if (fileTransfer.isExpired() || fileTransfer.status !== "active") {
          return { success: false, message: "Ce transfert a expiré" };
        }

        const result = await refreshTransferPayment(fileTransfer, {
          force: true,
          provider: ["stripe", "paypal"].includes(provider)
            ? provider
            : undefined,
          sessionId: typeof sessionId === "string" ? sessionId : undefined,
          orderId: typeof orderId === "string" ? orderId : undefined,
        });
        if (!fileTransfer.paymentReturnTokenConsumed) {
          await FileTransfer.updateOne(
            { _id: fileTransfer._id },
            { $set: { paymentReturnTokenConsumed: true } },
          );
        }
        return {
          success: true,
          message: result.message || null,
          status: result.status === "free" ? "paid" : result.status,
          shareLink: fileTransfer.shareLink,
          accessKey: fileTransfer.accessKey,
        };
      } catch (error) {
        logger.error(
          "Erreur à la confirmation d'un paiement de transfert:",
          error,
        );
        return { success: false, message: "Erreur interne" };
      }
    },

    /**
     * Compte PayPal Business de l'espace : son adresse e-mail suffit, PayPal
     * verse l'argent directement sur ce compte.
     */
    connectPaypal: async (
      _,
      { email },
      { user, organizationId, permissionLevels },
    ) => {
      if (!user) {
        throw new AppError(
          "Vous devez être connecté",
          ERROR_CODES.UNAUTHENTICATED,
        );
      }
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!canManageIntegrations(permissionLevels)) {
        return {
          success: false,
          message: "Votre rôle ne permet pas de connecter PayPal",
        };
      }
      if (!isFeatureEnabled("transferPayments", organizationId)) {
        return {
          success: false,
          message:
            "Cette fonctionnalité n'est pas encore disponible pour votre espace.",
        };
      }
      if (!isPaypalConfigured()) {
        return {
          success: false,
          message: "Le paiement par PayPal n'est pas encore disponible.",
        };
      }
      const normalized = String(email || "")
        .trim()
        .toLowerCase();
      if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) {
        return {
          success: false,
          message: "Adresse e-mail PayPal invalide",
        };
      }
      await PaypalMerchantAccount.findOneAndUpdate(
        { organizationId: String(organizationId) },
        {
          $set: { email: normalized, connectedBy: user._id },
          $setOnInsert: { organizationId: String(organizationId) },
        },
        { upsert: true, new: true },
      );
      return {
        success: true,
        message: "Compte PayPal connecté",
        email: normalized,
      };
    },

    disconnectPaypal: async (
      _,
      args,
      { user, organizationId, permissionLevels },
    ) => {
      if (!user) {
        throw new AppError(
          "Vous devez être connecté",
          ERROR_CODES.UNAUTHENTICATED,
        );
      }
      if (!organizationId) {
        return { success: false, message: "Aucune organisation active" };
      }
      if (!canManageIntegrations(permissionLevels)) {
        return {
          success: false,
          message: "Votre rôle ne permet pas de déconnecter PayPal",
        };
      }
      await PaypalMerchantAccount.deleteOne({
        organizationId: String(organizationId),
      });
      return { success: true, message: "Compte PayPal déconnecté" };
    },

    /**
     * Consume a single-use payment return token and return transfer info
     */
    consumePaymentReturnToken: async (_, { token }) => {
      try {
        const fileTransfer = await FileTransfer.findOne({
          paymentReturnToken: token,
          paymentReturnTokenConsumed: { $ne: true },
        });

        if (!fileTransfer) {
          return { success: false, message: "Invalid or already used token" };
        }

        if (
          fileTransfer.paymentReturnTokenExpiresAt &&
          new Date() > fileTransfer.paymentReturnTokenExpiresAt
        ) {
          return { success: false, message: "Token expired" };
        }

        // Mark token as consumed (single-use)
        await FileTransfer.updateOne(
          { _id: fileTransfer._id },
          { $set: { paymentReturnTokenConsumed: true } },
        );

        return {
          success: true,
          shareLink: fileTransfer.shareLink,
          accessKey: fileTransfer.accessKey,
          paymentStatus: fileTransfer.isPaid ? "paid" : "pending",
        };
      } catch (error) {
        logger.error("Error consuming payment return token:", error);
        return { success: false, message: "Internal error" };
      }
    },
  },
};

// ✅ Phase A.4 — Subscription check on Stripe Connect mutations (exclude disconnect/status/dashboard/payment)
const STRIPE_CONNECT_BLOCK = [
  "createStripeConnectAccount",
  "generateStripeOnboardingLink",
  "connectPaypal",
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

// 🔐 Sécurité : envelopper les resolvers Stripe Connect org-scopés dans
// withOrganization (position externe, après le check d'abonnement) pour valider
// l'appartenance à l'organisation en base et remplacer le rôle/l'org lus depuis
// les headers client (x-user-role / x-organization-id) par les valeurs vérifiées
// par RBAC (context.organizationId et context.userRole). Empêche l'escalade de
// rôle et la suppression du Stripe Connect d'une autre organisation.
// createPaymentSessionForFileTransfer / confirmTransferPayment /
// consumePaymentReturnToken / declareTransferBankPayment restent publics
// (paiement par un client externe), donc volontairement non enveloppés.
const STRIPE_CONNECT_ORG_SCOPED_QUERIES = [
  "myStripeConnectAccount",
  "paymentConnections",
];
const STRIPE_CONNECT_ORG_SCOPED_MUTATIONS = [
  "createStripeConnectAccount",
  "generateStripeOnboardingLink",
  "checkStripeConnectAccountStatus",
  "generateStripeDashboardLink",
  "disconnectStripe",
  "connectPaypal",
  "disconnectPaypal",
];
STRIPE_CONNECT_ORG_SCOPED_QUERIES.forEach((name) => {
  const original = stripeConnectResolvers.Query[name];
  if (original) stripeConnectResolvers.Query[name] = withOrganization(original);
});
STRIPE_CONNECT_ORG_SCOPED_MUTATIONS.forEach((name) => {
  const original = stripeConnectResolvers.Mutation[name];
  if (original)
    stripeConnectResolvers.Mutation[name] = withOrganization(original);
});

export default stripeConnectResolvers;
