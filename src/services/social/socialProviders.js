import instagramApi from "./direct/instagramApi.js";
import instagramFacebookApi from "./direct/instagramFacebookApi.js";
import linkedinApi from "./direct/linkedinApi.js";
import metaApi from "./direct/metaApi.js";
import tiktokApi from "./direct/tiktokApi.js";
import tiktokBusinessApi from "./direct/tiktokBusinessApi.js";
import xApi from "./direct/xApi.js";
import { isZernioConfigured } from "./providers/zernioProvider.js";
import storage from "./socialMediaStorage.js";
import { SOCIAL_PLATFORMS, platformLabel } from "./socialPostRules.js";

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
 *
 * Connecteurs : façons de connecter un réseau en direct. Chaque réseau a
 * son connecteur habituel (clé = réseau) ; Instagram peut aussi passer par
 * Facebook (instagram_facebook, sons tendance) et TikTok par TikTok API for
 * Business (tiktok_business, sons tendance). Les connecteurs de plus
 * n'existent qu'en direct et suivent le même réglage
 * SOCIAL_PROVIDER_<RÉSEAU> / SOCIAL_DIRECT_WORKSPACE_IDS[_<RÉSEAU>].
 * Le compte garde son connecteur (SocialAccount.connector : null,
 * « facebook » ou « business »).
 */

const ENV_SUFFIX = {
  facebook: "FACEBOOK",
  instagram: "INSTAGRAM",
  linkedin: "LINKEDIN",
  tiktok: "TIKTOK",
  twitter: "TWITTER",
};

/**
 * Registre des connecteurs, dans l'ordre d'affichage : clé → réseau,
 * connecteur gardé sur le compte, module de l'API, libellé et aide.
 */
const CONNECTORS = [
  {
    key: "instagram",
    platform: "instagram",
    connector: null,
    module: instagramApi,
    label: "Instagram",
    description: null,
  },
  {
    key: "instagram_facebook",
    platform: "instagram",
    connector: "facebook",
    module: instagramFacebookApi,
    label: "Instagram via Facebook",
    description:
      "Permet d'ajouter un son tendance aux Reels. Le compte doit être relié à une Page Facebook.",
  },
  {
    key: "facebook",
    platform: "facebook",
    connector: null,
    module: metaApi,
    label: "Facebook",
    description: null,
  },
  {
    key: "linkedin",
    platform: "linkedin",
    connector: null,
    module: linkedinApi,
    label: "LinkedIn",
    description: null,
  },
  {
    key: "twitter",
    platform: "twitter",
    connector: null,
    module: xApi,
    label: "X",
    description: null,
  },
  {
    key: "tiktok",
    platform: "tiktok",
    connector: null,
    module: tiktokApi,
    label: "TikTok",
    description: null,
  },
  {
    key: "tiktok_business",
    platform: "tiktok",
    connector: "business",
    module: tiktokBusinessApi,
    label: "TikTok Business",
    description: "Permet d'ajouter un son tendance.",
  },
];

const CONNECTORS_BY_KEY = new Map(
  CONNECTORS.map((entry) => [entry.key, entry]),
);

/** Connecteur d'une clé (liste fermée), null sinon. */
export const connectorByKey = (key) =>
  typeof key === "string" ? CONNECTORS_BY_KEY.get(key) || null : null;

/** Connecteur d'un compte (réseau + SocialAccount.connector). */
export const connectorOf = (platform, connector = null) =>
  CONNECTORS.find(
    (entry) =>
      entry.platform === platform && entry.connector === (connector || null),
  ) || null;

/** Module de l'API officielle d'un réseau et d'un connecteur (null si inconnu). */
export const directNetworkFor = (platform, connector = null) =>
  connectorOf(platform, connector)?.module || null;

export const isEncryptionConfigured = () =>
  Boolean(process.env.DATA_ENCRYPTION_KEY);

/**
 * Notre appli est utilisable pour ce réseau (et ce connecteur) :
 * identifiants, clé de chiffrement des jetons et stockage public des
 * images. Vrai pour publier avec un compte « direct » déjà connecté, quel
 * que soit le réglage SOCIAL_PROVIDER_<RÉSEAU>.
 */
export function isDirectNetworkReady(platform, connector = null) {
  const network = directNetworkFor(platform, connector);
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

/**
 * Connecteur proposé à cet espace : le connecteur habituel suit le
 * fournisseur du réseau (Zernio ou notre appli) ; un connecteur de plus
 * exige le direct et son appli configurée.
 */
export function isConnectorAvailable(key, workspaceId) {
  const entry = connectorByKey(key);
  if (!entry) return false;
  const direct = connectionProvider(entry.platform, workspaceId) === "direct";
  if (entry.connector) {
    return direct && isDirectNetworkReady(entry.platform, entry.connector);
  }
  return direct ? isDirectNetworkReady(entry.platform) : isZernioConfigured();
}

/** Connecteurs proposés à cet espace (SocialConnector GraphQL). */
export const availableConnectors = (workspaceId) =>
  CONNECTORS.filter((entry) =>
    isConnectorAvailable(entry.key, workspaceId),
  ).map(({ key, platform, label, description }) => ({
    key,
    platform,
    label: label || platformLabel(platform),
    description: description || null,
  }));

/** Réseau connectable par cet espace (au moins un connecteur disponible). */
export function isPlatformAvailable(platform, workspaceId) {
  if (!SOCIAL_PLATFORMS.includes(platform)) return false;
  return CONNECTORS.some(
    (entry) =>
      entry.platform === platform &&
      isConnectorAvailable(entry.key, workspaceId),
  );
}

/** Réseaux connectables par cet espace, dans l'ordre habituel. */
export const availablePlatforms = (workspaceId) =>
  SOCIAL_PLATFORMS.filter((platform) =>
    isPlatformAvailable(platform, workspaceId),
  );

/** Au moins un réseau publiable en direct (cron de publication). */
export const isAnyDirectNetworkReady = () =>
  CONNECTORS.some((entry) =>
    isDirectNetworkReady(entry.platform, entry.connector),
  );

/** Fonctionnalité active côté serveur : Zernio ou au moins une appli. */
export const isSocialPublishingEnabled = () =>
  isZernioConfigured() || isAnyDirectNetworkReady();

/** Le fournisseur d'un compte connecté peut encore publier. */
export const isAccountProviderUsable = (account) =>
  account?.provider === "direct"
    ? isDirectNetworkReady(account.platform, account.connector)
    : isZernioConfigured();

/** Connecteurs « direct » d'un réseau (rafraîchissement des jetons). */
export const directConnectorsOf = (platform) =>
  CONNECTORS.filter((entry) => entry.platform === platform);
