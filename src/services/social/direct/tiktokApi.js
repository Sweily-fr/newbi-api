import storage from "../socialMediaStorage.js";
import {
  DRAFT_PENDING_LIMIT_MESSAGE,
  PLATFORM_RULES,
  isVideoMedia,
  validateTikTokVideoDuration,
  videoCoverOffsetMs,
} from "../socialPostRules.js";
import { DirectApiError, configError, directRequest } from "./directHttp.js";

/**
 * TikTok : Login Kit v2 (web, sans PKCE : le secret reste sur le serveur)
 * et Content Posting API, publication directe de photos (carrousel) ou
 * d'une vidéo.
 *
 * - creator_info est relu avant chaque publication (confidentialités
 *   proposées, commentaires, duos et collages coupés, durée maximale d'une
 *   vidéo, compte bloqué) ;
 * - la vidéo passe aussi par PULL_FROM_URL (notre route .mp4) ; titre de
 *   2 200 caractères UTF-16 au plus, couverture à la position de notre
 *   vignette ;
 * - les photos passent uniquement par PULL_FROM_URL, depuis un domaine
 *   vérifié chez TikTok (route /social-media de l'API sous newbi.fr), en
 *   JPEG de 1080p au plus ;
 * - la publication est asynchrone : publish_id, puis suivi du statut par le
 *   cron (socialDirectPublisher.js) ;
 * - brouillon (tiktokSettings.mode « draft », autorisation video.upload) :
 *   vidéo par /post/publish/inbox/video/init/, photos en MEDIA_UPLOAD ; le
 *   client reçoit une notification dans l'appli TikTok et y termine la
 *   publication (son, texte, confidentialité). Le statut SEND_TO_USER_INBOX
 *   termine la cible (deliveredAs « draft », pas d'adresse de post). 5
 *   brouillons en attente par 24 h au plus.
 * Client non audité : posts « Moi uniquement » sur compte privé seulement.
 *
 * Jeton d'accès de 24 h, jeton de rafraîchissement d'un an qui peut changer
 * à chaque rafraîchissement.
 * Doc : developers.tiktok.com/doc/login-kit-web,
 * /oauth-user-access-token-management, /content-posting-api-reference-
 * photo-post, /content-posting-api-reference-direct-post,
 * /content-posting-api-reference-query-creator-info,
 * /content-posting-api-reference-get-video-status,
 * /content-posting-api-reference-upload-video
 */

export const NETWORK = "tiktok";
export const PLATFORMS = ["tiktok"];

const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const API_URL = "https://open.tiktokapis.com/v2";
// video.upload : brouillons (les comptes connectés avant ne l'ont pas tant
// qu'ils ne se reconnectent pas)
const SCOPES = ["user.info.basic", "video.publish", "video.upload"];
const DESCRIPTION_MAX = 4000;

export const isConfigured = () =>
  Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);

// ── Erreurs ────────────────────────────────────────────────────────────────

const AUTH_CODES = new Set([
  "access_token_invalid",
  "scope_not_authorized",
  "scope_permission_missed",
  "invalid_grant",
  "auth_removed",
]);
const QUOTA_CODES = new Set([
  "spam_risk_too_many_posts",
  "reached_active_user_cap",
  "spam_risk_too_many_pending_share",
]);
const ABUSE_CODES = new Set([
  "spam_risk_user_banned_from_posting",
  "spam_risk_text",
  "spam_risk",
]);
const CONTENT_CODES = new Set([
  "invalid_param",
  "invalid_params",
  "privacy_level_option_mismatch",
  "file_format_check_failed",
  "picture_size_check_failed",
  "invalid_file_upload",
]);
// Vidéo refusée par TikTok (fail_reason) : détail affiché en français
const VIDEO_REJECTED_CODES = {
  duration_check_failed: "durée non acceptée",
  frame_rate_check_failed: "nombre d'images par seconde non accepté",
};
const TRANSIENT_CODES = new Set([
  "internal_error",
  "internal",
  "rate_limit_exceeded",
]);

