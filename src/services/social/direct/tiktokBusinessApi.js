import storage from "../socialMediaStorage.js";
import {
  isVideoMedia,
  PLATFORM_RULES,
  validateTikTokVideoDuration,
  videoCoverOffsetMs,
} from "../socialPostRules.js";
import { apiPublicUrl } from "../socialConnectUrls.js";
import { DirectApiError, configError, directRequest } from "./directHttp.js";
import { sliceUtf16, tiktokError } from "./tiktokApi.js";

/**
 * Comptes TikTok Business (TikTok API for Business, appli « TikTok
 * Accounts » distincte de celle du Login Kit) : seul moyen d'ajouter un son
 * tendance de la Commercial Music Library, sur une vidéo ou des photos.
 *
 * - Connexion : adresse d'autorisation copiée depuis le portail
 *   (TIKTOK_BUSINESS_AUTH_URL, « TikTok account holder authorization URL »)
 *   à laquelle on ajoute state et disable_auto_auth=1 ; retour avec le code
 *   dans `code` ou `auth_code` (10 minutes, usage unique), adresse de
 *   retour déclarée finissant par « / » ;
 * - jeton d'accès de 24 h, jeton de rafraîchissement d'un an ;
 * - réglages du compte (/business/video/settings/) relus avant chaque
 *   publication : confidentialités, commentaires, duos, collages, durée
 *   maximale ;
 * - vidéo : toujours publique (l'API n'a pas de confidentialité pour la
 *   vidéo) ; photos : confidentialité choisie ;
 * - son : music_sound_info, volumes envoyés dès qu'un son est choisi (0 par
 *   défaut chez TikTok, la vidéo serait muette) ;
 * - brouillon : upload_to_draft (vidéo) ou is_draft (photos), le client
 *   termine la publication dans l'appli (SEND_TO_USER_INBOX) ;
 * - publication asynchrone : share_id, suivi par /business/publish/status/.
 * 15 posts par jour et 6 par minute au plus par compte.
 *
 * Réponses { code, message, request_id, data } : code 0 = succès, souvent
 * en HTTP 200 même en erreur.
 * Doc : business-api.tiktok.com/portal/docs/accounts-api-authorization/v1.3,
 * /accounts-api-authentication/v1.3,
 * /publish-a-public-video-post-to-an-owned-account/v1.3,
 * /publish-a-photo-post-to-an-owned-account/v1.3,
 * /get-the-publishing-status-of-a-tiktok-post/v1.3,
 * /get-the-post-privacy-settings-of-a-tiktok-account/v1.3,
 * /get-profile-data-of-a-tiktok-account/v1.3,
 * /get-popular-tracks-from-the-commercial-music-library/v1.3,
 * /return-codes-appendix/v1.3
 */

export const NETWORK = "tiktok";
export const PLATFORMS = ["tiktok"];

const API_URL = "https://business-api.tiktok.com/open_api/v1.3";
const CAPTION_MAX = PLATFORM_RULES.tiktok.video.maxText;
const PHOTO_CAPTION_MAX = 4000;
const SOUND_COUNTRY = "FR";
const PUBLIC = "PUBLIC_TO_EVERYONE";

export const isConfigured = () =>
  Boolean(
    process.env.TIKTOK_BUSINESS_APP_ID &&
    process.env.TIKTOK_BUSINESS_APP_SECRET &&
    process.env.TIKTOK_BUSINESS_AUTH_URL,
  );

// ── Erreurs ────────────────────────────────────────────────────────────────

// Annexe « Return codes » de TikTok API for Business
const AUTH_CODES = new Set([
  40101, 40102, 40103, 40104, 40105, 40106, 40107, 40110, 40131,
]);
const RATE_LIMIT_CODES = new Set([40016, 40100, 40133]);
const TRANSIENT_CODES = new Set([
  40202, 40902, 40903, 40913, 50000, 50002, 51305, 60001,
]);
const CONTENT_CODES = new Set([
  40904, 40905, 40906, 40907, 40908, 40910, 40914, 40915,
]);
// Paramètre refusé ou objet inconnu : son refusé quand le message en parle
const PARAM_CODES = new Set([40000, 40002, 40007]);
// Codes texte du Content Posting (spam_risk_…) cités dans le message
const TEXT_CODE =
  /\b(spam_risk_[a-z_]+|reached_active_user_cap|url_ownership_unverified|privacy_level_option_mismatch|unaudited_client_can_only_post_to_private_accounts)\b/;

