import crypto from "crypto";
import SocialAccount from "../../models/SocialAccount.js";
import SocialConnectState from "../../models/SocialConnectState.js";
import { decrypt, encrypt } from "../../utils/encryption.js";
import logger from "../../utils/logger.js";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import { userHasWorkspaceAction } from "../../utils/workspace-membership.js";
import {
  clearedCredentialFields,
  credentialFields,
  decryptTokens,
  loadAccountWithTokens,
} from "./socialAccountCredentials.js";
import {
  CONNECT_STATE_TTL_MS,
  DEFAULT_RETURN_TO,
  directRedirectUri,
  frontendRedirect,
  safeCode,
  sanitizeReturnTo,
} from "./socialConnectUrls.js";
import { directNetworkFor, isDirectNetworkReady } from "./socialProviders.js";

/**
 * Connexion d'un compte par notre propre appli chez le réseau (OAuth
 * « direct ») : jeton d'état aléatoire à usage unique (SocialConnectState,
 * 15 minutes, avec le vérificateur PKCE de X chiffré), retour sur
 * /social-connect/<réseau>/callback, échange du code, jetons chiffrés.
 * Mêmes conventions de retour vers le site que Zernio.
 */

// Refus de l'utilisateur dans la fenêtre du réseau → « cancelled »
const CANCEL_CODES = new Set([
  "access_denied",
  "user_cancelled_login",
  "user_cancelled_authorize",
  "user_denied",
]);

/** Adresse de la fenêtre d'autorisation du réseau. */
export async function createDirectConnectUrl({
  workspaceId,
  userId,
  platform,
  returnTo,
  now = new Date(),
}) {
  const network = directNetworkFor(platform);
  const token = crypto.randomBytes(24).toString("base64url");
  const codeVerifier = network.usesPkce
    ? crypto.randomBytes(48).toString("base64url")
    : null;
  await SocialConnectState.create({
    token,
    workspaceId,
    userId,
    platform,
    provider: "direct",
    codeVerifier: codeVerifier ? encrypt(codeVerifier) : null,
    returnTo: sanitizeReturnTo(returnTo),
    expiresAt: new Date(now.getTime() + CONNECT_STATE_TTL_MS),
  });
  return network.buildAuthorizeUrl({
    state: token,
    redirectUri: directRedirectUri(platform),
    codeChallenge: codeVerifier
      ? crypto.createHash("sha256").update(codeVerifier).digest("base64url")
      : undefined,
  });
}

/**
 * Enregistre les comptes renvoyés par le réseau (jetons chiffrés). Un
 * compte déjà actif dans un autre espace est ignoré ; un compte déconnecté
 * d'un autre espace libère son identifiant (renommé) pour celui-ci.
 * @returns {Promise<{saved: number, taken: number}>}
 */
export async function saveDirectAccounts(
  workspaceId,
  accounts,
  { connectedBy = null, now = new Date() } = {},
) {
  const connector = toObjectIdOrNull(String(connectedBy || ""));
  let saved = 0;
  let taken = 0;
  for (const remote of accounts) {
    let existing = await SocialAccount.findOne({
      provider: "direct",
      externalAccountId: remote.externalAccountId,
    });
    if (existing && String(existing.workspaceId) !== String(workspaceId)) {
      if (!existing.deletedAt) {
        logger.warn(
          `[SocialDirect] Compte ${remote.platform} ${remote.externalAccountId} déjà connecté à un autre espace, ignoré`,
        );
        taken += 1;
        continue;
      }
      await SocialAccount.updateOne(
        { _id: existing._id, deletedAt: { $ne: null } },
        {
          $set: {
            externalAccountId: `${existing.externalAccountId}#archive-${existing._id}`,
          },
        },
      );
      existing = null;
    }
    const fields = {
      platform: remote.platform,
      username: remote.username || null,
      displayName: remote.displayName || null,
      avatarUrl: remote.avatarUrl || null,
      status: "active",
      lastSyncedAt: now,
      deletedAt: null,
      credentialGroup: remote.credentialGroup || null,
      platformData: remote.platformData || null,
      ...credentialFields(remote.credentials),
    };
    try {
      if (existing) {
        const reconnected = existing.deletedAt || existing.status !== "active";
        await SocialAccount.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...fields,
              ...(connector && reconnected ? { connectedBy: connector } : {}),
            },
          },
        );
      } else {
        await SocialAccount.create({
          ...fields,
          workspaceId,
          provider: "direct",
          externalAccountId: remote.externalAccountId,
          connectedBy: connector,
        });
      }
      saved += 1;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      taken += 1;
    }
  }
  return { saved, taken };
}

/**
 * LinkedIn : les identifiants de membre sont propres à chaque appli. Un
 * profil déjà connecté (et actif) par l'appli « profile » par le même
 * utilisateur reste sur celle-ci : une connexion par l'appli « pages »
 * n'ajoute alors que les pages, sans doublon du profil.
 */
