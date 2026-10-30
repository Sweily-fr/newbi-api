import crypto from "crypto";
import { Board, Column, Task } from "../../models/kanban.js";
import SocialAccount from "../../models/SocialAccount.js";
import SocialConnectState from "../../models/SocialConnectState.js";
import SocialPost from "../../models/SocialPost.js";
import SocialPostMedia from "../../models/SocialPostMedia.js";
import SocialProfile from "../../models/SocialProfile.js";
import logger from "../../utils/logger.js";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import { userHasWorkspaceAction } from "../../utils/workspace-membership.js";
import provider, { SocialProviderError } from "./providers/zernioProvider.js";
import {
  DRAFT_NEEDS_RECONNECT_MESSAGE,
  INSTAGRAM_SOUND_ACCOUNT_MESSAGE,
  INSTAGRAM_SOUND_REEL_ONLY_MESSAGE,
  STORY_DIRECT_ONLY_MESSAGE,
  STORY_PLATFORMS,
  TIKTOK_BUSINESS_PUBLIC_VIDEO_MESSAGE,
  TIKTOK_SOUND_ACCOUNT_MESSAGE,
  TIKTOK_SOUND_DRAFT_MESSAGE,
  VIDEO_DIRECT_ONLY_MESSAGE,
  VIDEO_NOT_READY_MESSAGE,
  accountCapabilities,
  buildTaskTitle,
  contentToTaskDescription,
  isSupportedPlatform,
  isVideoMedia,
  parsePostFormat,
  platformLabel,
  soundAppliesTo,
  uniquePlatforms,
  validatePostContent,
  validateScheduleDate,
  validateSoundInput,
  validateTikTokSettings,
} from "./socialPostRules.js";
import { serializeMedia } from "./socialVideoUpload.js";
import { VIDEO_PROCESSING_FAILED_MESSAGE } from "./socialVideoProcessing.js";
import {
  FEATURE_UNAVAILABLE_MESSAGE,
  notFoundError,
  targetErrorMessage,
  toUserError,
  userError,
} from "./socialPostMessages.js";
import { normalizeSocialImage } from "./socialPostImage.js";
import { notifySocialPostOutcome } from "./socialPostNotifications.js";
import storage from "./socialMediaStorage.js";
import {
  connectionProvider,
  connectorByKey,
  directNetworkFor,
  isAccountProviderUsable,
  isConnectorAvailable,
  isDirectNetworkReady,
  isSocialPublishingEnabled as anyProviderEnabled,
} from "./socialProviders.js";
import {
  createDirectConnectUrl,
  disconnectDirectAccount,
} from "./socialDirectConnect.js";
import {
  aggregatePostStatus,
  isDirectTarget,
  postProviderOf,
  publishDirectTargetsNow,
  refreshPostStatus,
  resetFailedDirectTargets,
} from "./socialDirectPublisher.js";
import {
  getFreshAccessToken,
  loadAccountWithTokens,
} from "./socialAccountCredentials.js";
import {
  CONNECT_STATE_TTL_MS,
  DEFAULT_RETURN_TO,
  apiPublicUrl,
  frontendRedirect,
  safeCode,
  sanitizeReturnTo,
} from "./socialConnectUrls.js";

import {
  assertXPostQuota,
  countXTargets,
  sameParisMonth,
  X_PLATFORM,
} from "./xPostQuota.js";

export { sanitizeReturnTo };

/**
 * Publication programmée sur les réseaux sociaux depuis le kanban : règles
 * métier, indépendantes du fournisseur (providers/zernioProvider.js, et nos
 * propres applis : direct/*, socialDirectPublisher.js).
 *
 * Un post = une carte du tableau (sa date d'échéance est la date de
 * publication). Création : carte, puis post chez le fournisseur, puis post
 * local ; si le fournisseur refuse, la carte est supprimée (rien ne reste à
 * moitié).
 *
 * Chaque cible porte son fournisseur (celui de son compte) : les cibles
 * Zernio forment un seul post Zernio (externalPostId du post), les cibles
 * « direct » sont publiées par notre cron, et le statut du post agrège les
 * deux. Modifier, reprogrammer ou annuler une cible directe pas encore
 * partie reste local.
 */

const DEFAULT_TIMEZONE = "Europe/Paris";
const ACCOUNTS_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_CONTENT_LENGTH = 70000;
const MAX_MEDIA_PER_POST = 35;
const DEFAULT_LOGO_URL =
  "https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_NI_Purple.png";

// Statuts encore susceptibles de partir sur un réseau
const CANCELLABLE_ON_DELETE = new Set(["scheduled", "publishing", "failed"]);

export const isSocialPublishingEnabled = () => anyProviderEnabled();

export function assertSocialPublishingEnabled() {
  if (!anyProviderEnabled()) throw userError(FEATURE_UNAVAILABLE_MESSAGE);
}

const zernioTargetsOf = (post) =>
  (post.targets || []).filter((target) => !isDirectTarget(target));
const hasDirectTargets = (post) => (post.targets || []).some(isDirectTarget);

// Résolveurs kanban chargés à l'usage : kanban.js importe ce service
let kanbanModule = null;
const kanban = async () => {
  if (!kanbanModule) kanbanModule = await import("../../resolvers/kanban.js");
  return kanbanModule;
};

const syncTaskDescription = (taskId, description) =>
  import("../../collab/kanbanCollabServer.js")
    .then(({ syncExternalDescription }) =>
      syncExternalDescription(taskId, description),
    )
    .catch((error) =>
      logger.warn(
        "[SocialPost] Description non transmise à l'édition collaborative:",
        error.message,
      ),
    );

const toIso = (value) => (value ? new Date(value).toISOString() : null);
const idString = (value) => (value ? String(value) : null);

// ── Sérialisation GraphQL ──────────────────────────────────────────────────

export const serializeAccount = (account) => ({
  id: String(account._id),
  platform: account.platform,
  username: account.username || null,
  displayName: account.displayName || null,
  avatarUrl: account.avatarUrl || null,
  status: account.status || "active",
  connectedAt: toIso(account.createdAt),
  // null : connexion habituelle ; « facebook » ou « business » (sons)
  connector: account.provider === "direct" ? account.connector || null : null,
  capabilities: accountCapabilities(account),
});

export { serializeMedia };

const optionalBoolean = (value) => (typeof value === "boolean" ? value : null);

/** Son enregistré → SocialPostSound (identifiant exposé en `id`). */
const serializeSound = (sound) =>
  sound?.soundId
    ? {
        id: sound.soundId,
        title: sound.title,
        artist: sound.artist || null,
        coverUrl: sound.coverUrl || null,
        volume: Number(sound.volume) || 0,
        videoVolume: Number(sound.videoVolume) || 0,
      }
    : null;

function serializeTikTokSettings(settings) {
  if (!settings?.privacyLevel && settings?.mode !== "draft") return null;
  const mode = settings.mode === "draft" ? "draft" : "direct";
  return {
    privacyLevel: settings.privacyLevel || null,
    allowComment: mode === "draft" ? null : Boolean(settings.allowComment),
    brandOrganic: Boolean(settings.brandOrganic),
    brandContent: Boolean(settings.brandContent),
    allowDuet: optionalBoolean(settings.allowDuet),
    allowStitch: optionalBoolean(settings.allowStitch),
    mode,
    sound: serializeSound(settings.sound),
  };
}

const hasTarget = (post, platform) =>
  (post.targets || []).some((target) => target.platform === platform);

function serializePost(post, existingAccountIds) {
  return {
    id: String(post._id),
    boardId: String(post.boardId),
    taskId: String(post.taskId),
    content: post.content || "",
    // Médias d'un post : toujours prêts (contrôlés à la programmation)
    media: (post.media || []).map((media) => ({
      ...serializeMedia({ ...(media.toObject?.() || media), status: "ready" }),
      id: idString(media.mediaId) || "",
    })),
    targets: (post.targets || []).map((target) => ({
      accountId:
        target.socialAccountId &&
        existingAccountIds.has(String(target.socialAccountId))
          ? String(target.socialAccountId)
          : null,
      platform: target.platform,
      username: target.username || null,
      displayName: target.displayName || null,
      status: target.status || "pending",
      platformPostUrl: target.platformPostUrl || null,
      errorMessage: targetErrorMessage(target),
      publishedAt: toIso(target.publishedAt),
      deliveredAs: target.deliveredAs || null,
      storyCount: Array.isArray(target.storyIds) ? target.storyIds.length : 0,
    })),
    scheduledFor: toIso(post.scheduledFor),
    timezone: post.timezone || DEFAULT_TIMEZONE,
    status: post.status,
    tiktokSettings: serializeTikTokSettings(post.tiktokSettings),
    // Posts antérieurs aux stories : publication classique
    instagramSettings:
      post.instagramSettings || hasTarget(post, "instagram")
        ? {
            format: post.instagramSettings?.format || "post",
            sound: serializeSound(post.instagramSettings?.sound),
          }
        : null,
    facebookSettings:
      post.facebookSettings || hasTarget(post, "facebook")
        ? { format: post.facebookSettings?.format || "post" }
        : null,
    createdBy: idString(post.createdBy),
    createdAt: toIso(post.createdAt),
    updatedAt: toIso(post.updatedAt),
  };
}

