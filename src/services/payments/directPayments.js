/**
 * Paiements encaissés directement par le vendeur, sans commission Newbi :
 * briques communes aux transferts payants (transferPaymentService.js) et à
 * la billetterie des événements (appointments/eventPaymentService.js).
 *
 * - Stripe : session Checkout créée sur le compte Stripe du vendeur
 *   (rattaché par OAuth), sans application_fee ;
 * - SumUp : paiement créé sur le compte marchand SumUp du vendeur ;
 * - PayPal : commande dont le vendeur est le bénéficiaire (`payee`).
 *
 * Ce module ne sait rien des transferts ni des inscriptions : il crée,
 * ferme, relit et rembourse un paiement. La vérification (montant, devise,
 * référence, compte) reste à l'appelant.
 */
import Stripe from "stripe";
import StripeConnectAccount from "../../models/StripeConnectAccount.js";
import PaypalMerchantAccount from "../../models/PaypalMerchantAccount.js";
import SumupMerchantAccount from "../../models/SumupMerchantAccount.js";
import { isDirectStripeAccount } from "../stripeConnectService.js";
import {
  PaypalApiError,
  createPaypalOrder,
  isPaypalConfigured,
} from "../paypalService.js";
import {
  SumupApiError,
  createSumupCheckout,
  deactivateSumupCheckout,
  isSumupConfigured,
  refundSumupTransaction,
} from "../sumupService.js";
import logger from "../../utils/logger.js";

export const ONLINE_PAYMENT_PROVIDERS = Object.freeze([
  "stripe",
  "sumup",
  "paypal",
]);