/** Code d'erreur TikTok (API ou fail_reason) → DirectApiError classée. */
export function tiktokError(code, message, status = null) {
  const base = { network: NETWORK, status, code, detail: message || code };
  const text = `tiktok : ${code}${message ? ` (${message})` : ""}`;
  if (AUTH_CODES.has(code)) {
    return new DirectApiError(text, {
      ...base,
      category: "auth_expired",
      authInvalid: true,
    });
  }
  if (code === "rate_limit_exceeded") {
    return new DirectApiError(text, {
      ...base,
      category: "platform_rate_limit",
      transient: true,
    });
  }
  if (QUOTA_CODES.has(code)) {
    return new DirectApiError(text, {
      ...base,
      category: "quota_exhausted",
      ...(code === "spam_risk_too_many_pending_share"
        ? { detail: DRAFT_PENDING_LIMIT_MESSAGE }
        : {}),
    });
  }
  if (ABUSE_CODES.has(code)) {
    return new DirectApiError(text, { ...base, category: "user_abuse" });
  }
  if (code === "unaudited_client_can_only_post_to_private_accounts") {
    return new DirectApiError(text, { ...base, category: "account_issue" });
  }
  if (CONTENT_CODES.has(code)) {
    return new DirectApiError(text, { ...base, category: "user_content" });
  }
  if (VIDEO_REJECTED_CODES[code]) {
    return new DirectApiError(text, {
      ...base,
      category: "video_rejected",
      detail: VIDEO_REJECTED_CODES[code],
    });
  }
  if (TRANSIENT_CODES.has(code) || (status && status >= 500)) {
    return new DirectApiError(text, { ...base, transient: true });
  }
  // url_ownership_unverified, photo_pull_failed, publish_cancelled… :
  // réglage de notre côté ou refus du réseau
  return new DirectApiError(text, { ...base, category: "platform_rejected" });
}

/**
 * Réponses TikTok : { data, error: { code, message, log_id } } avec
 * code « ok » en cas de succès (parfois en HTTP 200 même en erreur), ou
 * { error, error_description } à plat pour l'OAuth.
 */
export function classifyTikTokError(response, data) {
  const nested =
    data?.error && typeof data.error === "object" ? data.error : null;
  if (nested && nested.code && nested.code !== "ok") {
    return tiktokError(nested.code, nested.message, response.status);
  }
  if (!nested && typeof data?.error === "string") {
    const code = data.error === "invalid_grant" ? "invalid_grant" : data.error;
    return tiktokError(code, data.error_description, response.status);
  }
  if (!response.ok) {
    return tiktokError(
      response.status === 429
        ? "rate_limit_exceeded"
        : `http_${response.status}`,
      null,
      response.status,
    );
  }
  return null;
}

const api = (method, path, { token, query, json, form, timeoutMs } = {}) =>
  directRequest({
    network: NETWORK,
    method,
    url: `${API_URL}/${path}`,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    query,
    json,
    form,
    timeoutMs,
    check: classifyTikTokError,
  });

// ── Connexion ──────────────────────────────────────────────────────────────