/** Posts → GraphQL (accountId null quand le compte a été supprimé). */
export async function serializePosts(posts) {
  const accountIds = [
    ...new Set(
      posts.flatMap((post) =>
        (post.targets || [])
          .map((target) => idString(target.socialAccountId))
          .filter(Boolean),
      ),
    ),
  ];
  const existing = accountIds.length
    ? await SocialAccount.find({ _id: { $in: accountIds }, deletedAt: null })
        .select("_id")
        .lean()
    : [];
  const existingIds = new Set(existing.map((account) => String(account._id)));
  return posts.map((post) => serializePost(post, existingIds));
}

export const serializeSocialPost = async (post) =>
  (await serializePosts([post]))[0];

// ── Accès ──────────────────────────────────────────────────────────────────

/**
 * Même règle que la requête `board` du kanban : tableau sans liste de
 * membres ouvert à tout l'espace, sinon propriétaire, membre listé, ou
 * niveau « suppression » sur les projets.
 */
export function canAccessBoard(board, user, permissions) {
  const members = (board.members || []).map((member) => String(member));
  if (members.length === 0) return true;
  const userId = user?.id ? String(user.id) : null;
  if (!userId) return false;
  if (String(board.userId) === userId || members.includes(userId)) return true;
  return Boolean(permissions?.canDelete?.("kanban"));
}

export async function loadAccessibleBoard(
  boardId,
  workspaceId,
  user,
  permissions,
) {
  const id = toObjectIdOrNull(String(boardId || ""));
  const board = id ? await Board.findOne({ _id: id, workspaceId }) : null;
  if (!board || !canAccessBoard(board, user, permissions)) {
    throw notFoundError("Tableau introuvable.");
  }
  return board;
}

async function loadPostForUser(postId, workspaceId, user, permissions) {
  const id = toObjectIdOrNull(String(postId || ""));
  const post = id ? await SocialPost.findOne({ _id: id, workspaceId }) : null;
  if (!post || post.taskDeletedAt) throw notFoundError("Post introuvable.");
  await loadAccessibleBoard(post.boardId, workspaceId, user, permissions);
  return post;
}

// ── Profil et comptes ──────────────────────────────────────────────────────

/** Profil du fournisseur de l'espace, créé à la première connexion. */
export async function ensureProfile(workspaceId, userId) {
  const existing = await SocialProfile.findOne({ workspaceId });
  if (existing) return existing;

  const externalId = String(workspaceId);
  let remote = await provider.findProfileByExternalId(externalId);
  if (!remote) {
    remote = await provider.createProfile({
      name: `newbi-${externalId}`,
      externalId,
    });
  }
  try {
    return await SocialProfile.create({
      workspaceId,
      provider: provider.PROVIDER,
      externalProfileId: remote.externalProfileId,
      createdBy: toObjectIdOrNull(String(userId || "")),
    });
  } catch (error) {
    // Deux connexions simultanées : le premier profil enregistré l'emporte
    if (error?.code === 11000) return SocialProfile.findOne({ workspaceId });
    throw error;
  }
}

export async function listWorkspaceAccounts(workspaceId) {
  return SocialAccount.find({ workspaceId, deletedAt: null })
    .sort({ platform: 1, createdAt: 1 })
    .lean();
}

/**
 * Recopie la liste des comptes du profil : comptes nouveaux créés, compte
 * dont le jeton a expiré → needs_reconnect, comptes disparus → deletedAt.
 * @param {object} [options]
 * @param {string} [options.connectedBy] - auteur d'une connexion (retour OAuth)
 */
