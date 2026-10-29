import storage from "../socialMediaStorage.js";
import {
  DirectApiError,
  configError,
  directRequest,
  readHeader,
} from "./directHttp.js";

/**
 * X : OAuth 2.0 avec PKCE (client confidentiel, offline.access), envoi
 * d'image par l'API média v2, post par POST /2/tweets.
 *
 * Chaque création de post est facturée à Sweily (0,015 $, 0,20 $ si le
 * texte contient un lien) : limite mensuelle par offre dans xPostQuota.js,
 * comptée sur les cibles X des posts (pas ici).
 *
 * Jeton d'accès de 2 h ; le jeton de rafraîchissement tourne (on garde
 * toujours le dernier reçu, rafraîchissements sérialisés par compte).
 * En local, X refuse « localhost » dans l'adresse de retour : utiliser
 * NEXT_PUBLIC_API_URL=http://127.0.0.1:4000.
 * Doc : docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code,
 * /x-api/media/upload-media, /x-api/posts/create-post
 */

export const NETWORK = "x";
export const PLATFORMS = ["twitter"];

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const API_URL = "https://api.x.com/2";
const SCOPES = [
  "tweet.read",
  "tweet.write",
  "users.read",
  "media.write",
  "offline.access",
];
const PUBLISH_TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 60000;

export const isConfigured = () =>
  Boolean(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET);

// ── Erreurs ────────────────────────────────────────────────────────────────

/** Délai avant la remise à zéro annoncée (x-rate-limit-reset, secondes). */
function retryAfterFromReset(response) {
  const reset = Number(readHeader(response, "x-rate-limit-reset"));
  if (!Number.isFinite(reset) || reset <= 0) return null;
  const delay = reset * 1000 - Date.now();
  return delay > 0 ? delay : null;
}

/** Réponse X (format « Problem ») → DirectApiError classée. */
export function classifyXError(response, data, label = "") {
  if (response.ok && !(data?.errors && !data?.data)) return null;
  const status = response.status;
  const problem = Array.isArray(data?.errors) ? data.errors[0] : data;
  const type = String(problem?.type || "");
  const detail =
    problem?.detail ||
    problem?.message ||
    data?.error_description ||
    data?.title ||
    data?.error ||
    null;
  const base = {
    network: NETWORK,
    status,
    code: type || data?.error || null,
    detail,
  };
  const make = (fields) =>
    new DirectApiError(`x ${label} : ${detail || `HTTP ${status}`}`, {
      ...base,
      ...fields,
    });

  if (status === 401 || data?.error === "invalid_grant") {
    return make({ category: "auth_expired", authInvalid: true });
  }
  if (
    status === 402 ||
    type.endsWith("/usage-capped") ||
    /credit/i.test(detail || "")
  ) {
    // Crédits de Sweily épuisés ou plafond de dépense atteint
    return make({ category: "quota_exhausted" });
  }
  if (status === 429) {
    return make({
      category: "platform_rate_limit",
      transient: true,
      retryAfterMs: retryAfterFromReset(response),
    });
  }
  if (status === 403) {
    if (/duplicate/i.test(detail || ""))
      return make({ category: "user_content" });
    if (type.endsWith("/client-forbidden")) {
      return make({ category: "platform_rejected" });
    }
    return make({ category: "auth_expired", authInvalid: true });
  }
  if (status === 400) return make({ category: "user_content" });
  if (status >= 500) return make({ transient: true });
  return make({ category: "platform_rejected" });
}

