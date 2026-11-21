import dotenv from "dotenv";
dotenv.config();

import Stripe from "stripe";
import logger from "../utils/logger.js";
import StripeConnectAccount from "../models/StripeConnectAccount.js";
import { creditedTTC } from "../utils/invoiceCredit.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---------------------------------------------------------------------------
// Compte Stripe du client rattaché par OAuth
// ---------------------------------------------------------------------------
//
// Le client connecte son propre compte Stripe (existant ou créé pendant le
// parcours) : les paiements sont créés directement sur son compte (direct
// charges), Stripe lui facture ses frais, et rien ne passe par le compte de
// Newbi, qui ne prend aucune commission. L'ancien parcours (compte Express
// créé par Newbi, destination charges) reste en place pour les espaces qui
// l'utilisent déjà.
//
// Prérequis : OAuth activé dans les réglages Connect du compte Stripe de
// Newbi, STRIPE_CONNECT_CLIENT_ID (ca_…, différent en test et en
// production) et l'adresse de retour déclarée chez Stripe :
// <API>/stripe-connect/callback.

/** Compte rattaché par OAuth : paiements créés sur le compte du client. */
export const isDirectStripeAccount = (account) =>
  account?.connectionType === "oauth";

export function isStripeOAuthConfigured(env = process.env) {
  return Boolean(env.STRIPE_CONNECT_CLIENT_ID && env.STRIPE_SECRET_KEY);
}

/** Adresse publique de l'API, sans barre finale. */
export function apiPublicUrl(env = process.env) {
  return String(
    env.API_URL ||
      env.NEXT_PUBLIC_API_URL ||
      env.BACKEND_URL ||
      "http://localhost:4000",
  ).replace(/\/+$/, "");
}

export function stripeOAuthRedirectUri(env = process.env) {
  return (
    env.STRIPE_CONNECT_REDIRECT_URI ||
    `${apiPublicUrl(env)}/stripe-connect/callback`
  );
}

/** Adresse de la page Stripe où le client autorise Newbi. */
export function buildStripeOAuthUrl({ state, email, businessName }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.STRIPE_CONNECT_CLIENT_ID,
    scope: "read_write",
    redirect_uri: stripeOAuthRedirectUri(),
    state,
  });
  // Formulaire d'inscription prérempli pour qui n'a pas encore de compte
  if (email) params.set("stripe_user[email]", email);
  if (businessName) params.set("stripe_user[business_name]", businessName);
  params.set("stripe_user[country]", "FR");
  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}

export async function exchangeStripeOAuthCode(code) {
  return stripe.oauth.token({ grant_type: "authorization_code", code });
}

/** Retire à Newbi l'accès au compte du client (déconnexion). */
export async function deauthorizeStripeAccount(accountId) {
  if (!process.env.STRIPE_CONNECT_CLIENT_ID || !accountId) return false;
  try {
    await stripe.oauth.deauthorize({
      client_id: process.env.STRIPE_CONNECT_CLIENT_ID,
      stripe_user_id: accountId,
    });
    return true;
  } catch (error) {
    // Déjà retiré côté Stripe (le client l'a fait lui-même) : rien à faire
    logger.warn(
      `[stripe-connect] Déconnexion OAuth de ${accountId} non confirmée : ${error.message}`,
    );
    return false;
  }
}

/** Champs enregistrés d'un compte Stripe (objet `account` de l'API). */
export function describeStripeAccount(stripeAccount) {
  return {
    chargesEnabled: Boolean(stripeAccount?.charges_enabled),
    payoutsEnabled: Boolean(stripeAccount?.payouts_enabled),
    isOnboarded: Boolean(
      stripeAccount?.details_submitted && stripeAccount?.charges_enabled,
    ),
    displayName:
      stripeAccount?.settings?.dashboard?.display_name ||
      stripeAccount?.business_profile?.name ||
      null,
    accountEmail: stripeAccount?.email || null,
  };
}

/**
 * Rattache à l'espace le compte autorisé par OAuth. Un compte déjà rattaché
 * à un autre espace est refusé ; l'ancien compte Express de l'espace est
 * remplacé (gardé en trace).
 * @returns {Promise<{ok: true, account: object}|{ok: false, error: string}>}
 */
export async function saveOAuthConnection({
  organizationId,
  userId,
  accountId,
  livemode,
}) {
  const elsewhere = await StripeConnectAccount.findOne({
    accountId,
    organizationId: { $nin: [organizationId] },
  }).lean();
  if (elsewhere) return { ok: false, error: "already_connected" };

  const stripeAccount = await stripe.accounts.retrieve(accountId);
  const fields = {
    ...describeStripeAccount(stripeAccount),
    accountId,
    connectionType: "oauth",
    livemode: Boolean(livemode),
    connectedBy: userId || undefined,
    connectedAt: new Date(),
  };

  const existing = await StripeConnectAccount.findOne({ organizationId });
  if (existing) {
    if (existing.accountId !== accountId && !isDirectStripeAccount(existing)) {
      fields.replacedAccountId = existing.accountId;
    }
    const previousOAuthAccount =
      isDirectStripeAccount(existing) && existing.accountId !== accountId
        ? existing.accountId
        : null;
    Object.assign(existing, fields);
    await existing.save();
    // Autre compte Stripe du client connecté à la place : l'ancien accès est
    // retiré
    if (previousOAuthAccount) {
      await deauthorizeStripeAccount(previousOAuthAccount);
    }
    return { ok: true, account: existing };
  }

  const account = await StripeConnectAccount.create({
    organizationId,
    userId: userId || undefined,
    ...fields,
  });
  return { ok: true, account };
}

