import { classifyMetaError, graphVersion } from "./metaApi.js";
import { DirectApiError, configError } from "./directHttp.js";
import { createInstagramPublisher } from "./instagramPublishing.js";
import logger from "../../../utils/logger.js";

/**
 * Comptes Instagram professionnels par « Instagram API with Unified Login »
 * (connexion recommandée par Meta pour les nouvelles applis, Instagram
 * Login n'y étant plus proposé). Le client se connecte avec son seul compte
 * Instagram (sans compte Facebook) ou avec Facebook, choisit son portefeuille
 * business (créé par Meta s'il n'en a pas) et son compte : ni Page Facebook,
 * ni permission publicitaire.
 *
 * Appli Meta des Pages (META_APP_ID / META_APP_SECRET) : la configuration
 * Unified Login (META_INSTAGRAM_UNIFIED_CONFIG_ID, permissions
 * instagram_basic, instagram_content_publish, instagram_manage_messages)
 * vit dans le produit Instagram de cette appli. Sans elle, pas de connexion :
 * Unified Login ne fonctionne que par configuration (pas de « scope »).
 *
 * Jeton : jeton d'utilisateur système de l'intégration (Business Integration
 * System User Access Token), sans expiration si la configuration le dit
 * (« Jamais »), partagé par les comptes d'une même connexion
 * (credentialGroup). Rien à rafraîchir ; une date d'expiration renvoyée
 * malgré tout est gardée, et le compte passe « à reconnecter » après elle.
 *
 * Comptes : ceux assignés à l'utilisateur système (GET
 * /me/assigned_instagram_accounts), sinon ceux du portefeuille du client
 * (client_business_id), au mieux.
 *
 * Publication : mêmes appels qu'Instagram via Facebook
 * (instagramPublishing.js), sur graph.facebook.com, sans son tendance (l'API
 * Audio exige un jeton utilisateur).
 * Doc : developers.facebook.com/documentation/instagram-platform/
 * instagram-api-with-unified-login (get-started, authentication,
 * business-onboarding, permissions)
 */

export const NETWORK = "instagram";
export const PLATFORMS = ["instagram"];

const GRAPH_URL = "https://graph.facebook.com";
const DIALOG_URL = "https://www.facebook.com";
// Au-delà, le Reel est considéré comme non traité par Meta
export const MAX_PROCESSING_MS = 30 * 60 * 1000;
const MAX_PAGES = 5;
const PROFILE_FIELDS = "id,username,name,profile_picture_url";

const trimmed = (value) => String(value || "").trim();

/**
 * Appli et configuration Unified Login, null s'il en manque une.
 * @returns {{appId: string, appSecret: string, configId: string}|null}
 */
export function unifiedLoginSettings() {
  const appId = trimmed(process.env.META_APP_ID);
  const appSecret = trimmed(process.env.META_APP_SECRET);
  const configId = trimmed(process.env.META_INSTAGRAM_UNIFIED_CONFIG_ID);
  return appId && appSecret && configId ? { appId, appSecret, configId } : null;
}

export const isConfigured = () => Boolean(unifiedLoginSettings());

const classify = (response, data, label) =>
  classifyMetaError(response, data, label, NETWORK);

const publisher = createInstagramPublisher({
  network: NETWORK,
  graphUrl: GRAPH_URL,
  tokenIn: "query",
  classify,
  sounds: false,
});
const { graph } = publisher;

const missingConfig = () =>
  configError(
    NETWORK,
    "META_APP_ID, META_APP_SECRET ou META_INSTAGRAM_UNIFIED_CONFIG_ID absente",
  );

// ── Connexion ──────────────────────────────────────────────────────────────

export function buildAuthorizeUrl({ state, redirectUri }) {
  const settings = unifiedLoginSettings();
  if (!settings) throw missingConfig();
  const url = new URL(`${DIALOG_URL}/${graphVersion()}/dialog/oauth`);
  url.searchParams.set("client_id", settings.appId);
  url.searchParams.set("config_id", settings.configId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  // Code (et non jeton) même quand la configuration délivre un jeton
  // d'utilisateur système, comme dans l'adresse donnée par Meta
  url.searchParams.set("response_type", "code");
  url.searchParams.set("override_default_response_type", "true");
  return url.toString();
}

const expiresAt = (seconds, now = new Date()) =>
  Number(seconds) > 0 ? new Date(now.getTime() + Number(seconds) * 1000) : null;

/** Toutes les pages d'une liste Graph (5 au plus). */
async function listAll(path, token, fields) {
  const items = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data } = await graph("GET", path, {
      token,
      query: { fields, limit: 100, after },
    });
    items.push(...(data?.data || []));
    after = data?.paging?.next ? data?.paging?.cursors?.after : null;
    if (!after) break;
  }
  return items;
}

