/**
 * Transferts de fichiers payants.
 *
 * L'argent va directement au vendeur, jamais par le compte de Newbi :
 * - carte : session Stripe Checkout créée sur le compte Stripe du vendeur,
 *   rattaché par OAuth (frais Stripe à sa charge) ;
 * - PayPal : commande dont le vendeur est le bénéficiaire (frais PayPal à sa
 *   charge) ;
 * - virement : IBAN de l'entreprise et référence affichés au destinataire,
 *   le vendeur débloque le transfert lui-même (« Marquer comme payé »).
 * Newbi ne prend aucune commission.
 *
 * Le transfert est débloqué (`isPaid`) dès que le paiement est vérifié
 * auprès du prestataire : au retour du payeur, par le webhook Stripe des
 * comptes connectés, ou à la visite suivante de la page du transfert. Le
 * webhook accélère, il n'est pas indispensable.
 */
import crypto from "crypto";
import mongoose from "mongoose";
import Stripe from "stripe";
import { UserInputError } from "apollo-server-express";
import FileTransfer from "../models/FileTransfer.js";
import StripeConnectAccount from "../models/StripeConnectAccount.js";
import PaypalMerchantAccount from "../models/PaypalMerchantAccount.js";
import Notification from "../models/Notification.js";
import User from "../models/User.js";
import logger from "../utils/logger.js";
import {
  featureUnavailableError,
  isFeatureEnabled,
} from "../utils/featureAccess.js";
import {
  isDirectStripeAccount,
  isStripeOAuthConfigured,
} from "./stripeConnectService.js";
import {
  PaypalApiError,
  capturePaypalOrder,
  createPaypalOrder,
  getPaypalCapture,
  getPaypalOrder,
  isPaypalConfigured,
  isPaypalId,
  summarizePaypalOrder,
} from "./paypalService.js";
import { buildTransferPaidEmail } from "../utils/transferPaymentEmails.js";
import { createOriginChecker } from "../utils/corsOrigins.js";
import { sendRenderedEmail } from "../utils/trialEmails.js";

export const TRANSFER_PAYMENT_METHODS = Object.freeze([
  "stripe",
  "paypal",
  "bank_transfer",
]);
export const ONLINE_PAYMENT_PROVIDERS = Object.freeze(["stripe", "paypal"]);

// Lien de retour du payeur (jeton opaque) : valable une heure
export const PAYMENT_RETURN_TTL_MS = 60 * 60 * 1000;
// Session Stripe : durée minimale imposée par Stripe (30 min), alignée sur
// le jeton de retour
const STRIPE_SESSION_TTL_S = 60 * 60;
// Vérification auprès du prestataire à la visite de la page : au plus une
// fois par intervalle, pour ne pas solliciter Stripe ou PayPal à chaque
// rafraîchissement
const RECHECK_INTERVAL_MS = 15 * 1000;
// Même forcée (retour du payeur), une vérification par transfert au plus
// toutes les quelques secondes
const FORCED_RECHECK_INTERVAL_MS = 3 * 1000;

