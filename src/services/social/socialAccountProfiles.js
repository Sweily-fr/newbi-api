import SocialAccount from "../../models/SocialAccount.js";
import logger from "../../utils/logger.js";
import {
  getFreshAccessToken,
  markNeedsReconnect,
} from "./socialAccountCredentials.js";
import { directNetworkFor } from "./socialProviders.js";

/**
 * Nom, pseudo et photo des comptes « direct » relus chez le réseau au moins
 * tous les 28 jours (LinkedIn exige de rafraîchir les données d'une page au
 * moins toutes les 8 semaines ; même règle pour tous les réseaux). Appelé
 * par le cron de publication directe, une fois par heure (instance PM2 0).
 *
 * - fetchProfile du module du réseau : mêmes lectures qu'à la connexion,
 *   aucune permission de plus. Un nom ou un pseudo absent de la réponse
 *   reste tel quel ; une photo absente est effacée.
 * - Un essai par jour au plus et par compte (profileRefreshAttemptedAt),
 *   même en échec : jamais de relecture en boucle.
 * - Échec journalisé sans toucher au statut du compte, sauf jeton refusé
 *   même après un rafraîchissement (« à reconnecter », comme à la
 *   publication).
 * - Jeton partagé (credentialGroup) : rafraîchi une fois pour le groupe.
 * Les comptes Zernio ne sont pas concernés (Zernio garde leurs données).
 */

export const PROFILE_MAX_AGE_MS = 28 * 24 * 60 * 60 * 1000;
export const PROFILE_RETRY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 20;

const notTriedSince = (now) => ({
  $or: [
    { profileRefreshAttemptedAt: null },
    {
      profileRefreshAttemptedAt: {
        $lte: new Date(now.getTime() - PROFILE_RETRY_MS),
      },
    },
  ],
});

/** Comptes dont le profil a plus de 28 jours (filtre Mongo). */
export function profileDueFilter(now = new Date()) {
  const cutoff = new Date(now.getTime() - PROFILE_MAX_AGE_MS);
  return {
    provider: "direct",
    status: "active",
    deletedAt: null,
    $and: [
      {
        $or: [
          { profileRefreshedAt: { $lte: cutoff } },
          // Jamais relu : date de la connexion, sinon de création
          { profileRefreshedAt: null, lastSyncedAt: { $lte: cutoff } },
          {
            profileRefreshedAt: null,
            lastSyncedAt: null,
            createdAt: { $lte: cutoff },
          },
        ],
      },
      notTriedSince(now),
    ],
  };
}

/** Champs du compte à écrire d'après la réponse du réseau. */
export function profileFields(profile = {}) {
  const fields = {};
  if (profile.username) fields.username = profile.username;
  if (profile.displayName) fields.displayName = profile.displayName;
  if (profile.avatarUrl !== undefined) {
    fields.avatarUrl = profile.avatarUrl || null;
  }
  return fields;
}

const groupKey = (account) =>
  account.credentialGroup
    ? `${account.workspaceId}:${account.credentialGroup}`
    : null;

/**
 * Profil lu avec un jeton frais, un nouvel essai après rafraîchissement si
 * le réseau refuse le jeton (même règle qu'à la publication).
 */
async function readProfile(account, network, now, groupTokens) {
  const group = groupKey(account);
  let token =
    (group && groupTokens.get(group)) ||
    (await getFreshAccessToken(account, { now }));
  if (group) groupTokens.set(group, token);
  try {
    return await network.fetchProfile({ account, accessToken: token });
  } catch (error) {
    if (!error?.authInvalid) throw error;
    // Jeton refusé avant sa date : un rafraîchissement peut le sauver (un
    // rafraîchissement refusé met lui-même le compte « à reconnecter »)
    token = await getFreshAccessToken(account, { now, force: true });
    if (group) groupTokens.set(group, token);
    try {
      return await network.fetchProfile({ account, accessToken: token });
    } catch (retryError) {
      // Refusé même rafraîchi : à reconnecter, comme à la publication
      if (retryError?.authInvalid) {
        await markNeedsReconnect(account, retryError.message);
      }
      throw retryError;
    }
  }
}

/**
 * Un tour : au plus `limit` comptes dont le profil a plus de 28 jours.
 * @returns {Promise<{refreshed: number, failed: number}>}
 */
export async function refreshAccountProfiles({
  now = new Date(),
  limit = BATCH_SIZE,
} = {}) {
  const stats = { refreshed: 0, failed: 0 };
  const accounts = await SocialAccount.find(profileDueFilter(now))
    .select("+accessToken +refreshToken")
    .sort({ profileRefreshedAt: 1, lastSyncedAt: 1, createdAt: 1 })
    .limit(limit);
  // Jeton déjà obtenu dans ce tour pour un groupe (credentialGroup)
  const groupTokens = new Map();

  for (const account of accounts) {
    // Essai réservé (un par jour au plus, même s'il échoue)
    const claimed = await SocialAccount.updateOne(
      { _id: account._id, ...notTriedSince(now) },
      { $set: { profileRefreshAttemptedAt: now } },
      { timestamps: false },
    );
    if (claimed.modifiedCount === 0) continue;
    const network = directNetworkFor(account.platform, account.connector);
    if (!network?.fetchProfile || !network.isConfigured()) continue;
    try {
      const profile = await readProfile(account, network, now, groupTokens);
      if (
        profile?.externalAccountId &&
        String(profile.externalAccountId) !== account.externalAccountId
      ) {
        throw new Error("le réseau a renvoyé un autre compte");
      }
      await SocialAccount.updateOne(
        { _id: account._id, deletedAt: null },
        { $set: { ...profileFields(profile), profileRefreshedAt: now } },
      );
      stats.refreshed += 1;
    } catch (error) {
      stats.failed += 1;
      logger.warn(
        `[SocialDirect] Profil ${account.platform} ${account._id} non relu : ${error.message}`,
      );
    }
  }
  return stats;
}
