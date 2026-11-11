import SocialAccount from "../../models/SocialAccount.js";
import { decrypt, encrypt, isEncrypted } from "../../utils/encryption.js";
import logger from "../../utils/logger.js";
import { DirectApiError, timing } from "./direct/directHttp.js";
import { directConnectorsOf, directNetworkFor } from "./socialProviders.js";

/**
 * Jetons des comptes « direct » : chiffrés au repos (utils/encryption.js),
 * déchiffrés seulement au moment d'appeler le réseau, jamais renvoyés au
 * site ni journalisés. Rafraîchis avant usage quand ils arrivent à
 * expiration, un seul rafraîchissement à la fois par compte (bail
 * tokenRefreshLockedUntil : X fait tourner le jeton de rafraîchissement,
 * deux rafraîchissements simultanés perdraient le compte).
 */

const DEFAULT_REFRESH_AHEAD_MS = 5 * 60 * 1000;
const REFRESH_LOCK_MS = 30 * 1000;
const REFRESH_WAIT_MS = 1500;

const encrypted = (value) =>
  value ? (isEncrypted(value) ? value : encrypt(value)) : null;

/** Champs du compte pour des jetons neufs (chiffrés). */
export function credentialFields(credentials = {}) {
  return {
    accessToken: encrypted(credentials.accessToken),
    refreshToken: encrypted(credentials.refreshToken),
    tokenExpiresAt: credentials.tokenExpiresAt || null,
    refreshTokenExpiresAt: credentials.refreshTokenExpiresAt || null,
    tokenScopes: Array.isArray(credentials.scopes) ? credentials.scopes : [],
    tokenRefreshLockedUntil: null,
  };
}

/** Champs qui effacent les jetons (déconnexion). */
export const clearedCredentialFields = () => ({
  accessToken: null,
  refreshToken: null,
  tokenExpiresAt: null,
  refreshTokenExpiresAt: null,
  tokenScopes: [],
  tokenRefreshLockedUntil: null,
});

/** Compte avec ses jetons chiffrés (sélection explicite). */
export const loadAccountWithTokens = (filter) =>
  SocialAccount.findOne(filter).select("+accessToken +refreshToken");

export const decryptTokens = (account) => ({
  accessToken: account?.accessToken ? decrypt(account.accessToken) : null,
  refreshToken: account?.refreshToken ? decrypt(account.refreshToken) : null,
});

// Comptes qui partagent ce jeton (profil et pages LinkedIn d'un membre)
const groupFilter = (account) =>
  account.credentialGroup
    ? {
        workspaceId: account.workspaceId,
        provider: "direct",
        credentialGroup: account.credentialGroup,
      }
    : { _id: account._id };

/** Jeton invalide ou révoqué : le compte (et son groupe) à reconnecter. */
export async function markNeedsReconnect(account, reason = "") {
  await SocialAccount.updateMany(
    { ...groupFilter(account), deletedAt: null },
    { $set: { status: "needs_reconnect", tokenRefreshLockedUntil: null } },
  );
  logger.warn(
    `[SocialDirect] Compte ${account.platform} ${account._id} à reconnecter${reason ? ` : ${reason}` : ""}`,
  );
}

const authError = (account, message) =>
  new DirectApiError(message, {
    network: account.platform,
    kind: "auth",
    category: "auth_expired",
    authInvalid: true,
  });

/**
 * Jeton d'accès utilisable tout de suite : rafraîchi s'il expire bientôt
 * (ou si force), sinon tel quel.
 * @param {object} account - compte chargé avec loadAccountWithTokens
 * @param {object} [options]
 * @param {boolean} [options.force] - rafraîchir même s'il n'expire pas
 *   (le réseau vient de le refuser)
 * @returns {Promise<string>}
 * @throws {DirectApiError} authInvalid si le compte doit être reconnecté
 */