export async function syncAccounts(
  workspaceId,
  { connectedBy = null, now = new Date() } = {},
) {
  const profile = await SocialProfile.findOne({ workspaceId });
  // Pas de profil Zernio : seulement des comptes « direct », s'il y en a
  if (!profile) return listWorkspaceAccounts(workspaceId);
  const remoteAccounts = await provider.listAccounts(profile.externalProfileId);
  const connector = toObjectIdOrNull(String(connectedBy || ""));
  const seen = [];

  for (const remote of remoteAccounts) {
    if (
      !remote.externalAccountId ||
      !isSupportedPlatform(remote.platform) ||
      !remote.enabled
    ) {
      continue;
    }
    const fields = {
      platform: remote.platform,
      username: remote.username,
      displayName: remote.displayName,
      avatarUrl: remote.avatarUrl,
      status: remote.active ? "active" : "needs_reconnect",
      lastSyncedAt: now,
      deletedAt: null,
    };
    const existing = await SocialAccount.findOne({
      provider: provider.PROVIDER,
      externalAccountId: remote.externalAccountId,
    });
    if (existing && String(existing.workspaceId) !== String(workspaceId)) {
      logger.warn(
        `[SocialPost] Compte ${remote.externalAccountId} déjà rattaché à un autre espace, ignoré`,
      );
      continue;
    }
    seen.push(remote.externalAccountId);
    try {
      if (existing) {
        // Reconnexion : le compte revient à celui qui l'a reconnecté
        const reconnected = existing.deletedAt || existing.status !== "active";
        await SocialAccount.updateOne(
          { _id: existing._id },
          {
            $set: {
              ...fields,
              ...(connector && reconnected && fields.status === "active"
                ? { connectedBy: connector }
                : {}),
            },
          },
        );
      } else {
        await SocialAccount.create({
          ...fields,
          workspaceId,
          provider: provider.PROVIDER,
          externalAccountId: remote.externalAccountId,
          connectedBy: connector,
        });
      }
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }

  await SocialAccount.updateMany(
    {
      workspaceId,
      provider: provider.PROVIDER,
      deletedAt: null,
      externalAccountId: { $nin: seen },
    },
    { $set: { deletedAt: now } },
  );
  await SocialProfile.updateOne(
    { _id: profile._id },
    { $set: { accountsSyncedAt: now } },
  );
  return listWorkspaceAccounts(workspaceId);
}

/**
 * Synchronisation en arrière-plan, au plus une fois toutes les 10 minutes
 * par espace (réservation atomique sur le profil).
 * @returns {Promise<boolean>} true si une synchronisation a été lancée
 */
export async function refreshAccountsIfStale(workspaceId, now = new Date()) {
  if (!provider.isConfigured()) return false;
  const threshold = new Date(now.getTime() - ACCOUNTS_REFRESH_INTERVAL_MS);
  const claimed = await SocialProfile.findOneAndUpdate(
    {
      workspaceId,
      $or: [
        { accountsSyncedAt: null },
        { accountsSyncedAt: { $lte: threshold } },
      ],
    },
    { $set: { accountsSyncedAt: now } },
  );
  if (!claimed) return false;
  syncAccounts(workspaceId, { now }).catch((error) =>
    logger.warn(
      `[SocialPost] Synchronisation des comptes de l'espace ${workspaceId} impossible: ${error.message}`,
    ),
  );
  return true;
}

/**
 * Adresse d'autorisation vers laquelle envoyer le navigateur pour connecter
 * un compte : notre appli chez le réseau si celui-ci est en direct pour cet
 * espace, sinon Zernio (profil du fournisseur créé au besoin).
 */
export async function createConnectUrl({
  workspaceId,
  userId,
  platform,
  connector = null,
  returnTo,
  now = new Date(),
}) {
  assertSocialPublishingEnabled();
  if (!isSupportedPlatform(platform)) {
    throw userError("Ce réseau social n'est pas pris en charge.");
  }
  // Connecteur : celui du réseau par défaut, sinon une clé de la liste
  // fermée (instagram_facebook, tiktok_business) du même réseau
  const entry = connectorByKey(connector || platform);
  if (!entry || entry.platform !== platform) {
    throw userError("Ce mode de connexion n'est pas pris en charge.");
  }
  if (!isConnectorAvailable(entry.key, workspaceId)) {
    throw userError(
      `La connexion à ${entry.label} n'est pas encore disponible.`,
    );
  }
  if (connectionProvider(platform, workspaceId) === "direct") {
    try {
      return await createDirectConnectUrl({
        workspaceId,
        userId,
        platform,
        connector: entry.key,
        returnTo,
        now,
      });
    } catch (error) {
      throw toUserError(error, "connect");
    }
  }
  try {
    const profile = await ensureProfile(workspaceId, userId);
    const token = crypto.randomBytes(24).toString("base64url");
    await SocialConnectState.create({
      token,
      workspaceId,
      userId,
      platform,
      returnTo: sanitizeReturnTo(returnTo),
      expiresAt: new Date(now.getTime() + CONNECT_STATE_TTL_MS),
    });
    return await provider.getConnectUrl({
      platform,
      externalProfileId: profile.externalProfileId,
      redirectUrl: `${apiPublicUrl()}/social-connect/callback?state=${token}`,
      brandName: "Newbi",
      logoUrl: process.env.SOCIAL_CONNECT_LOGO_URL || DEFAULT_LOGO_URL,
    });
  } catch (error) {
    throw toUserError(error, "connect");
  }
}

/**
 * Retour du navigateur après la connexion chez le fournisseur : jeton à
 * usage unique, droit « Applications » toujours présent, synchronisation
 * des comptes, puis adresse du site où renvoyer le navigateur.
 * @param {object} query - paramètres reçus (state, connected, error…)
 * @returns {Promise<string>} adresse de redirection
 */
export async function completeConnect(query = {}, { now = new Date() } = {}) {
  const token =
    typeof query.state === "string" && query.state.length <= 64
      ? query.state
      : null;
  const state = token
    ? await SocialConnectState.findOneAndDelete({
        token,
        // Parcours Zernio seulement (les nôtres reviennent sur
        // /social-connect/<réseau>/callback)
        provider: { $ne: "direct" },
        expiresAt: { $gt: now },
      })
    : null;

  const redirect = frontendRedirect;

  if (!state) {
    logger.warn("[SocialConnect] Retour OAuth avec un state inconnu ou expiré");
    return redirect(DEFAULT_RETURN_TO, { social_error: "invalid_state" });
  }
  const platform = isSupportedPlatform(query.platform)
    ? query.platform
    : state.platform;

  if (query.error) {
    logger.warn(
      `[SocialConnect] Connexion ${platform} refusée pour l'espace ${state.workspaceId} : ${query.error} (${query.error_message || "sans détail"})`,
    );
    return redirect(state.returnTo, {
      social_error: safeCode(query.error),
      social_platform: platform,
    });
  }

  const allowed = await userHasWorkspaceAction(
    String(state.userId),
    String(state.workspaceId),
    "integrations",
    "manage",
  );
  if (!allowed) {
    return redirect(state.returnTo, {
      social_error: "forbidden",
      social_platform: platform,
    });
  }

  try {
    await syncAccounts(state.workspaceId, { connectedBy: state.userId, now });
  } catch (error) {
    logger.error(
      `[SocialConnect] Synchronisation des comptes après connexion impossible (espace ${state.workspaceId}):`,
      error,
    );
    return redirect(state.returnTo, {
      social_error: "sync_failed",
      social_platform: platform,
    });
  }
  logger.info(
    `[SocialConnect] Compte ${platform} connecté pour l'espace ${state.workspaceId}`,
  );
  return redirect(state.returnTo, { social_connected: platform });
}

/**
 * Cible directe annulée sans se croiser avec le cron (écriture atomique),
 * puis statut du post recalculé ; son post Zernio est supprimé s'il n'a
 * plus de cible.
 */
async function cancelDirectPostTargetsOfAccount(post, accountId) {
  await SocialPost.updateOne(
    { _id: post._id },
    {
      $set: {
        "targets.$[t].status": "cancelled",
        "targets.$[t].lockedUntil": null,
      },
    },
    {
      arrayFilters: [{ "t.socialAccountId": accountId, "t.status": "pending" }],
    },
  );
  const fresh = await SocialPost.findById(post._id);
  if (!fresh) return;
  const zernioLeft = zernioTargetsOf(fresh).some(
    (target) => target.status !== "cancelled",
  );
  if (fresh.externalPostId && !zernioLeft && provider.isConfigured()) {
    await provider
      .deletePost(fresh.externalPostId)
      .catch((error) =>
        logger.warn(
          `[SocialPost] Post ${fresh._id} non supprimé chez le fournisseur: ${error.message}`,
        ),
      );
  }
  const next = aggregatePostStatus(fresh);
  if (next === "cancelled") {
    // Annulation voulue : pas de notification
    await SocialPost.updateOne(
      { _id: fresh._id, status: fresh.status },
      { $set: { status: "cancelled", notifiedStatus: "cancelled" } },
    );
  } else if (next !== fresh.status) {
    await refreshPostStatus(fresh._id);
  }
}

/**
 * Cibles des posts programmés sur un compte déconnecté : annulées
 * localement (le fournisseur annule de son côté les posts dont le compte
 * disparaît) ; un post sans plus aucune cible est supprimé chez le
 * fournisseur, au mieux.
 */
async function cancelPendingTargetsOfAccount(workspaceId, accountId) {
  const posts = await SocialPost.find({
    workspaceId,
    status: { $in: ["scheduled", "publishing"] },
    targets: { $elemMatch: { socialAccountId: accountId, status: "pending" } },
  });
  for (const post of posts) {
    if (hasDirectTargets(post)) {
      await cancelDirectPostTargetsOfAccount(post, accountId);
      continue;
    }
    if (post.status !== "scheduled") continue;
    post.targets.forEach((target) => {
      if (
        String(target.socialAccountId) === String(accountId) &&
        target.status === "pending"
      ) {
        target.status = "cancelled";
      }
    });
    if (post.targets.every((target) => target.status === "cancelled")) {
      post.status = "cancelled";
      post.notifiedStatus = "cancelled";
      if (provider.isConfigured()) {
        await provider
          .deletePost(post.externalPostId)
          .catch((error) =>
            logger.warn(
              `[SocialPost] Post ${post._id} non supprimé chez le fournisseur: ${error.message}`,
            ),
          );
      }
    }
    await post.save();
  }
}

export async function disconnectAccount({
  workspaceId,
  accountId,
  now = new Date(),
}) {
  assertSocialPublishingEnabled();
  const id = toObjectIdOrNull(String(accountId || ""));
  const account = id
    ? await SocialAccount.findOne({ _id: id, workspaceId, deletedAt: null })
    : null;
  if (!account) throw notFoundError("Compte introuvable.");
  if (account.provider === "direct") {
    // Jetons effacés, accès révoqué chez le réseau quand c'est possible
    await disconnectDirectAccount(account, { now });
  } else {
    try {
      await provider.deleteAccount(account.externalAccountId);
    } catch (error) {
      throw toUserError(error, "account");
    }
    await SocialAccount.updateOne(
      { _id: account._id },
      { $set: { deletedAt: now } },
    );
  }
  await cancelPendingTargetsOfAccount(workspaceId, account._id);
  return true;
}

/**
 * Désinstallation de l'application « Réseaux sociaux » : tous les comptes
 * de l'espace sont déconnectés, au mieux (ne lève jamais d'erreur).
 * @returns {Promise<number>} nombre de comptes déconnectés
 */
export async function disconnectAllAccounts(workspaceId, now = new Date()) {
  const accounts = await SocialAccount.find({ workspaceId, deletedAt: null });
  let count = 0;
  for (const account of accounts) {
    try {
      if (account.provider === "direct") {
        await disconnectDirectAccount(account, { now });
      } else {
        if (provider.isConfigured()) {
          await provider.deleteAccount(account.externalAccountId);
        }
        await SocialAccount.updateOne(
          { _id: account._id },
          { $set: { deletedAt: now } },
        );
      }
      await cancelPendingTargetsOfAccount(workspaceId, account._id);
      count += 1;
    } catch (error) {
      logger.warn(
        `[SocialPost] Compte ${account._id} non déconnecté à la désinstallation: ${error.message}`,
      );
    }
  }
  return count;
}

export async function getTikTokCreatorInfo({ workspaceId, accountId }) {
  assertSocialPublishingEnabled();
  const id = toObjectIdOrNull(String(accountId || ""));
  const account = id
    ? await SocialAccount.findOne({ _id: id, workspaceId, deletedAt: null })
    : null;
  if (!account || account.platform !== "tiktok") {
    throw notFoundError("Compte TikTok introuvable.");
  }
  try {
    const info =
      account.provider === "direct"
        ? await readDirectCreatorInfo(account)
        : await provider.getTikTokCreatorInfo(account.externalAccountId);
    return {
      username: account.username || null,
      ...info,
      // Vidéo : réglages coupés par le créateur et durée maximale
      duetDisabled: info.duetDisabled === true,
      stitchDisabled: info.stitchDisabled === true,
      maxVideoPostDurationSec:
        Number(info.maxVideoPostDurationSec) > 0
          ? Number(info.maxVideoPostDurationSec)
          : null,
      privacyLevels: info.privacyLevels.map((level) => ({
        value: level.value,
        label: TIKTOK_PRIVACY_LABELS[level.value] || level.label,
      })),
    };
  } catch (error) {
    throw toUserError(error, "read");
  }
}

// Compte bloqué ou plafond de posts atteint : affiché, pas une erreur
const CREATOR_BLOCKED_CATEGORIES = new Set(["quota_exhausted", "user_abuse"]);

async function readDirectCreatorInfo(account) {
  const withTokens = await loadAccountWithTokens({ _id: account._id });
  const accessToken = await getFreshAccessToken(withTokens);
  try {
    // TikTok Business : réglages lus dans /business/video/settings/
    const info = await directNetworkFor(
      "tiktok",
      account.connector,
    ).getCreatorInfo({ accessToken, account });
    if (info.username && info.username !== account.username) {
      await SocialAccount.updateOne(
        { _id: account._id },
        { $set: { username: info.username } },
      );
      account.username = info.username;
    }
    return info;
  } catch (error) {
    if (!CREATOR_BLOCKED_CATEGORIES.has(error?.category)) throw error;
    return {
      nickname: account.displayName || null,
      canPostMore: false,
      commentDisabled: false,
      duetDisabled: false,
      stitchDisabled: false,
      maxVideoPostDurationSec: null,
      privacyLevels: [],
    };
  }
}

const TIKTOK_PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: "Tout le monde",
  MUTUAL_FOLLOW_FRIENDS: "Amis",
  FOLLOWER_OF_CREATOR: "Abonnés",
  SELF_ONLY: "Moi uniquement",
};