async function withoutKnownLinkedInProfile(state, accounts) {
  const isPagesProfile = (account) =>
    account.platformData?.kind === "person" &&
    account.platformData?.app === "pages";
  if (!accounts.some(isPagesProfile)) return accounts;
  const known = await SocialAccount.exists({
    workspaceId: state.workspaceId,
    provider: "direct",
    platform: "linkedin",
    status: "active",
    deletedAt: null,
    connectedBy: state.userId,
    "platformData.kind": "person",
    "platformData.app": { $ne: "pages" },
  });
  return known
    ? accounts.filter((account) => !isPagesProfile(account))
    : accounts;
}

/**
 * Retour du navigateur après l'autorisation chez le réseau : jeton d'état à
 * usage unique et du même réseau, droit « Applications » toujours présent,
 * échange du code, enregistrement des comptes, puis adresse du site.
 * @returns {Promise<string>} adresse de redirection
 */
export async function completeDirectConnect(
  platform,
  query = {},
  { now = new Date() } = {},
) {
  const token =
    typeof query.state === "string" && query.state.length <= 64
      ? query.state
      : null;
  const state = token
    ? await SocialConnectState.findOneAndDelete({
        token,
        provider: "direct",
        expiresAt: { $gt: now },
      })
    : null;
  if (!state || state.platform !== platform) {
    logger.warn(
      `[SocialConnect] Retour OAuth ${platform} avec un state inconnu, expiré ou d'un autre réseau`,
    );
    return frontendRedirect(DEFAULT_RETURN_TO, {
      social_error: "invalid_state",
    });
  }
  const fail = (code) =>
    frontendRedirect(state.returnTo, {
      social_error: code,
      social_platform: platform,
    });

  if (query.error) {
    const code = String(query.error);
    logger.warn(
      `[SocialConnect] Connexion ${platform} refusée pour l'espace ${state.workspaceId} : ${code}`,
    );
    return fail(CANCEL_CODES.has(code) ? "cancelled" : safeCode(code));
  }
  const allowed = await userHasWorkspaceAction(
    String(state.userId),
    String(state.workspaceId),
    "integrations",
    "manage",
  );
  if (!allowed) return fail("forbidden");
  if (typeof query.code !== "string" || !query.code)
    return fail("connection_failed");
  if (!isDirectNetworkReady(platform)) return fail("unavailable");

  let result;
  try {
    result = await directNetworkFor(platform).exchangeCode({
      code: query.code,
      redirectUri: directRedirectUri(platform),
      codeVerifier: state.codeVerifier
        ? decrypt(state.codeVerifier)
        : undefined,
      now,
    });
  } catch (error) {
    logger.error(
      `[SocialConnect] Échange du code ${platform} impossible (espace ${state.workspaceId}) : ${error.message}`,
    );
    return fail("connection_failed");
  }
  const accounts = (result?.accounts || []).filter(
    (account) => account.platform === platform && account.externalAccountId,
  );
  if (accounts.length === 0) {
    return fail(platform === "facebook" ? "no_facebook_pages" : "no_account");
  }
  const toSave = await withoutKnownLinkedInProfile(state, accounts);
  if (toSave.length === 0) {
    return frontendRedirect(state.returnTo, { social_connected: platform });
  }
  const { saved, taken } = await saveDirectAccounts(state.workspaceId, toSave, {
    connectedBy: state.userId,
    now,
  });
  if (saved === 0 && taken > 0) return fail("account_in_use");
  logger.info(
    `[SocialConnect] ${saved} compte(s) ${platform} connecté(s) en direct pour l'espace ${state.workspaceId}`,
  );
  return frontendRedirect(state.returnTo, { social_connected: platform });
}

/**
 * Déconnexion d'un compte « direct » : accès révoqué chez le réseau quand
 * son API le permet et que le jeton n'est pas partagé avec un autre compte
 * encore connecté (au mieux), puis jetons effacés.
 */
export async function disconnectDirectAccount(
  account,
  { now = new Date() } = {},
) {
  const network = directNetworkFor(account.platform);
  if (network?.revoke && network.isConfigured()) {
    const shared =
      account.credentialGroup &&
      (await SocialAccount.exists({
        _id: { $ne: account._id },
        workspaceId: account.workspaceId,
        provider: "direct",
        credentialGroup: account.credentialGroup,
        deletedAt: null,
      }));
    if (!shared) {
      try {
        const withTokens = await loadAccountWithTokens({ _id: account._id });
        await network.revoke(decryptTokens(withTokens));
      } catch (error) {
        logger.warn(
          `[SocialDirect] Accès ${account.platform} non révoqué chez le réseau (compte ${account._id}) : ${error.message}`,
        );
      }
    }
  }
  await SocialAccount.updateOne(
    { _id: account._id },
    { $set: { deletedAt: now, ...clearedCredentialFields() } },
  );
}
