/**
 * Boîte Gmail de prospection : OAuth (projet Google dédié,
 * PROSPECTING_GOOGLE_CLIENT_ID / _SECRET, jamais le client du calendrier),
 * envoi par l'API Gmail (users.messages.send, message MIME en base64url).
 *
 * Droits demandés : gmail.send (envoi seulement : la boîte n'est jamais
 * lue), openid, email, profile (adresse et nom de la boîte).
 */
import { apiPublicUrl, googleCredentials } from "../config.js";
import {
  MailProviderError,
  PROVIDER_TIMEOUT_MS,
  readJson,
  request,
} from "./errors.js";

export const GOOGLE_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GOOGLE_SCOPES = Object.freeze([
  GOOGLE_SEND_SCOPE,
  "openid",
  "email",
  "profile",
]);

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const ACCOUNT_REASONS = new Set(["failedPrecondition", "domainPolicy"]);

const QUOTA_REASONS = new Set([
  "dailyLimitExceeded",
  "userRateLimitExceeded",
  "rateLimitExceeded",
  "quotaExceeded",
  "sendingLimitExceeded",
]);

export const googleRedirectUri = () =>
  `${apiPublicUrl()}/mailbox-connect/google/callback`;

function credentials() {
  const { clientId, clientSecret } = googleCredentials();
  if (!clientId || !clientSecret) {
    throw new MailProviderError(
      "AUTH",
      "Connexion Gmail non configurée (PROSPECTING_GOOGLE_CLIENT_ID / _SECRET)",
    );
  }
  return { clientId, clientSecret };
}

/** Adresse d'autorisation (accès hors ligne, consentement redemandé). */
export function getAuthUrl(state) {
  const { clientId } = credentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Erreur du point de jeton : invalid_grant = autorisation retirée. */
async function tokenError(response) {
  const body = await readJson(response);
  const code = String(body?.error || "");
  const message = body?.error_description || code || `HTTP ${response.status}`;
  if (code === "invalid_grant" || code === "unauthorized_client") {
    return new MailProviderError("AUTH", `Google : ${message}`, {
      status: response.status,
      code,
    });
  }
  if (response.status >= 500 || response.status === 429) {
    return new MailProviderError("TEMPORARY", `Google : ${message}`, {
      status: response.status,
      code,
    });
  }
  return new MailProviderError("AUTH", `Google : ${message}`, {
    status: response.status,
    code,
  });
}

function tokensFrom(body, now = Date.now()) {
  const expiresIn = Number(body?.expires_in);
  return {
    accessToken: body?.access_token || null,
    refreshToken: body?.refresh_token || null,
    expiresAt: Number.isFinite(expiresIn)
      ? new Date(now + expiresIn * 1000)
      : null,
    scopes: String(body?.scope || "")
      .split(/\s+/)
      .filter(Boolean),
  };
}

/** Code d'autorisation → jetons et droits accordés. */
export async function exchangeCode(code) {
  const { clientId, clientSecret } = credentials();
  const response = await request(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: googleRedirectUri(),
        grant_type: "authorization_code",
      }).toString(),
    },
    "Google",
  );
  if (!response.ok) throw await tokenError(response);
  return tokensFrom(await readJson(response));
}

/** Adresse et nom de la boîte. */
export async function getUserInfo(accessToken) {
  const response = await request(
    USERINFO_URL,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    "Google",
  );
  if (!response.ok) {
    throw new MailProviderError(
      response.status === 401 ? "AUTH" : "TEMPORARY",
      `Google : profil illisible (HTTP ${response.status})`,
      { status: response.status },
    );
  }
  const body = await readJson(response);
  return {
    email: String(body?.email || "")
      .trim()
      .toLowerCase(),
    name: body?.name || null,
  };
}

/** Nouveau jeton d'accès à partir du jeton de rafraîchissement. */
export async function refreshAccessToken(refreshToken) {
  if (!refreshToken) {
    throw new MailProviderError(
      "AUTH",
      "Google : aucun jeton de rafraîchissement",
    );
  }
  const { clientId, clientSecret } = credentials();
  const response = await request(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }).toString(),
    },
    "Google",
  );
  if (!response.ok) throw await tokenError(response);
  return tokensFrom(await readJson(response));
}

/** Révoque l'accès chez Google (sans erreur si c'est déjà fait). */
export async function revokeToken(token) {
  if (!token) return false;
  try {
    const response = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Classe une erreur de l'API Gmail. */
export function classifyGmailError(status, body) {
  const error = body?.error || {};
  const reason = String(error.errors?.[0]?.reason || error.status || "");
  const message = String(error.message || `HTTP ${status}`);
  const details = { status, code: reason || null };
  if (status === 401) {
    return new MailProviderError("AUTH", `Gmail : ${message}`, details);
  }
  if (
    status === 429 ||
    QUOTA_REASONS.has(reason) ||
    /quota|limit exceeded|sending limit/i.test(message)
  ) {
    return new MailProviderError("QUOTA", `Gmail : ${message}`, details);
  }
  // Refus propre au compte (Gmail désactivé, règle du domaine) : la boîte
  // ne peut rien envoyer, aucun destinataire n'est en cause
  if (
    ACCOUNT_REASONS.has(reason) ||
    /precondition check failed|mail service not enabled|gmail.*(disabled|not enabled)/i.test(
      message,
    )
  ) {
    return new MailProviderError("ACCOUNT", `Gmail : ${message}`, details);
  }
  if (status === 403) {
    return new MailProviderError("AUTH", `Gmail : ${message}`, details);
  }
  if (status === 400) {
    const recipient =
      /recipient|address|to header|invalid to|destinataire/i.test(message);
    return new MailProviderError(
      recipient ? "RECIPIENT" : "PERMANENT",
      `Gmail : ${message}`,
      details,
    );
  }
  // Passerelle sans réponse : Gmail a pu traiter l'envoi
  if (status === 502 || status === 504) {
    return new MailProviderError("UNCERTAIN", `Gmail : ${message}`, details);
  }
  if (status >= 500 || status === 408) {
    return new MailProviderError("TEMPORARY", `Gmail : ${message}`, details);
  }
  return new MailProviderError("PERMANENT", `Gmail : ${message}`, details);
}

/**
 * Envoie un message MIME depuis la boîte : { providerMessageId, threadId }.
 */
export async function sendMessage({ accessToken, mime }) {
  const response = await request(
    SEND_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        raw: Buffer.from(mime, "utf8").toString("base64url"),
      }),
    },
    "Gmail",
    { sending: true },
  );
  const body = await readJson(response);
  if (!response.ok) throw classifyGmailError(response.status, body);
  return {
    providerMessageId: body?.id || null,
    threadId: body?.threadId || null,
  };
}