/** Mise à jour depuis un événement account.updated (compte connecté). */
export async function syncStripeAccountFromEvent(stripeAccount) {
  if (!stripeAccount?.id) return { status: "ignored" };
  const result = await StripeConnectAccount.updateOne(
    { accountId: stripeAccount.id },
    { $set: describeStripeAccount(stripeAccount) },
  );
  return {
    status: result.matchedCount ? "success" : "ignored",
    message: result.matchedCount
      ? "Compte Stripe mis à jour"
      : "Compte inconnu",
  };
}

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

      // Fallback: ancien compte de l'utilisateur sans organizationId. Un
      // compte rattaché à un autre espace ne doit pas être réutilisé ici.
      if (!existingAccount && userId) {
        existingAccount = await StripeConnectAccount.findOne({
          userId,
          organizationId: { $in: [null, ""] },
        });
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
        { new: true },
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
        error,
      );
      return {
        success: false,
        message: `Erreur lors de la génération du lien de tableau de bord: ${error.message}`,
      };
    }
  },

  // Paiement des transferts de fichiers : voir transferPaymentService.js
  // (session créée sur le compte Stripe du client, sans commission). L'ancienne
  // session à 10 % de commission sur le compte de Newbi est retirée.

  /**
   * Crée une session de paiement Stripe Checkout pour une facture Newbi.
   * Encaissement direct sur le compte Stripe Connect du vendeur (destination charge),
   * SANS commission Newbi (contrairement aux transferts de fichiers).
   * @param {Object} invoice - Document Invoice (Mongoose)
   * @param {string} accountId - ID du compte Stripe Connect du vendeur
   * @param {string} successUrl - URL de succès après paiement
   * @param {string} cancelUrl - URL d'annulation
   * @returns {Promise<Object>} - { success, sessionId, sessionUrl }
   */
  async createInvoicePaymentSession(invoice, accountId, successUrl, cancelUrl) {
    try {
      const account = await StripeConnectAccount.findOne({ accountId });
      if (!account || !account.chargesEnabled) {
        return {
          success: false,
          message:
            "Le compte Stripe Connect n'est pas configuré pour recevoir des paiements",
        };
      }

      // Reste à payer : le TTC moins les avoirs émis sur la facture (un
      // avoir partiel ne laisse payer que la différence)
      const credited = await creditedTTC(invoice);
      const amount = Math.max(
        0,
        Math.round((invoice.finalTotalTTC || 0) * 100) -
          Math.round(credited * 100),
      ); // centimes
      if (!amount || amount <= 0) {
        return {
          success: false,
          message: "Montant de facture invalide pour un paiement en ligne",
        };
      }

      const invoiceLabel = `${invoice.prefix || ""}${invoice.number}`;
      const metadata = {
        invoiceId: invoice._id.toString(),
        workspaceId: invoice.workspaceId.toString(),
        type: "invoice_payment",
      };

      const sessionParams = {
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "eur",
              product_data: {
                name: `Facture ${invoiceLabel}`,
                description:
                  [
                    invoice.client?.name
                      ? `Paiement pour ${invoice.client.name}`
                      : null,
                    credited > 0 ? "reste à payer après avoir" : null,
                  ]
                    .filter(Boolean)
                    .join(", ") || undefined,
              },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: successUrl,
        cancel_url: cancelUrl,
        // Compte Stripe du client (connexion OAuth) : le paiement est créé
        // sur son compte, frais Stripe à sa charge, rien ne passe par le
        // compte de Newbi. Ancien compte Express : destination charge SANS
        // application_fee_amount (100 % au vendeur, frais payés par Newbi).
        payment_intent_data: isDirectStripeAccount(account)
          ? { metadata }
          : {
              transfer_data: {
                destination: accountId,
              },
              metadata,
            },
        metadata,
      };
      const session = isDirectStripeAccount(account)
        ? await stripe.checkout.sessions.create(sessionParams, {
            stripeAccount: accountId,
          })
        : await stripe.checkout.sessions.create(sessionParams);

      return {
        success: true,
        sessionId: session.id,
        sessionUrl: session.url,
        direct: isDirectStripeAccount(account),
        message: "Session de paiement créée avec succès",
      };
    } catch (error) {
      logger.error(
        "Erreur lors de la création de la session de paiement facture:",
        error,
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
    metadata = {},
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
        error,
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
  createInvoicePaymentSession,
  transferToStripeConnect,
} = stripeConnectService;
