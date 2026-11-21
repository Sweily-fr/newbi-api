import Stripe from "stripe";
import mongoose from "mongoose";
import FileTransfer from "../models/FileTransfer.js";
import StripeConnectAccount from "../models/StripeConnectAccount.js";
import logger from "../utils/logger.js";
import { applyStripeSession } from "../services/transferPaymentService.js";
import { syncStripeAccountFromEvent } from "../services/stripeConnectService.js";
import { applyInvoiceCheckoutSession } from "./invoicePaymentController.js";

/**
 * Webhook des comptes Stripe connectés (endpoint « Connected accounts »).
 * POST /webhook/stripe-connect (body brut), secret STRIPE_CONNECT_WEBHOOK_SECRET.
 *
 * Les paiements des comptes connectés par OAuth sont créés sur le compte du
 * client : leurs événements portent `event.account` et n'arrivent qu'à cet
 * endpoint. Ils débloquent les transferts payants, soldent les factures, et
 * tiennent à jour l'état des comptes (account.updated) et leur déconnexion
 * depuis Stripe (account.application.deauthorized).
 *
 * Chaque paiement est aussi vérifié au retour du payeur et à la visite
 * suivante : ce webhook accélère, il n'est pas indispensable.
 */

let stripeClient = null;
function getStripe() {
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

async function applyTransferSessionEvent(type, session, accountId) {
  const transferId = session?.metadata?.fileTransferId;
  if (!mongoose.isValidObjectId(transferId)) {
    return { status: "ignored", message: "Transfert absent de la session" };
  }
  const transfer = await FileTransfer.findById(transferId);
  if (!transfer) return { status: "error", message: "Transfert introuvable" };
  if (type === "checkout.session.async_payment_failed") {
    logger.warn(
      `[stripe-connect] Paiement différé refusé pour le transfert ${transferId} (session ${session.id})`,
    );
    return { status: "ignored", message: "Paiement différé refusé" };
  }
  const result = await applyStripeSession(transfer, session, accountId);
  return {
    status: result.status === "paid" ? "success" : "ignored",
    message: `Transfert ${result.status}`,
  };
}

async function removeDeauthorizedAccount(accountId) {
  if (!accountId) return { status: "ignored", message: "Compte absent" };
  const result = await StripeConnectAccount.deleteMany({
    accountId,
    connectionType: "oauth",
  });
  if (result.deletedCount) {
    logger.warn(
      `[stripe-connect] Accès au compte ${accountId} retiré depuis Stripe : connexion supprimée`,
    );
  }
  return {
    status: result.deletedCount ? "success" : "ignored",
    message: result.deletedCount ? "Connexion supprimée" : "Compte inconnu",
  };
}

/** Traitement d'un événement déjà authentifié. */
export async function dispatchConnectEvent(event) {
  const accountId = event?.account || null;
  switch (event?.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed": {
      if (!accountId) {
        return { status: "ignored", message: "Événement sans compte connecté" };
      }
      const session = event.data?.object;
      const type = session?.metadata?.type;
      if (type === "file_transfer") {
        return applyTransferSessionEvent(event.type, session, accountId);
      }
      if (
        type === "invoice_payment" &&
        event.type !== "checkout.session.async_payment_failed"
      ) {
        return applyInvoiceCheckoutSession(session, { accountId });
      }
      return { status: "ignored", message: "Session étrangère à Newbi" };
    }
    case "account.updated":
      return syncStripeAccountFromEvent(event.data?.object);
    case "account.application.deauthorized":
      return removeDeauthorizedAccount(accountId);
    default:
      return {
        status: "ignored",
        message: `Événement non géré : ${event?.type}`,
      };
  }
}

export const handleStripeConnectWebhook = async (req, res) => {
  const secret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  if (!secret) {
    logger.error(
      "[stripe-connect] STRIPE_CONNECT_WEBHOOK_SECRET absent : événements des comptes connectés refusés",
    );
    return res.status(503).send("Webhook non configuré");
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body,
      req.headers["stripe-signature"],
      secret,
    );
  } catch (error) {
    logger.warn(`[stripe-connect] Signature invalide : ${error.message}`);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    const result = await dispatchConnectEvent(event);
    logger.debug(
      `[stripe-connect] ${event.type} (${event.id}) : ${result?.status}`,
    );
    return res.status(200).json({ received: true, result });
  } catch (error) {
    // Erreur passagère (base, Stripe) : Stripe renverra l'événement
    logger.error(
      `[stripe-connect] Traitement de ${event.type} (${event.id}) :`,
      error,
    );
    return res.status(500).json({ received: false });
  }
};
