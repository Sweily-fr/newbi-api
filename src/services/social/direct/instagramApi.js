import { isVideoMedia, videoCoverOffsetMs } from "../socialPostRules.js";
import { classifyMetaError, graphVersion } from "./metaApi.js";
import {
  DirectApiError,
  configError,
  directRequest,
  timing,
} from "./directHttp.js";

/**
 * Comptes Instagram professionnels par « Instagram API with Instagram
 * Login » (produit Instagram de la même appli Meta, identifiants
 * INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET affichés dans ce produit).
 *
 * Choisi plutôt que la connexion par Facebook : pas de Page Facebook liée
 * à exiger du client, et pas de permissions publicitaires (ads_management,
 * ads_read) quand son rôle sur la Page vient du Business Manager.
 *
 * Vidéo : publiée en Reel (media_type REELS, share_to_feed), en deux temps
 * (le traitement chez Meta prend souvent plus d'une minute) : publish crée
 * le conteneur, checkPublication lit son statut (une lecture par minute,
 * conseil de Meta) et le publie quand il est prêt.
 *
 * Jeton utilisateur longue durée (60 jours), rafraîchi tant qu'il est
 * valide et vieux d'au moins 24 h : on le rafraîchit 15 jours avant son
 * expiration, même sans publication (cron).
 * Doc : developers.facebook.com/docs/instagram-platform/
 * instagram-api-with-instagram-login/business-login, /content-publishing
 */

export const NETWORK = "instagram";
export const PLATFORMS = ["instagram"];

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_URL = "https://graph.instagram.com";
const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
];
const CONTAINER_POLL_ATTEMPTS = 10;
const CONTAINER_POLL_DELAY_MS = 3000;
const PUBLISH_TIMEOUT_MS = 60000;
// Reel : statut du conteneur lu une fois par minute (conseil de Meta)
const VIDEO_CHECK_MS = 60 * 1000;
// Au-delà, la vidéo est considérée comme non traitée par Meta
export const MAX_PROCESSING_MS = 30 * 60 * 1000;
// Rafraîchi 15 jours avant l'expiration (au-delà de 60 jours sans
// rafraîchissement, le jeton est perdu)
export const REFRESH_AHEAD_MS = 15 * 24 * 60 * 60 * 1000;

export const isConfigured = () =>
  Boolean(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET);

/**
 * Erreurs de api.instagram.com (format « error_type / error_message ») et
 * de graph.instagram.com (format Graph).
 */
function classifyInstagramError(response, data, label) {
  if (data?.error_type || data?.error_message) {
    const authInvalid =
      response.status === 400 ||
      response.status === 401 ||
      response.status === 403;
    return new DirectApiError(
      `instagram ${label} : ${data.error_message || data.error_type}`,
      {
        network: NETWORK,
        status: response.status,
        code: data.code ?? null,
        category: authInvalid ? "auth_expired" : null,
        authInvalid,
        transient: response.status >= 500,
      },
    );
  }
  return classifyMetaError(response, data, label, NETWORK);
}

const graph = (method, path, { token, query, json, timeoutMs } = {}) =>
  directRequest({
    network: NETWORK,
    method,
    url: `${GRAPH_URL}/${graphVersion()}/${path}`,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    query,
    json,
    timeoutMs,
    check: classifyInstagramError,
  });

// ── Connexion ──────────────────────────────────────────────────────────────

