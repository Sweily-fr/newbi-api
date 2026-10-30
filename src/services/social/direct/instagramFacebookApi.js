import { classifyMetaError, graphVersion } from "./metaApi.js";
import { DirectApiError, configError } from "./directHttp.js";
import { createInstagramPublisher } from "./instagramPublishing.js";

/**
 * Comptes Instagram professionnels connectés via Facebook (« Instagram API
 * with Facebook Login », Facebook Login for Business) : seul moyen
 * d'utiliser l'API Audio d'Instagram (son tendance sur les Reels). Le
 * compte doit être relié à une Page Facebook que l'utilisateur gère.
 *
 * Appli Meta : META_INSTAGRAM_FB_APP_ID / META_INSTAGRAM_FB_APP_SECRET
 * quand Instagram via Facebook vit dans une seconde appli (la relecture de
 * Meta peut refuser Facebook Login et Instagram Login dans la même appli),
 * sinon META_APP_ID / META_APP_SECRET (celle des Pages). Configuration
 * Facebook Login for Business propre : META_INSTAGRAM_LOGIN_CONFIG_ID
 * (sans elle, les permissions passent par scope).
 *
 * Jeton gardé : le jeton UTILISATEUR longue durée (l'API Audio exige « A
 * valid User access token », la publication accepte un jeton utilisateur
 * ou de Page), partagé par les comptes d'une même connexion
 * (credentialGroup). 60 jours, rafraîchi 15 jours avant par
 * fb_exchange_token (au mieux) ; sans expires_in (utilisateur système) :
 * pas d'expiration.
 *
 * Publication : mêmes appels qu'Instagram Login (instagramPublishing.js),
 * sur graph.facebook.com.
 * Doc : developers.facebook.com/docs/instagram-platform/
 * instagram-api-with-facebook-login/, /documentation/instagram-platform/
 * content-publishing/audio-api
 */

export const NETWORK = "instagram";
export const PLATFORMS = ["instagram"];

const GRAPH_URL = "https://graph.facebook.com";
const DIALOG_URL = "https://www.facebook.com";
const SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
];
const PUBLISHING_TASKS = new Set(["CREATE_CONTENT", "MANAGE"]);
// Pas de pagination documentée pour ig_audio : liste tronquée
const MAX_SOUNDS = 50;
export const SOUND_KINDS = ["music", "original_sound"];
// Au-delà, le Reel est considéré comme non traité par Meta
export const MAX_PROCESSING_MS = 30 * 60 * 1000;
// Rafraîchi 15 jours avant l'expiration (60 jours)
export const REFRESH_AHEAD_MS = 15 * 24 * 60 * 60 * 1000;

/**
 * Identifiants de l'appli Meta d'Instagram via Facebook : la paire dédiée
 * si elle est complète, sinon celle des Pages Facebook.
 * @returns {{appId: string, appSecret: string}|null}
 */
export function metaAppCredentials() {
  const appId = (process.env.META_INSTAGRAM_FB_APP_ID || "").trim();
  const appSecret = (process.env.META_INSTAGRAM_FB_APP_SECRET || "").trim();
  if (appId && appSecret) return { appId, appSecret };
  const fallbackId = (process.env.META_APP_ID || "").trim();
  const fallbackSecret = (process.env.META_APP_SECRET || "").trim();
  return fallbackId && fallbackSecret
    ? { appId: fallbackId, appSecret: fallbackSecret }
    : null;
}

export const isConfigured = () => Boolean(metaAppCredentials());

const classify = (response, data, label) =>
  classifyMetaError(response, data, label, NETWORK);

const publisher = createInstagramPublisher({
  network: NETWORK,
  graphUrl: GRAPH_URL,
  tokenIn: "query",
  classify,
  sounds: true,
});
const { graph } = publisher;

const missingConfig = () =>
  configError(NETWORK, "META_APP_ID (ou META_INSTAGRAM_FB_APP_ID) absente");

// ── Connexion ──────────────────────────────────────────────────────────────

