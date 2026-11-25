/**
 * Boîte Outlook (Microsoft 365, Outlook.com) de prospection : OAuth par MSAL
 * (ConfidentialClientApplication, autorité « common »), envoi par Microsoft
 * Graph (POST /me/sendMail, message MIME en base64, réponse 202 sans
 * identifiant).
 *
 * Appli : PROSPECTING_MICROSOFT_CLIENT_ID / _SECRET, repli sur celle du
 * calendrier (MICROSOFT_CALENDAR_CLIENT_ID / _SECRET) ; l'adresse de retour
 * /mailbox-connect/microsoft/callback et le droit délégué Mail.Send doivent
 * y être déclarés. Droits demandés : Mail.Send, User.Read, offline_access.
 *
 * Microsoft n'offre pas de révocation d'un seul jeton (revokeSignInSessions
 * fermerait toutes les sessions du compte) : à la déconnexion, les jetons
 * sont seulement effacés chez Newbi.
 */
import { ConfidentialClientApplication } from "@azure/msal-node";
import { apiPublicUrl, microsoftCredentials } from "../config.js";
import { MailProviderError, readJson, request, withTimeout } from "./errors.js";

export const MICROSOFT_SEND_SCOPE = "https://graph.microsoft.com/Mail.Send";
export const MICROSOFT_SCOPES = Object.freeze([
  MICROSOFT_SEND_SCOPE,
  "https://graph.microsoft.com/User.Read",
  "offline_access",
]);
// Rafraîchissement : offline_access est implicite
const REFRESH_SCOPES = [
  MICROSOFT_SEND_SCOPE,
  "https://graph.microsoft.com/User.Read",
];

const GRAPH = "https://graph.microsoft.com/v1.0";
const AUTHORITY = "https://login.microsoftonline.com/common";

export const microsoftRedirectUri = () =>
  `${apiPublicUrl()}/mailbox-connect/microsoft/callback`;

function client() {
  const { clientId, clientSecret } = microsoftCredentials();
  if (!clientId || !clientSecret) {
    throw new MailProviderError(
      "AUTH",
      "Connexion Outlook non configurée (PROSPECTING_MICROSOFT_CLIENT_ID / _SECRET)",
    );
  }
  return new ConfidentialClientApplication({
    auth: { clientId, clientSecret, authority: AUTHORITY },
  });
}

/** Jeton de rafraîchissement gardé par MSAL dans son cache. */
function refreshTokenFromCache(cca) {
  try {
    const cache = JSON.parse(cca.getTokenCache().serialize());
    const tokens = Object.values(cache.RefreshToken || {});
    return tokens[0]?.secret || null;
  } catch {
    return null;
  }
}

/**
 * Erreur de MSAL : autorisation retirée ou refusée (jeton révoqué ou
 * expiré, appli inconnue ou secret refusé : invalid_client,
 * unauthorized_client), sinon erreur passagère.
 */
export function msalError(error) {
  if (error?.name === "MailProviderError") return error;
  const code = String(error?.errorCode || error?.code || "");
  const message = error?.errorMessage || error?.message || "erreur inconnue";
  const auth =
    error?.name === "InteractionRequiredAuthError" ||
    /invalid_grant|invalid_client|unauthorized_client|interaction_required|consent_required|login_required|AADSTS(50173|70000|70008|700082|700016|7000215|7000222|65001|50076|50079)\b/i.test(
      `${code} ${message}`,
    );
  if (auth) {
    return new MailProviderError("AUTH", `Microsoft : ${message}`, { code });
  }
  // Panne réseau ou du service : nouvel essai
  return new MailProviderError("TEMPORARY", `Microsoft : ${message}`, { code });
}

const scopesOf = (result) =>
  (Array.isArray(result?.scopes) ? result.scopes : []).map(String);

/** Adresse d'autorisation (consentement redemandé). */
export async function getAuthUrl(state) {
  return withTimeout(
    client().getAuthCodeUrl({
      scopes: [...MICROSOFT_SCOPES],
      redirectUri: microsoftRedirectUri(),
      state,
      prompt: "consent",
    }),
    "Microsoft",
  );
}

/** Code d'autorisation → jetons et droits accordés. */
export async function exchangeCode(code) {
  const cca = client();
  let result;
  try {
    result = await withTimeout(
      cca.acquireTokenByCode({
        code,
        scopes: [...MICROSOFT_SCOPES],
        redirectUri: microsoftRedirectUri(),
      }),
      "Microsoft",
    );
  } catch (error) {
    throw msalError(error);
  }
  return {
    accessToken: result?.accessToken || null,
    refreshToken: refreshTokenFromCache(cca),
    expiresAt: result?.expiresOn ? new Date(result.expiresOn) : null,
    scopes: scopesOf(result),
  };
}

