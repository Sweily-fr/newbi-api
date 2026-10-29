import instagramApi from "./direct/instagramApi.js";
import linkedinApi from "./direct/linkedinApi.js";
import metaApi from "./direct/metaApi.js";
import tiktokApi from "./direct/tiktokApi.js";
import xApi from "./direct/xApi.js";
import { isZernioConfigured } from "./providers/zernioProvider.js";
import storage from "./socialMediaStorage.js";
import { SOCIAL_PLATFORMS } from "./socialPostRules.js";

/**
 * Choix du fournisseur de publication, réseau par réseau.
 *
 * SOCIAL_PROVIDER_<RÉSEAU> (FACEBOOK, INSTAGRAM, LINKEDIN, TIKTOK, TWITTER)
 * = « zernio » (défaut) ou « direct » (notre propre appli chez le réseau).
 * SOCIAL_DIRECT_WORKSPACE_IDS (identifiants d'espaces séparés par des
 * virgules, vide = tous), ou SOCIAL_DIRECT_WORKSPACE_IDS_<RÉSEAU> qui le
 * remplace pour un réseau : seuls ces espaces passent en direct, les autres
 * restent sur Zernio (comptes de relecture Meta, LinkedIn et TikTok sur la
 * prod pendant que les clients restent sur Zernio).
 *
 * Un réseau est disponible pour un espace si son fournisseur est configuré
 * (ZERNIO_API_KEY, ou identifiants de notre appli + DATA_ENCRYPTION_KEY +
 * stockage des images). Une connexion neuve passe par le fournisseur
 * choisi ; un compte déjà connecté garde le sien (SocialAccount.provider).
 */

const ENV_SUFFIX = {
  facebook: "FACEBOOK",
  instagram: "INSTAGRAM",
  linkedin: "LINKEDIN",
  tiktok: "TIKTOK",
  twitter: "TWITTER",
};

const NETWORK_BY_PLATFORM = {
  facebook: metaApi,
  instagram: instagramApi,
  linkedin: linkedinApi,
  tiktok: tiktokApi,
  twitter: xApi,
};

/** Module de l'API officielle d'un réseau (null si inconnu). */
export const directNetworkFor = (platform) =>
  NETWORK_BY_PLATFORM[platform] || null;

export const isEncryptionConfigured = () =>
  Boolean(process.env.DATA_ENCRYPTION_KEY);

/**
 * Notre appli est utilisable pour ce réseau : identifiants, clé de
 * chiffrement des jetons et stockage public des images. Vrai pour publier
 * avec un compte « direct » déjà connecté, quel que soit le réglage
 * SOCIAL_PROVIDER_<RÉSEAU>.
 */
export function isDirectNetworkReady(platform) {
  const network = directNetworkFor(platform);
  return Boolean(
    network?.isConfigured() &&
    isEncryptionConfigured() &&
    storage.isConfigured(),
  );
}

const parseIds = (value) =>
  String(value || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

/** Espaces autorisés en direct pour ce réseau (null = tous). */
function directWorkspaceIds(platform) {
  const specific =
    process.env[`SOCIAL_DIRECT_WORKSPACE_IDS_${ENV_SUFFIX[platform]}`];
  const ids = parseIds(
    specific !== undefined && specific.trim() !== ""
      ? specific
      : process.env.SOCIAL_DIRECT_WORKSPACE_IDS,
  );
  return ids.length ? new Set(ids) : null;
}

/**
 * Fournisseur d'une connexion neuve pour cet espace : « direct » si le
 * réseau est réglé en direct ET que l'espace est dans la liste éventuelle,
 * sinon « zernio ».
 */
export function connectionProvider(platform, workspaceId) {
  const suffix = ENV_SUFFIX[platform];
  if (!suffix) return "zernio";
  const choice = String(process.env[`SOCIAL_PROVIDER_${suffix}`] || "")
    .trim()
    .toLowerCase();
  if (choice !== "direct") return "zernio";
  const allowed = directWorkspaceIds(platform);
  if (allowed && !allowed.has(String(workspaceId || ""))) return "zernio";
  return "direct";
}

/** Réseau connectable par cet espace (fournisseur choisi configuré). */
export function isPlatformAvailable(platform, workspaceId) {
  if (!SOCIAL_PLATFORMS.includes(platform)) return false;
  return connectionProvider(platform, workspaceId) === "direct"
    ? isDirectNetworkReady(platform)
    : isZernioConfigured();
}

/** Réseaux connectables par cet espace, dans l'ordre habituel. */
export const availablePlatforms = (workspaceId) =>
  SOCIAL_PLATFORMS.filter((platform) =>
    isPlatformAvailable(platform, workspaceId),
  );

/** Au moins un réseau publiable en direct (cron de publication). */
export const isAnyDirectNetworkReady = () =>
  SOCIAL_PLATFORMS.some((platform) => isDirectNetworkReady(platform));

/** Fonctionnalité active côté serveur : Zernio ou au moins une appli. */
export const isSocialPublishingEnabled = () =>
  isZernioConfigured() || isAnyDirectNetworkReady();

/** Le fournisseur d'un compte connecté peut encore publier. */
export const isAccountProviderUsable = (account) =>
  account?.provider === "direct"
    ? isDirectNetworkReady(account.platform)
    : isZernioConfigured();