// ── Sons tendance ──────────────────────────────────────────────────────────

// Liste par (compte, type, recherche) gardée 30 minutes en mémoire
export const SOUNDS_CACHE_MS = 30 * 60 * 1000;
const SOUNDS_CACHE_MAX_ENTRIES = 500;
const SOUND_SEARCH_MAX_LENGTH = 100;
const INSTAGRAM_SOUND_KINDS = ["music", "original_sound"];
const soundsCache = new Map();

/** Vide le cache des sons (tests). */
export const clearSoundsCache = () => soundsCache.clear();

function cachedSounds(key, now) {
  const entry = soundsCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    soundsCache.delete(key);
    return null;
  }
  return entry.sounds;
}

function cacheSounds(key, sounds, now) {
  if (soundsCache.size >= SOUNDS_CACHE_MAX_ENTRIES) {
    // Plus ancienne entrée retirée (ordre d'insertion de la Map)
    soundsCache.delete(soundsCache.keys().next().value);
  }
  soundsCache.set(key, { sounds, expiresAt: now + SOUNDS_CACHE_MS });
}

/**
 * Sons proposés pour un compte de l'espace qui permet le son tendance
 * (Instagram via Facebook : tendances ou recherche, musique ou sons
 * originaux ; TikTok Business : tendances, sans recherche).
 */
export async function listTrendingSounds({
  workspaceId,
  accountId,
  search = null,
  kind = null,
  now = Date.now(),
}) {
  assertSocialPublishingEnabled();
  const id = toObjectIdOrNull(String(accountId || ""));
  const account = id
    ? await SocialAccount.findOne({ _id: id, workspaceId, deletedAt: null })
    : null;
  if (!account) throw notFoundError("Compte introuvable.");
  if (!accountCapabilities(account).sounds) {
    throw userError(
      account.platform === "tiktok"
        ? TIKTOK_SOUND_ACCOUNT_MESSAGE
        : account.platform === "instagram"
          ? INSTAGRAM_SOUND_ACCOUNT_MESSAGE
          : "Ce compte ne permet pas d'ajouter un son tendance.",
    );
  }
  if (account.status !== "active") {
    throw userError(
      `Le compte ${platformLabel(account.platform)} doit être reconnecté avant de choisir un son.`,
    );
  }
  const network = directNetworkFor(account.platform, account.connector);
  if (
    !network?.listSounds ||
    !isDirectNetworkReady(account.platform, account.connector)
  ) {
    throw userError("Les sons tendance sont momentanément indisponibles.");
  }
  const instagram = account.platform === "instagram";
  const soundKind = instagram ? kind || "music" : null;
  if (instagram && !INSTAGRAM_SOUND_KINDS.includes(soundKind)) {
    throw userError("Type de son inconnu.");
  }
  // Recherche par mot : Instagram seulement (TikTok n'a que les tendances)
  const query =
    instagram && typeof search === "string"
      ? search.trim().slice(0, SOUND_SEARCH_MAX_LENGTH)
      : "";
  const key = [String(account._id), soundKind || "", query.toLowerCase()].join(
    "|",
  );
  const cached = cachedSounds(key, now);
  if (cached) return cached;
  try {
    const withTokens = await loadAccountWithTokens({ _id: account._id });
    const accessToken = await getFreshAccessToken(withTokens);
    const sounds = await network.listSounds({
      account,
      accessToken,
      search: query,
      kind: soundKind,
    });
    cacheSounds(key, sounds, now);
    return sounds;
  } catch (error) {
    throw toUserError(error, "read");
  }
}

// ── Médias ─────────────────────────────────────────────────────────────────

async function readUpload(file, maxBytes) {
  const { createReadStream } = await file;
  const stream = createReadStream();
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy();
      throw userError("Image trop lourde (20 Mo maximum).");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Téléverse une image de post (normalisée) pour l'espace. */
export async function uploadPostMedia({ workspaceId, userId, file }) {
  assertSocialPublishingEnabled();
  const buffer = await readUpload(file, 20 * 1024 * 1024);
  let image;
  try {
    image = await normalizeSocialImage(buffer);
  } catch (error) {
    throw userError(error.message);
  }
  // Notre bucket dès qu'il est configuré (indispensable aux publications
  // directes, accepté aussi par Zernio), sinon le stockage de Zernio
  const ownStorage = storage.isConfigured();
  let uploaded;
  try {
    uploaded = ownStorage
      ? await storage.storeImage({
          buffer: image.buffer,
          contentType: image.contentType,
          workspaceId,
        })
      : await provider.uploadMedia({
          buffer: image.buffer,
          filename: `${crypto.randomUUID()}.jpg`,
          contentType: image.contentType,
        });
  } catch (error) {
    if (ownStorage) {
      logger.error("[SocialPost] Image non déposée dans le bucket:", error);
      throw userError(
        "L'image n'a pas pu être enregistrée. Réessayez dans quelques instants.",
      );
    }
    throw toUserError(error, "media");
  }
  const media = await SocialPostMedia.create({
    workspaceId,
    createdBy: toObjectIdOrNull(String(userId || "")),
    provider: ownStorage ? "newbi" : provider.PROVIDER,
    url: uploaded.url,
    key: uploaded.key,
    width: image.width,
    height: image.height,
    contentType: image.contentType,
    size: image.size,
  });
  return serializeMedia(media);
}

// ── Contrôles d'un post ────────────────────────────────────────────────────

const uniqueIds = (ids) => [...new Set((ids || []).map(String))];

/** Comptes visés : ceux de l'espace, actifs, dans l'ordre reçu. */
async function loadTargetAccounts(workspaceId, accountIds) {
  const ids = uniqueIds(accountIds);
  if (ids.length === 0) throw userError("Sélectionnez au moins un compte.");
  const objectIds = ids.map(toObjectIdOrNull);
  const accounts = objectIds.every(Boolean)
    ? await SocialAccount.find({
        _id: { $in: objectIds },
        workspaceId,
        deletedAt: null,
      })
    : [];
  if (accounts.length !== ids.length) {
    throw userError(
      "Un des comptes sélectionnés est introuvable. Actualisez la liste des comptes.",
    );
  }
  const byId = new Map(
    accounts.map((account) => [String(account._id), account]),
  );
  const ordered = ids.map((id) => byId.get(id));
  const inactive = ordered.find((account) => account.status !== "active");
  if (inactive) {
    const name = inactive.username ? ` @${inactive.username}` : "";
    throw userError(
      `Le compte ${platformLabel(inactive.platform)}${name} doit être reconnecté avant de publier.`,
    );
  }
  const unusable = ordered.find((account) => !isAccountProviderUsable(account));
  if (unusable) {
    throw userError(
      `La publication sur ${platformLabel(unusable.platform)} est momentanément indisponible.`,
    );
  }
  return ordered;
}

/**
 * Médias : ceux téléversés par l'espace, dans l'ordre reçu ; une vidéo doit
 * être prête.
 */
async function loadMedia(workspaceId, mediaIds) {
  const ids = uniqueIds(mediaIds);
  if (ids.length === 0) return [];
  if (ids.length > MAX_MEDIA_PER_POST) {
    throw userError(`${MAX_MEDIA_PER_POST} images au maximum par post.`);
  }
  const objectIds = ids.map(toObjectIdOrNull);
  const found = objectIds.every(Boolean)
    ? await SocialPostMedia.find({
        _id: { $in: objectIds },
        workspaceId,
      }).lean()
    : [];
  if (found.length !== ids.length) {
    throw userError("Une des images est introuvable. Ajoutez-la de nouveau.");
  }
  const byId = new Map(found.map((media) => [String(media._id), media]));
  const ordered = ids.map((id) => byId.get(id));
  const failed = ordered.find((media) => media.status === "failed");
  if (failed) {
    throw userError(failed.errorMessage || VIDEO_PROCESSING_FAILED_MESSAGE);
  }
  if (ordered.some((media) => (media.status || "ready") !== "ready")) {
    throw userError(VIDEO_NOT_READY_MESSAGE);
  }
  return ordered;
}

const hasVideo = (media) => (media || []).some(isVideoMedia);

/** Vidéo : comptes connectés directement seulement (pas de Zernio). */
function assertVideoTargets(media, accounts) {
  if (
    hasVideo(media) &&
    accounts.some((account) => !isDirectAccount(account))
  ) {
    throw userError(VIDEO_DIRECT_ONLY_MESSAGE);
  }
}

const normalizeContent = (value) => {
  const text =
    typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : "";
  if (text.length > MAX_CONTENT_LENGTH) throw userError("Texte trop long.");
  return text;
};

const parseDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  return new Date(value);
};