export function buildAuthorizeUrl({ state, redirectUri }) {
  const app = metaAppCredentials();
  if (!app) throw missingConfig();
  const url = new URL(`${DIALOG_URL}/${graphVersion()}/dialog/oauth`);
  url.searchParams.set("client_id", app.appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  const configId = (process.env.META_INSTAGRAM_LOGIN_CONFIG_ID || "").trim();
  if (configId) {
    url.searchParams.set("config_id", configId);
  } else {
    url.searchParams.set("scope", SCOPES.join(","));
  }
  return url.toString();
}

const expiresAt = (seconds, now = new Date()) =>
  Number(seconds) > 0 ? new Date(now.getTime() + Number(seconds) * 1000) : null;

/** Jeton utilisateur → jeton longue durée (aussi le rafraîchissement). */
async function exchangeForLongLived(token, app) {
  const { data } = await graph("GET", "oauth/access_token", {
    query: {
      grant_type: "fb_exchange_token",
      client_id: app.appId,
      client_secret: app.appSecret,
      fb_exchange_token: token,
    },
  });
  return data || {};
}

async function listPagesWithInstagram(userToken) {
  const pages = [];
  let after = null;
  for (let page = 0; page < 5; page += 1) {
    const { data } = await graph("GET", "me/accounts", {
      token: userToken,
      query: {
        fields:
          "id,name,tasks,instagram_business_account{id,username,name,profile_picture_url}",
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

/**
 * Code de retour → un compte Instagram par Page qui en a un et où
 * l'utilisateur peut publier (tâche CREATE_CONTENT ou MANAGE). Aucun
 * compte : liste vide (erreur no_instagram_account côté connexion).
 */
export async function exchangeCode({ code, redirectUri, now = new Date() }) {
  const app = metaAppCredentials();
  if (!app) throw missingConfig();
  const { data: short } = await graph("GET", "oauth/access_token", {
    query: {
      client_id: app.appId,
      client_secret: app.appSecret,
      redirect_uri: redirectUri,
      code,
    },
  });
  if (!short?.access_token) {
    throw new DirectApiError("instagram : jeton absent de la réponse", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  const long = await exchangeForLongLived(short.access_token, app);
  const userToken = long.access_token || short.access_token;
  const tokenExpiresAt = long.access_token
    ? expiresAt(long.expires_in, now)
    : expiresAt(short.expires_in, now);
  const { data: me } = await graph("GET", "me", {
    token: userToken,
    query: { fields: "id" },
  });
  const metaUserId = me?.id ? String(me.id) : null;
  const pages = await listPagesWithInstagram(userToken);

  const accounts = [];
  const seen = new Set();
  for (const page of pages) {
    const instagram = page.instagram_business_account;
    const tasks = Array.isArray(page.tasks) ? page.tasks : [];
    if (
      !instagram?.id ||
      seen.has(String(instagram.id)) ||
      !tasks.some((task) => PUBLISHING_TASKS.has(task))
    ) {
      continue;
    }
    seen.add(String(instagram.id));
    accounts.push({
      platform: "instagram",
      externalAccountId: String(instagram.id),
      username: instagram.username || null,
      displayName: instagram.name || instagram.username || null,
      avatarUrl: instagram.profile_picture_url || null,
      credentials: { accessToken: userToken, tokenExpiresAt, scopes: [] },
      // Même jeton utilisateur pour tous les comptes de cette connexion
      credentialGroup: metaUserId ? `meta-user:${metaUserId}` : null,
      platformData: {
        pageId: String(page.id),
        pageName: page.name || null,
        metaUserId,
      },
    });
  }
  return { accounts };
}

/** Nouveau jeton longue durée à partir du jeton actuel (au mieux). */
export async function refreshCredentials({ accessToken, now = new Date() }) {
  const app = metaAppCredentials();
  if (!app) throw missingConfig();
  const data = await exchangeForLongLived(accessToken, app);
  if (!data.access_token) {
    throw new DirectApiError("instagram : jeton rafraîchi absent", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return {
    accessToken: data.access_token,
    tokenExpiresAt: expiresAt(data.expires_in, now),
  };
}

// ── Sons ───────────────────────────────────────────────────────────────────

const toSound = (audio) => ({
  id: String(audio.audio_id),
  title: audio.title || "Son sans titre",
  artist: audio.display_artist || audio.ig_username || null,
  coverUrl:
    audio.cover_artwork_thumbnail_uri ||
    audio.cover_artwork_thumbnail_url ||
    null,
  // Adresse temporaire (environ un jour et demi), jamais gardée
  previewUrl: audio.download_url || null,
  durationMs:
    Number(audio.duration_in_ms) > 0 ? Number(audio.duration_in_ms) : null,
  rank: null,
  kind: audio.audio_type || null,
});

/**
 * Sons utilisables par ce compte : tendances sans `search`, recherche par
 * mot sinon. kind : « music » (défaut) ou « original_sound ».
 */
export async function listSounds({
  account,
  accessToken,
  search = "",
  kind = "music",
}) {
  const { data } = await graph("GET", "ig_audio", {
    token: accessToken,
    query: {
      audio_type: SOUND_KINDS.includes(kind) ? kind : "music",
      user_id: account.externalAccountId,
      search_query: search || undefined,
    },
  });
  const list = Array.isArray(data?.audio)
    ? data.audio
    : Array.isArray(data?.data)
      ? data.data
      : [];
  return list
    .filter((audio) => audio?.audio_id)
    .slice(0, MAX_SOUNDS)
    .map(toSound);
}

// ── Publication ────────────────────────────────────────────────────────────

/** Photo, carrousel, Reel (avec son tendance) ou stories. */
export const { publish, checkPublication } = publisher;

export default {
  NETWORK,
  PLATFORMS,
  usesPkce: false,
  refreshAheadMs: REFRESH_AHEAD_MS,
  // Le jeton d'accès se rafraîchit lui-même
  refreshesAccessToken: true,
  isConfigured,
  buildAuthorizeUrl,
  exchangeCode,
  refreshCredentials,
  publish,
  checkPublication,
  listSounds,
  maxProcessingMs: MAX_PROCESSING_MS,
};
