import logger from "../../../utils/logger.js";

/**
 * Fournisseur Zernio (API unifiée de publication sur les réseaux sociaux).
 *
 * Une seule clé API côté serveur (ZERNIO_API_KEY) ; chaque espace Newbi a son
 * profil Zernio (« newbi-<workspaceId> »), dans lequel ses clients
 * connectent leurs comptes par l'OAuth de Zernio. Aucun jeton n'est stocké
 * chez nous.
 *
 * Ce module ne contient que le transport HTTP et la traduction des réponses
 * dans un format neutre (statuts, cibles) : les règles métier sont dans
 * socialPublishingService.js, pour pouvoir brancher un autre fournisseur (ou
 * l'API directe d'un réseau) derrière la même interface.
 */

export const PROVIDER = "zernio";

const DEFAULT_BASE_URL = "https://zernio.com/api/v1";
const DEFAULT_TIMEOUT_MS = 15000;
// Publication immédiate et nouvel essai : Zernio publie dans la requête
const PUBLISH_TIMEOUT_MS = 60000;
const UPLOAD_TIMEOUT_MS = 60000;
// Nouvel essai d'une création après une coupure : même Idempotency-Key
const CREATE_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_RETRY_AFTER_MS = 5000;

/**
 * Erreur normalisée du fournisseur.
 * kind : "config" (clé absente), "timeout", "network", "http".
 */
export class SocialProviderError extends Error {
  constructor(
    message,
    {
      kind = "http",
      status = null,
      code = null,
      type = null,
      details = null,
      reason = null,
      retryAfterMs = null,
    } = {},
  ) {
    super(message);
    this.name = "SocialProviderError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.type = type;
    this.details = details;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }

  /** Erreur de notre côté ou passagère : rien n'est perdu, on réessaie. */
  get transient() {
    return (
      this.kind === "timeout" ||
      this.kind === "network" ||
      (this.kind === "http" && (this.status >= 500 || this.status === 429))
    );
  }
}

export const isZernioConfigured = () =>
  Boolean(process.env.ZERNIO_API_KEY && process.env.ZERNIO_API_KEY.trim());