function normalizeTimezone(value) {
  if (!value) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: value });
    return value;
  } catch {
    throw userError("Fuseau horaire invalide.");
  }
}

// ── Réglages par réseau (format, son, mode TikTok) ─────────────────────────

/** SocialPostSoundInput → son enregistré (identifiant gardé en soundId). */
function normalizeSound(input) {
  const error = validateSoundInput(input);
  if (error) throw userError(error);
  return {
    soundId: input.id.trim(),
    title: input.title.trim(),
    artist: input.artist ? String(input.artist).trim() || null : null,
    coverUrl: input.coverUrl || null,
    volume: input.volume,
    videoVolume: input.videoVolume,
  };
}

/** Son enregistré → forme de l'input (relu à la modification d'un post). */
const soundInputOf = (sound) =>
  sound?.soundId
    ? {
        id: sound.soundId,
        title: sound.title,
        artist: sound.artist || null,
        coverUrl: sound.coverUrl || null,
        volume: sound.volume,
        videoVolume: sound.videoVolume,
      }
    : null;

const accountsOf = (accounts, platform) =>
  accounts.filter((account) => account.platform === platform);

/**
 * Format de chaque réseau visé qui publie des stories (« post » par
 * défaut) ; un réglage d'un réseau non visé est ignoré. Story : comptes
 * connectés directement seulement.
 * @param {object} settingsByPlatform - { instagram, facebook } (réglages reçus ou gardés)
 * @returns {{instagram?: string, facebook?: string}}
 */
function resolveFormats(accounts, settingsByPlatform) {
  const formats = {};
  for (const platform of STORY_PLATFORMS) {
    const targeted = accountsOf(accounts, platform);
    if (targeted.length === 0) continue;
    const { format, error } = parsePostFormat(
      settingsByPlatform[platform]?.format,
    );
    if (error) throw userError(error);
    if (format === "story" && targeted.some((a) => !isDirectAccount(a))) {
      throw userError(STORY_DIRECT_ONLY_MESSAGE);
    }
    formats[platform] = format;
  }
  return formats;
}

/**
 * Son d'un réseau : contrôlé, puis gardé seulement s'il s'applique à au
 * moins un compte visé (les autres publient sans son). Réglage reçu
 * incompatible : refus clair ; réglage gardé (modification) : son retiré.
 */
function resolveSound(rawSound, { accounts, media, format, mode, strict }) {
  if (!rawSound) return null;
  const sound = normalizeSound(rawSound);
  if (accounts.some((a) => soundAppliesTo(a, { format, mode, media }))) {
    return sound;
  }
  if (!strict) return null;
  const platform = accounts[0]?.platform;
  if (platform === "tiktok") {
    throw userError(
      mode === "draft"
        ? TIKTOK_SOUND_DRAFT_MESSAGE
        : TIKTOK_SOUND_ACCOUNT_MESSAGE,
    );
  }
  const reel =
    format !== "story" && (media || []).length === 1 && isVideoMedia(media[0]);
  throw userError(
    reel ? INSTAGRAM_SOUND_ACCOUNT_MESSAGE : INSTAGRAM_SOUND_REEL_ONLY_MESSAGE,
  );
}

/** Réglages Instagram enregistrés (null si Instagram n'est pas visé). */
function buildInstagramSettings({ accounts, media, formats, raw, strict }) {
  const targeted = accountsOf(accounts, "instagram");
  if (targeted.length === 0) return null;
  const format = formats.instagram || "post";
  const sound = resolveSound(raw?.sound, {
    accounts: targeted,
    media,
    format,
    strict,
  });
  return { format, ...(sound ? { sound } : {}) };
}

/**
 * Réglages TikTok : mode « direct » (confidentialité, commentaires…
 * obligatoires) ou « draft » (brouillon : comptes directs avec
 * l'autorisation video.upload, rien d'autre). Compte TikTok Business +
 * vidéo en direct : toujours public.
 */
function normalizeTikTokSettings(
  input,
  { video = false, accounts = [], media = [], strict = true } = {},
) {
  const error = validateTikTokSettings(input, { video });
  if (error) throw userError(error);
  const tiktokAccounts = accountsOf(accounts, "tiktok");
  if (input.mode === "draft") {
    // Chaque compte TikTok visé doit pouvoir recevoir un brouillon (compte
    // direct avec video.upload) ; même message que le site, compte Zernio
    // compris
    if (tiktokAccounts.some((a) => !accountCapabilities(a).drafts)) {
      throw userError(DRAFT_NEEDS_RECONNECT_MESSAGE);
    }
    // Le son se choisit dans l'appli TikTok
    resolveSound(input.sound, {
      accounts: tiktokAccounts,
      media,
      mode: "draft",
      strict,
    });
    return { mode: "draft" };
  }
  const privacyLevel = input.privacyLevel.trim();
  // Règle TikTok : un contenu de marque ne peut pas être privé
  if (input.brandContent === true && privacyLevel === "SELF_ONLY") {
    throw userError(
      "Le contenu de marque ne peut pas être visible par vous seul sur TikTok.",
    );
  }
  // TikTok Business : pas de confidentialité pour une vidéo (publique)
  if (
    video &&
    privacyLevel !== "PUBLIC_TO_EVERYONE" &&
    tiktokAccounts.some(
      (account) => isDirectAccount(account) && account.connector === "business",
    )
  ) {
    throw userError(TIKTOK_BUSINESS_PUBLIC_VIDEO_MESSAGE);
  }
  const sound = resolveSound(input.sound, {
    accounts: tiktokAccounts,
    media,
    mode: "direct",
    strict,
  });
  return {
    mode: "direct",
    privacyLevel,
    allowComment: input.allowComment,
    brandOrganic: Boolean(input.brandOrganic),
    brandContent: Boolean(input.brandContent),
    // Vidéo seulement (sans objet pour un carrousel photo)
    ...(video
      ? { allowDuet: input.allowDuet, allowStitch: input.allowStitch }
      : {}),
    ...(sound ? { sound } : {}),
  };
}

/** Réglages TikTok gardés → forme de l'input (modification d'un post). */
const storedTikTokSettings = (settings) => {
  if (settings?.mode === "draft") return { mode: "draft" };
  return settings?.privacyLevel
    ? {
        mode: "direct",
        privacyLevel: settings.privacyLevel,
        allowComment: Boolean(settings.allowComment),
        brandOrganic: Boolean(settings.brandOrganic),
        brandContent: Boolean(settings.brandContent),
        ...(typeof settings.allowDuet === "boolean"
          ? { allowDuet: settings.allowDuet }
          : {}),
        ...(typeof settings.allowStitch === "boolean"
          ? { allowStitch: settings.allowStitch }
          : {}),
        ...(settings.sound?.soundId
          ? { sound: soundInputOf(settings.sound) }
          : {}),
      }
    : null;
};

/** Réglages Instagram gardés → forme de l'input. */
const storedInstagramSettings = (settings) =>
  settings
    ? {
        format: settings.format || "post",
        ...(settings.sound?.soundId
          ? { sound: soundInputOf(settings.sound) }
          : {}),
      }
    : null;

const assertValid = (message) => {
  if (message) throw userError(message);
};

const providerTargets = (accounts) =>
  accounts.map((account) => ({
    platform: account.platform,
    externalAccountId: account.externalAccountId,
  }));

const isDirectAccount = (account) => account.provider === "direct";

/** Cibles locales d'un post, chacune avec le fournisseur de son compte. */
const localTargets = (accounts) =>
  accounts.map((account) => ({
    socialAccountId: account._id,
    platform: account.platform,
    externalAccountId: account.externalAccountId,
    username: account.username,
    displayName: account.displayName,
    status: "pending",
    provider: isDirectAccount(account) ? "direct" : "zernio",
  }));