/** Réponse de l'API for Business → DirectApiError classée (null si bonne). */
export function classifyBusinessError(response, data) {
  const code = Number(data?.code);
  const failed = Number.isFinite(code) && code !== 0;
  if (!failed) {
    if (response.ok) return null;
    return tiktokError(
      response.status === 429
        ? "rate_limit_exceeded"
        : `http_${response.status}`,
      null,
      response.status,
    );
  }
  const message = String(data?.message || "");
  const textCode = TEXT_CODE.exec(message)?.[1];
  if (textCode) return tiktokError(textCode, message, response.status);
  const base = {
    network: NETWORK,
    status: response.status,
    code,
    detail: message || null,
  };
  const text = `tiktok business : ${code}${message ? ` (${message})` : ""}`;
  if (AUTH_CODES.has(code)) {
    return new DirectApiError(text, {
      ...base,
      category: "auth_expired",
      authInvalid: true,
    });
  }
  if (RATE_LIMIT_CODES.has(code)) {
    return new DirectApiError(text, {
      ...base,
      category: "platform_rate_limit",
      transient: true,
    });
  }
  if (PARAM_CODES.has(code) && /music|sound|song/i.test(message)) {
    return new DirectApiError(text, { ...base, category: "sound_rejected" });
  }
  if (CONTENT_CODES.has(code)) {
    return new DirectApiError(text, { ...base, category: "user_content" });
  }
  if (TRANSIENT_CODES.has(code) || response.status >= 500) {
    return new DirectApiError(text, { ...base, transient: true });
  }
  return new DirectApiError(text, { ...base, category: "platform_rejected" });
}

const api = (method, path, { token, query, json, timeoutMs } = {}) =>
  directRequest({
    network: NETWORK,
    method,
    url: `${API_URL}/${path}`,
    headers: token ? { "Access-Token": token } : {},
    query,
    json,
    timeoutMs,
    check: classifyBusinessError,
  });

const missingConfig = () =>
  configError(NETWORK, "TIKTOK_BUSINESS_APP_ID absente");

// ── Connexion ──────────────────────────────────────────────────────────────

/**
 * Adresse de retour déclarée dans le portail : celle de l'adresse
 * d'autorisation (paramètre redirect_uri), sinon la nôtre (« / » final
 * exigé par TikTok).
 */
export function redirectUri() {
  try {
    const declared = new URL(
      process.env.TIKTOK_BUSINESS_AUTH_URL || "",
    ).searchParams.get("redirect_uri");
    if (declared) return declared;
  } catch {
    // Adresse absente ou illisible : la nôtre
  }
  return `${apiPublicUrl()}/social-connect/tiktok_business/callback/`;
}

export function buildAuthorizeUrl({ state }) {
  if (!isConfigured()) throw missingConfig();
  const url = new URL(process.env.TIKTOK_BUSINESS_AUTH_URL);
  url.searchParams.set("state", state);
  // Écran d'autorisation toujours affiché (choix du compte)
  url.searchParams.set("disable_auto_auth", "1");
  return url.toString();
}

const secondsFromNow = (seconds, now) =>
  Number(seconds) > 0 ? new Date(now.getTime() + Number(seconds) * 1000) : null;