// Les lectures « au mieux » ignorent toute erreur, refus de permission
// compris (codes 200 à 299, classés authInvalid par classifyMetaError) : un
// jeton vraiment invalide fait déjà échouer les lectures obligatoires.

/** Utilisateur système et portefeuille du client (portefeuille au mieux). */
async function readSystemUser(token) {
  try {
    const { data } = await graph("GET", "me", {
      token,
      query: { fields: "id,client_business_id" },
    });
    return data || {};
  } catch {
    const { data } = await graph("GET", "me", {
      token,
      query: { fields: "id" },
    });
    return data || {};
  }
}

/**
 * Comptes Instagram ouverts à l'intégration : assignés à l'utilisateur
 * système, sinon ceux du portefeuille du client (au mieux).
 */
async function listInstagramAccounts(token, businessId) {
  const assigned = await listAll(
    "me/assigned_instagram_accounts",
    token,
    "id,username",
  );
  if (assigned.length > 0 || !businessId) {
    return { accounts: assigned, source: "assigned" };
  }
  try {
    const owned = await listAll(
      `${businessId}/instagram_accounts`,
      token,
      "id,username",
    );
    return { accounts: owned, source: "business" };
  } catch (error) {
    logger.warn(
      `[SocialConnect] Instagram unifié : comptes du portefeuille illisibles (${error.message})`,
    );
    return { accounts: [], source: "none" };
  }
}

/** Nom et photo d'un compte (au mieux : le pseudo de la liste suffit). */
async function readProfile(id, token) {
  try {
    const { data } = await graph("GET", String(id), {
      token,
      query: { fields: PROFILE_FIELDS },
    });
    return data || {};
  } catch {
    return {};
  }
}

/**
 * Code de retour → jeton d'utilisateur système → un compte par compte
 * Instagram ouvert à l'intégration. Aucun compte : liste vide (erreur
 * no_instagram_selected côté connexion).
 */
export async function exchangeCode({ code, redirectUri, now = new Date() }) {
  const settings = unifiedLoginSettings();
  if (!settings) throw missingConfig();
  const { data: tokenData } = await graph("GET", "oauth/access_token", {
    query: {
      client_id: settings.appId,
      client_secret: settings.appSecret,
      redirect_uri: redirectUri,
      code,
    },
  });
  const token = tokenData?.access_token;
  if (!token) {
    throw new DirectApiError("instagram : jeton absent de la réponse", {
      network: NETWORK,
      status: 502,
      transient: true,
    });
  }
  const tokenExpiresAt = expiresAt(tokenData.expires_in, now);
  const me = await readSystemUser(token);
  const metaUserId = me?.id ? String(me.id) : null;
  const businessId = me?.client_business_id
    ? String(me.client_business_id)
    : null;
  const { accounts: remote, source } = await listInstagramAccounts(
    token,
    businessId,
  );
  logger.info(
    `[SocialConnect] Instagram unifié : ${remote.length} compte(s) trouvé(s) (${source}), expiration ${tokenExpiresAt ? tokenExpiresAt.toISOString() : "aucune"}`,
  );

  const accounts = [];
  const seen = new Set();
  for (const item of remote) {
    const id = item?.id ? String(item.id) : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const profile = await readProfile(id, token);
    const username = profile.username || item.username || null;
    accounts.push({
      platform: "instagram",
      externalAccountId: id,
      username,
      displayName: profile.name || username,
      avatarUrl: profile.profile_picture_url || null,
      credentials: { accessToken: token, tokenExpiresAt, scopes: [] },
      // Même jeton pour tous les comptes de cette connexion
      credentialGroup: metaUserId ? `meta-system-user:${metaUserId}` : null,
      platformData: { metaUserId, businessId },
    });
  }
  return { accounts };
}

/** Pseudo, nom et photo relus (rafraîchissement régulier du compte). */
export async function fetchProfile({ account, accessToken }) {
  const id = String(account.externalAccountId);
  const { data } = await graph("GET", id, {
    token: accessToken,
    query: { fields: PROFILE_FIELDS },
  });
  if (!data?.id) {
    throw new DirectApiError("instagram : compte introuvable", {
      network: NETWORK,
      status: 404,
    });
  }
  return {
    externalAccountId: id,
    username: data.username || null,
    displayName: data.name || data.username || null,
    avatarUrl: data.profile_picture_url || null,
  };
}

// ── Publication ────────────────────────────────────────────────────────────

/** Photo, carrousel, Reel ou stories (sans son tendance). */
export const { publish, checkPublication } = publisher;

export default {
  NETWORK,
  PLATFORMS,
  usesPkce: false,
  // Jeton sans renouvellement : rien à rafraîchir à l'avance
  refreshAheadMs: 0,
  refreshesAccessToken: false,
  isConfigured,
  buildAuthorizeUrl,
  exchangeCode,
  fetchProfile,
  publish,
  checkPublication,
  maxProcessingMs: MAX_PROCESSING_MS,
};
