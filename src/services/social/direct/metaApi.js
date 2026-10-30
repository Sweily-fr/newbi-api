import { isVideoMedia } from "../socialPostRules.js";
import { DirectApiError, configError, directRequest } from "./directHttp.js";

/**
 * Pages Facebook par l'API Graph de Meta (Facebook Login for Business).
 * Instagram passe par sa propre connexion (instagramApi.js, Instagram
 * Login), dans la même appli Meta : ni Page Facebook liée, ni permissions
 * publicitaires exigées quand le rôle vient du Business Manager.
 *
 * Connexion : le client choisit ses pages dans la fenêtre Meta ; on échange
 * le code contre un jeton utilisateur, puis contre un jeton longue durée,
 * dont on tire les jetons de page (/me/accounts, sans date d'expiration).
 * Seuls les jetons de page sont gardés (chiffrés) : un compte par page.
 *
 * Vidéo : vidéo de page (POST graph-video.facebook.com/<page>/videos,
 * file_url = notre route .mp4), publiée dès la réponse ; Facebook la traite
 * ensuite de son côté (1 Go et 20 minutes au plus par adresse).
 *
 * Version de l'API épinglée par META_GRAPH_VERSION.
 * Doc : developers.facebook.com/docs/pages-api/posts,
 * /docs/graph-api/reference/page/videos/, /docs/video-api/guides/publishing,
 * /docs/facebook-login/facebook-login-for-business
 */

export const NETWORK = "meta";
export const PLATFORMS = ["facebook"];

const DEFAULT_GRAPH_VERSION = "v26.0";
const GRAPH_URL = "https://graph.facebook.com";
const GRAPH_VIDEO_URL = "https://graph-video.facebook.com";
const DIALOG_URL = "https://www.facebook.com";
const PUBLISH_TIMEOUT_MS = 60000;
// Facebook va chercher la vidéo pendant la requête
const VIDEO_PUBLISH_TIMEOUT_MS = 90000;

// Permissions demandées (vérifiées par l'App Review de Meta)
const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
];
const PUBLISHING_TASKS = new Set(["CREATE_CONTENT", "MANAGE"]);

export const isConfigured = () =>
  Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);

export const graphVersion = () =>
  (process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION).trim();

// ── Erreurs ────────────────────────────────────────────────────────────────

const AUTH_CODES = new Set([102, 190, 3, 10]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 341, 80001, 80002]);
const TRANSIENT_CODES = new Set([1, 2, -1]);
const TRANSIENT_SUBCODES = new Set([
  2207001, 2207003, 2207006, 2207008, 2207020, 2207027, 2207032, 2207053,
]);
const CONTENT_SUBCODES = new Set([
  2207004, 2207005, 2207009, 2207010, 2207028, 2207040, 2207052,
]);
const CONTENT_CODES = new Set([324, 506, 9004, 36000, 36001, 36003, 36004]);
// Vidéos : fichier refusé (format, fichier endommagé…) ; vidéo introuvable
// à l'adresse donnée ou envoi interrompu chez Facebook (passagers)
const VIDEO_CONTENT_CODES = new Set([351, 352, 353, 356, 357]);
const VIDEO_TRANSIENT_CODES = new Set([389, 390, 6000, 6001]);

