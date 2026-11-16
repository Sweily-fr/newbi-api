/**
 * Jetons signés des campagnes e-mail (HMAC-SHA256, sans expiration : un lien
 * de désinscription doit marcher pour toujours) et adresses publiques :
 *
 *   u  désinscription d'un destinataire   /api/email-campaigns/unsubscribe?t=
 *   o  ouverture (pixel)                  /api/email-campaigns/o/<jeton>.gif
 *   c  clic sur un lien                   /api/email-campaigns/c/<jeton>/<n>
 *   t  désinscription d'un e-mail de test (aucun effet, page d'explication)
 *
 * Jeton = `<identifiant>.<signature>` ; la signature couvre le type et
 * l'identifiant (un jeton d'ouverture ne désinscrit pas). Comparaison en
 * temps constant.
 */
import crypto from "crypto";

export const TOKEN_KINDS = Object.freeze({
  unsubscribe: "u",
  open: "o",
  click: "c",
  testUnsubscribe: "t",
});

const OBJECT_ID = /^[0-9a-f]{24}$/i;
// 16 octets de signature en base64url
const SIGNATURE_LENGTH = 22;

function tokenSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour signer les liens des campagnes e-mail",
    );
  }
  return secret;
}

function signatureOf(kind, id) {
  return crypto
    .createHmac("sha256", tokenSecret())
    .update(`email-campaign:${kind}:${String(id).toLowerCase()}`)
    .digest("base64url")
    .slice(0, SIGNATURE_LENGTH);
}

export function createCampaignToken(kind, id) {
  const value = String(id);
  if (!OBJECT_ID.test(value)) {
    throw new Error("Identifiant invalide pour un jeton de campagne");
  }
  return `${value}.${signatureOf(kind, value)}`;
}

/** @returns {string|null} l'identifiant si le jeton est authentique */
export function verifyCampaignToken(kind, token) {
  if (typeof token !== "string" || token.length > 64) return null;
  const [id, signature, ...rest] = token.split(".");
  if (rest.length || !id || !OBJECT_ID.test(id) || !signature) return null;
  try {
    const expected = Buffer.from(signatureOf(kind, id));
    const provided = Buffer.from(signature);
    return expected.length === provided.length &&
      crypto.timingSafeEqual(expected, provided)
      ? id.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/** Adresse publique de l'API (liens des e-mails). */
export function apiBaseUrl() {
  return (
    process.env.BACKEND_URL ||
    process.env.API_URL ||
    "https://api.newbi.fr"
  ).replace(/\/+$/, "");
}

const routesBase = () => `${apiBaseUrl()}/api/email-campaigns`;

export const unsubscribeUrlFor = (recipientId) =>
  `${routesBase()}/unsubscribe?t=${createCampaignToken(TOKEN_KINDS.unsubscribe, recipientId)}`;

export const testUnsubscribeUrlFor = (campaignId) =>
  `${routesBase()}/unsubscribe?t=${createCampaignToken(TOKEN_KINDS.testUnsubscribe, campaignId)}`;

export const openPixelUrlFor = (recipientId) =>
  `${routesBase()}/o/${createCampaignToken(TOKEN_KINDS.open, recipientId)}.gif`;

/** Fabrique des liens suivis d'un destinataire : index → adresse. */
export function clickUrlBuilder(recipientId) {
  const token = createCampaignToken(TOKEN_KINDS.click, recipientId);
  return (index) => `${routesBase()}/c/${token}/${index}`;
}