const postMedia = (media) =>
  media.map((item) => ({
    mediaId: item._id || item.mediaId,
    kind: item.kind || "image",
    url: item.url,
    width: item.width ?? null,
    height: item.height ?? null,
    contentType: item.contentType || "image/jpeg",
    thumbnailUrl: item.thumbnailUrl || null,
    durationMs: item.durationMs ?? null,
    size: item.size ?? null,
  }));

// ── État renvoyé par le fournisseur ────────────────────────────────────────

function findRemoteTarget(remoteTargets, target) {
  return (
    remoteTargets.find(
      (remote) =>
        remote.externalAccountId &&
        remote.externalAccountId === target.externalAccountId,
    ) ||
    remoteTargets.find(
      (remote) =>
        !remote.externalAccountId && remote.platform === target.platform,
    ) ||
    null
  );
}

/**
 * Recopie sur le post local l'état renvoyé par le fournisseur (statut global
 * et cibles). Modifie le document, sans l'enregistrer.
 */
export function applyRemotePost(post, remote, now = new Date()) {
  if (!remote) return post;
  const mixed = hasDirectTargets(post);
  // Post mixte : le statut Zernio ne couvre que ses cibles, le statut
  // global est recalculé depuis toutes les cibles
  if (remote.status && !mixed) post.status = remote.status;
  post.targets.forEach((target) => {
    if (isDirectTarget(target)) return;
    const match = findRemoteTarget(remote.targets || [], target);
    if (!match) return;
    target.status = match.status;
    if (match.platformPostUrl) target.platformPostUrl = match.platformPostUrl;
    const failed = match.status === "failed";
    target.errorMessage = failed ? match.errorMessage : null;
    target.errorCategory = failed ? match.errorCategory : null;
    if (match.status === "published" && !target.publishedAt) {
      target.publishedAt = match.publishedAt
        ? new Date(match.publishedAt)
        : now;
    }
  });
  if (mixed) post.status = aggregatePostStatus(post);
  return post;
}

// ── Programmer ─────────────────────────────────────────────────────────────

/**
 * Programme (ou publie tout de suite) un post et crée sa carte.
 * @returns {Promise<{post: object, task: object}>} post sérialisé et carte
 *   enrichie (mêmes champs que createTask)
 */
export async function schedulePost({
  workspaceId,
  user,
  permissions,
  input,
  now = new Date(),
}) {
  assertSocialPublishingEnabled();
  const board = await loadAccessibleBoard(
    input.boardId,
    workspaceId,
    user,
    permissions,
  );
  const columnObjectId = input.columnId
    ? toObjectIdOrNull(String(input.columnId))
    : null;
  if (input.columnId && !columnObjectId)
    throw notFoundError("Colonne introuvable.");
  const column = columnObjectId
    ? await Column.findOne({
        _id: columnObjectId,
        boardId: board._id,
        workspaceId,
      })
    : await Column.findOne({ boardId: board._id, workspaceId }).sort({
        order: 1,
      });
  if (!column) {
    throw notFoundError(
      input.columnId
        ? "Colonne introuvable."
        : "Ce tableau n'a pas de colonne. Ajoutez une colonne avant de programmer un post.",
    );
  }

  const accounts = await loadTargetAccounts(workspaceId, input.accountIds);
  const media = await loadMedia(workspaceId, input.mediaIds);
  const content = normalizeContent(input.content);
  const platforms = uniquePlatforms(
    accounts.map((account) => account.platform),
  );
  // Format par réseau (« post » ou « story »), absent = publication
  const formats = resolveFormats(accounts, {
    instagram: input.instagramSettings,
    facebook: input.facebookSettings,
  });
  assertValid(
    validatePostContent({
      platforms,
      content,
      media,
      formats,
      tiktokMode: input.tiktokSettings?.mode,
    }),
  );
  assertVideoTargets(media, accounts);

  const publishNow = input.publishNow === true;
  const scheduledFor = publishNow ? now : parseDate(input.scheduledFor);
  if (!publishNow) assertValid(validateScheduleDate(scheduledFor, { now }));
  const timezone = normalizeTimezone(input.timezone);
  const tiktokSettings = platforms.includes("tiktok")
    ? normalizeTikTokSettings(input.tiktokSettings, {
        video: hasVideo(media),
        accounts,
        media,
      })
    : null;
  const instagramSettings = buildInstagramSettings({
    accounts,
    media,
    formats,
    raw: input.instagramSettings,
    strict: true,
  });
  const facebookSettings = formats.facebook
    ? { format: formats.facebook }
    : null;
  await assertXPostQuota(workspaceId, {
    xCount: countXTargets(accounts),
    at: scheduledFor,
    now,
  });

  // 1. La carte (non diffusée tant que le fournisseur n'a pas accepté)
  const { createTaskInWorkspace, discardCreatedTask, publishTaskCreated } =
    await kanban();
  const { savedTask, enrichedTask } = await createTaskInWorkspace({
    input: {
      title: buildTaskTitle(platforms, content),
      description: contentToTaskDescription(content),
      boardId: String(board._id),
      columnId: String(column._id),
      dueDate: scheduledFor,
    },
    user,
    workspaceId,
    publish: false,
  });

  // 2. Les cibles Zernio : un seul post chez Zernio (les cibles directes
  // partent par notre cron, ou tout de suite ci-dessous)
  const zernioAccounts = accounts.filter(
    (account) => !isDirectAccount(account),
  );
  const idempotencyKey = crypto.randomUUID();
  let result = null;
  if (zernioAccounts.length > 0) {
    try {
      result = await provider.createPost({
        idempotencyKey,
        content,
        mediaUrls: media.map((item) => item.url),
        targets: providerTargets(zernioAccounts),
        scheduledFor,
        publishNow,
        timezone,
        tiktokSettings,
      });
      if (!result?.post?.externalPostId) {
        throw new SocialProviderError("Réponse sans identifiant de post", {
          kind: "http",
          status: 502,
        });
      }
    } catch (error) {
      await discardCreatedTask(savedTask, workspaceId);
      throw toUserError(error, "create");
    }
  }

  // 3. Le post local
  const targets = localTargets(accounts);
  let post;
  try {
    post = new SocialPost({
      workspaceId,
      boardId: board._id,
      taskId: savedTask._id,
      createdBy: toObjectIdOrNull(String(user?.id || "")),
      updatedBy: toObjectIdOrNull(String(user?.id || "")),
      provider: postProviderOf(targets),
      externalPostId: result?.post?.externalPostId || null,
      idempotencyKey,
      content,
      media: postMedia(media),
      targets,
      scheduledFor,
      timezone,
      status: publishNow ? "publishing" : "scheduled",
      tiktokSettings,
      instagramSettings,
      facebookSettings,
    });
    if (result) applyRemotePost(post, result.post, now);
    await post.save();
  } catch (error) {
    logger.error("[SocialPost] Post local non enregistré, annulation:", error);
    if (result) {
      await provider
        .deletePost(result.post.externalPostId)
        .catch((deleteError) =>
          logger.error(
            `[SocialPost] Post ${result.post.externalPostId} orphelin chez le fournisseur:`,
            deleteError,
          ),
        );
    }
    await discardCreatedTask(savedTask, workspaceId);
    throw error;
  }

  publishTaskCreated(enrichedTask, workspaceId);
  if (publishNow && hasDirectTargets(post)) {
    // Cibles directes publiées dans la mutation (statut final ou en cours)
    post = (await publishDirectTargetsNow(post._id, { now })) || post;
  } else {
    // Publication immédiate Zernio : le résultat est déjà connu
    await notifySocialPostOutcome(post);
  }
  return { post: await serializeSocialPost(post), task: enrichedTask };
}

// ── Modifier, annuler, réessayer ───────────────────────────────────────────

const UPDATE_TOO_LATE_MESSAGE =
  "Ce post ne peut plus être modifié : sa publication est en cours ou terminée.";