let stripeClient = null;
function getStripe() {
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

const frontendUrl = (env = process.env) =>
  String(env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");

/**
 * Site où revient le payeur après Stripe ou PayPal. En production : toujours
 * FRONTEND_URL. Hors production : le site d'où le paiement a été lancé
 * (en-tête Origin) s'il fait partie des origines autorisées, car un
 * FRONTEND_URL réglé sur l'adresse réseau du poste (tests sur téléphone)
 * renverrait le payeur sur une adresse d'où le navigateur bloque les appels
 * à l'API locale.
 */
export function paymentReturnBase(origin, env = process.env) {
  if (env.NODE_ENV !== "production" && typeof origin === "string" && origin) {
    const isAllowed = createOriginChecker({
      nodeEnv: env.NODE_ENV,
      frontendUrl: env.FRONTEND_URL,
      partnerFrontendUrl: env.PARTNER_FRONTEND_URL,
    });
    if (isAllowed(origin)) return origin.replace(/\/+$/, "");
  }
  return frontendUrl(env);
}

const toCents = (amount) => Math.round(Number(amount || 0) * 100);

const sameAmount = (a, b) => toCents(a) === toCents(b);

const workspaceKey = (workspaceId) =>
  workspaceId == null || workspaceId === "" ? null : String(workspaceId);

/** Moyens proposés par un transfert (anciens transferts : carte seule). */
export function transferPaymentMethods(transfer) {
  if (!transfer?.isPaymentRequired) return [];
  const methods = Array.isArray(transfer.paymentMethods)
    ? transfer.paymentMethods.filter((m) =>
        TRANSFER_PAYMENT_METHODS.includes(m),
      )
    : [];
  return methods.length ? methods : ["stripe"];
}

export function normalizeIban(value) {
  const iban = String(value || "")
    .replace(/\s+/g, "")
    .toUpperCase();
  return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{8,30}$/.test(iban) ? iban : null;
}

/** IBAN lisible : groupes de quatre caractères. */
export const formatIban = (iban) => iban.replace(/(.{4})/g, "$1 ").trim();

async function loadOrganization(workspaceId) {
  const id = workspaceKey(workspaceId);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  const db = mongoose.connection?.db;
  if (!db) return null;
  return db.collection("organization").findOne(
    { _id: new mongoose.Types.ObjectId(id) },
    {
      projection: {
        name: 1,
        companyName: 1,
        bankIban: 1,
        bankBic: 1,
        bankName: 1,
      },
    },
  );
}

/** Nom affiché au payeur : raison sociale, sinon nom de l'espace. */
export async function getSellerName(workspaceId) {
  const organization = await loadOrganization(workspaceId);
  return organization?.companyName || organization?.name || null;
}

/**
 * Moyens d'encaissement de l'espace (réglages, formulaire de création).
 */
export async function getPaymentConnections(workspaceId) {
  const orgId = workspaceKey(workspaceId);
  const [stripeAccount, paypalAccount, organization] = await Promise.all([
    orgId
      ? StripeConnectAccount.findOne({ organizationId: orgId }).lean()
      : null,
    orgId
      ? PaypalMerchantAccount.findOne({ organizationId: orgId }).lean()
      : null,
    loadOrganization(orgId),
  ]);
  const featureOpen = orgId
    ? isFeatureEnabled("transferPayments", orgId)
    : false;
  const direct = isDirectStripeAccount(stripeAccount);
  const iban = normalizeIban(organization?.bankIban);
  return {
    stripe: {
      connected: Boolean(stripeAccount),
      ready: Boolean(stripeAccount && direct && stripeAccount.chargesEnabled),
      legacy: Boolean(stripeAccount && !direct),
      oauthAvailable: isStripeOAuthConfigured() && featureOpen,
      chargesEnabled: Boolean(stripeAccount?.chargesEnabled),
      displayName: stripeAccount?.displayName || null,
      accountEmail: stripeAccount?.accountEmail || null,
    },
    paypal: {
      available: isPaypalConfigured() && featureOpen,
      connected: Boolean(paypalAccount),
      email: paypalAccount?.email || null,
    },
    bankTransfer: {
      available: Boolean(iban),
      ibanLast4: iban ? iban.slice(-4) : null,
    },
  };
}

const UNAVAILABLE_MESSAGES = {
  stripe:
    "Connectez votre compte Stripe (Paramètres > Applications) pour accepter les paiements par carte.",
  paypal:
    "Connectez votre compte PayPal (Paramètres > Applications) pour accepter PayPal.",
  bank_transfer:
    "Renseignez l'IBAN de votre entreprise (Paramètres > Entreprise) pour proposer le virement.",
};

/**
 * Moyens d'un nouveau transfert payant, vérifiés : sans précision, tous ceux
 * que l'espace peut proposer.
 */
export async function resolveTransferPaymentMethods(workspaceId, requested) {
  const connections = await getPaymentConnections(workspaceId);
  const available = {
    stripe: connections.stripe.ready,
    paypal: connections.paypal.available && connections.paypal.connected,
    bank_transfer: connections.bankTransfer.available,
  };
  const wanted = requested?.length
    ? requested
    : TRANSFER_PAYMENT_METHODS.filter((method) => available[method]);
  if (!wanted.length) {
    throw new UserInputError(
      "Connectez Stripe ou PayPal, ou renseignez l'IBAN de votre entreprise, pour demander un paiement.",
    );
  }
  const unavailable = wanted.find((method) => !available[method]);
  if (unavailable) throw new UserInputError(UNAVAILABLE_MESSAGES[unavailable]);
  return wanted;
}

// Référence de virement : sans 0/O ni 1/I pour éviter les erreurs de saisie
const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generatePaymentReference() {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += REFERENCE_ALPHABET[crypto.randomInt(REFERENCE_ALPHABET.length)];
  }
  return `NB-${code}`;
}

/**
 * Options de paiement d'un nouveau transfert (création) : espace requis,
 * fonctionnalité ouverte à l'espace, pas de filigrane (le destinataire ne
 * pourrait jamais télécharger), moyens disponibles.
 */
export async function prepareTransferPayment({
  workspaceId,
  isPaymentRequired,
  paymentMethods,
  hasWatermark,
}) {
  if (!isPaymentRequired) return {};
  const orgId = workspaceKey(workspaceId);
  if (!orgId) {
    throw new UserInputError(
      "Un transfert payant doit être créé depuis un espace.",
    );
  }
  if (!isFeatureEnabled("transferPayments", orgId)) {
    throw featureUnavailableError();
  }
  if (hasWatermark) {
    throw new UserInputError(
      "Le paiement n'est pas compatible avec le filigrane : le destinataire ne pourrait pas télécharger les fichiers après avoir payé.",
    );
  }
  const methods = await resolveTransferPaymentMethods(orgId, paymentMethods);
  return {
    paymentMethods: methods,
    paymentReference: methods.includes("bank_transfer")
      ? generatePaymentReference()
      : undefined,
  };
}

/** Coordonnées de virement montrées au payeur (transfert non payé). */
export async function getBankTransferDetails(transfer) {
  if (
    !transfer?.isPaymentRequired ||
    transfer.isPaid ||
    !transferPaymentMethods(transfer).includes("bank_transfer")
  ) {
    return null;
  }
  const organization = await loadOrganization(transfer.workspaceId);
  const iban = normalizeIban(organization?.bankIban);
  if (!iban) return null;
  return {
    holder: organization?.companyName || organization?.name || null,
    iban: formatIban(iban),
    bic: organization?.bankBic ? String(organization.bankBic).trim() : null,
    bankName: organization?.bankName || null,
    reference: transfer.paymentReference || null,
  };
}

// ---------------------------------------------------------------------------
// Déblocage
// ---------------------------------------------------------------------------

function definedOnly(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  );
}

