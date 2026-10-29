import storage from "../socialMediaStorage.js";
import {
  DirectApiError,
  configError,
  directRequest,
  readHeader,
  timing,
} from "./directHttp.js";

/**
 * LinkedIn : profil personnel (Share on LinkedIn, w_member_social) et pages
 * entreprise (Community Management API, w_organization_social).
 *
 * La Community Management API doit être SEULE sur son appli (doc LinkedIn,
 * « must be the only product ») : deux applis, chacune ses identifiants.
 * - « profile » : Share on LinkedIn + OpenID Connect (LINKEDIN_CLIENT_ID),
 *   profil seulement, sans validation, identité par /v2/userinfo ;
 * - « pages » : Community Management API (LINKEDIN_PAGES_CLIENT_ID), profil
 *   ET pages après validation par LinkedIn, identité par /v2/me.
 * Les connexions neuves passent par « pages » dès qu'elle est configurée,
 * ou seulement pour les espaces de LINKEDIN_PAGES_WORKSPACE_IDS (virgules,
 * vide = tous) tant que LinkedIn ne l'a pas validée au Standard tier.
 * Chaque compte garde l'appli de sa connexion (platformData.app) pour
 * rafraîchir son jeton avec les bons identifiants : les profils connectés
 * avant la validation continuent de publier sans reconnexion.
 *
 * Jetons de 60 jours ; jeton de rafraîchissement seulement si LinkedIn
 * l'accorde à l'appli (sinon : reconnexion à l'expiration).
 * Version épinglée par LINKEDIN_API_VERSION (en-tête Linkedin-Version).
 * Doc : learn.microsoft.com/linkedin/marketing/community-management/shares/
 * posts-api, images-api, little-text-format ; /shared/authentication/
 */

export const NETWORK = "linkedin";
export const PLATFORMS = ["linkedin"];

const DEFAULT_API_VERSION = "202610";
const AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const API_URL = "https://api.linkedin.com";
const PUBLISH_TIMEOUT_MS = 60000;
const UPLOAD_TIMEOUT_MS = 60000;
const IMAGE_POLL_ATTEMPTS = 5;
const IMAGE_POLL_DELAY_MS = 2000;
// Rôles d'une page qui peuvent publier (la doc écrit CONTENT_ADMIN ou
// CONTENT_ADMINISTRATOR selon les pages)
const PUBLISHING_ROLES = new Set([
  "ADMINISTRATOR",
  "DIRECT_SPONSORED_CONTENT_POSTER",
  "CONTENT_ADMINISTRATOR",
  "CONTENT_ADMIN",
]);

const APPS = {
  profile: {
    clientIdVar: "LINKEDIN_CLIENT_ID",
    clientSecretVar: "LINKEDIN_CLIENT_SECRET",
    scopes: ["openid", "profile", "w_member_social"],
  },
  pages: {
    clientIdVar: "LINKEDIN_PAGES_CLIENT_ID",
    clientSecretVar: "LINKEDIN_PAGES_CLIENT_SECRET",
    scopes: [
      "r_basicprofile",
      "w_member_social",
      "w_organization_social",
      "rw_organization_admin",
    ],
  },
};

const appCredentials = (app) => ({
  clientId: process.env[APPS[app].clientIdVar],
  clientSecret: process.env[APPS[app].clientSecretVar],
});

const isAppConfigured = (app) => {
  const { clientId, clientSecret } = appCredentials(app);
  return Boolean(clientId && clientSecret);
};

