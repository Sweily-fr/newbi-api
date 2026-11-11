import crypto from "crypto";
import SocialAccount from "../../models/SocialAccount.js";
import SocialDataDeletionRequest from "../../models/SocialDataDeletionRequest.js";
import logger from "../../utils/logger.js";
import { metaAppCredentials } from "./direct/instagramFacebookApi.js";
import { clearedCredentialFields } from "./socialAccountCredentials.js";
import { apiPublicUrl } from "./socialConnectUrls.js";

/**
 * Rappels exigés par Meta pour la validation des applis (« Deauthorize
 * callback URL » et « Data deletion request URL »), appelés par les
 * serveurs de Meta avec signed_request=<signature>.<charge> (base64url,
 * HMAC-SHA256 de la charge avec le secret de l'appli) :
 * - meta : Facebook Login (Pages Facebook), META_APP_SECRET ;
 * - instagram : Instagram Login, INSTAGRAM_APP_SECRET ;
 * - instagram_facebook : Instagram via Facebook, secret de son appli
 *   (META_INSTAGRAM_FB_APP_SECRET, sinon META_APP_SECRET).
 *
 * Comptes concernés : user_id de la charge = identifiant de l'utilisateur
 * pour l'appli (platformData.metaUserId) chez Facebook Login, identifiant
 * du compte (externalAccountId) chez Instagram Login. Désautorisation :
 * comptes à reconnecter, jetons effacés. Suppression : comptes déconnectés
 * (deletedAt, jetons effacés ; les posts passés gardent leurs cibles),
 * demande gardée avec un code de suivi. Aucune autre donnée modifiée.
 * Doc : developers.facebook.com/docs/development/create-an-app/
 * app-dashboard/data-deletion-callback (signed_request et réponse)
 */

export const META_CALLBACK_SOURCES = [
  "meta",
  "instagram",
  "instagram_facebook",
];
const CODE_PATTERN = /^[a-f0-9]{24}$/;

const trimmed = (value) => String(value || "").trim();

/** Secret de l'appli qui signe les rappels de cette source (null si absent). */
function secretOf(source) {
  if (source === "meta") return trimmed(process.env.META_APP_SECRET) || null;
  if (source === "instagram") {
    return trimmed(process.env.INSTAGRAM_APP_SECRET) || null;
  }
  if (source === "instagram_facebook") {
    return metaAppCredentials()?.appSecret || null;
  }
  return null;
}

/** Instagram via Facebook vit dans l'appli des Pages (pas d'appli dédiée). */
const instagramFacebookSharesMetaApp = () => {
  const app = metaAppCredentials();
  return Boolean(app && app.appId === trimmed(process.env.META_APP_ID));
};

const base64UrlDecode = (value) =>
  Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Vérifie et lit un signed_request de Meta (comparaison à temps constant).
 * @returns {object|null} charge JSON, ou null si la signature est fausse
 */
export function parseSignedRequest(signedRequest, secret) {
  if (typeof signedRequest !== "string" || !secret) return null;
  const [signature, payload, extra] = signedRequest.split(".");
  if (!signature || !payload || extra !== undefined) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const received = base64UrlDecode(signature);
  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return null;
  }
  try {
    const data = JSON.parse(base64UrlDecode(payload).toString("utf8"));
    if (
      data?.algorithm &&
      String(data.algorithm).toUpperCase() !== "HMAC-SHA256"
    ) {
      return null;
    }
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** Comptes « direct » visés par un rappel de cette source. */
function accountsFilter(source, userId) {
  if (source === "instagram") {
    return {
      provider: "direct",
      platform: "instagram",
      connector: null,
      externalAccountId: userId,
    };
  }
  const facebook = { platform: "facebook" };
  const instagramFacebook = { platform: "instagram", connector: "facebook" };
  const shared = instagramFacebookSharesMetaApp();
  const scopes =
    source === "meta"
      ? [facebook, ...(shared ? [instagramFacebook] : [])]
      : [instagramFacebook, ...(shared ? [facebook] : [])];
  return {
    provider: "direct",
    "platformData.metaUserId": userId,
    $or: scopes,
  };
}

/**
 * Charge vérifiée d'un rappel, ou réponse d'erreur : 404 si l'appli n'est
 * pas configurée, 400 si la signature ou la charge est fausse.
 */
function verify(source, signedRequest) {
  const secret = secretOf(source);
  if (!secret) return { error: 404 };
  const payload = parseSignedRequest(signedRequest, secret);
  const userId =
    payload?.user_id !== undefined && payload?.user_id !== null
      ? String(payload.user_id)
      : "";
  if (!payload || !userId || userId.length > 64) {
    logger.warn(`[SocialConnect] Rappel Meta ${source} : signature refusée`);
    return { error: 400 };
  }
  return { userId };
}

/**
 * Désautorisation de notre appli par l'utilisateur : ses comptes (tous
 * espaces) passent « à reconnecter », jetons effacés.
 * @returns {Promise<{status: number, body?: object}>}
 */
export async function handleDeauthorize(source, signedRequest) {
  const { error, userId } = verify(source, signedRequest);
  if (error) return { status: error };
  const result = await SocialAccount.updateMany(
    { ...accountsFilter(source, userId), deletedAt: null },
    { $set: { status: "needs_reconnect", ...clearedCredentialFields() } },
  );
  logger.info(
    `[SocialConnect] Rappel Meta ${source} (désautorisation) : ${result.modifiedCount} compte(s) à reconnecter, jetons effacés`,
  );
  return { status: 200, body: { success: true } };
}

/**
 * Demande de suppression des données : comptes déconnectés (comme une
 * déconnexion dans Newbi), demande gardée, adresse de suivi et code de
 * confirmation renvoyés à Meta.
 * @returns {Promise<{status: number, body?: object}>}
 */
export async function handleDataDeletion(
  source,
  signedRequest,
  { now = new Date() } = {},
) {
  const { error, userId } = verify(source, signedRequest);
  if (error) return { status: error };
  const result = await SocialAccount.updateMany(
    { ...accountsFilter(source, userId), deletedAt: null },
    { $set: { deletedAt: now, ...clearedCredentialFields() } },
  );
  const code = crypto.randomBytes(12).toString("hex");
  await SocialDataDeletionRequest.create({
    code,
    source,
    accountCount: result.modifiedCount,
  });
  logger.info(
    `[SocialConnect] Rappel Meta ${source} (suppression des données) : ${result.modifiedCount} compte(s) déconnecté(s), demande ${code}`,
  );
  return {
    status: 200,
    body: {
      url: `${apiPublicUrl()}/social-connect/meta/data-deletion/${code}`,
      confirmation_code: code,
    },
  };
}

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Page de suivi d'une demande de suppression (adresse donnée à Meta).
 * @returns {Promise<string|null>} page HTML, ou null si le code est inconnu
 */
export async function dataDeletionStatusPage(code) {
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) return null;
  const request = await SocialDataDeletionRequest.findOne({ code }).lean();
  if (!request) return null;
  const date = new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "long",
    timeZone: "Europe/Paris",
  }).format(new Date(request.createdAt));
  const message = `Demande de suppression reçue le ${date} : ${request.accountCount} compte(s) déconnecté(s) et leurs accès supprimés.`;
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Suppression des données | Newbi</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 16px; color: #1f2937; line-height: 1.5;">
<h1 style="font-size: 20px;">Suppression des données</h1>
<p>${escapeHtml(message)}</p>
<p>Code de confirmation : <code>${escapeHtml(code)}</code></p>
</body>
</html>`;
}