/**
 * Marque le transfert payé, une seule fois (mise à jour atomique : un même
 * paiement vu au retour et au webhook ne compte qu'une fois). Un second
 * paiement en ligne d'un transfert déjà payé est remboursé (Stripe).
 * @returns {Promise<{status: "paid", transfer: object, newlyPaid: boolean, duplicate?: boolean}>}
 */
export async function markTransferPaid(
  transfer,
  { provider, paymentId, amount, currency, payerEmail, accountId, markedBy },
) {
  const updated = await FileTransfer.findOneAndUpdate(
    { _id: transfer._id, isPaid: { $ne: true } },
    {
      $set: definedOnly({
        isPaid: true,
        paymentId: paymentId || undefined,
        paymentDate: new Date(),
        paymentProvider: provider,
        paidAmount: amount,
        paidCurrency: currency ? String(currency).toUpperCase() : undefined,
        payerEmail: payerEmail || undefined,
        paymentMarkedBy: markedBy || undefined,
      }),
    },
    { new: true },
  );

  if (updated) {
    logger.info(
      `[transfer-payment] Transfert ${updated._id} payé (${provider}, ${amount} ${currency || ""})`,
    );
    if (provider !== "manual") {
      await notifyTransferPaid(updated).catch((error) =>
        logger.error(
          `[transfer-payment] Notification du paiement de ${updated._id} : ${error.message}`,
        ),
      );
    }
    return { status: "paid", transfer: updated, newlyPaid: true };
  }

  const current = await FileTransfer.findById(transfer._id);
  const duplicate =
    provider !== "manual" &&
    Boolean(paymentId) &&
    current?.paymentId !== paymentId;
  if (duplicate) {
    await refundDuplicatePayment({
      transfer: current,
      provider,
      paymentId,
      accountId,
    });
  }
  return { status: "paid", transfer: current, newlyPaid: false, duplicate };
}