/** Modifie un post encore programmé, puis sa carte (titre, texte, date). */
export async function updatePost({
  workspaceId,
  user,
  permissions,
  postId,
  input = {},
  now = new Date(),
}) {
  assertSocialPublishingEnabled();
  let post = await loadPostForUser(postId, workspaceId, user, permissions);
  if (post.status !== "scheduled") {
    throw userError(UPDATE_TOO_LATE_MESSAGE);
  }

  const accounts = await loadTargetAccounts(
    workspaceId,
    input.accountIds ??
      post.targets.map((target) => target.socialAccountId).filter(Boolean),
  );
  const media =
    input.mediaIds !== undefined && input.mediaIds !== null
      ? await loadMedia(workspaceId, input.mediaIds)
      : post.media.map((item) => item.toObject?.() || item);
  const content =
    input.content !== undefined && input.content !== null
      ? normalizeContent(input.content)
      : post.content || "";
  const platforms = uniquePlatforms(
    accounts.map((account) => account.platform),
  );
  // Réglages reçus, sinon ceux du post (relus sans exiger un nouvel accord)
  const instagramRaw =
    input.instagramSettings ?? storedInstagramSettings(post.instagramSettings);
  const facebookRaw = input.facebookSettings ?? post.facebookSettings ?? null;
  const formats = resolveFormats(accounts, {
    instagram: instagramRaw,
    facebook: facebookRaw,
  });
  const tiktokMode = (input.tiktokSettings || post.tiktokSettings)?.mode;
  assertValid(
    validatePostContent({ platforms, content, media, formats, tiktokMode }),
  );
  assertVideoTargets(media, accounts);

  let scheduledFor = post.scheduledFor;
  if (input.scheduledFor !== undefined && input.scheduledFor !== null) {
    scheduledFor = parseDate(input.scheduledFor);
    assertValid(validateScheduleDate(scheduledFor, { now }));
  }
  // Limite X vérifiée seulement si le post en demande plus, ou change de
  // mois : modifier le texte reste possible après un passage à une offre
  // inférieure
  const xCount = countXTargets(accounts);
  if (
    xCount > countXTargets(post.targets) ||
    !sameParisMonth(scheduledFor, post.scheduledFor)
  ) {
    await assertXPostQuota(workspaceId, {
      xCount,
      at: scheduledFor,
      excludePostId: post._id,
      now,
    });
  }
  let tiktokSettings = null;
  if (platforms.includes("tiktok")) {
    const video = hasVideo(media);
    const stored = storedTikTokSettings(post.tiktokSettings);
    tiktokSettings = input.tiktokSettings
      ? normalizeTikTokSettings(input.tiktokSettings, {
          video,
          accounts,
          media,
        })
      : stored
        ? // Réglages gardés : complets pour une vidéo (duos, collages) ;
          // son retiré s'il ne s'applique plus
          normalizeTikTokSettings(
            { ...stored, consentGiven: true },
            { video, accounts, media, strict: false },
          )
        : normalizeTikTokSettings(null);
  }
  const instagramSettings = buildInstagramSettings({
    accounts,
    media,
    formats,
    raw: instagramRaw,
    strict: Boolean(input.instagramSettings),
  });
  const facebookSettings = formats.facebook
    ? { format: formats.facebook }
    : null;

  // Part Zernio : mise à jour, suppression ou création de son post selon
  // les comptes Zernio qui restent visés ; la part directe est locale
  const zernioAccounts = accounts.filter(
    (account) => !isDirectAccount(account),
  );
  const remoteFields = {
    content,
    mediaUrls: media.map((item) => item.url),
    targets: providerTargets(zernioAccounts),
    scheduledFor,
    timezone: post.timezone || DEFAULT_TIMEZONE,
    tiktokSettings,
  };
  let externalPostId = post.externalPostId || null;
  let idempotencyKey = post.idempotencyKey;
  try {
    if (externalPostId && zernioAccounts.length > 0) {
      await provider.updatePost(externalPostId, remoteFields);
    } else if (externalPostId) {
      await provider.deletePost(externalPostId);
      externalPostId = null;
    } else if (zernioAccounts.length > 0) {
      idempotencyKey = crypto.randomUUID();
      const created = await provider.createPost({
        idempotencyKey,
        ...remoteFields,
      });
      externalPostId = created?.post?.externalPostId || null;
      if (!externalPostId) {
        throw new SocialProviderError("Réponse sans identifiant de post", {
          kind: "http",
          status: 502,
        });
      }
    }
  } catch (error) {
    throw toUserError(error, "update");
  }

  // Cibles neuves : stories publiées (storyIds) et brouillon remis à zéro
  const targets = localTargets(accounts);
  const fields = {
    content,
    media: postMedia(media),
    targets,
    scheduledFor,
    tiktokSettings,
    instagramSettings,
    facebookSettings,
    provider: postProviderOf(targets),
    externalPostId,
    idempotencyKey,
    updatedBy: toObjectIdOrNull(String(user?.id || "")),
  };
  if (hasDirectTargets(post) || fields.provider !== "zernio") {
    // Écriture conditionnelle : le cron a pu commencer à publier
    const updated = await SocialPost.findOneAndUpdate(
      { _id: post._id, status: "scheduled" },
      { $set: fields },
      { new: true },
    );
    if (!updated) throw userError(UPDATE_TOO_LATE_MESSAGE);
    post = updated;
  } else {
    Object.assign(post, fields);
    await post.save();
  }

  // La carte suit le post (diffusée en temps réel)
  const description = contentToTaskDescription(content);
  const task = await Task.findOneAndUpdate(
    { _id: post.taskId, workspaceId },
    {
      $set: {
        title: buildTaskTitle(platforms, content),
        description,
        dueDate: scheduledFor,
        updatedAt: now,
      },
    },
    { new: true },
  );
  if (task) {
    syncTaskDescription(task._id, task.description);
    const { publishTaskUpdated } = await kanban();
    await publishTaskUpdated(task, workspaceId);
  }
  return serializeSocialPost(post);
}

/**
 * Annule un post pas encore publié chez le fournisseur et le passe en
 * « cancelled ». Un post publié entre-temps (refus 400) est laissé au suivi.
 * @returns {Promise<boolean>} true si le post est annulé
 */
async function cancelRemotePost(post) {
  if (hasDirectTargets(post)) return cancelPostWithDirectTargets(post);
  if (provider.isConfigured()) {
    try {
      await provider.deletePost(post.externalPostId);
    } catch (error) {
      if (error instanceof SocialProviderError && error.status === 400) {
        logger.info(
          `[SocialPost] Post ${post._id} déjà publié chez le fournisseur, non annulé`,
        );
        return false;
      }
      throw toUserError(error, "cancel");
    }
  } else {
    logger.warn(
      `[SocialPost] ZERNIO_API_KEY absente : post ${post._id} annulé localement seulement`,
    );
  }
  post.status = "cancelled";
  // Annulation voulue : pas de notification
  post.notifiedStatus = "cancelled";
  post.targets.forEach((target) => {
    if (target.status !== "published") target.status = "cancelled";
  });
  await post.save();
  return true;
}

/**
 * Annulation d'un post qui a des cibles directes : son post Zernio
 * éventuel est supprimé comme d'habitude, puis toutes les cibles pas encore
 * parties sont annulées d'un coup, sauf si une cible directe est en cours
 * d'envoi (trop tard).
 * @returns {Promise<boolean>} true si le post est annulé
 */
async function cancelPostWithDirectTargets(post) {
  const sending = (post.targets || []).some(
    (target) => isDirectTarget(target) && target.status === "publishing",
  );
  if (sending) return false;
  const zernioPending = zernioTargetsOf(post).some(
    (target) => target.status !== "published" && target.status !== "cancelled",
  );
  if (post.externalPostId && zernioPending) {
    if (provider.isConfigured()) {
      try {
        await provider.deletePost(post.externalPostId);
      } catch (error) {
        if (error instanceof SocialProviderError && error.status === 400) {
          return false;
        }
        throw toUserError(error, "cancel");
      }
    } else {
      logger.warn(
        `[SocialPost] ZERNIO_API_KEY absente : post ${post._id} annulé localement seulement`,
      );
    }
  }
  const updated = await SocialPost.findOneAndUpdate(
    {
      _id: post._id,
      targets: {
        $not: { $elemMatch: { provider: "direct", status: "publishing" } },
      },
    },
    {
      $set: {
        "targets.$[t].status": "cancelled",
        "targets.$[t].lockedUntil": null,
        "targets.$[t].nextAttemptAt": null,
      },
    },
    {
      new: true,
      arrayFilters: [
        { "t.status": { $in: ["pending", "publishing", "failed"] } },
      ],
    },
  );
  if (!updated) return false;
  const next = aggregatePostStatus(updated);
  await SocialPost.updateOne(
    { _id: post._id },
    {
      $set: {
        status: next,
        // Annulation voulue : pas de notification
        ...(next === "cancelled" ? { notifiedStatus: "cancelled" } : {}),
      },
    },
  );
  return next === "cancelled";
}

export async function cancelPost({ workspaceId, user, permissions, postId }) {
  assertSocialPublishingEnabled();
  const post = await loadPostForUser(postId, workspaceId, user, permissions);
  if (post.status === "cancelled") return serializeSocialPost(post);
  if (post.status === "published" || post.status === "partial") {
    throw userError(
      "Ce post est déjà publié : supprimez-le directement sur le réseau social.",
    );
  }
  if (post.status === "publishing") {
    throw userError(
      "Ce post est en cours de publication, il ne peut plus être annulé.",
    );
  }
  const cancelled = await cancelRemotePost(post);
  if (!cancelled) {
    throw userError(
      "Ce post vient d'être publié, il ne peut plus être annulé.",
    );
  }
  if (hasDirectTargets(post)) {
    return serializeSocialPost((await SocialPost.findById(post._id)) || post);
  }
  return serializeSocialPost(post);
}