let stripeClient = null;
export function getStripe() {
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

/** Montant décimal (12.5) vers centimes (1250). */
export const toCents = (amount) => Math.round(Number(amount || 0) * 100);

export const sameAmount = (a, b) => toCents(a) === toCents(b);

export const workspaceKey = (workspaceId) =>
  workspaceId == null || workspaceId === "" ? null : String(workspaceId);

/** Compte SumUp de l'espace (jetons compris, jamais renvoyé au site). */
export function findSumupAccount(workspaceId) {
  const orgId = workspaceKey(workspaceId);
  return orgId ? SumupMerchantAccount.findOne({ organizationId: orgId }) : null;
}

/** Compte SumUp utilisable pour encaisser (connexion valide). */
export const isSumupAccountReady = (account) =>
  Boolean(account?.merchantCode && account.status !== "reconnect");

/** Compte Stripe direct (OAuth) de l'espace prêt à encaisser, sinon null. */
export async function readyStripeAccount(workspaceId) {
  const orgId = workspaceKey(workspaceId);
  if (!orgId) return null;
  const account = await StripeConnectAccount.findOne({ organizationId: orgId });
  return account && isDirectStripeAccount(account) && account.chargesEnabled
    ? account
    : null;
}

/** Comptes Stripe directs de l'espace (pour relire une session). */
export async function directStripeAccountIds(workspaceId) {
  const orgId = workspaceKey(workspaceId);
  if (!orgId) return [];
  const account = await StripeConnectAccount.findOne({
    organizationId: orgId,
  }).lean();
  return isDirectStripeAccount(account) ? [account.accountId] : [];
}

/**
 * Moyen de paiement non disponible pour l'espace (compte non connecté,
 * à reconnecter, prestataire non configuré). `provider` : le moyen.
 */
export class DirectPaymentUnavailableError extends Error {
  constructor(provider, message = "Moyen de paiement indisponible") {
    super(message);
    this.name = "DirectPaymentUnavailableError";
    this.provider = provider;
  }
}

/**
 * Crée un paiement chez le prestataire, sur le compte du vendeur.
 *
 * @param {object} params
 * @param {"stripe"|"sumup"|"paypal"} params.provider
 * @param {string} params.workspaceId - espace du vendeur
 * @param {number} params.amount - montant décimal (12.5 = 12,50 €)
 * @param {string} params.currency
 * @param {string} params.name - libellé principal
 * @param {string} params.description - précision (nombre de fichiers, places…)
 * @param {object} params.metadata - métadonnées Stripe (session et paiement)
 * @param {string} params.returnUrl - retour du payeur
 * @param {string} params.cancelUrl - abandon (Stripe, PayPal)
 * @param {number} params.stripeExpiresAt - fin de la session Stripe (secondes)
 * @param {string} params.idempotencyKey - clé Stripe et PayPal-Request-Id
 * @param {string} params.sumupReference - checkout_reference SumUp
 * @param {string} params.paypalCustomId - custom_id de la commande PayPal
 * @param {string|null} params.brandName - nom affiché par PayPal
 * @returns {Promise<{ attempt: object, url: string }>}
 * @throws {DirectPaymentUnavailableError|SumupApiError|PaypalApiError|Error}
 */
export async function createDirectCheckout({
  provider,
  workspaceId,
  amount,
  currency = "EUR",
  name,
  description,
  metadata,
  returnUrl,
  cancelUrl,
  stripeExpiresAt,
  idempotencyKey,
  sumupReference,
  paypalCustomId,
  brandName = null,
}) {
  const orgId = workspaceKey(workspaceId);
  if (provider === "stripe") {
    const account = await readyStripeAccount(orgId);
    if (!account) throw new DirectPaymentUnavailableError("stripe");
    const session = await getStripe().checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: String(currency || "EUR").toLowerCase(),
              unit_amount: toCents(amount),
              product_data: { name, description },
            },
          },
        ],
        success_url: `${returnUrl}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelUrl,
        locale: "fr",
        expires_at: stripeExpiresAt,
        metadata,
        payment_intent_data: { metadata, description: name },
      },
      { stripeAccount: account.accountId, idempotencyKey },
    );
    return {
      attempt: {
        provider: "stripe",
        reference: session.id,
        accountId: account.accountId,
        status: "open",
        createdAt: new Date(),
      },
      url: session.url,
    };
  }

  if (provider === "sumup") {
    const account = await findSumupAccount(orgId);
    if (!isSumupConfigured() || !isSumupAccountReady(account)) {
      throw new DirectPaymentUnavailableError("sumup");
    }
    const checkout = await createSumupCheckout(account, {
      reference: sumupReference,
      amount,
      currency: currency || "EUR",
      description: `${name} (${description})`,
      redirectUrl: returnUrl,
    });
    if (!checkout?.id || !checkout.url) {
      throw new SumupApiError("Paiement SumUp sans page de paiement");
    }
    return {
      attempt: {
        provider: "sumup",
        reference: checkout.id,
        accountId: account.merchantCode,
        status: "open",
        createdAt: new Date(),
      },
      url: checkout.url,
    };
  }

  if (provider === "paypal") {
    const merchant = orgId
      ? await PaypalMerchantAccount.findOne({ organizationId: orgId }).lean()
      : null;
    if (!isPaypalConfigured() || !merchant?.email) {
      throw new DirectPaymentUnavailableError("paypal");
    }
    const order = await createPaypalOrder({
      amount,
      currency: currency || "EUR",
      payeeEmail: merchant.email,
      description: `${name} (${description})`,
      customId: paypalCustomId,
      brandName,
      returnUrl,
      cancelUrl,
      requestId: idempotencyKey,
    });
    if (!order?.id || !order.approveUrl) {
      throw new PaypalApiError("Commande PayPal sans adresse de paiement");
    }
    return {
      attempt: {
        provider: "paypal",
        reference: order.id,
        status: "open",
        createdAt: new Date(),
      },
      url: order.approveUrl,
    };
  }

  throw new DirectPaymentUnavailableError(
    provider,
    "Moyen de paiement inconnu",
  );
}

/**
 * Ferme un paiement encore ouvert (session Stripe expirée, paiement SumUp
 * désactivé) pour qu'il ne puisse plus être payé. PayPal : rien à faire
 * (une commande non approuvée expire seule). Jamais d'erreur.
 */
export async function closeDirectCheckout(attempt, workspaceId, logPrefix) {
  if (attempt?.provider === "sumup" && attempt.reference) {
    try {
      const account = await findSumupAccount(workspaceId);
      if (account) await deactivateSumupCheckout(account, attempt.reference);
    } catch (error) {
      logger.warn(
        `${logPrefix} Paiement SumUp ${attempt.reference} non fermé : ${error.message}`,
      );
    }
    return;
  }
  if (attempt?.provider !== "stripe" || !attempt.reference) return;
  if (!attempt.accountId) return;
  try {
    const session = await getStripe().checkout.sessions.retrieve(
      attempt.reference,
      { stripeAccount: attempt.accountId },
    );
    if (session?.status === "open") {
      await getStripe().checkout.sessions.expire(attempt.reference, {
        stripeAccount: attempt.accountId,
      });
    }
  } catch (error) {
    logger.warn(
      `${logPrefix} Session ${attempt.reference} non expirée : ${error.message}`,
    );
  }
}

/**
 * Relit une session Checkout sur l'un des comptes Stripe donnés.
 * @returns {Promise<{ session: object, accountId: string }|null>}
 */
export async function retrieveStripeSession(reference, accountIds, logPrefix) {
  for (const accountId of accountIds) {
    try {
      const session = await getStripe().checkout.sessions.retrieve(reference, {
        stripeAccount: accountId,
      });
      return { session, accountId };
    } catch (error) {
      // Session inconnue sur ce compte : essayer le suivant
      if (error?.code !== "resource_missing") {
        logger.warn(
          `${logPrefix} Session ${reference} illisible sur ${accountId} : ${error.message}`,
        );
      }
    }
  }
  return null;
}

/**
 * Rembourse un paiement en ligne sur le compte du vendeur.
 * Stripe : PaymentIntent `pi_…` ; SumUp : transaction (`refundReference`).
 * PayPal : non pris en charge (à rembourser à la main).
 * @returns {Promise<boolean>} true si le remboursement est parti
 * @throws {Error} échec du prestataire
 */
export async function refundDirectPayment({
  provider,
  paymentId,
  accountId,
  refundReference,
  workspaceId,
  metadata,
  idempotencyKey,
  reason = "duplicate",
}) {
  if (provider === "sumup" && refundReference) {
    const account = await findSumupAccount(workspaceId);
    if (!account) return false;
    await refundSumupTransaction(account, refundReference);
    return true;
  }
  if (provider === "stripe" && accountId && paymentId?.startsWith("pi_")) {
    await getStripe().refunds.create(
      {
        payment_intent: paymentId,
        ...(reason ? { reason } : {}),
        metadata,
      },
      { stripeAccount: accountId, idempotencyKey },
    );
    return true;
  }
  return false;
}