async function refundDuplicatePayment({
  transfer,
  provider,
  paymentId,
  accountId,
}) {
  if (provider === "stripe" && accountId && paymentId?.startsWith("pi_")) {
    try {
      await getStripe().refunds.create(
        {
          payment_intent: paymentId,
          reason: "duplicate",
          metadata: {
            type: "file_transfer",
            fileTransferId: String(transfer._id),
          },
        },
        { stripeAccount: accountId, idempotencyKey: `dup-refund-${paymentId}` },
      );
      logger.warn(
        `[transfer-payment] Second paiement ${paymentId} du transfert ${transfer._id} remboursé`,
      );
      return;
    } catch (error) {
      logger.error(
        `[transfer-payment] ANOMALIE : second paiement ${paymentId} du transfert ${transfer._id} non remboursé (${error.message}) : à rembourser depuis le compte Stripe ${accountId}`,
      );
      return;
    }
  }
  logger.error(
    `[transfer-payment] ANOMALIE : second paiement ${provider} ${paymentId} reçu pour le transfert ${transfer._id} déjà payé : à rembourser`,
  );
}

/** « Marquer comme payé » par l'expéditeur (virement, espèces…). */
export async function markTransferPaidManually(transfer, userId) {
  const result = await markTransferPaid(transfer, {
    provider: "manual",
    amount: transfer.paymentAmount,
    currency: transfer.paymentCurrency,
    markedBy: userId,
  });
  // Paiement en ligne encore ouvert : plus payable
  if (result.newlyPaid) await closeOpenAttempt(transfer);
  return result;
}

// ---------------------------------------------------------------------------
// Paiement en ligne
// ---------------------------------------------------------------------------

const fail = (message) => ({ success: false, message });

async function closeOpenAttempt(transfer) {
  const attempt = transfer?.paymentAttempt;
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
      `[transfer-payment] Session ${attempt.reference} non expirée : ${error.message}`,
    );
  }
}

function paymentLabel(transfer) {
  const count = transfer.files?.length || 0;
  return {
    name: transfer.title
      ? `Transfert : ${String(transfer.title).slice(0, 200)}`
      : "Transfert de fichiers",
    description: `${count} fichier${count > 1 ? "s" : ""}`,
  };
}

/**
 * Lance un paiement en ligne (le transfert doit être actif, payant, non payé,
 * accès vérifié par l'appelant). `returnOrigin` : en-tête Origin de la page
 * du payeur (voir paymentReturnBase).
 * @returns {Promise<{success: boolean, message?: string, sessionId?: string, sessionUrl?: string}>}
 */