export function buildAuthorizeUrl({ state, redirectUri }) {
  if (!isConfigured()) throw configError(NETWORK, "TIKTOK_CLIENT_KEY absente");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_key", process.env.TIKTOK_CLIENT_KEY);
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

const secondsFromNow = (seconds, now) =>
  Number(seconds) > 0 ? new Date(now.getTime() + Number(seconds) * 1000) : null;

async function tokenRequest(form, now) {
  const { data } = await api("POST", "oauth/token/", {
    form: {
      ...form,
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
    },
  });
  if (!data?.access_token) {
    throw new DirectApiError("tiktok : jeton absent de la réponse", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    tokenExpiresAt: secondsFromNow(data.expires_in, now),
    refreshTokenExpiresAt: secondsFromNow(data.refresh_expires_in, now),
    scopes: String(data.scope || "")
      .split(",")
      .filter(Boolean),
    openId: data.open_id || null,
  };
}

/** Réglages de publication du créateur, relus avant chaque post. */
export async function getCreatorInfo({ accessToken }) {
  const { data } = await api("POST", "post/publish/creator_info/query/", {
    token: accessToken,
    json: {},
  });
  const info = data?.data || {};
  return {
    nickname: info.creator_nickname || null,
    username: info.creator_username || null,
    avatarUrl: info.creator_avatar_url || null,
    canPostMore: true,
    commentDisabled: info.comment_disabled === true,
    // Vidéo seulement (sans objet pour les photos)
    duetDisabled: info.duet_disabled === true,
    stitchDisabled: info.stitch_disabled === true,
    maxVideoPostDurationSec:
      Number(info.max_video_post_duration_sec) > 0
        ? Number(info.max_video_post_duration_sec)
        : null,
    privacyLevels: (info.privacy_level_options || []).map((value) => ({
      value,
      label: value,
    })),
  };
}

export async function exchangeCode({ code, redirectUri, now = new Date() }) {
  if (!isConfigured()) throw configError(NETWORK, "TIKTOK_CLIENT_KEY absente");
  const credentials = await tokenRequest(
    {
      grant_type: "authorization_code",
      code: decodeURIComponent(String(code || "")),
      redirect_uri: redirectUri,
    },
    now,
  );
  const { data } = await api("GET", "user/info/", {
    token: credentials.accessToken,
    query: { fields: "open_id,union_id,avatar_url,display_name" },
  });
  const user = data?.data?.user || {};
  let username = null;
  try {
    username = (await getCreatorInfo({ accessToken: credentials.accessToken }))
      .username;
  } catch {
    // Pseudo facultatif ici (relu à chaque publication)
  }
  const openId = user.open_id || credentials.openId;
  if (!openId) {
    throw new DirectApiError("tiktok : compte sans identifiant", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  const tokens = { ...credentials };
  delete tokens.openId;
  return {
    accounts: [
      {
        platform: "tiktok",
        externalAccountId: String(openId),
        username,
        displayName: user.display_name || username || null,
        avatarUrl: user.avatar_url || null,
        credentials: tokens,
        credentialGroup: null,
        platformData: null,
      },
    ],
  };
}

export async function refreshCredentials({ refreshToken, now = new Date() }) {
  if (!refreshToken)
    throw tiktokError("access_token_invalid", "sans jeton de rafraîchissement");
  const tokens = await tokenRequest(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    now,
  );
  delete tokens.openId;
  return tokens;
}

/** Révocation à la déconnexion (au mieux). */
export async function revoke({ accessToken }) {
  if (!accessToken) return;
  await api("POST", "oauth/revoke/", {
    form: {
      client_key: process.env.TIKTOK_CLIENT_KEY,
      client_secret: process.env.TIKTOK_CLIENT_SECRET,
      token: accessToken,
    },
  });
}

// ── Publication ────────────────────────────────────────────────────────────

const postUrl = (username, postId, kind = "photo") =>
  username && postId
    ? `https://www.tiktok.com/@${username}/${kind}/${postId}`
    : null;

/** Texte coupé à `max` unités UTF-16, sans couper un emoji en deux. */
export function sliceUtf16(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value;
  let sliced = value.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(sliced)) sliced = sliced.slice(0, -1);
  return sliced;
}

const publishIdOf = (data) => {
  const publishId = data?.data?.publish_id;
  if (!publishId) {
    throw new DirectApiError("tiktok : publish_id absent", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return String(publishId);
};

/**
 * Lance la publication d'une vidéo (TikTok va la chercher à notre
 * adresse), après contrôle de la durée maximale du créateur.
 */
async function publishVideo({
  account,
  accessToken,
  content,
  video,
  tiktokSettings,
  creator,
}) {
  const tooLong = validateTikTokVideoDuration(
    video.durationMs,
    creator.maxVideoPostDurationSec,
  );
  if (tooLong) {
    throw new DirectApiError("tiktok : vidéo trop longue pour ce créateur", {
      network: NETWORK,
      category: "video_too_long",
      detail: tooLong,
    });
  }
  const title = sliceUtf16(content, PLATFORM_RULES.tiktok.video.maxText);
  const { data } = await api("POST", "post/publish/video/init/", {
    token: accessToken,
    json: {
      post_info: {
        ...(title ? { title } : {}),
        privacy_level: tiktokSettings.privacyLevel,
        disable_comment:
          !tiktokSettings.allowComment || creator.commentDisabled,
        disable_duet: !tiktokSettings.allowDuet || creator.duetDisabled,
        disable_stitch: !tiktokSettings.allowStitch || creator.stitchDisabled,
        video_cover_timestamp_ms: videoCoverOffsetMs(video.durationMs),
        brand_content_toggle: Boolean(tiktokSettings.brandContent),
        brand_organic_toggle: Boolean(tiktokSettings.brandOrganic),
      },
      source_info: { source: "PULL_FROM_URL", video_url: video.url },
    },
  });
  return {
    status: "publishing",
    externalPostId: publishIdOf(data),
    platformPostUrl: null,
    username: creator.username || account.username || null,
  };
}

/** Photos TikTok : JPEG de 1080p au plus, servis par notre domaine vérifié. */
async function prepareImages(media, workspaceId) {
  const images = [];
  for (const item of media) {
    images.push(await storage.prepareTikTokImage(item, workspaceId));
  }
  return images;
}

/**
 * Brouillon : vidéo ou photos envoyées dans la boîte de réception de
 * l'appli TikTok du client (ni confidentialité, ni réglages : TikTok les
 * demande dans son appli). La vidéo n'a pas de champ texte ; les photos
 * gardent la description.
 */
async function publishDraft({
  account,
  accessToken,
  content,
  media,
  workspaceId,
}) {
  if (media.length === 1 && isVideoMedia(media[0])) {
    const { data } = await api("POST", "post/publish/inbox/video/init/", {
      token: accessToken,
      json: {
        source_info: { source: "PULL_FROM_URL", video_url: media[0].url },
      },
    });
    return {
      status: "publishing",
      externalPostId: publishIdOf(data),
      platformPostUrl: null,
      username: account.username || null,
    };
  }
  const images = await prepareImages(media, workspaceId);
  const text = Array.from(content || "");
  const { data } = await api("POST", "post/publish/content/init/", {
    token: accessToken,
    json: {
      media_type: "PHOTO",
      post_mode: "MEDIA_UPLOAD",
      post_info: { description: text.slice(0, DESCRIPTION_MAX).join("") },
      source_info: {
        source: "PULL_FROM_URL",
        photo_cover_index: 0,
        photo_images: images,
      },
    },
  });
  return {
    status: "publishing",
    externalPostId: publishIdOf(data),
    platformPostUrl: null,
    username: account.username || null,
  };
}

/**
 * Lance la publication d'un carrousel photo ou d'une vidéo (asynchrone
 * chez TikTok), ou l'envoi en brouillon (mode « draft »).
 * tiktokSettings : { mode, privacyLevel, allowComment, brandOrganic,
 * brandContent, allowDuet, allowStitch }
 */
export async function publish({
  account,
  accessToken,
  content,
  media,
  tiktokSettings,
  workspaceId,
}) {
  if (tiktokSettings?.mode === "draft") {
    return publishDraft({ account, accessToken, content, media, workspaceId });
  }
  const creator = await getCreatorInfo({ accessToken });
  const levels = creator.privacyLevels.map((level) => level.value);
  if (!levels.includes(tiktokSettings?.privacyLevel)) {
    throw tiktokError(
      "privacy_level_option_mismatch",
      "cette confidentialité n'est plus proposée par TikTok",
    );
  }
  if (media.length === 1 && isVideoMedia(media[0])) {
    return publishVideo({
      account,
      accessToken,
      content,
      video: media[0],
      tiktokSettings,
      creator,
    });
  }
  const images = await prepareImages(media, workspaceId);
  const text = Array.from(content || "");
  const { data } = await api("POST", "post/publish/content/init/", {
    token: accessToken,
    json: {
      media_type: "PHOTO",
      post_mode: "DIRECT_POST",
      post_info: {
        // Texte complet en description, sans titre (il serait affiché en
        // double au-dessus)
        description: text.slice(0, DESCRIPTION_MAX).join(""),
        privacy_level: tiktokSettings.privacyLevel,
        disable_comment:
          !tiktokSettings.allowComment || creator.commentDisabled,
        auto_add_music: true,
        brand_content_toggle: Boolean(tiktokSettings.brandContent),
        brand_organic_toggle: Boolean(tiktokSettings.brandOrganic),
      },
      source_info: {
        source: "PULL_FROM_URL",
        photo_cover_index: 0,
        photo_images: images,
      },
    },
  });
  return {
    status: "publishing",
    externalPostId: publishIdOf(data),
    platformPostUrl: null,
    username: creator.username || account.username || null,
  };
}

/**
 * Statut d'une publication lancée : publiée (avec l'adresse si le post est
 * public et validé par la modération), brouillon livré dans l'appli TikTok,
 * en cours, ou erreur levée.
 */
export async function checkPublication({
  account,
  accessToken,
  externalPostId,
  media = [],
}) {
  const { data, text } = await api("POST", "post/publish/status/fetch/", {
    token: accessToken,
    json: { publish_id: externalPostId },
  });
  const info = data?.data || {};
  if (info.status === "FAILED") {
    throw tiktokError(info.fail_reason || "publish_failed", info.fail_reason);
  }
  if (info.status === "SEND_TO_USER_INBOX") {
    // Brouillon livré : le client termine la publication dans TikTok
    return {
      status: "published",
      deliveredAs: "draft",
      externalPostId,
      platformPostUrl: null,
    };
  }
  if (info.status === "PUBLISH_COMPLETE") {
    // Identifiant int64 (orthographe de TikTok : « publicaly ») : lu dans le
    // texte brut, JSON.parse l'arrondirait
    const raw = /"publicl?a?l?y_available_post_id"\s*:\s*\[\s*"?(\d+)/.exec(
      text,
    );
    const postId = raw?.[1] || null;
    return {
      status: "published",
      externalPostId: postId || externalPostId,
      platformPostUrl: postUrl(
        account.username,
        postId,
        media.length === 1 && isVideoMedia(media[0]) ? "video" : "photo",
      ),
    };
  }
  return { status: "publishing", externalPostId, platformPostUrl: null };
}

export default {
  NETWORK,
  PLATFORMS,
  usesPkce: false,
  isConfigured,
  buildAuthorizeUrl,
  exchangeCode,
  refreshCredentials,
  getCreatorInfo,
  publish,
  checkPublication,
  revoke,
};