const baseUrl = () =>
  (process.env.ZERNIO_API_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");

const sleep = (ms) =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

const parseRetryAfter = (value) => {
  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
};

const readHeader = (response, name) => {
  try {
    return response?.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
};

/**
 * Appel HTTP authentifié, avec délai maximal (AbortController).
 * @returns {Promise<{status: number, data: any}>}
 */
async function zernioRequest(
  method,
  path,
  { query, body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  if (!isZernioConfigured()) {
    throw new SocialProviderError("ZERNIO_API_KEY absente", { kind: "config" });
  }
  const url = new URL(`${baseUrl()}${path}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text;
  try {
    response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${process.env.ZERNIO_API_KEY.trim()}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    const timedOut = error?.name === "AbortError" || controller.signal.aborted;
    throw new SocialProviderError(
      timedOut
        ? `Zernio ${method} ${path} : délai dépassé (${timeoutMs} ms)`
        : `Zernio ${method} ${path} : ${error?.message || "erreur réseau"}`,
      { kind: timedOut ? "timeout" : "network" },
    );
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 500) };
    }
  }

  if (!response.ok) {
    throw new SocialProviderError(
      data?.error || `Zernio ${method} ${path} : HTTP ${response.status}`,
      {
        kind: "http",
        status: response.status,
        code: data?.code || null,
        type: data?.type || null,
        details: data?.details || null,
        reason: data?.reason || null,
        retryAfterMs: parseRetryAfter(readHeader(response, "retry-after")),
      },
    );
  }
  return { status: response.status, data };
}

const extractId = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value._id || value.id || null;
  return String(value);
};

// Statut d'une cible chez Zernio → statut affiché par Newbi
const TARGET_STATUSES = {
  pending: "pending",
  processing: "publishing",
  uploading: "publishing",
  published: "published",
  failed: "failed",
  cancelled: "cancelled",
};
const POST_STATUSES = new Set([
  "scheduled",
  "publishing",
  "published",
  "partial",
  "failed",
  "cancelled",
]);

/**
 * Post Zernio → format neutre. Statut global null si Zernio en renvoie un
 * qui n'a pas de sens pour Newbi (brouillon, en attente d'approbation).
 */
export function normalizePost(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    externalPostId: extractId(raw._id || raw.id),
    status: POST_STATUSES.has(raw.status) ? raw.status : null,
    scheduledFor: raw.scheduledFor || null,
    targets: (Array.isArray(raw.platforms) ? raw.platforms : []).map(
      (entry) => ({
        platform: entry?.platform || null,
        externalAccountId: extractId(entry?.accountId),
        status: TARGET_STATUSES[entry?.status] || "pending",
        platformPostUrl: entry?.platformPostUrl || null,
        errorMessage: entry?.errorMessage || null,
        errorCategory: entry?.errorCategory || null,
        publishedAt: entry?.publishedAt || null,
      }),
    ),
  };
}

/** Compte Zernio → format neutre. */
export function normalizeAccount(raw) {
  return {
    externalAccountId: extractId(raw?._id || raw?.id),
    platform: raw?.platform || null,
    username: raw?.username || null,
    displayName: raw?.displayName || null,
    avatarUrl: raw?.profilePicture || raw?.avatar || null,
    // Jeton expiré ou révoqué : le client doit reconnecter le compte
    active: raw?.isActive !== false && raw?.needsReconnection !== true,
    // Compte créé en effet de bord (connexion publicité) : non publiable
    enabled: raw?.enabled !== false,
  };
}

// ── Profils ────────────────────────────────────────────────────────────────

export async function findProfileByExternalId(externalId) {
  const { data } = await zernioRequest("GET", "/profiles", {
    query: { externalId },
  });
  const profile = (data?.profiles || [])[0];
  return profile ? { externalProfileId: extractId(profile._id) } : null;
}

/**
 * Crée le profil de l'espace ; un profil déjà existant (nom ou externalId,
 * 409) est repris tel quel.
 */
export async function createProfile({ name, externalId }) {
  try {
    const { data } = await zernioRequest("POST", "/profiles", {
      body: { name, externalId, description: "Espace Newbi" },
      headers: { "Idempotency-Key": `newbi-profile-${externalId}` },
    });
    return { externalProfileId: extractId(data?.profile?._id) };
  } catch (error) {
    const existing = error?.details?.existingProfileId;
    if (
      error instanceof SocialProviderError &&
      error.status === 409 &&
      existing
    ) {
      return { externalProfileId: String(existing) };
    }
    throw error;
  }
}

// ── Connexion des comptes ──────────────────────────────────────────────────

/**
 * Adresse d'autorisation OAuth (écran d'accueil à la marque de Newbi, droits
 * de publication seulement). Zernio héberge le choix de la page Facebook ou
 * de l'organisation LinkedIn, puis renvoie le navigateur sur redirectUrl.
 */
export async function getConnectUrl({
  platform,
  externalProfileId,
  redirectUrl,
  brandName,
  logoUrl,
}) {
  const { data } = await zernioRequest(
    "GET",
    `/connect/${encodeURIComponent(platform)}`,
    {
      query: {
        profileId: externalProfileId,
        redirect_url: redirectUrl,
        welcome: "true",
        brandName,
        logoUrl,
        scopes: "posting",
      },
    },
  );
  if (!data?.authUrl) {
    throw new SocialProviderError("Zernio : authUrl absente de la réponse", {
      kind: "http",
      status: 502,
    });
  }
  return data.authUrl;
}

export async function listAccounts(externalProfileId) {
  const { data } = await zernioRequest("GET", "/accounts", {
    query: { profileId: externalProfileId },
  });
  return (data?.accounts || []).map(normalizeAccount);
}

/** Déconnecte un compte ; déjà déconnecté (404) compte comme un succès. */
export async function deleteAccount(externalAccountId) {
  try {
    await zernioRequest(
      "DELETE",
      `/accounts/${encodeURIComponent(externalAccountId)}`,
    );
  } catch (error) {
    if (error instanceof SocialProviderError && error.status === 404) return;
    throw error;
  }
}

export async function getTikTokCreatorInfo(externalAccountId) {
  const { data } = await zernioRequest(
    "GET",
    `/accounts/${encodeURIComponent(externalAccountId)}/tiktok/creator-info`,
    { query: { mediaType: "photo" } },
  );
  const commentSetting =
    data?.postingLimits?.interactionSettings?.allow_comment;
  return {
    nickname: data?.creator?.nickname || null,
    canPostMore: data?.creator?.canPostMore !== false,
    commentDisabled: commentSetting?.enabled === false,
    privacyLevels: (data?.privacyLevels || [])
      .filter((level) => level?.value)
      .map((level) => ({
        value: level.value,
        label: level.label || level.value,
      })),
  };
}

// ── Médias ─────────────────────────────────────────────────────────────────

/**
 * Téléverse une image chez Zernio (adresse présignée, valable une heure) et
 * renvoie son adresse publique, à utiliser dans les posts.
 */
export async function uploadMedia({ buffer, filename, contentType }) {
  const { data } = await zernioRequest("POST", "/media/presign", {
    body: { filename, contentType, size: buffer.length },
  });
  if (!data?.uploadUrl || !data?.publicUrl) {
    throw new SocialProviderError("Zernio : adresse de téléversement absente", {
      kind: "http",
      status: 502,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  let response;
  try {
    // Adresse présignée : pas d'en-tête Authorization
    response = await fetch(data.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: buffer,
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError" || controller.signal.aborted;
    throw new SocialProviderError(
      `Zernio : téléversement interrompu (${error?.message || "réseau"})`,
      { kind: timedOut ? "timeout" : "network" },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new SocialProviderError(
      `Zernio : téléversement refusé (HTTP ${response.status})`,
      { kind: "http", status: response.status >= 500 ? response.status : 502 },
    );
  }
  return { url: data.publicUrl, key: data.key || null };
}

// ── Posts ──────────────────────────────────────────────────────────────────

/**
 * Corps d'un post Zernio. targets : [{ platform, externalAccountId }].
 * Les réglages TikTok sont obligatoires dès qu'une cible TikTok est visée
 * (carrousel photo : le texte complet va dans `description`, Zernio tronque
 * le titre à 90 caractères).
 */
export function buildPostPayload({
  content,
  mediaUrls,
  targets,
  scheduledFor,
  publishNow,
  timezone,
  tiktokSettings,
}) {
  const payload = {};
  if (content !== undefined) payload.content = content || "";
  if (mediaUrls !== undefined) {
    payload.mediaItems = mediaUrls.map((url) => ({ type: "image", url }));
  }
  if (targets !== undefined) {
    payload.platforms = targets.map((target) => ({
      platform: target.platform,
      accountId: target.externalAccountId,
    }));
  }
  if (publishNow) {
    payload.publishNow = true;
  } else if (scheduledFor) {
    payload.scheduledFor = new Date(scheduledFor).toISOString();
  }
  if (timezone) payload.timezone = timezone;
  const hasTikTok = (targets || []).some((t) => t.platform === "tiktok");
  if (tiktokSettings && hasTikTok) {
    payload.tiktokSettings = {
      privacyLevel: tiktokSettings.privacyLevel,
      allowComment: Boolean(tiktokSettings.allowComment),
      contentPreviewConfirmed: true,
      expressConsentGiven: true,
      mediaType: "photo",
      photoCoverIndex: 0,
      description: Array.from(content || "")
        .slice(0, 4000)
        .join(""),
      // Contenu de marque (partenariat rémunéré) prioritaire ; les deux
      // types déclarés ensemble par isBrandOrganicPost (doc Zernio)
      ...(tiktokSettings.brandContent
        ? {
            commercialContentType: "brand_content",
            ...(tiktokSettings.brandOrganic
              ? { isBrandOrganicPost: true }
              : {}),
          }
        : tiktokSettings.brandOrganic
          ? { commercialContentType: "brand_organic" }
          : {}),
    };
  }
  return payload;
}

const postResult = ({ status, data }) => ({
  httpStatus: status,
  // 207 : enregistré, mais la publication immédiate n'a pas tout réussi
  incomplete: status === 207,
  post: normalizePost(data?.post),
});

/**
 * Crée le post. Après une coupure (délai, réseau, 5xx) ou un 409
 * idempotency_conflict (première requête encore en cours), la requête est
 * rejouée avec la même Idempotency-Key : Zernio renvoie alors le post déjà
 * créé au lieu d'en créer un second.
 */
export async function createPost(
  { idempotencyKey, ...fields },
  { retryDelayMs = DEFAULT_RETRY_DELAY_MS, timeoutMs } = {},
) {
  const body = buildPostPayload(fields);
  const requestTimeout =
    timeoutMs || (fields.publishNow ? PUBLISH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  let lastError;
  for (let attempt = 1; attempt <= CREATE_ATTEMPTS; attempt += 1) {
    try {
      const response = await zernioRequest("POST", "/posts", {
        body,
        headers: { "Idempotency-Key": idempotencyKey },
        timeoutMs: requestTimeout,
      });
      return postResult(response);
    } catch (error) {
      lastError = error;
      const replayable =
        error instanceof SocialProviderError &&
        (error.kind === "timeout" ||
          error.kind === "network" ||
          (error.kind === "http" && error.status >= 500) ||
          (error.status === 409 && error.code === "idempotency_conflict"));
      if (!replayable || attempt === CREATE_ATTEMPTS) break;
      logger.warn(
        `[Zernio] Création du post rejouée (${attempt}/${CREATE_ATTEMPTS - 1}) : ${error.message}`,
      );
      await sleep(
        Math.min(error.retryAfterMs ?? retryDelayMs, MAX_RETRY_AFTER_MS),
      );
    }
  }
  throw lastError;
}

export async function updatePost(externalPostId, fields, { timeoutMs } = {}) {
  const response = await zernioRequest(
    "PUT",
    `/posts/${encodeURIComponent(externalPostId)}`,
    {
      body: buildPostPayload(fields),
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    },
  );
  return postResult(response);
}

/**
 * Supprime le post chez Zernio (tout sauf un post publié). Déjà supprimé
 * (404) compte comme un succès.
 * @returns {Promise<{alreadyGone: boolean}>}
 */
export async function deletePost(externalPostId) {
  try {
    await zernioRequest(
      "DELETE",
      `/posts/${encodeURIComponent(externalPostId)}`,
    );
    return { alreadyGone: false };
  } catch (error) {
    if (error instanceof SocialProviderError && error.status === 404) {
      return { alreadyGone: true };
    }
    throw error;
  }
}

/** Nouvel essai des seules plateformes en échec (synchrone chez Zernio). */
export async function retryPost(externalPostId, { timeoutMs } = {}) {
  const response = await zernioRequest(
    "POST",
    `/posts/${encodeURIComponent(externalPostId)}/retry`,
    { timeoutMs: timeoutMs || PUBLISH_TIMEOUT_MS },
  );
  return postResult(response);
}

export async function getPost(externalPostId) {
  const { data } = await zernioRequest(
    "GET",
    `/posts/${encodeURIComponent(externalPostId)}`,
  );
  return normalizePost(data?.post);
}

export default {
  PROVIDER,
  isConfigured: isZernioConfigured,
  findProfileByExternalId,
  createProfile,
  getConnectUrl,
  listAccounts,
  deleteAccount,
  getTikTokCreatorInfo,
  uploadMedia,
  createPost,
  updatePost,
  deletePost,
  retryPost,
  getPost,
};