export async function startOnlinePayment(
  transfer,
  provider,
  { returnOrigin } = {},
) {
  if (!ONLINE_PAYMENT_PROVIDERS.includes(provider)) {
    return fail("Moyen de paiement inconnu");
  }
  if (!transferPaymentMethods(transfer).includes(provider)) {
    return fail(
      provider === "paypal"
        ? "Le paiement par PayPal n'est pas proposé pour ce transfert."
        : "Le paiement par carte n'est pas proposé pour ce transfert.",
    );
  }

  // Paiement précédent peut-être abouti (autre onglet) : vérifié d'abord
  if (transfer.paymentAttempt?.reference) {
    const previous = await refreshTransferPayment(transfer, { force: true });
    if (previous.status === "paid") {
      return fail("Ce transfert est déjà payé.");
    }
    if (previous.status === "pending") {
      return fail(
        "Un paiement est en cours de confirmation pour ce transfert. Réessayez dans quelques minutes.",
      );
    }
    await closeOpenAttempt(transfer);
  }

  const orgId = workspaceKey(transfer.workspaceId);
  const returnToken = crypto.randomBytes(16).toString("hex");
  const back = `${paymentReturnBase(returnOrigin)}/transfer/return?rt=${returnToken}&provider=${provider}`;
  const { name, description } = paymentLabel(transfer);
  const metadata = {
    type: "file_transfer",
    fileTransferId: String(transfer._id),
    workspaceId: orgId || "",
  };

  let attempt;
  let url;
  try {
    if (provider === "stripe") {
      const account = orgId
        ? await StripeConnectAccount.findOne({ organizationId: orgId })
        : null;
      if (
        !account ||
        !isDirectStripeAccount(account) ||
        !account.chargesEnabled
      ) {
        return fail(
          "Le paiement par carte n'est pas disponible pour le moment. Contactez l'expéditeur du transfert.",
        );
      }
      const session = await getStripe().checkout.sessions.create(
        {
          mode: "payment",
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: String(
                  transfer.paymentCurrency || "EUR",
                ).toLowerCase(),
                unit_amount: toCents(transfer.paymentAmount),
                product_data: { name, description },
              },
            },
          ],
          success_url: `${back}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${back}&canceled=1`,
          locale: "fr",
          expires_at: Math.floor(Date.now() / 1000) + STRIPE_SESSION_TTL_S,
          metadata,
          payment_intent_data: { metadata, description: name },
        },
        {
          stripeAccount: account.accountId,
          idempotencyKey: `transfer-${transfer._id}-${returnToken}`,
        },
      );
      attempt = {
        provider: "stripe",
        reference: session.id,
        accountId: account.accountId,
        status: "open",
        createdAt: new Date(),
      };
      url = session.url;
    } else {
      const merchant = orgId
        ? await PaypalMerchantAccount.findOne({ organizationId: orgId }).lean()
        : null;
      if (!isPaypalConfigured() || !merchant?.email) {
        return fail(
          "Le paiement par PayPal n'est pas disponible pour le moment. Contactez l'expéditeur du transfert.",
        );
      }
      const order = await createPaypalOrder({
        amount: transfer.paymentAmount,
        currency: transfer.paymentCurrency || "EUR",
        payeeEmail: merchant.email,
        description: `${name} (${description})`,
        customId: String(transfer._id),
        brandName: await getSellerName(orgId),
        returnUrl: back,
        cancelUrl: `${back}&canceled=1`,
        requestId: `transfer-${transfer._id}-${returnToken}`,
      });
      if (!order?.id || !order.approveUrl) {
        throw new PaypalApiError("Commande PayPal sans adresse de paiement");
      }
      attempt = {
        provider: "paypal",
        reference: order.id,
        status: "open",
        createdAt: new Date(),
      };
      url = order.approveUrl;
    }
  } catch (error) {
    logger.error(
      `[transfer-payment] Paiement ${provider} du transfert ${transfer._id} non lancé : ${error.message}`,
    );
    return fail(
      error instanceof PaypalApiError &&
        String(error.issue || "").startsWith("PAYEE_")
        ? "Le compte PayPal de l'expéditeur ne peut pas recevoir ce paiement. Contactez-le."
        : "Le paiement n'a pas pu être lancé. Réessayez dans quelques instants.",
    );
  }

  await FileTransfer.updateOne(
    { _id: transfer._id },
    {
      $set: {
        paymentAttempt: attempt,
        paymentReturnToken: returnToken,
        paymentReturnTokenExpiresAt: new Date(
          Date.now() + PAYMENT_RETURN_TTL_MS,
        ),
        paymentReturnTokenConsumed: false,
      },
    },
  );
  return { success: true, sessionId: attempt.reference, sessionUrl: url };
}