const pagesWorkspaceIds = () =>
  String(process.env.LINKEDIN_PAGES_WORKSPACE_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

const pagesAppAllowed = (workspaceId) => {
  if (!isAppConfigured("pages")) return false;
  const ids = pagesWorkspaceIds();
  return ids.length === 0 || ids.includes(String(workspaceId || ""));
};

/**
 * Appli des connexions neuves pour cet espace : « pages » si configurée et
 * ouverte à l'espace, sinon « profile » (null : aucune appli).
 */
export const connectApp = (workspaceId) => {
  if (pagesAppAllowed(workspaceId)) return "pages";
  if (isAppConfigured("profile")) return "profile";
  return null;
};

export const isConfigured = () =>
  isAppConfigured("profile") || isAppConfigured("pages");

/** Appli d'un compte déjà connecté (les plus anciens : « profile »). */
export const accountApp = (account) =>
  account?.platformData?.app === "pages" ? "pages" : "profile";

export const apiVersion = () =>
  (process.env.LINKEDIN_API_VERSION || DEFAULT_API_VERSION).trim();

export const scopes = (app) => APPS[app]?.scopes || [];

// ── Erreurs ────────────────────────────────────────────────────────────────

/** Réponse LinkedIn → DirectApiError classée (null si tout va bien). */
export function classifyLinkedInError(response, data, label = "") {
  if (response.ok) return null;
  const status = response.status;
  const message =
    data?.message || data?.error_description || data?.error || `HTTP ${status}`;
  const base = {
    network: NETWORK,
    status,
    code: data?.serviceErrorCode ?? data?.code ?? data?.error ?? null,
    detail: data?.message || null,
  };
  const make = (fields) =>
    new DirectApiError(`linkedin ${label} : ${message}`, {
      ...base,
      ...fields,
    });

  // Jeton (ou jeton de rafraîchissement) invalide, expiré ou révoqué
  if (status === 401 || data?.error === "invalid_grant") {
    return make({ category: "auth_expired", authInvalid: true });
  }
  if (
    status === 400 &&
    data?.error === "invalid_request" &&
    /token/i.test(message)
  ) {
    return make({ category: "auth_expired", authInvalid: true });
  }
  if (status === 403) {
    // Permission retirée, ou rôle perdu sur la page
    return make({ category: "auth_expired", authInvalid: true });
  }
  if (status === 429) {
    return make({ category: "platform_rate_limit", transient: true });
  }
  if (status === 426) {
    // Version arrêtée : LINKEDIN_API_VERSION à mettre à jour
    return make({ category: "platform_rejected" });
  }
  if (status === 422 || status === 413 || status === 400) {
    return make({ category: "user_content" });
  }
  if (status === 409 || status >= 500) return make({ transient: true });
  return make({ category: "platform_rejected" });
}

const restHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  "Linkedin-Version": apiVersion(),
  "X-Restli-Protocol-Version": "2.0.0",
});

const rest = (method, path, { token, query, json, timeoutMs } = {}) =>
  directRequest({
    network: NETWORK,
    method,
    url: `${API_URL}/rest/${path}`,
    headers: restHeaders(token),
    query,
    json,
    timeoutMs,
    check: classifyLinkedInError,
  });

// ── Connexion ──────────────────────────────────────────────────────────────

export function buildAuthorizeUrl({ state, redirectUri, workspaceId }) {
  const app = connectApp(workspaceId);
  if (!app) throw configError(NETWORK, "LINKEDIN_CLIENT_ID absente");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", appCredentials(app).clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", scopes(app).join(" "));
  return url.toString();
}

const secondsFromNow = (seconds, now) =>
  Number(seconds) > 0 ? new Date(now.getTime() + Number(seconds) * 1000) : null;

const tokenCredentials = (data, now) => ({
  accessToken: data.access_token,
  refreshToken: data.refresh_token || null,
  tokenExpiresAt: secondsFromNow(data.expires_in, now),
  refreshTokenExpiresAt: secondsFromNow(data.refresh_token_expires_in, now),
  scopes: String(data.scope || "")
    .split(/[ ,]+/)
    .filter(Boolean),
});