const basicAuth = () =>
  `Basic ${Buffer.from(
    `${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`,
  ).toString("base64")}`;

// ── Connexion ──────────────────────────────────────────────────────────────

export function buildAuthorizeUrl({ state, redirectUri, codeChallenge }) {
  if (!isConfigured()) throw configError(NETWORK, "X_CLIENT_ID absente");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.X_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

const secondsFromNow = (seconds, now) =>
  Number(seconds) > 0 ? new Date(now.getTime() + Number(seconds) * 1000) : null;

async function tokenRequest(form, now) {
  const { data } = await directRequest({
    network: NETWORK,
    method: "POST",
    url: `${API_URL}/oauth2/token`,
    headers: { Authorization: basicAuth() },
    form,
    check: classifyXError,
  });
  if (!data?.access_token) {
    throw new DirectApiError("x : jeton absent de la réponse", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    tokenExpiresAt: secondsFromNow(data.expires_in || 7200, now),
    refreshTokenExpiresAt: null,
    scopes: String(data.scope || "")
      .split(" ")
      .filter(Boolean),
  };
}

export async function exchangeCode({
  code,
  redirectUri,
  codeVerifier,
  now = new Date(),
}) {
  if (!isConfigured()) throw configError(NETWORK, "X_CLIENT_ID absente");
  const credentials = await tokenRequest(
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    },
    now,
  );
  const { data } = await directRequest({
    network: NETWORK,
    url: `${API_URL}/users/me`,
    headers: { Authorization: `Bearer ${credentials.accessToken}` },
    query: { "user.fields": "profile_image_url" },
    check: classifyXError,
  });
  const user = data?.data;
  if (!user?.id) {
    throw new DirectApiError("x : compte sans identifiant", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return {
    accounts: [
      {
        platform: "twitter",
        externalAccountId: String(user.id),
        username: user.username || null,
        displayName: user.name || user.username || null,
        avatarUrl: user.profile_image_url || null,
        credentials,
        credentialGroup: null,
        platformData: null,
      },
    ],
  };
}

export async function refreshCredentials({ refreshToken, now = new Date() }) {
  if (!refreshToken) {
    throw new DirectApiError("x : pas de jeton de rafraîchissement", {
      network: NETWORK,
      kind: "auth",
      category: "auth_expired",
      authInvalid: true,
    });
  }
  return tokenRequest(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    now,
  );
}

/** Révocation à la déconnexion (au mieux). */
export async function revoke({ accessToken, refreshToken }) {
  for (const token of [refreshToken, accessToken].filter(Boolean)) {
    await directRequest({
      network: NETWORK,
      method: "POST",
      url: `${API_URL}/oauth2/revoke`,
      headers: { Authorization: basicAuth() },
      form: { token },
      check: classifyXError,
    });
  }
}

// ── Publication ────────────────────────────────────────────────────────────

async function uploadImage(token, media) {
  const { buffer, contentType } = await storage.fetchImage(media.url);
  const form = new FormData();
  form.append(
    "media",
    new Blob([buffer], { type: contentType || "image/jpeg" }),
    "image.jpg",
  );
  form.append("media_category", "tweet_image");
  const { data } = await directRequest({
    network: NETWORK,
    method: "POST",
    url: `${API_URL}/media/upload`,
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    check: classifyXError,
  });
  const id = data?.data?.id || data?.data?.media_id || data?.media_id_string;
  if (!id) {
    throw new DirectApiError("x : média sans identifiant", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return String(id);
}

export async function publish({ account, accessToken, content, media }) {
  const mediaIds = [];
  for (const item of media) mediaIds.push(await uploadImage(accessToken, item));
  const body = {};
  if (content) body.text = content;
  if (mediaIds.length) body.media = { media_ids: mediaIds };
  const { data } = await directRequest({
    network: NETWORK,
    method: "POST",
    url: `${API_URL}/tweets`,
    headers: { Authorization: `Bearer ${accessToken}` },
    json: body,
    timeoutMs: PUBLISH_TIMEOUT_MS,
    check: classifyXError,
  });
  const id = data?.data?.id;
  if (!id) {
    throw new DirectApiError("x : post sans identifiant", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return {
    status: "published",
    externalPostId: String(id),
    platformPostUrl: account.username
      ? `https://x.com/${account.username}/status/${id}`
      : `https://x.com/i/web/status/${id}`,
  };
}

export default {
  NETWORK,
  PLATFORMS,
  usesPkce: true,
  isConfigured,
  buildAuthorizeUrl,
  exchangeCode,
  refreshCredentials,
  publish,
  revoke,
};