/** Compte Stripe autorisé à confirmer le paiement d'un transfert. */
async function expectedStripeAccounts(transfer) {
  const accounts = new Set();
  if (transfer.paymentAttempt?.accountId) {
    accounts.add(transfer.paymentAttempt.accountId);
  }
  const orgId = workspaceKey(transfer.workspaceId);
  if (orgId) {
    const account = await StripeConnectAccount.findOne({
      organizationId: orgId,
    }).lean();
    if (isDirectStripeAccount(account)) accounts.add(account.accountId);
  }
  return accounts;
}

/**
 * Applique une session Checkout (retour, webhook ou visite) : la session
 * doit venir du compte Stripe du vendeur et correspondre au transfert, au
 * montant et à la devise. Sans ces contrôles, quelqu'un qui a son propre
 * compte connecté pourrait payer chez lui-même une session portant l'id du
 * transfert d'un autre et le débloquer.
 */
export async function applyStripeSession(transfer, session, accountId) {
  if (!session || session.metadata?.fileTransferId !== String(transfer._id)) {
    logger.warn(
      `[transfer-payment] Session ${session?.id} étrangère au transfert ${transfer._id}`,
    );
    return { status: "unpaid" };
  }
  const allowed = await expectedStripeAccounts(transfer);
  if (!accountId || !allowed.has(accountId)) {
    logger.warn(
      `[transfer-payment] Session ${session.id} venue du compte ${accountId}, étranger au transfert ${transfer._id}`,
    );
    return { status: "unpaid" };
  }

  if (session.payment_status === "paid") {
    const currency = String(session.currency || "").toUpperCase();
    if (
      session.amount_total !== toCents(transfer.paymentAmount) ||
      currency !== String(transfer.paymentCurrency || "EUR").toUpperCase()
    ) {
      logger.error(
        `[transfer-payment] ANOMALIE : session ${session.id} payée ${session.amount_total} ${currency} pour le transfert ${transfer._id} (${transfer.paymentAmount} ${transfer.paymentCurrency}) : non appliquée`,
      );
      return { status: "unpaid" };
    }
    return markTransferPaid(transfer, {
      provider: "stripe",
      paymentId: session.payment_intent || session.id,
      amount: session.amount_total / 100,
      currency,
      payerEmail: session.customer_details?.email,
      accountId,
    });
  }

  // Moyen de paiement différé (prélèvement…) : payé plus tard
  if (session.status === "complete") {
    await setAttemptStatus(transfer, "pending");
    return { status: "pending" };
  }
  if (session.status === "expired") {
    await setAttemptStatus(transfer, "failed", session.id);
  }
  return { status: "unpaid" };
}

async function setAttemptStatus(transfer, status, reference, extra = {}) {
  const filter = { _id: transfer._id };
  if (reference) filter["paymentAttempt.reference"] = reference;
  await FileTransfer.updateOne(filter, {
    $set: {
      "paymentAttempt.status": status,
      ...Object.fromEntries(
        Object.entries(extra).map(([key, value]) => [
          `paymentAttempt.${key}`,
          value,
        ]),
      ),
    },
  });
}

async function verifyStripeAttempt(transfer, sessionId) {
  const attempt = transfer.paymentAttempt || {};
  const reference =
    typeof sessionId === "string" &&
    /^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)
      ? sessionId
      : attempt.reference;
  if (!reference) return { status: "unpaid" };
  const accounts = [...(await expectedStripeAccounts(transfer))];
  for (const accountId of accounts) {
    try {
      const session = await getStripe().checkout.sessions.retrieve(reference, {
        stripeAccount: accountId,
      });
      return applyStripeSession(transfer, session, accountId);
    } catch (error) {
      // Session inconnue sur ce compte : essayer le suivant
      if (error?.code !== "resource_missing") {
        logger.warn(
          `[transfer-payment] Session ${reference} illisible sur ${accountId} : ${error.message}`,
        );
      }
    }
  }
  return { status: "unpaid" };
}