export async function getFreshAccessToken(
  account,
  { now = new Date(), force = false } = {},
) {
  const network = directNetworkFor(account.platform, account.connector);
  const { accessToken, refreshToken } = decryptTokens(account);
  if (!accessToken) {
    await markNeedsReconnect(account, "jeton absent");
    throw authError(account, "Jeton absent");
  }
  const expiresAt = account.tokenExpiresAt
    ? new Date(account.tokenExpiresAt).getTime()
    : null;
  const ahead = network?.refreshAheadMs ?? DEFAULT_REFRESH_AHEAD_MS;
  const expiring = expiresAt !== null && expiresAt - ahead <= now.getTime();
  if (!force && !expiring) return accessToken;

  const canRefresh = network?.refreshesAccessToken
    ? true
    : Boolean(refreshToken) &&
      (!account.refreshTokenExpiresAt ||
        new Date(account.refreshTokenExpiresAt).getTime() > now.getTime());
  if (!canRefresh) {
    const expired = expiresAt !== null && expiresAt <= now.getTime();
    if (force || expired) {
      await markNeedsReconnect(
        account,
        "jeton expiré, pas de rafraîchissement",
      );
      throw authError(account, "Jeton expiré");
    }
    return accessToken;
  }

  const claimed = await SocialAccount.findOneAndUpdate(
    {
      _id: account._id,
      $or: [
        { tokenRefreshLockedUntil: null },
        { tokenRefreshLockedUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        tokenRefreshLockedUntil: new Date(now.getTime() + REFRESH_LOCK_MS),
      },
    },
    { new: true },
  ).select("+accessToken +refreshToken");

  if (!claimed) {
    // Rafraîchissement en cours ailleurs : on reprend son résultat
    await timing.sleep(REFRESH_WAIT_MS);
    const reloaded = await loadAccountWithTokens({ _id: account._id });
    const tokens = decryptTokens(reloaded);
    const reloadedExpiry = reloaded?.tokenExpiresAt
      ? new Date(reloaded.tokenExpiresAt).getTime()
      : null;
    if (
      reloaded?.status === "active" &&
      tokens.accessToken &&
      tokens.accessToken !== accessToken &&
      (reloadedExpiry === null || reloadedExpiry > now.getTime())
    ) {
      return tokens.accessToken;
    }
    throw new DirectApiError("Rafraîchissement du jeton déjà en cours", {
      network: account.platform,
      transient: true,
    });
  }

  try {
    const fresh = await network.refreshCredentials({
      // LinkedIn : identifiants de l'appli qui a connecté le compte
      account,
      accessToken,
      refreshToken,
      now,
    });
    const fields = credentialFields({
      ...fresh,
      // Jeton de rafraîchissement inchangé quand le réseau n'en renvoie pas
      refreshToken: fresh.refreshToken || refreshToken,
      scopes: fresh.scopes?.length ? fresh.scopes : account.tokenScopes,
    });
    await SocialAccount.updateMany(
      { ...groupFilter(account), deletedAt: null },
      { $set: fields },
    );
    logger.info(
      `[SocialDirect] Jeton ${account.platform} rafraîchi (compte ${account._id})`,
    );
    return fresh.accessToken;
  } catch (error) {
    await SocialAccount.updateOne(
      { _id: account._id },
      { $set: { tokenRefreshLockedUntil: null } },
    );
    if (error?.authInvalid) {
      await markNeedsReconnect(account, "rafraîchissement refusé");
    }
    throw error;
  }
}

/**
 * Rafraîchit à l'avance les jetons qui le demandent même sans publication
 * (Instagram, par Instagram Login ou via Facebook : perdu après 60 jours
 * sans rafraîchissement). Au mieux.
 * @returns {Promise<number>} nombre de comptes rafraîchis
 */
export async function refreshExpiringTokens({
  now = new Date(),
  limit = 20,
} = {}) {
  let count = 0;
  for (const { platform, connector, module: network } of directConnectorsOf(
    "instagram",
  )) {
    if (!network?.isConfigured() || !network.refreshAheadMs) continue;
    const accounts = await SocialAccount.find({
      provider: "direct",
      platform,
      // null couvre aussi les comptes connectés avant les connecteurs
      connector,
      status: "active",
      deletedAt: null,
      tokenExpiresAt: {
        $gt: now,
        $lte: new Date(now.getTime() + network.refreshAheadMs),
      },
    })
      .select("+accessToken +refreshToken")
      .limit(limit);
    // Jeton partagé (comptes Instagram d'une même connexion via Facebook) :
    // rafraîchi une fois pour tout le groupe
    const refreshedGroups = new Set();
    for (const account of accounts) {
      const group = account.credentialGroup
        ? `${account.workspaceId}:${account.credentialGroup}`
        : null;
      if (group && refreshedGroups.has(group)) continue;
      try {
        await getFreshAccessToken(account, { now });
        if (group) refreshedGroups.add(group);
        count += 1;
      } catch (error) {
        logger.warn(
          `[SocialDirect] Jeton ${platform} ${account._id} non rafraîchi : ${error.message}`,
        );
      }
    }
  }
  return count;
}