export async function retryPost({
  workspaceId,
  user,
  permissions,
  postId,
  now = new Date(),
}) {
  assertSocialPublishingEnabled();
  const post = await loadPostForUser(postId, workspaceId, user, permissions);
  if (post.status !== "failed" && post.status !== "partial") {
    throw userError("Seul un post en échec peut être publié de nouveau.");
  }
  // Chaque cible X en échec repart chez X (Zernio ou direct) : un envoi de
  // plus ce mois-ci
  const failedXCount = post.targets.filter(
    (target) => target.platform === X_PLATFORM && target.status === "failed",
  ).length;
  await assertXPostQuota(workspaceId, { xCount: failedXCount, at: now, now });
  if (hasDirectTargets(post)) {
    return retryPostWithDirectTargets(post, user, now);
  }
  let result;
  try {
    result = await provider.retryPost(post.externalPostId);
  } catch (error) {
    throw toUserError(error, "retry");
  }
  if (result?.post) {
    applyRemotePost(post, result.post, now);
  } else {
    post.status = "publishing";
  }
  for (let i = 0; i < failedXCount; i += 1) post.xRetriedAt.push(now);
  // Même échec qu'avant : déjà notifié (notifiedStatus), rien n'est renvoyé
  post.updatedBy = toObjectIdOrNull(String(user?.id || ""));
  post.syncLockedUntil = null;
  await post.save();
  await notifySocialPostOutcome(post);
  return serializeSocialPost(post);
}

/**
 * Nouvel essai d'un post qui a des cibles directes : cibles Zernio en échec
 * relancées chez Zernio, cibles directes en échec republiées tout de suite.
 */
async function retryPostWithDirectTargets(post, user, now) {
  const failedX = (targets) =>
    targets.filter(
      (target) => target.platform === X_PLATFORM && target.status === "failed",
    ).length;
  const zernioTargets = zernioTargetsOf(post);
  const zernioFailed = zernioTargets.some(
    (target) => target.status === "failed",
  );
  if (post.externalPostId && zernioFailed) {
    const zernioFailedX = failedX(zernioTargets);
    let result;
    try {
      result = await provider.retryPost(post.externalPostId);
    } catch (error) {
      throw toUserError(error, "retry");
    }
    if (result?.post) applyRemotePost(post, result.post, now);
    // Chaque cible X relancée chez Zernio : un envoi facturé de plus
    for (let i = 0; i < zernioFailedX; i += 1) post.xRetriedAt.push(now);
    post.updatedBy = toObjectIdOrNull(String(user?.id || ""));
    post.syncLockedUntil = null;
    await post.save();
  }
  const directTargets = post.targets.filter(isDirectTarget);
  const directFailedX = failedX(directTargets);
  const directFailed = directTargets.some(
    (target) => target.status === "failed",
  );
  if (directFailed && (await resetFailedDirectTargets(post._id)) > 0) {
    // Le premier envoi de chaque cible X relancée compte ici ; les nouveaux
    // essais automatiques du cron s'ajoutent ensuite (socialDirectPublisher)
    if (directFailedX > 0) {
      await SocialPost.updateOne(
        { _id: post._id },
        { $push: { xRetriedAt: { $each: Array(directFailedX).fill(now) } } },
      );
    }
    await publishDirectTargetsNow(post._id, { now });
  }
  const fresh = await refreshPostStatus(post._id, now);
  return serializeSocialPost(fresh || post);
}

// ── Carte modifiée ou supprimée dans le kanban ─────────────────────────────

const sameInstant = (a, b) => {
  const timeA = a ? new Date(a).getTime() : null;
  const timeB = b ? new Date(b).getTime() : null;
  return timeA === timeB;
};

/**
 * updateTask : la date d'échéance d'une carte avec un post programmé est la
 * date de publication. Reprogrammée chez le fournisseur AVANT
 * l'enregistrement de la carte ; refusée (erreur) si la date est trop proche,
 * trop lointaine ou retirée. Sans post programmé : rien (une requête).
 */
export async function rescheduleSocialPostForTask({
  task,
  dueDate,
  workspaceId,
  userId,
  now = new Date(),
}) {
  if (!task || dueDate === undefined || sameInstant(task.dueDate, dueDate)) {
    return null;
  }
  const post = await SocialPost.findOne({
    taskId: task._id,
    workspaceId,
    status: "scheduled",
  });
  if (!post) return null;
  // Date retirée : null, ou chaîne vide (le scalaire DateTime en fait une
  // date invalide)
  const next = dueDate === null || dueDate === "" ? null : new Date(dueDate);
  if (!next || Number.isNaN(next.getTime())) {
    throw userError("Un post programmé doit garder une date de publication");
  }
  if (sameInstant(post.scheduledFor, next)) return post;
  assertValid(validateScheduleDate(next, { now }));
  assertSocialPublishingEnabled();
  if (!sameParisMonth(next, post.scheduledFor)) {
    await assertXPostQuota(workspaceId, {
      xCount: countXTargets(post.targets),
      at: next,
      excludePostId: post._id,
      now,
    });
  }
  if (post.externalPostId) {
    try {
      await provider.updatePost(post.externalPostId, {
        scheduledFor: next,
        timezone: post.timezone || DEFAULT_TIMEZONE,
      });
    } catch (error) {
      throw toUserError(error, "update");
    }
  }
  // Cibles directes : la nouvelle date suffit (le cron publie à l'heure) ;
  // écriture conditionnelle, le cron a pu commencer à publier
  const result = await SocialPost.updateOne(
    {
      _id: post._id,
      ...(hasDirectTargets(post) ? { status: "scheduled" } : {}),
    },
    {
      $set: {
        scheduledFor: next,
        updatedBy: toObjectIdOrNull(String(userId || "")),
      },
    },
  );
  if (result.matchedCount === 0) throw userError(UPDATE_TOO_LATE_MESSAGE);
  return post;
}

/**
 * deleteTask, deleteColumn, deleteBoard : les posts pas encore publiés des
 * cartes supprimées sont annulés chez le fournisseur AVANT la suppression
 * (une erreur passagère bloque la suppression : sinon le post partirait
 * sans carte). Un post déjà publié reste en ligne. Espace sans post : une
 * seule requête, rien d'autre.
 */
export async function cancelSocialPostsBeforeTaskDeletion({
  workspaceId,
  taskId,
  columnId,
  boardId,
  now = new Date(),
}) {
  if (!(await SocialPost.exists({ workspaceId }))) return 0;

  const filter = { workspaceId, taskDeletedAt: null };
  if (taskId) {
    const id = toObjectIdOrNull(String(taskId));
    if (!id) return 0;
    filter.taskId = id;
  } else if (boardId) {
    const id = toObjectIdOrNull(String(boardId));
    if (!id) return 0;
    filter.boardId = id;
  } else if (columnId) {
    if (!toObjectIdOrNull(String(columnId))) return 0;
    const taskIds = await Task.distinct("_id", {
      columnId: String(columnId),
      workspaceId,
    });
    if (taskIds.length === 0) return 0;
    filter.taskId = { $in: taskIds };
  } else {
    return 0;
  }

  const posts = await SocialPost.find(filter);
  if (posts.length === 0) return 0;
  let cancelled = 0;
  for (const post of posts) {
    if (
      CANCELLABLE_ON_DELETE.has(post.status) &&
      (await cancelRemotePost(post))
    ) {
      cancelled += 1;
    }
  }
  await SocialPost.updateMany(
    { _id: { $in: posts.map((post) => post._id) } },
    { $set: { taskDeletedAt: now } },
  );
  return cancelled;
}

// ── Lecture ────────────────────────────────────────────────────────────────

export async function listBoardPosts({
  workspaceId,
  user,
  permissions,
  boardId,
}) {
  const board = await loadAccessibleBoard(
    boardId,
    workspaceId,
    user,
    permissions,
  );
  const posts = await SocialPost.find({
    workspaceId,
    boardId: board._id,
    taskDeletedAt: null,
  })
    .sort({ scheduledFor: -1 })
    .limit(500);
  return serializePosts(posts);
}

export async function getPostForUser({
  workspaceId,
  user,
  permissions,
  postId,
}) {
  try {
    const post = await loadPostForUser(postId, workspaceId, user, permissions);
    return serializeSocialPost(post);
  } catch (error) {
    if (error?.code === "NOT_FOUND") return null;
    throw error;
  }
}