async function verifyPaypalAttempt(transfer, orderId) {
  if (!isPaypalConfigured()) return { status: "unpaid" };
  const attempt = transfer.paymentAttempt || {};
  try {
    // Capture en attente chez PayPal : relue directement
    if (
      attempt.provider === "paypal" &&
      attempt.status === "pending" &&
      attempt.captureId &&
      (!orderId || orderId === attempt.reference)
    ) {
      const capture = await getPaypalCapture(attempt.captureId);
      return applyPaypalCapture(transfer, {
        orderId: attempt.reference,
        customId: capture?.custom_id || String(transfer._id),
        captureId: capture?.id,
        captureStatus: capture?.status,
        amount: Number(capture?.amount?.value),
        currency: capture?.amount?.currency_code,
        payerEmail: transfer.payerEmail || null,
      });
    }

    const reference = isPaypalId(orderId) ? orderId : attempt.reference;
    if (!isPaypalId(reference)) return { status: "unpaid" };
    let summary = summarizePaypalOrder(await getPaypalOrder(reference));
    if (summary.customId !== String(transfer._id)) {
      logger.warn(
        `[transfer-payment] Commande PayPal ${reference} étrangère au transfert ${transfer._id}`,
      );
      return { status: "unpaid" };
    }
    if (summary.orderStatus === "APPROVED") {
      // Approuvée par le payeur : encaissée maintenant (le transfert n'est
      // pas encore payé, vérifié par l'appelant)
      summary = summarizePaypalOrder(await capturePaypalOrder(reference));
    }
    return applyPaypalCapture(transfer, summary);
  } catch (error) {
    logger.warn(
      `[transfer-payment] Vérification PayPal du transfert ${transfer._id} : ${error.message}`,
    );
    if (
      error instanceof PaypalApiError &&
      error.issue === "INSTRUMENT_DECLINED"
    ) {
      return {
        status: "unpaid",
        message: "Le moyen de paiement a été refusé par PayPal.",
      };
    }
    return { status: "unpaid" };
  }
}

async function applyPaypalCapture(transfer, summary) {
  if (summary.customId && summary.customId !== String(transfer._id)) {
    return { status: "unpaid" };
  }
  if (summary.captureStatus === "COMPLETED") {
    if (
      !sameAmount(summary.amount, transfer.paymentAmount) ||
      String(summary.currency || "").toUpperCase() !==
        String(transfer.paymentCurrency || "EUR").toUpperCase()
    ) {
      logger.error(
        `[transfer-payment] ANOMALIE : capture PayPal ${summary.captureId} de ${summary.amount} ${summary.currency} pour le transfert ${transfer._id} (${transfer.paymentAmount} ${transfer.paymentCurrency}) : non appliquée`,
      );
      return { status: "unpaid" };
    }
    return markTransferPaid(transfer, {
      provider: "paypal",
      paymentId: summary.captureId,
      amount: summary.amount,
      currency: summary.currency,
      payerEmail: summary.payerEmail,
    });
  }
  if (summary.captureStatus === "PENDING") {
    await setAttemptStatus(transfer, "pending", summary.orderId, {
      captureId: summary.captureId,
    });
    return { status: "pending" };
  }
  if (
    ["DECLINED", "FAILED"].includes(summary.captureStatus) ||
    summary.orderStatus === "VOIDED"
  ) {
    await setAttemptStatus(transfer, "failed", summary.orderId);
  }
  return { status: "unpaid" };
}

/**
 * Vérifie le dernier paiement en ligne du transfert auprès du prestataire et
 * débloque le transfert s'il est payé.
 * @param {object} transfer - document FileTransfer
 * @param {object} [options]
 * @param {boolean} [options.force] - ignorer l'intervalle entre deux vérifications
 * @param {string} [options.provider] - prestataire du retour (stripe | paypal)
 * @param {string} [options.sessionId] - session Checkout du retour Stripe
 * @param {string} [options.orderId] - commande du retour PayPal
 * @returns {Promise<{status: "paid"|"pending"|"unpaid"|"free", message?: string}>}
 */