async function tokenRequest(form, now, app) {
  if (!isAppConfigured(app)) {
    throw configError(
      NETWORK,
      `identifiants de l'appli LinkedIn ${app} absents`,
    );
  }
  const { clientId, clientSecret } = appCredentials(app);
  const { data } = await directRequest({
    network: NETWORK,
    method: "POST",
    url: TOKEN_URL,
    form: {
      ...form,
      client_id: clientId,
      client_secret: clientSecret,
    },
    check: classifyLinkedInError,
  });
  if (!data?.access_token) {
    throw new DirectApiError("linkedin : jeton absent de la réponse", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  return tokenCredentials(data, now);
}

/** Membre connecté : identifiant (URN), nom et photo. */
async function readMember(token, app) {
  if (app === "pages") {
    const { data } = await directRequest({
      network: NETWORK,
      url: `${API_URL}/v2/me`,
      headers: { Authorization: `Bearer ${token}` },
      query: {
        projection:
          "(id,localizedFirstName,localizedLastName,profilePicture(displayImage~:playableStreams))",
      },
      check: classifyLinkedInError,
    });
    const streams = data?.profilePicture?.["displayImage~"]?.elements || [];
    const picture =
      streams[streams.length - 1]?.identifiers?.[0]?.identifier || null;
    return {
      id: data?.id,
      name: [data?.localizedFirstName, data?.localizedLastName]
        .filter(Boolean)
        .join(" "),
      picture,
    };
  }
  const { data } = await directRequest({
    network: NETWORK,
    url: `${API_URL}/v2/userinfo`,
    headers: { Authorization: `Bearer ${token}` },
    check: classifyLinkedInError,
  });
  return {
    id: data?.sub,
    name: data?.name || null,
    picture: data?.picture || null,
  };
}

const organizationUrnOf = (element) =>
  element?.organization || element?.organizationTarget || null;

/** Pages où le membre a un rôle qui permet de publier. */
async function listOrganizations(token) {
  const { data } = await rest("GET", "organizationAcls", {
    token,
    query: { q: "roleAssignee", state: "APPROVED", count: 100 },
  });
  const urns = [
    ...new Set(
      (data?.elements || [])
        .filter((element) => PUBLISHING_ROLES.has(element?.role))
        .map(organizationUrnOf)
        .filter(
          (urn) =>
            typeof urn === "string" && urn.startsWith("urn:li:organization:"),
        ),
    ),
  ];
  const organizations = [];
  for (const urn of urns) {
    const id = urn.split(":").pop();
    let name = null;
    let vanityName = null;
    try {
      const { data: organization } = await rest("GET", `organizations/${id}`, {
        token,
      });
      name = organization?.localizedName || null;
      vanityName = organization?.vanityName || null;
    } catch {
      // Lecture réservée aux administrateurs : nom de repli
    }
    organizations.push({
      urn,
      id,
      name: name || `Page LinkedIn ${id}`,
      vanityName,
    });
  }
  return organizations;
}

/**
 * Code de retour → le profil du membre, et ses pages entreprise si l'appli
 * a la Community Management API. Tous partagent le même jeton.
 */
export async function exchangeCode({
  code,
  redirectUri,
  workspaceId,
  now = new Date(),
}) {
  const app = connectApp(workspaceId);
  if (!app) throw configError(NETWORK, "LINKEDIN_CLIENT_ID absente");
  const credentials = await tokenRequest(
    { grant_type: "authorization_code", code, redirect_uri: redirectUri },
    now,
    app,
  );
  const member = await readMember(credentials.accessToken, app);
  if (!member?.id) {
    throw new DirectApiError("linkedin : membre sans identifiant", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  const personUrn = `urn:li:person:${member.id}`;
  const credentialGroup = `linkedin:${personUrn}`;
  const accounts = [
    {
      platform: "linkedin",
      externalAccountId: personUrn,
      username: null,
      displayName: member.name || null,
      avatarUrl: member.picture || null,
      credentials,
      credentialGroup,
      platformData: { kind: "person", app },
    },
  ];
  if (app === "pages") {
    for (const organization of await listOrganizations(
      credentials.accessToken,
    )) {
      accounts.push({
        platform: "linkedin",
        externalAccountId: organization.urn,
        username: organization.vanityName,
        displayName: organization.name,
        avatarUrl: null,
        credentials,
        credentialGroup,
        platformData: { kind: "organization", app },
      });
    }
  }
  return { accounts };
}

export async function refreshCredentials({
  account,
  refreshToken,
  now = new Date(),
}) {
  if (!refreshToken) {
    throw new DirectApiError("linkedin : pas de jeton de rafraîchissement", {
      network: NETWORK,
      kind: "auth",
      category: "auth_expired",
      authInvalid: true,
    });
  }
  return tokenRequest(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    now,
    accountApp(account),
  );
}

// ── Publication ────────────────────────────────────────────────────────────

/**
 * Texte au « little text format » : les caractères réservés sont échappés,
 * sauf « # » suivi d'une lettre ou d'un chiffre (hashtag voulu).
 */
export function escapeLittleText(text = "") {
  return String(text).replace(/[\\|{}@[\]()<>*_~#]/gu, (char, offset, all) => {
    if (char === "#" && /[\p{L}\p{N}_]/u.test(all[offset + 1] || "")) {
      return char;
    }
    return `\\${char}`;
  });
}

/** Dépose une image chez LinkedIn et renvoie son URN (urn:li:image:…). */
async function uploadImage({ token, owner, media }) {
  const { data } = await rest("POST", "images", {
    token,
    query: { action: "initializeUpload" },
    json: { initializeUploadRequest: { owner } },
  });
  const uploadUrl = data?.value?.uploadUrl;
  const image = data?.value?.image;
  if (!uploadUrl || !image) {
    throw new DirectApiError("linkedin : adresse de dépôt absente", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  const { buffer, contentType } = await storage.fetchImage(media.url);
  await directRequest({
    network: NETWORK,
    method: "PUT",
    url: uploadUrl,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": contentType || "image/jpeg",
    },
    body: buffer,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    check: classifyLinkedInError,
  });
  // Image prête avant le post (sinon il resterait invisible) ; la lecture
  // du statut est refusée à l'appli « Share on LinkedIn » : on patiente
  for (let attempt = 1; attempt <= IMAGE_POLL_ATTEMPTS; attempt += 1) {
    try {
      const { data: info } = await rest(
        "GET",
        `images/${encodeURIComponent(image)}`,
        { token },
      );
      if (info?.status === "AVAILABLE") return image;
      if (info?.status === "PROCESSING_FAILED") {
        throw new DirectApiError("linkedin : image refusée", {
          network: NETWORK,
          status: 422,
          category: "user_content",
          detail: "image refusée",
        });
      }
    } catch (error) {
      if (error?.category === "user_content") throw error;
      if (error?.status === 403 || error?.status === 401) {
        await timing.sleep(IMAGE_POLL_DELAY_MS);
        return image;
      }
      if (!error?.transient) throw error;
    }
    await timing.sleep(IMAGE_POLL_DELAY_MS);
  }
  return image;
}

export async function publish({ account, accessToken, content, media }) {
  const author = account.externalAccountId;
  const images = [];
  for (const item of media) {
    images.push(
      await uploadImage({ token: accessToken, owner: author, media: item }),
    );
  }
  const body = {
    author,
    commentary: escapeLittleText(content || ""),
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (images.length === 1) {
    body.content = { media: { id: images[0] } };
  } else if (images.length > 1) {
    body.content = { multiImage: { images: images.map((id) => ({ id })) } };
  }
  const { response } = await rest("POST", "posts", {
    token: accessToken,
    json: body,
    timeoutMs: PUBLISH_TIMEOUT_MS,
  });
  const urn = readHeader(response, "x-restli-id");
  return {
    status: "published",
    externalPostId: urn || null,
    platformPostUrl: urn
      ? `https://www.linkedin.com/feed/update/${urn}/`
      : null,
  };
}

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
