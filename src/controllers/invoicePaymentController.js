import Stripe from "stripe";
import Invoice from "../models/Invoice.js";
import StripeConnectAccount from "../models/StripeConnectAccount.js";
import stripeConnectService, {
  apiPublicUrl,
  isDirectStripeAccount,
} from "../services/stripeConnectService.js";
import { getCacheClient } from "../config/redis.js";
import { applyInvoicePaid } from "../resolvers/invoice.js";
import logger from "../utils/logger.js";
import { isInvoiceFullyCredited } from "../utils/invoiceCredit.js";
import {
  acceptsUnsignedPaymentLink,
  verifyInvoicePaymentToken,
} from "../utils/invoicePaymentLink.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

/** Identifiant de facture valide : 24 caractères hexadécimaux. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * Petite page HTML d'information (erreur / état non payable).
 */
function infoPage(res, status, title, message) {
  res.status(status).send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f9fafb;color:#111827;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;max-width:420px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}h1{font-size:18px;margin:0 0 8px}p{color:#6b7280;font-size:14px;margin:0}</style>
</head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`);
}

/**
 * Endpoint public de redirection vers Stripe Checkout pour le paiement d'une facture.
 * GET /pay/invoice/:invoiceId
 *
 * Crée une session Checkout fraîche à chaque appel (les sessions expirent ≤ 24h), donc le
 * lien reste valable indéfiniment dans les emails / le dashboard, et redirige (302) vers Stripe.
 */
export const redirectToInvoicePayment = async (req, res) => {
  try {
    const { invoiceId } = req.params;

    // Lien abîmé (identifiant qui n'est pas un ObjectId) : introuvable, et
    // non une erreur serveur (findById lève une CastError)
    const found = OBJECT_ID.test(invoiceId)
      ? await Invoice.findById(invoiceId)
      : null;
    // Lien signé (e-mail, tableau de bord) ; sans jeton valide, seules les
    // factures antérieures aux liens signés restent payables par leur ancien
    // lien. Sinon : même réponse qu'une facture inconnue.
    const token = typeof req.query?.t === "string" ? req.query.t : null;
    const signed = Boolean(
      found && token && verifyInvoicePaymentToken(found._id, token),
    );
    const invoice =
      found && (signed || (await acceptsUnsignedPaymentLink(found)))
        ? found
        : null;
    if (!invoice) {
      return infoPage(
        res,
        404,
        "Facture introuvable",
        "Ce lien de paiement n'est plus valide.",
      );
    }

    // Déjà payée → page de succès
    if (
      invoice.status === "COMPLETED" ||
      invoice.stripePaymentStatus === "paid"
    ) {
      return res.redirect(`${FRONTEND_URL}/pay/invoice/${invoiceId}/success`);
    }

    // Non payable
    if (invoice.status === "DRAFT" || invoice.status === "CANCELED") {
      return infoPage(
        res,
        409,
        "Facture non payable",
        "Cette facture ne peut pas être réglée en ligne pour le moment.",
      );
    }

    // Facture soldée par avoir : plus rien à régler
    if (await isInvoiceFullyCredited(invoice)) {
      return infoPage(
        res,
        409,
        "Facture soldée par avoir",
        "Cette facture a été entièrement annulée par un avoir : il n'y a plus rien à régler.",
      );
    }

    // Compte Stripe Connect de l'organisation
    const account = await StripeConnectAccount.findOne({
      organizationId: invoice.workspaceId.toString(),
    });
    if (!account || !account.chargesEnabled) {
      return infoPage(
        res,
        409,
        "Paiement en ligne indisponible",
        "Le paiement en ligne n'est pas activé pour cette facture. Contactez l'émetteur.",
      );
    }

    // Compte du client (OAuth) : le retour passe par l'API, qui vérifie le
    // paiement sur son compte avant d'afficher la page de succès
    const successUrl = isDirectStripeAccount(account)
      ? `${apiPublicUrl()}/pay/invoice/${invoiceId}/return?session_id={CHECKOUT_SESSION_ID}`
      : `${FRONTEND_URL}/pay/invoice/${invoiceId}/success`;
    const cancelUrl = `${FRONTEND_URL}/pay/invoice/${invoiceId}/cancel${
      signed ? `?t=${encodeURIComponent(token)}` : ""
    }`;

    const result = await stripeConnectService.createInvoicePaymentSession(
      invoice,
      account.accountId,
      successUrl,
      cancelUrl,
    );

    if (!result.success || !result.sessionUrl) {
      logger.error("[invoice-payment] Échec création session:", result.message);
      return infoPage(
        res,
        500,
        "Erreur de paiement",
        "Impossible d'initialiser le paiement. Réessayez plus tard.",
      );
    }

    return res.redirect(303, result.sessionUrl);
  } catch (error) {
    logger.error("[invoice-payment] Erreur redirection:", error);
    return infoPage(
      res,
      500,
      "Erreur de paiement",
      "Une erreur est survenue. Réessayez plus tard.",
    );
  }
};

/**
 * Webhook Stripe dédié à l'encaissement des factures.
 * POST /webhook/invoice-payment  (body brut requis)
 *
 * Endpoint Stripe distinct du webhook file-transfer → secret de signature propre :
 * STRIPE_INVOICE_WEBHOOK_SECRET.
 */
export const handleInvoicePaymentWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_INVOICE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    logger.error("[invoice-payment] Signature webhook invalide:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  let result = {
    status: "ignored",
    message: `Événement non géré: ${event.type}`,
  };

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    // Ignorer les sessions qui ne sont pas des paiements de facture
    if (session.metadata?.type !== "invoice_payment") {
      return res.status(200).json({ received: true, result });
    }

    try {
      result = await applyInvoiceCheckoutSession(session);
    } catch (error) {
      logger.error("[invoice-payment] Erreur traitement webhook:", error);
      result = { status: "error", message: error.message };
    }
  }

  res.status(200).json({ received: true, result });
};

// Une session n'est appliquée qu'une fois, même vue en même temps par le
// retour du payeur et le webhook (instances PM2 distinctes : Redis)
const SESSION_LOCK_TTL_MS = 60 * 1000;

/**
 * Applique une session Checkout de facture : webhook de la plateforme
 * (ancien compte Express), webhook des comptes connectés ou retour du payeur
 * (compte du client connecté par OAuth, `accountId`).
 * @returns {Promise<{status: string, message: string}>}
 */
export async function applyInvoiceCheckoutSession(
  session,
  { accountId = null } = {},
) {
  if (session?.metadata?.type !== "invoice_payment") {
    return { status: "ignored", message: "Session étrangère aux factures" };
  }
  // Moyen de paiement différé : appliqué à async_payment_succeeded
  if (session.payment_status && session.payment_status !== "paid") {
    return { status: "ignored", message: "Paiement pas encore confirmé" };
  }

  const { invoiceId } = session.metadata;
  const invoice = OBJECT_ID.test(String(invoiceId || ""))
    ? await Invoice.findById(invoiceId)
    : null;

  const reference = invoice
    ? `${invoice.prefix || ""}${invoice.prefix ? "-" : ""}${invoice.number}`
    : invoiceId;

  if (!invoice) {
    return { status: "error", message: "Facture non trouvée" };
  }

  // Session d'un compte connecté : ce doit être le compte de l'espace de la
  // facture (un autre compte connecté pourrait sinon créer chez lui une
  // session portant l'identifiant de cette facture)
  if (accountId) {
    const account = await StripeConnectAccount.findOne({
      organizationId: invoice.workspaceId.toString(),
    }).lean();
    if (!account || account.accountId !== accountId) {
      logger.warn(
        `[invoice-payment] Session ${session.id} du compte ${accountId}, étranger à la facture ${reference}`,
      );
      return { status: "ignored", message: "Compte Stripe étranger" };
    }
  }

  if (
    invoice.stripePaymentStatus === "paid" ||
    invoice.status === "COMPLETED"
  ) {
    if (invoice.stripeCheckoutSessionId === session.id) {
      // Idempotence : même session déjà traitée (Stripe rejoue l'événement)
      return {
        status: "ignored",
        message: "Facture déjà marquée comme payée",
      };
    }
    // Facture déjà réglée (autre session ou paiement enregistré à la
    // main) : ce second encaissement est à rembourser, on le signale.
    logger.error(
      `[invoice-payment] ANOMALIE : second paiement reçu pour la facture ${reference} déjà payée (session ${session.id}, paiement ${session.payment_intent}, espace ${invoice.workspaceId}) : à rembourser`,
    );
    return {
      status: "anomaly",
      message: "Facture déjà payée : second paiement à rembourser",
    };
  }

  if (invoice.status !== "PENDING" && invoice.status !== "OVERDUE") {
    // Facture annulée (ou repassée en brouillon) après l'ouverture de la
    // session de paiement : elle reste en l'état, l'encaissement est
    // signalé pour être remboursé ou réaffecté.
    logger.error(
      `[invoice-payment] ANOMALIE : paiement reçu pour la facture ${reference} au statut ${invoice.status} (session ${session.id}, paiement ${session.payment_intent}, espace ${invoice.workspaceId}) : à rembourser ou réaffecter`,
    );
    return {
      status: "anomaly",
      message: `Paiement reçu sur une facture au statut ${invoice.status} : non appliqué`,
    };
  }

  const apply = async () => {
    await applyInvoicePaid(invoice, {
      paymentDate: new Date(),
      userId: invoice.createdBy,
      workspaceId: invoice.workspaceId.toString(),
      paymentMethod: "CARD",
      stripe: {
        paymentIntentId: session.payment_intent,
        checkoutSessionId: session.id,
      },
    });
    return { status: "success", message: "Facture marquée comme payée" };
  };
  // Compte du client : le retour du payeur et le webhook arrivent presque
  // en même temps, sur des instances différentes
  return accountId
    ? withSessionLock(`invoice-payment:session:${session.id}`, apply)
    : apply();
}

const localSessionLocks = new Set();

/**
 * Un seul traitement à la fois d'une même session (verrou Redis partagé
 * entre les instances, relâché à la fin ; sans Redis, verrou du processus).
 * La seconde arrivée est ignorée : la première applique le paiement.
 */
async function withSessionLock(key, fn) {
  const busy = { status: "ignored", message: "Session en cours de traitement" };
  const client = getCacheClient();
  if (client) {
    let acquired = true;
    try {
      acquired =
        (await client.set(key, "1", "PX", SESSION_LOCK_TTL_MS, "NX")) === "OK";
    } catch (error) {
      // Redis en erreur : traitement sans verrou, comme avant
      logger.warn(`[invoice-payment] Verrou indisponible : ${error.message}`);
    }
    if (!acquired) return busy;
    try {
      return await fn();
    } finally {
      client.del(key).catch(() => {});
    }
  }
  if (localSessionLocks.has(key)) return busy;
  localSessionLocks.add(key);
  try {
    return await fn();
  } finally {
    localSessionLocks.delete(key);
  }
}

const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]+$/;

/**
 * Retour du payeur après le paiement d'une facture sur le compte Stripe du
 * client (connexion OAuth) : la session est relue sur ce compte et
 * appliquée, puis le payeur arrive sur la page de succès. Le webhook des
 * comptes connectés fait la même chose ; ce retour évite d'en dépendre.
 * GET /pay/invoice/:invoiceId/return?session_id=cs_…
 */
export const handleInvoicePaymentReturn = async (req, res) => {
  const { invoiceId } = req.params;
  const successUrl = `${FRONTEND_URL}/pay/invoice/${
    OBJECT_ID.test(invoiceId) ? invoiceId : ""
  }/success`;
  const sessionId =
    typeof req.query?.session_id === "string" ? req.query.session_id : null;
  if (
    !OBJECT_ID.test(invoiceId) ||
    !sessionId ||
    !CHECKOUT_SESSION_ID.test(sessionId)
  ) {
    return res.redirect(successUrl);
  }
  try {
    const invoice = await Invoice.findById(invoiceId)
      .select("workspaceId")
      .lean();
    const account = invoice
      ? await StripeConnectAccount.findOne({
          organizationId: invoice.workspaceId.toString(),
        }).lean()
      : null;
    if (account && isDirectStripeAccount(account)) {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        stripeAccount: account.accountId,
      });
      if (session?.metadata?.invoiceId === invoiceId) {
        await applyInvoiceCheckoutSession(session, {
          accountId: account.accountId,
        });
      }
    }
  } catch (error) {
    logger.warn(
      `[invoice-payment] Retour de paiement de la facture ${invoiceId} : ${error.message}`,
    );
  }
  return res.redirect(successUrl);
};