export async function refreshTransferPayment(
  transfer,
  { force = false, provider, sessionId, orderId } = {},
) {
  if (!transfer?.isPaymentRequired) return { status: "free" };
  if (transfer.isPaid) return { status: "paid" };
  const attempt = transfer.paymentAttempt || {};
  const attemptProvider = ONLINE_PAYMENT_PROVIDERS.includes(provider)
    ? provider
    : attempt.provider;
  if (!attemptProvider || (!attempt.reference && !sessionId && !orderId)) {
    return { status: "unpaid" };
  }

  const elapsed = attempt.checkedAt
    ? Date.now() - new Date(attempt.checkedAt).getTime()
    : Infinity;
  if (elapsed < (force ? FORCED_RECHECK_INTERVAL_MS : RECHECK_INTERVAL_MS)) {
    return { status: attempt.status === "pending" ? "pending" : "unpaid" };
  }
  await FileTransfer.updateOne(
    { _id: transfer._id },
    { $set: { "paymentAttempt.checkedAt": new Date() } },
  );

  try {
    const result =
      attemptProvider === "stripe"
        ? await verifyStripeAttempt(transfer, sessionId)
        : await verifyPaypalAttempt(transfer, orderId);
    return { status: result.status, message: result.message };
  } catch (error) {
    logger.error(
      `[transfer-payment] Vérification du transfert ${transfer._id} : ${error.message}`,
    );
    return { status: "unpaid" };
  }
}

// ---------------------------------------------------------------------------
// Notification du vendeur
// ---------------------------------------------------------------------------

export function formatTransferAmount(amount, currency = "EUR") {
  try {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: String(currency || "EUR").toUpperCase(),
    }).format(Number(amount || 0));
  } catch {
    return `${Number(amount || 0).toFixed(2)} ${currency}`;
  }
}

/** E-mail, notification dans l'appli et push au créateur du transfert. */
export async function notifyTransferPaid(transfer) {
  const owner = await User.findById(transfer.userId)
    .select("email notificationPreferences")
    .lean();
  if (!owner) return;
  const amount = formatTransferAmount(
    transfer.paidAmount ?? transfer.paymentAmount,
    transfer.paidCurrency || transfer.paymentCurrency,
  );
  const label = transfer.title ? `« ${transfer.title} »` : "votre transfert";
  const payer = transfer.payerEmail || "Votre client";
  const url = "/dashboard/outils/transferts-fichiers";

  const orgId = workspaceKey(transfer.workspaceId);
  if (orgId && mongoose.Types.ObjectId.isValid(orgId)) {
    try {
      const notification = await Notification.create({
        userId: transfer.userId,
        workspaceId: new mongoose.Types.ObjectId(orgId),
        type: "TRANSFER_PAID",
        title: "Paiement reçu",
        message: `${payer} a payé ${amount} pour ${label}. Les fichiers sont débloqués.`,
        data: { url, amountTTC: transfer.paidAmount ?? transfer.paymentAmount },
      });
      const [{ publishNotification }, { sendNotificationPush }] =
        await Promise.all([
          import("../resolvers/notification.js"),
          import("./notificationPushService.js"),
        ]);
      await publishNotification(notification).catch(() => {});
      await sendNotificationPush(notification);
    } catch (error) {
      logger.warn(
        `[transfer-payment] Notification in-app non créée : ${error.message}`,
      );
    }
  }

  if (
    owner.email &&
    owner.notificationPreferences?.payment_received?.email !== false
  ) {
    const email = buildTransferPaidEmail({
      amount,
      transferTitle: transfer.title || null,
      payerEmail: transfer.payerEmail || null,
      provider: transfer.paymentProvider,
      fileCount: transfer.files?.length || 0,
      url: `${frontendUrl()}${url}`,
    });
    await sendRenderedEmail({ to: owner.email, ...email });
  }
}