/** Délai annoncé par X-Business-Use-Case-Usage (minutes), en ms. */
function retryAfterFromUsage(response) {
  try {
    const raw = response?.headers?.get?.("x-business-use-case-usage");
    if (!raw) return null;
    const usage = JSON.parse(raw);
    const minutes = Object.values(usage)
      .flat()
      .map((entry) => Number(entry?.estimated_time_to_regain_access) || 0);
    const max = Math.max(0, ...minutes);
    return max > 0 ? max * 60 * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Erreur Graph → DirectApiError classée (null si la réponse est bonne).
 * Même format chez graph.instagram.com (instagramApi.js).
 */
export function classifyMetaError(
  response,
  data,
  label = "",
  network = NETWORK,
) {
  const error = data?.error;
  if (response.ok && !error) return null;
  const code = Number(error?.code);
  const subcode = Number(error?.error_subcode) || null;
  const message = error?.message || `HTTP ${response.status}`;
  const detail = error?.error_user_msg || error?.message || null;
  const base = {
    network,
    status: response.status,
    code: Number.isFinite(code) ? code : null,
    subcode,
    detail,
  };
  const make = (fields) =>
    new DirectApiError(`${network} ${label} : ${message}`, {
      ...base,
      ...fields,
    });

  // Sous-codes Instagram d'abord (le code 4 sert aussi au spam, le 9 au quota)
  if (subcode === 2207042) return make({ category: "quota_exhausted" });
  if (subcode === 2207051) return make({ category: "user_abuse" });
  if (subcode === 2207050) return make({ category: "account_issue" });
  if (subcode && CONTENT_SUBCODES.has(subcode)) {
    return make({ category: "user_content" });
  }
  if (subcode && TRANSIENT_SUBCODES.has(subcode)) {
    return make({ transient: true });
  }
  if (
    AUTH_CODES.has(code) ||
    (code >= 200 && code <= 299) ||
    response.status === 401
  ) {
    return make({ category: "auth_expired", authInvalid: true });
  }
  if (RATE_LIMIT_CODES.has(code)) {
    return make({
      category: "platform_rate_limit",
      transient: true,
      retryAfterMs: retryAfterFromUsage(response),
    });
  }
  if (code === 368) return make({ category: "user_abuse" });
  if (CONTENT_CODES.has(code)) return make({ category: "user_content" });
  if (VIDEO_CONTENT_CODES.has(code))
    return make({ category: "video_rejected" });
  if (VIDEO_TRANSIENT_CODES.has(code)) return make({ transient: true });
  if (TRANSIENT_CODES.has(code) || response.status >= 500) {
    return make({ transient: true });
  }
  return make({ category: "platform_rejected" });
}

const graph = (
  method,
  path,
  { token, query, form, timeoutMs, host = GRAPH_URL } = {},
) =>
  directRequest({
    network: NETWORK,
    method,
    url: `${host}/${graphVersion()}/${path}`,
    // Jeton en paramètre (méthode documentée) ; jamais journalisé
    query: method === "GET" ? { ...query, access_token: token } : query,
    form: method === "GET" ? undefined : { ...form, access_token: token },
    timeoutMs,
    check: classifyMetaError,
  });

// ── Connexion ──────────────────────────────────────────────────────────────

/**
 * Adresse de la fenêtre de connexion Meta. META_LOGIN_CONFIG_ID (la
 * configuration Facebook Login for Business, qui porte les permissions)
 * est recommandé par Meta ; sans lui, les permissions passent par scope.
 */
export function buildAuthorizeUrl({ state, redirectUri }) {
  if (!isConfigured()) throw configError(NETWORK, "META_APP_ID absente");
  const url = new URL(`${DIALOG_URL}/${graphVersion()}/dialog/oauth`);
  url.searchParams.set("client_id", process.env.META_APP_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  const configId = (process.env.META_LOGIN_CONFIG_ID || "").trim();
  if (configId) {
    url.searchParams.set("config_id", configId);
  } else {
    url.searchParams.set("scope", FACEBOOK_SCOPES.join(","));
  }
  return url.toString();
}

async function listPages(userToken) {
  const pages = [];
  let after = null;
  for (let page = 0; page < 5; page += 1) {
    const { data } = await graph("GET", "me/accounts", {
      token: userToken,
      query: {
        fields: "id,name,access_token,tasks,picture{url}",
        limit: 100,
        after,
      },
    });
    pages.push(...(data?.data || []));
    after = data?.paging?.next ? data?.paging?.cursors?.after : null;
    if (!after) break;
  }
  return pages;
}

/** Code de retour → une page Facebook connectée par page accordée. */
export async function exchangeCode({ code, redirectUri }) {
  if (!isConfigured()) throw configError(NETWORK, "META_APP_ID absente");
  const { data: short } = await graph("GET", "oauth/access_token", {
    query: {
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: redirectUri,
      code,
    },
  });
  if (!short?.access_token) {
    throw new DirectApiError("meta : jeton absent de la réponse", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  const { data: long } = await graph("GET", "oauth/access_token", {
    query: {
      grant_type: "fb_exchange_token",
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: short.access_token,
    },
  });
  const userToken = long?.access_token || short.access_token;
  const pages = await listPages(userToken);

  const accounts = [];
  for (const page of pages) {
    const tasks = Array.isArray(page.tasks) ? page.tasks : [];
    if (
      !page.access_token ||
      !tasks.some((task) => PUBLISHING_TASKS.has(task))
    ) {
      continue;
    }
    accounts.push({
      platform: "facebook",
      externalAccountId: String(page.id),
      username: null,
      displayName: page.name || null,
      avatarUrl: page.picture?.data?.url || null,
      credentials: { accessToken: page.access_token, tokenExpiresAt: null },
      credentialGroup: null,
      platformData: null,
    });
  }
  return { accounts };
}

/** Les jetons de page n'expirent pas : rien à rafraîchir. */
export async function refreshCredentials() {
  throw new DirectApiError("meta : jeton de page non rafraîchissable", {
    network: NETWORK,
    kind: "auth",
    category: "auth_expired",
    authInvalid: true,
  });
}

// ── Publication ────────────────────────────────────────────────────────────

async function permalink(id, token, field) {
  try {
    const { data } = await graph("GET", id, {
      token,
      query: { fields: field },
    });
    return data?.[field] || null;
  } catch {
    // Publié : l'adresse manquante ne doit pas faire croire à un échec
    return null;
  }
}

/** Adresse absolue (permalink_url d'une vidéo est parfois relative). */
const absoluteFacebookUrl = (url) => {
  if (!url) return null;
  return url.startsWith("/") ? `https://www.facebook.com${url}` : url;
};

/** Vidéo de page : Facebook va la chercher à notre adresse. */
async function publishFacebookVideo({ account, accessToken, content, video }) {
  const { data } = await graph("POST", `${account.externalAccountId}/videos`, {
    host: GRAPH_VIDEO_URL,
    token: accessToken,
    form: {
      file_url: video.url,
      description: content || undefined,
      published: "true",
    },
    timeoutMs: VIDEO_PUBLISH_TIMEOUT_MS,
  });
  const videoId = data?.id || data?.video_id;
  if (!videoId) {
    throw new DirectApiError("meta : vidéo sans identifiant", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return {
    status: "published",
    externalPostId: String(videoId),
    platformPostUrl: absoluteFacebookUrl(
      await permalink(String(videoId), accessToken, "permalink_url"),
    ),
  };
}

async function publishFacebook({ account, accessToken, content, media }) {
  if (media.length === 1 && isVideoMedia(media[0])) {
    return publishFacebookVideo({
      account,
      accessToken,
      content,
      video: media[0],
    });
  }
  const pageId = account.externalAccountId;
  let postId;
  if (media.length === 0) {
    const { data } = await graph("POST", `${pageId}/feed`, {
      token: accessToken,
      form: { message: content },
      timeoutMs: PUBLISH_TIMEOUT_MS,
    });
    postId = data?.id;
  } else if (media.length === 1) {
    const { data } = await graph("POST", `${pageId}/photos`, {
      token: accessToken,
      form: { url: media[0].url, caption: content || undefined },
      timeoutMs: PUBLISH_TIMEOUT_MS,
    });
    postId = data?.post_id || data?.id;
  } else {
    // Plusieurs photos : déposées sans être publiées, puis un seul post
    const photoIds = [];
    for (const item of media) {
      const { data } = await graph("POST", `${pageId}/photos`, {
        token: accessToken,
        form: { url: item.url, published: "false" },
        timeoutMs: PUBLISH_TIMEOUT_MS,
      });
      if (!data?.id) {
        throw new DirectApiError("meta : photo sans identifiant", {
          network: NETWORK,
          status: 502,
          transient: true,
        });
      }
      photoIds.push(data.id);
    }
    const form = { message: content || undefined };
    photoIds.forEach((id, index) => {
      form[`attached_media[${index}]`] = JSON.stringify({ media_fbid: id });
    });
    const { data } = await graph("POST", `${pageId}/feed`, {
      token: accessToken,
      form,
      timeoutMs: PUBLISH_TIMEOUT_MS,
    });
    postId = data?.id;
  }
  if (!postId) {
    throw new DirectApiError("meta : post sans identifiant", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return {
    status: "published",
    externalPostId: String(postId),
    platformPostUrl: await permalink(postId, accessToken, "permalink_url"),
  };
}

/**
 * Publie tout de suite sur une page Facebook.
 * media : [{ url, width, height }] (adresses publiques), ou une vidéo
 * [{ kind: "video", url }].
 */
export const publish = (params) => publishFacebook(params);

export default {
  NETWORK,
  PLATFORMS,
  usesPkce: false,
  isConfigured,
  buildAuthorizeUrl,
  exchangeCode,
  refreshCredentials,
  publish,
};