async function tokenRequest(path, fields, now) {
  const { data } = await api("POST", path, {
    json: {
      client_id: process.env.TIKTOK_BUSINESS_APP_ID,
      client_secret: process.env.TIKTOK_BUSINESS_APP_SECRET,
      ...fields,
    },
  });
  const tokens = data?.data || {};
  if (!tokens.access_token) {
    throw new DirectApiError("tiktok business : jeton absent de la réponse", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    tokenExpiresAt: secondsFromNow(tokens.expires_in, now),
    refreshTokenExpiresAt: secondsFromNow(tokens.refresh_token_expires_in, now),
    scopes: String(tokens.scope || "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
    openId: tokens.open_id || null,
  };
}

/** Profil du compte (au mieux : le pseudo exige user.info.username). */
async function readProfile(accessToken, openId) {
  try {
    const { data } = await api("GET", "business/get/", {
      token: accessToken,
      query: {
        business_id: openId,
        fields: JSON.stringify(["username", "display_name", "profile_image"]),
      },
    });
    return data?.data || {};
  } catch (error) {
    if (error?.authInvalid) throw error;
    return {};
  }
}

/** Code de retour → le compte TikTok Business connecté. */
export async function exchangeCode({
  code,
  redirectUri: uri,
  now = new Date(),
}) {
  if (!isConfigured()) throw missingConfig();
  const credentials = await tokenRequest(
    "tt_user/oauth2/token/",
    {
      grant_type: "authorization_code",
      auth_code: decodeURIComponent(String(code || "")),
      redirect_uri: uri || redirectUri(),
    },
    now,
  );
  if (!credentials.openId) {
    throw new DirectApiError("tiktok business : compte sans identifiant", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  const profile = await readProfile(
    credentials.accessToken,
    credentials.openId,
  );
  const tokens = { ...credentials };
  delete tokens.openId;
  return {
    accounts: [
      {
        platform: "tiktok",
        externalAccountId: String(credentials.openId),
        username: profile.username || null,
        displayName: profile.display_name || profile.username || null,
        avatarUrl: profile.profile_image || null,
        credentials: tokens,
        credentialGroup: null,
        platformData: null,
      },
    ],
  };
}

export async function refreshCredentials({ refreshToken, now = new Date() }) {
  if (!refreshToken) {
    throw tiktokError("access_token_invalid", "sans jeton de rafraîchissement");
  }
  const tokens = await tokenRequest(
    "tt_user/oauth2/refresh_token/",
    { grant_type: "refresh_token", refresh_token: refreshToken },
    now,
  );
  delete tokens.openId;
  return tokens;
}

/** Révocation à la déconnexion (au mieux). */
export async function revoke({ accessToken }) {
  if (!accessToken) return;
  await api("POST", "tt_user/oauth2/revoke/", {
    json: {
      client_id: process.env.TIKTOK_BUSINESS_APP_ID,
      client_secret: process.env.TIKTOK_BUSINESS_APP_SECRET,
      access_token: accessToken,
    },
  });
}

/**
 * Réglages de publication du compte, relus avant chaque post (même forme
 * que le creator_info du Content Posting).
 */
export async function getCreatorInfo({ accessToken, account }) {
  const { data } = await api("GET", "business/video/settings/", {
    token: accessToken,
    query: { business_id: account.externalAccountId },
  });
  const info = data?.data || {};
  return {
    nickname: account.displayName || null,
    username: account.username || null,
    avatarUrl: account.avatarUrl || null,
    canPostMore: true,
    commentDisabled: info.comment_disabled === true,
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

// ── Sons ───────────────────────────────────────────────────────────────────

/**
 * Titre de la liste des tendances → SocialSound. L'identifiant attendu par
 * music_sound_id est celui d'un extrait (song_clip_id), pas
 * commercial_music_id (gardé en dernier recours).
 */
const toSound = (track) => {
  const clip = track.trending_song_clip || track.full_duration_song_clip;
  const id =
    track.trending_song_clip?.song_clip_id ||
    track.full_duration_song_clip?.song_clip_id ||
    track.commercial_music_id;
  return {
    id: id ? String(id) : null,
    title: track.commercial_music_name || "Son sans titre",
    artist: track.artist || null,
    coverUrl: track.thumbnail_url || null,
    previewUrl: clip?.preview_url || track.preview_url || null,
    durationMs:
      Number(track.duration) > 0 ? Number(track.duration) * 1000 : null,
    rank: Number(track.rank_position) > 0 ? Number(track.rank_position) : null,
    kind: null,
  };
};

/** Tendances de la Commercial Music Library en France (pas de recherche). */
export async function listSounds({ account, accessToken }) {
  const { data } = await api("GET", "discovery/cml/trending_list/", {
    token: accessToken,
    query: {
      business_id: account.externalAccountId,
      country_code: SOUND_COUNTRY,
      date_range: "7DAY",
    },
  });
  const list = Array.isArray(data?.data?.list) ? data.data.list : [];
  return list.map(toSound).filter((sound) => sound.id);
}

// ── Publication ────────────────────────────────────────────────────────────

const postUrl = (username, postId, kind) =>
  username && postId
    ? `https://www.tiktok.com/@${username}/${kind}/${postId}`
    : null;

const shareIdOf = (data) => {
  const shareId = data?.data?.share_id;
  if (!shareId) {
    throw new DirectApiError("tiktok business : share_id absent", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return String(shareId);
};

const hasSound = (settings) => Boolean(settings?.sound?.soundId);

/** Vidéo : publiée (toujours publique) ou envoyée en brouillon. */
async function publishVideo({
  account,
  accessToken,
  content,
  video,
  tiktokSettings,
}) {
  let postInfo;
  if (tiktokSettings?.mode === "draft") {
    // Le reste de post_info est ignoré par TikTok en brouillon
    postInfo = {
      upload_to_draft: true,
      is_brand_organic: false,
      is_branded_content: false,
    };
  } else {
    if (tiktokSettings?.privacyLevel !== PUBLIC) {
      throw tiktokError(
        "privacy_level_option_mismatch",
        "une vidéo TikTok Business est toujours publique",
      );
    }
    const settings = await getCreatorInfo({ accessToken, account });
    const tooLong = validateTikTokVideoDuration(
      video.durationMs,
      settings.maxVideoPostDurationSec,
    );
    if (tooLong) {
      throw new DirectApiError("tiktok : vidéo trop longue pour ce créateur", {
        network: NETWORK,
        category: "video_too_long",
        detail: tooLong,
      });
    }
    const caption = sliceUtf16(content, CAPTION_MAX);
    const sound = tiktokSettings.sound;
    postInfo = {
      ...(caption ? { caption } : {}),
      is_brand_organic: Boolean(tiktokSettings.brandOrganic),
      is_branded_content: Boolean(tiktokSettings.brandContent),
      disable_comment: !tiktokSettings.allowComment || settings.commentDisabled,
      disable_duet: !tiktokSettings.allowDuet || settings.duetDisabled,
      disable_stitch: !tiktokSettings.allowStitch || settings.stitchDisabled,
      thumbnail_offset: videoCoverOffsetMs(video.durationMs),
      // Volumes toujours envoyés avec un son (0 par défaut chez TikTok) ;
      // sans son, le son d'origine de la vidéo reste tel quel
      ...(hasSound(tiktokSettings)
        ? {
            music_sound_info: {
              music_sound_id: sound.soundId,
              music_sound_volume: sound.volume,
              video_original_sound_volume: sound.videoVolume,
            },
          }
        : {}),
    };
  }
  const { data } = await api("POST", "business/video/publish/", {
    token: accessToken,
    json: {
      business_id: account.externalAccountId,
      video_url: video.url,
      post_info: postInfo,
    },
  });
  return {
    status: "publishing",
    externalPostId: shareIdOf(data),
    platformPostUrl: null,
    username: account.username || null,
  };
}

/** Photos (35 au plus) : publiées ou envoyées en brouillon. */
async function publishPhotos({
  account,
  accessToken,
  content,
  media,
  tiktokSettings,
  workspaceId,
}) {
  const draft = tiktokSettings?.mode === "draft";
  let settings = null;
  if (!draft) {
    settings = await getCreatorInfo({ accessToken, account });
    const levels = settings.privacyLevels.map((level) => level.value);
    if (!levels.includes(tiktokSettings?.privacyLevel)) {
      throw tiktokError(
        "privacy_level_option_mismatch",
        "cette confidentialité n'est plus proposée par TikTok",
      );
    }
  }
  const images = [];
  for (const item of media) {
    images.push(await storage.prepareTikTokImage(item, workspaceId));
  }
  const caption = sliceUtf16(content, PHOTO_CAPTION_MAX);
  const postInfo = draft
    ? {
        // Seuls le titre et le texte comptent en brouillon ; les champs
        // obligatoires reçoivent des valeurs toujours acceptées
        is_draft: true,
        ...(caption ? { caption } : {}),
        privacy_level: "SELF_ONLY",
        is_brand_organic: false,
        is_branded_content: false,
      }
    : {
        // Texte complet en description, sans titre (affiché en double)
        ...(caption ? { caption } : {}),
        privacy_level: tiktokSettings.privacyLevel,
        disable_comment:
          !tiktokSettings.allowComment || settings.commentDisabled,
        // Musique proposée par TikTok seulement sans son choisi
        auto_add_music: !hasSound(tiktokSettings),
        is_brand_organic: Boolean(tiktokSettings.brandOrganic),
        is_branded_content: Boolean(tiktokSettings.brandContent),
        ...(hasSound(tiktokSettings)
          ? {
              music_sound_info: {
                music_sound_id: tiktokSettings.sound.soundId,
              },
            }
          : {}),
      };
  const { data } = await api("POST", "business/photo/publish/", {
    token: accessToken,
    json: {
      business_id: account.externalAccountId,
      photo_images: images,
      photo_cover_index: 0,
      post_info: postInfo,
    },
  });
  return {
    status: "publishing",
    externalPostId: shareIdOf(data),
    platformPostUrl: null,
    username: account.username || null,
  };
}

/**
 * Lance la publication d'une vidéo ou de photos (asynchrone chez TikTok),
 * ou l'envoi en brouillon (mode « draft »).
 * tiktokSettings : { mode, privacyLevel, allowComment, brandOrganic,
 * brandContent, allowDuet, allowStitch, sound }
 */
export async function publish({
  account,
  accessToken,
  content,
  media,
  tiktokSettings,
  workspaceId,
}) {
  if (media.length === 1 && isVideoMedia(media[0])) {
    return publishVideo({
      account,
      accessToken,
      content,
      video: media[0],
      tiktokSettings,
    });
  }
  return publishPhotos({
    account,
    accessToken,
    content,
    media,
    tiktokSettings,
    workspaceId,
  });
}

/**
 * Statut d'une publication lancée : publiée (adresse quand TikTok donne
 * l'identifiant du post, jusqu'à 3 minutes après), brouillon livré, en
 * cours, ou erreur levée (mêmes raisons d'échec que le Content Posting).
 */
export async function checkPublication({
  account,
  accessToken,
  externalPostId,
  media = [],
}) {
  const { data, text } = await api("GET", "business/publish/status/", {
    token: accessToken,
    query: {
      business_id: account.externalAccountId,
      publish_id: externalPostId,
    },
  });
  const info = data?.data || {};
  if (info.status === "FAILED") {
    throw tiktokError(info.reason || "publish_failed", info.reason);
  }
  if (info.status === "SEND_TO_USER_INBOX") {
    return {
      status: "published",
      deliveredAs: "draft",
      externalPostId,
      platformPostUrl: null,
    };
  }
  if (info.status === "PUBLISH_COMPLETE") {
    // Identifiant lu dans le texte brut (un nombre de 64 bits serait arrondi)
    const postId = /"post_ids"\s*:\s*\[\s*"?(\d+)/.exec(text)?.[1] || null;
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
  redirectUri,
  buildAuthorizeUrl,
  exchangeCode,
  refreshCredentials,
  getCreatorInfo,
  publish,
  checkPublication,
  revoke,
  listSounds,
};