/** Adresse et nom de la boîte (Graph /me). */
export async function getUserInfo(accessToken) {
  const response = await request(
    `${GRAPH}/me?$select=displayName,mail,userPrincipalName`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "Microsoft",
  );
  if (!response.ok) {
    throw new MailProviderError(
      response.status === 401 ? "AUTH" : "TEMPORARY",
      `Microsoft : profil illisible (HTTP ${response.status})`,
      { status: response.status },
    );
  }
  const body = await readJson(response);
  return {
    email: String(body?.mail || body?.userPrincipalName || "")
      .trim()
      .toLowerCase(),
    name: body?.displayName || null,
  };
}

/** Nouveau jeton d'accès (et nouveau jeton de rafraîchissement si donné). */
export async function refreshAccessToken(refreshToken) {
  if (!refreshToken) {
    throw new MailProviderError(
      "AUTH",
      "Microsoft : aucun jeton de rafraîchissement",
    );
  }
  const cca = client();
  let result;
  try {
    result = await withTimeout(
      cca.acquireTokenByRefreshToken({
        refreshToken,
        scopes: REFRESH_SCOPES,
      }),
      "Microsoft",
    );
  } catch (error) {
    throw msalError(error);
  }
  if (!result?.accessToken) {
    throw new MailProviderError("AUTH", "Microsoft : jeton non renouvelé");
  }
  return {
    accessToken: result.accessToken,
    refreshToken: refreshTokenFromCache(cca),
    expiresAt: result.expiresOn
      ? new Date(result.expiresOn)
      : new Date(Date.now() + 3600 * 1000),
    scopes: scopesOf(result),
  };
}

/** Aucune révocation d'un seul jeton chez Microsoft (voir plus haut). */
export async function revokeToken() {
  return false;
}

const QUOTA_CODES = new Set([
  "ErrorExceededMessageLimit",
  "ErrorQuotaExceeded",
  "ErrorSubmissionQuotaExceeded",
  "ApplicationThrottled",
  "MailboxConcurrency",
  "TooManyRequests",
]);
// Refus propres au compte : la boîte ne peut rien envoyer (pas de boîte
// Exchange, compte désactivé, droit d'envoi refusé, MIME refusé)
const ACCOUNT_CODES = new Set([
  "MailboxNotEnabledForRESTAPI",
  "MailboxNotHostedInExchangeOnline",
  "ErrorAccountDisabled",
  "ErrorSendAsDenied",
  "ErrorMimeContentInvalid",
  "ErrorMimeContentConversionFailed",
  "ErrorInvalidMimeContent",
]);
const RECIPIENT_CODES = new Set([
  "ErrorInvalidRecipients",
  "ErrorRecipientNotFound",
  "ErrorInvalidSmtpAddress",
  "ErrorInvalidRecipientSubfilter",
]);

/** Classe une erreur de Microsoft Graph. */
export function classifyGraphError(status, body) {
  const code = String(body?.error?.code || "");
  const message = String(body?.error?.message || `HTTP ${status}`);
  const details = { status, code: code || null };
  if (status === 401) {
    return new MailProviderError("AUTH", `Outlook : ${message}`, details);
  }
  if (
    status === 429 ||
    QUOTA_CODES.has(code) ||
    /quota|limit exceeded|throttl/i.test(message)
  ) {
    return new MailProviderError("QUOTA", `Outlook : ${message}`, details);
  }
  if (ACCOUNT_CODES.has(code) || (status === 400 && /mime/i.test(message))) {
    return new MailProviderError("ACCOUNT", `Outlook : ${message}`, details);
  }
  if (status === 403) {
    return new MailProviderError("AUTH", `Outlook : ${message}`, details);
  }
  if (status === 400) {
    return new MailProviderError(
      RECIPIENT_CODES.has(code) || /recipient|destinataire/i.test(message)
        ? "RECIPIENT"
        : "PERMANENT",
      `Outlook : ${message}`,
      details,
    );
  }
  // Passerelle sans réponse : Graph a pu traiter l'envoi
  if (status === 502 || status === 504) {
    return new MailProviderError("UNCERTAIN", `Outlook : ${message}`, details);
  }
  if (status >= 500 || status === 408) {
    return new MailProviderError("TEMPORARY", `Outlook : ${message}`, details);
  }
  return new MailProviderError("PERMANENT", `Outlook : ${message}`, details);
}

/**
 * Envoie un message MIME depuis la boîte. Graph répond 202 sans identifiant
 * (ni message ni conversation à garder).
 */
export async function sendMessage({ accessToken, mime }) {
  const response = await request(
    `${GRAPH}/me/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "text/plain",
      },
      body: Buffer.from(mime, "utf8").toString("base64"),
    },
    "Outlook",
    { sending: true },
  );
  if (!response.ok) {
    throw classifyGraphError(response.status, await readJson(response));
  }
  return { providerMessageId: null, threadId: null };
}
