import crypto from "crypto";
import mongoose from "mongoose";
import logger from "./logger.js";

/**
 * Lien public de paiement d'une facture (/pay/invoice/:id?t=<jeton>).
 *
 * Le jeton, signé par le serveur, prouve que le lien vient d'un e-mail ou du
 * tableau de bord : l'identifiant de la facture seul ne suffit plus.
 *
 * Liens déjà envoyés (sans jeton) : acceptés pour les factures créées avant
 * la mise en service des jetons. Cette date est enregistrée au premier
 * démarrage de l'API qui signe les liens (collection app_settings), avec une
 * marge couvrant le redémarrage progressif des instances.
 */
const SETTING_ID = "invoicePaymentLinkTokens";
const ROLLOUT_MARGIN_MS = 60 * 60 * 1000;
const TOKEN_LENGTH = 32;

function getSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour signer les liens de paiement",
    );
  }
  return secret;
}

export function invoicePaymentToken(invoiceId) {
  return crypto
    .createHmac("sha256", getSecret())
    .update(`invoice-payment:v1:${String(invoiceId)}`)
    .digest("base64url")
    .slice(0, TOKEN_LENGTH);
}

export function verifyInvoicePaymentToken(invoiceId, token) {
  if (typeof token !== "string" || token.length !== TOKEN_LENGTH) return false;
  let expected;
  try {
    expected = invoicePaymentToken(invoiceId);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

/** Lien de paiement signé, ou null si le serveur ne peut pas signer. */
export function buildInvoicePaymentUrl(baseUrl, invoiceId) {
  try {
    const token = invoicePaymentToken(invoiceId);
    return `${baseUrl}/pay/invoice/${String(invoiceId)}?t=${token}`;
  } catch (error) {
    logger.error("[invoice-payment] Lien non signé :", error.message);
    return null;
  }
}

let cachedSince = null;

/**
 * Date à partir de laquelle les factures créées exigent un lien signé.
 * Posée une seule fois par base ($setOnInsert), au premier démarrage.
 */
export async function ensurePaymentLinkTokensSince() {
  const db = mongoose.connection.db;
  if (!db) return null;
  const doc = await db.collection("app_settings").findOneAndUpdate(
    { _id: SETTING_ID },
    { $setOnInsert: { since: new Date(Date.now() + ROLLOUT_MARGIN_MS) } },
    { upsert: true, returnDocument: "after" },
  );
  const value = doc?.value ?? doc;
  cachedSince = value?.since ? new Date(value.since) : null;
  return cachedSince;
}

export function resetPaymentLinkTokensSinceCache() {
  cachedSince = null;
}

/**
 * Lien sans jeton (envoyé avant la mise en service) : accepté seulement pour
 * une facture créée avant cette date.
 */
export async function acceptsUnsignedPaymentLink(invoice) {
  const since = cachedSince || (await ensurePaymentLinkTokensSince());
  if (!since || !invoice?._id?.getTimestamp) return false;
  return invoice._id.getTimestamp() < since;
}