export function buildAuthorizeUrl({ state, redirectUri }) {
  if (!isConfigured()) throw configError(NETWORK, "INSTAGRAM_APP_ID absente");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", process.env.INSTAGRAM_APP_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

const expiresAt = (seconds, now = new Date()) =>
  Number(seconds) > 0 ? new Date(now.getTime() + Number(seconds) * 1000) : null;

/** Code de retour → le compte Instagram professionnel connecté. */
export async function exchangeCode({ code, redirectUri, now = new Date() }) {
  if (!isConfigured()) throw configError(NETWORK, "INSTAGRAM_APP_ID absente");
  // Instagram ajoute parfois « #_ » au code
  const cleanCode = String(code || "").replace(/#_$/, "");
  const { data } = await directRequest({
    network: NETWORK,
    method: "POST",
    url: TOKEN_URL,
    form: {
      client_id: process.env.INSTAGRAM_APP_ID,
      client_secret: process.env.INSTAGRAM_APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code: cleanCode,
    },
    check: classifyInstagramError,
  });
  const short = Array.isArray(data?.data) ? data.data[0] : data;
  if (!short?.access_token) {
    throw new DirectApiError("instagram : jeton absent de la réponse", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  const { data: long } = await directRequest({
    network: NETWORK,
    method: "GET",
    url: `${GRAPH_URL}/access_token`,
    query: {
      grant_type: "ig_exchange_token",
      client_secret: process.env.INSTAGRAM_APP_SECRET,
      access_token: short.access_token,
    },
    check: classifyInstagramError,
  });
  const accessToken = long?.access_token || short.access_token;
  const { data: me } = await graph("GET", "me", {
    token: accessToken,
    query: { fields: "user_id,username,name,profile_picture_url,account_type" },
  });
  // user_id : identifiant du compte professionnel (celui des publications)
  const accountId = me?.user_id || short.user_id || me?.id;
  if (!accountId) {
    throw new DirectApiError("instagram : compte sans identifiant", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return {
    accounts: [
      {
        platform: "instagram",
        externalAccountId: String(accountId),
        username: me?.username || null,
        displayName: me?.name || me?.username || null,
        avatarUrl: me?.profile_picture_url || null,
        credentials: {
          accessToken,
          tokenExpiresAt: expiresAt(long?.expires_in, now),
          scopes: Array.isArray(short.permissions)
            ? short.permissions
            : String(short.permissions || "")
                .split(",")
                .filter(Boolean),
        },
        credentialGroup: null,
        platformData: { accountType: me?.account_type || null },
      },
    ],
  };
}

/** Rafraîchit le jeton longue durée lui-même (pas de jeton de rafraîchissement). */
export async function refreshCredentials({ accessToken, now = new Date() }) {
  const { data } = await directRequest({
    network: NETWORK,
    method: "GET",
    url: `${GRAPH_URL}/refresh_access_token`,
    query: { grant_type: "ig_refresh_token", access_token: accessToken },
    check: classifyInstagramError,
  });
  if (!data?.access_token) {
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

// ── Publication ────────────────────────────────────────────────────────────

/**
 * Conteneur en erreur → DirectApiError classée (« status » porte le
 * sous-code, ex. 2207009 : format). Vidéo : refus de la vidéo.
 */
function containerError(data, { video = false } = {}) {
  const subcode = Number(String(data?.status || "").match(/\d{7}/)?.[0]);
  const error = classifyMetaError(
    { ok: false, status: 400, headers: null },
    {
      error: {
        message: data?.status || "Conteneur en erreur",
        code: 100,
        error_subcode: subcode || null,
      },
    },
    "container",
    NETWORK,
  );
  if (
    video &&
    !error.transient &&
    !error.authInvalid &&
    ["platform_rejected", "user_content"].includes(error.category)
  ) {
    error.category = "video_rejected";
  }
  return error;
}

/** Attend qu'un conteneur soit prêt (FINISHED). */
async function waitForContainer(containerId, token) {
  for (let attempt = 1; attempt <= CONTAINER_POLL_ATTEMPTS; attempt += 1) {
    const { data } = await graph("GET", containerId, {
      token,
      query: { fields: "status_code,status" },
    });
    const status = data?.status_code;
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR") throw containerError(data);
    if (status === "EXPIRED") {
      throw new DirectApiError("instagram : conteneur expiré", {
        network: NETWORK,
        transient: true,
      });
    }
    await timing.sleep(CONTAINER_POLL_DELAY_MS);
  }
  throw new DirectApiError("instagram : conteneur pas encore prêt", {
    network: NETWORK,
    transient: true,
  });
}

async function createContainer(igUserId, accessToken, json) {
  const { data } = await graph("POST", `${igUserId}/media`, {
    token: accessToken,
    json,
    timeoutMs: PUBLISH_TIMEOUT_MS,
  });
  if (!data?.id) {
    throw new DirectApiError("instagram : conteneur sans identifiant", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return String(data.id);
}

/** Publie un conteneur prêt, puis lit l'adresse du post (au mieux). */
async function publishContainer(igUserId, containerId, accessToken) {
  const { data } = await graph("POST", `${igUserId}/media_publish`, {
    token: accessToken,
    json: { creation_id: containerId },
    timeoutMs: PUBLISH_TIMEOUT_MS,
  });
  if (!data?.id) {
    throw new DirectApiError("instagram : publication sans identifiant", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  let platformPostUrl = null;
  try {
    const { data: info } = await graph("GET", String(data.id), {
      token: accessToken,
      query: { fields: "permalink" },
    });
    platformPostUrl = info?.permalink || null;
  } catch {
    // Publié : l'adresse manquante ne doit pas faire croire à un échec
  }
  return {
    status: "published",
    externalPostId: String(data.id),
    platformPostUrl,
  };
}

/**
 * Reel : conteneur créé (Instagram va chercher la vidéo à notre adresse),
 * publié plus tard par checkPublication.
 */
async function publishReel({ account, accessToken, content, video }) {
  const containerId = await createContainer(
    account.externalAccountId,
    accessToken,
    {
      media_type: "REELS",
      video_url: video.url,
      share_to_feed: true,
      thumb_offset: videoCoverOffsetMs(video.durationMs),
      ...(content ? { caption: content } : {}),
    },
  );
  return {
    status: "publishing",
    externalPostId: null,
    processingRef: containerId,
    platformPostUrl: null,
    nextCheckMs: VIDEO_CHECK_MS,
  };
}

/**
 * Suivi d'un Reel : conteneur prêt → publié ; en cours → à relire ; en
 * erreur → refus ; expiré (jamais publié) → publication à reprendre.
 */
export async function checkPublication({
  account,
  accessToken,
  processingRef,
}) {
  const { data } = await graph("GET", processingRef, {
    token: accessToken,
    query: { fields: "status_code,status" },
  });
  const status = data?.status_code;
  if (status === "FINISHED") {
    return publishContainer(
      account.externalAccountId,
      processingRef,
      accessToken,
    );
  }
  if (status === "PUBLISHED") {
    // Publié au tour précédent (réponse perdue) : identifiant inconnu
    return { status: "published", externalPostId: null, platformPostUrl: null };
  }
  if (status === "ERROR") throw containerError(data, { video: true });
  if (status === "EXPIRED") {
    throw new DirectApiError("instagram : conteneur expiré", {
      network: NETWORK,
      transient: true,
      restart: true,
    });
  }
  return { status: "publishing", nextCheckMs: VIDEO_CHECK_MS };
}

/**
 * Publie une image ou un carrousel (2 à 10 images), ou lance un Reel (une
 * vidéo). Les médias doivent être à une adresse publique (Instagram va les
 * chercher).
 */
export async function publish({ account, accessToken, content, media }) {
  if (media.length === 1 && isVideoMedia(media[0])) {
    return publishReel({ account, accessToken, content, video: media[0] });
  }
  const igUserId = account.externalAccountId;
  const create = (json) => createContainer(igUserId, accessToken, json);

  let containerId;
  if (media.length === 1) {
    containerId = await create({
      image_url: media[0].url,
      ...(content ? { caption: content } : {}),
    });
  } else {
    const children = [];
    for (const item of media) {
      children.push(
        await create({ image_url: item.url, is_carousel_item: true }),
      );
    }
    containerId = await create({
      media_type: "CAROUSEL",
      children: children.join(","),
      ...(content ? { caption: content } : {}),
    });
  }
  await waitForContainer(containerId, accessToken);
  return publishContainer(igUserId, containerId, accessToken);
}

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
  maxProcessingMs: MAX_PROCESSING_MS,
};
