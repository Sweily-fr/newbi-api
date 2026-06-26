import Stripe from "stripe";
import Invoice from "../models/Invoice.js";
import StripeConnectAccount from "../models/StripeConnectAccount.js";
import stripeConnectService from "../services/stripeConnectService.js";
import { applyInvoicePaid } from "../resolvers/invoice.js";
import logger from "../utils/logger.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

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

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return infoPage(res, 404, "Facture introuvable", "Ce lien de paiement n'est plus valide.");
    }

    // Déjà payée → page de succès
    if (invoice.status === "COMPLETED" || invoice.stripePaymentStatus === "paid") {
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

    const successUrl = `${FRONTEND_URL}/pay/invoice/${invoiceId}/success`;
    const cancelUrl = `${FRONTEND_URL}/pay/invoice/${invoiceId}/cancel`;

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

  let result = { status: "ignored", message: `Événement non géré: ${event.type}` };

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    // Ignorer les sessions qui ne sont pas des paiements de facture
    if (session.metadata?.type !== "invoice_payment") {
      return res.status(200).json({ received: true, result });
    }

    try {
      const { invoiceId } = session.metadata;
      const invoice = await Invoice.findById(invoiceId);

      if (!invoice) {
        result = { status: "error", message: "Facture non trouvée" };
      } else if (
        invoice.stripePaymentStatus === "paid" ||
        invoice.status === "COMPLETED"
      ) {
        // Idempotence : déjà traitée
        result = { status: "ignored", message: "Facture déjà marquée comme payée" };
      } else {
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
        result = { status: "success", message: "Facture marquée comme payée" };
      }
    } catch (error) {
      logger.error("[invoice-payment] Erreur traitement webhook:", error);
      result = { status: "error", message: error.message };
    }
  }

  res.status(200).json({ received: true, result });
};
