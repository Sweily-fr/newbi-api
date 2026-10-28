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
  buildTaskTitle,
  contentToTaskDescription,
  isSupportedPlatform,
  platformLabel,
  uniquePlatforms,
  validatePostContent,
  validateScheduleDate,
  validateTikTokSettings,
} from "./socialPostRules.js";
import {
  FEATURE_UNAVAILABLE_MESSAGE,
  notFoundError,
  targetErrorMessage,
  toUserError,
  userError,
} from "./socialPostMessages.js";
import { normalizeSocialImage } from "./socialPostImage.js";
import { notifySocialPostOutcome } from "./socialPostNotifications.js";

/**
 * Publication programmée sur les réseaux sociaux depuis le kanban : règles
 * métier, indépendantes du fournisseur (providers/zernioProvider.js).
 *
 * Un post = une carte du tableau (sa date d'échéance est la date de
 * publication). Création : carte, puis post chez le fournisseur, puis post
 * local ; si le fournisseur refuse, la carte est supprimée (rien ne reste à
 * moitié).
 */

const DEFAULT_TIMEZONE = "Europe/Paris";
const DEFAULT_RETURN_TO = "/dashboard/outils/kanban";
const CONNECT_STATE_TTL_MS = 15 * 60 * 1000;
const ACCOUNTS_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_CONTENT_LENGTH = 70000;
const MAX_MEDIA_PER_POST = 35;
const DEFAULT_LOGO_URL =
  "https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_NI_Purple.png";

// Statuts encore susceptibles de partir sur un réseau
const CANCELLABLE_ON_DELETE = new Set(["scheduled", "publishing", "failed"]);

export const isSocialPublishingEnabled = () => provider.isConfigured();

export function assertSocialPublishingEnabled() {
  if (!provider.isConfigured()) throw userError(FEATURE_UNAVAILABLE_MESSAGE);
}

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
});

export const serializeMedia = (media) => ({
  id: String(media._id || media.mediaId),
  url: media.url,
  width: media.width ?? null,
  height: media.height ?? null,
  contentType: media.contentType || "image/jpeg",
});

function serializePost(post, existingAccountIds) {
  return {
    id: String(post._id),
    boardId: String(post.boardId),
    taskId: String(post.taskId),
    content: post.content || "",
    media: (post.media || []).map((media) => ({
      id: idString(media.mediaId) || "",
      url: media.url,
      width: media.width ?? null,
      height: media.height ?? null,
      contentType: media.contentType || "image/jpeg",
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
    })),
    scheduledFor: toIso(post.scheduledFor),
    timezone: post.timezone || DEFAULT_TIMEZONE,
    status: post.status,
    tiktokSettings: post.tiktokSettings?.privacyLevel
      ? {
          privacyLevel: post.tiktokSettings.privacyLevel,
          allowComment: Boolean(post.tiktokSettings.allowComment),
          brandOrganic: Boolean(post.tiktokSettings.brandOrganic),
        }
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
  if (!profile) return [];
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
 * Page de retour après la connexion : un chemin du tableau de bord
 * seulement (ni schéma, ni hôte, ni « // »).
 */
export function sanitizeReturnTo(value) {
  if (typeof value !== "string") return DEFAULT_RETURN_TO;
  const raw = value.trim();
  if (
    !raw.startsWith("/dashboard") ||
    raw.includes("//") ||
    raw.includes("\\") ||
    raw.length > 500 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(raw)
  ) {
    return DEFAULT_RETURN_TO;
  }
  try {
    const base = "https://newbi.invalid";
    const url = new URL(raw, base);
    if (url.origin !== base) return DEFAULT_RETURN_TO;
    if (
      url.pathname !== "/dashboard" &&
      !url.pathname.startsWith("/dashboard/")
    ) {
      return DEFAULT_RETURN_TO;
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

const apiPublicUrl = () =>
  (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(
    /\/+$/,
    "",
  );

/**
 * Adresse d'autorisation vers laquelle envoyer le navigateur pour connecter
 * un compte (profil du fournisseur créé au besoin).
 */
export async function createConnectUrl({
  workspaceId,
  userId,
  platform,
  returnTo,
  now = new Date(),
}) {
  assertSocialPublishingEnabled();
  if (!isSupportedPlatform(platform)) {
    throw userError("Ce réseau social n'est pas pris en charge.");
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

const safeCode = (value) =>
  typeof value === "string" && /^[a-z0-9_]{1,64}$/i.test(value)
    ? value
    : "connection_failed";

/**
 * Retour du navigateur après la connexion chez le fournisseur : jeton à
 * usage unique, droit « Applications » toujours présent, synchronisation
 * des comptes, puis adresse du site où renvoyer le navigateur.
 * @param {object} query - paramètres reçus (state, connected, error…)
 * @returns {Promise<string>} adresse de redirection
 */
export async function completeConnect(query = {}, { now = new Date() } = {}) {
  const frontend = (
    process.env.FRONTEND_URL || "http://localhost:3000"
  ).replace(/\/+$/, "");
  const token =
    typeof query.state === "string" && query.state.length <= 64
      ? query.state
      : null;
  const state = token
    ? await SocialConnectState.findOneAndDelete({
        token,
        expiresAt: { $gt: now },
      })
    : null;

  const redirect = (returnTo, params) => {
    const url = new URL(returnTo, `${frontend}/`);
    ["social_connected", "social_error", "social_platform"].forEach((key) =>
      url.searchParams.delete(key),
    );
    Object.entries(params).forEach(([key, value]) =>
      url.searchParams.set(key, value),
    );
    return url.toString();
  };

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
 * Cibles des posts programmés sur un compte déconnecté : annulées
 * localement (le fournisseur annule de son côté les posts dont le compte
 * disparaît) ; un post sans plus aucune cible est supprimé chez le
 * fournisseur, au mieux.
 */
async function cancelPendingTargetsOfAccount(workspaceId, accountId) {
  const posts = await SocialPost.find({
    workspaceId,
    status: "scheduled",
    "targets.socialAccountId": accountId,
  });
  for (const post of posts) {
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
  try {
    await provider.deleteAccount(account.externalAccountId);
  } catch (error) {
    throw toUserError(error, "account");
  }
  await SocialAccount.updateOne(
    { _id: account._id },
    { $set: { deletedAt: now } },
  );
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
      if (provider.isConfigured()) {
        await provider.deleteAccount(account.externalAccountId);
      }
      await SocialAccount.updateOne(
        { _id: account._id },
        { $set: { deletedAt: now } },
      );
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
    const info = await provider.getTikTokCreatorInfo(account.externalAccountId);
    return {
      ...info,
      privacyLevels: info.privacyLevels.map((level) => ({
        value: level.value,
        label: TIKTOK_PRIVACY_LABELS[level.value] || level.label,
      })),
    };
  } catch (error) {
    throw toUserError(error, "read");
  }
}

const TIKTOK_PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: "Tout le monde",
  MUTUAL_FOLLOW_FRIENDS: "Amis",
  FOLLOWER_OF_CREATOR: "Abonnés",
  SELF_ONLY: "Moi uniquement",
};

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
  let uploaded;
  try {
    uploaded = await provider.uploadMedia({
      buffer: image.buffer,
      filename: `${crypto.randomUUID()}.jpg`,
      contentType: image.contentType,
    });
  } catch (error) {
    throw toUserError(error, "media");
  }
  const media = await SocialPostMedia.create({
    workspaceId,
    createdBy: toObjectIdOrNull(String(userId || "")),
    provider: provider.PROVIDER,
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
  return ordered;
}

/** Images : celles téléversées par l'espace, dans l'ordre reçu. */
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
  return ids.map((id) => byId.get(id));
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

function normalizeTikTokSettings(input) {
  const error = validateTikTokSettings(input);
  if (error) throw userError(error);
  return {
    privacyLevel: input.privacyLevel.trim(),
    allowComment: input.allowComment,
    brandOrganic: Boolean(input.brandOrganic),
  };
}

const assertValid = (message) => {
  if (message) throw userError(message);
};

const providerTargets = (accounts) =>
  accounts.map((account) => ({
    platform: account.platform,
    externalAccountId: account.externalAccountId,
  }));

const postMedia = (media) =>
  media.map((item) => ({
    mediaId: item._id || item.mediaId,
    url: item.url,
    width: item.width ?? null,
    height: item.height ?? null,
    contentType: item.contentType || "image/jpeg",
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
  if (remote.status) post.status = remote.status;
  post.targets.forEach((target) => {
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
  assertValid(validatePostContent({ platforms, content, media }));

  const publishNow = input.publishNow === true;
  const scheduledFor = publishNow ? now : parseDate(input.scheduledFor);
  if (!publishNow) assertValid(validateScheduleDate(scheduledFor, { now }));
  const timezone = normalizeTimezone(input.timezone);
  const tiktokSettings = platforms.includes("tiktok")
    ? normalizeTikTokSettings(input.tiktokSettings)
    : null;

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

  // 2. Le post chez le fournisseur
  const idempotencyKey = crypto.randomUUID();
  let result;
  try {
    result = await provider.createPost({
      idempotencyKey,
      content,
      mediaUrls: media.map((item) => item.url),
      targets: providerTargets(accounts),
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

  // 3. Le post local
  let post;
  try {
    post = new SocialPost({
      workspaceId,
      boardId: board._id,
      taskId: savedTask._id,
      createdBy: toObjectIdOrNull(String(user?.id || "")),
      updatedBy: toObjectIdOrNull(String(user?.id || "")),
      provider: provider.PROVIDER,
      externalPostId: result.post.externalPostId,
      idempotencyKey,
      content,
      media: postMedia(media),
      targets: accounts.map((account) => ({
        socialAccountId: account._id,
        platform: account.platform,
        externalAccountId: account.externalAccountId,
        username: account.username,
        displayName: account.displayName,
        status: "pending",
      })),
      scheduledFor,
      timezone,
      status: publishNow ? "publishing" : "scheduled",
      tiktokSettings,
    });
    applyRemotePost(post, result.post, now);
    await post.save();
  } catch (error) {
    logger.error("[SocialPost] Post local non enregistré, annulation:", error);
    await provider
      .deletePost(result.post.externalPostId)
      .catch((deleteError) =>
        logger.error(
          `[SocialPost] Post ${result.post.externalPostId} orphelin chez le fournisseur:`,
          deleteError,
        ),
      );
    await discardCreatedTask(savedTask, workspaceId);
    throw error;
  }

  publishTaskCreated(enrichedTask, workspaceId);
  // Publication immédiate : le résultat est déjà connu
  await notifySocialPostOutcome(post);
  return { post: await serializeSocialPost(post), task: enrichedTask };
}

// ── Modifier, annuler, réessayer ───────────────────────────────────────────

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
  const post = await loadPostForUser(postId, workspaceId, user, permissions);
  if (post.status !== "scheduled") {
    throw userError(
      "Ce post ne peut plus être modifié : sa publication est en cours ou terminée.",
    );
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
  assertValid(validatePostContent({ platforms, content, media }));

  let scheduledFor = post.scheduledFor;
  if (input.scheduledFor !== undefined && input.scheduledFor !== null) {
    scheduledFor = parseDate(input.scheduledFor);
    assertValid(validateScheduleDate(scheduledFor, { now }));
  }
  let tiktokSettings = null;
  if (platforms.includes("tiktok")) {
    tiktokSettings = input.tiktokSettings
      ? normalizeTikTokSettings(input.tiktokSettings)
      : post.tiktokSettings?.privacyLevel
        ? {
            privacyLevel: post.tiktokSettings.privacyLevel,
            allowComment: Boolean(post.tiktokSettings.allowComment),
            brandOrganic: Boolean(post.tiktokSettings.brandOrganic),
          }
        : normalizeTikTokSettings(null);
  }

  try {
    await provider.updatePost(post.externalPostId, {
      content,
      mediaUrls: media.map((item) => item.url),
      targets: providerTargets(accounts),
      scheduledFor,
      timezone: post.timezone || DEFAULT_TIMEZONE,
      tiktokSettings,
    });
  } catch (error) {
    throw toUserError(error, "update");
  }

  post.content = content;
  post.media = postMedia(media);
  post.targets = accounts.map((account) => ({
    socialAccountId: account._id,
    platform: account.platform,
    externalAccountId: account.externalAccountId,
    username: account.username,
    displayName: account.displayName,
    status: "pending",
  }));
  post.scheduledFor = scheduledFor;
  post.tiktokSettings = tiktokSettings;
  post.updatedBy = toObjectIdOrNull(String(user?.id || ""));
  await post.save();

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
  // Même échec qu'avant : déjà notifié (notifiedStatus), rien n'est renvoyé
  post.updatedBy = toObjectIdOrNull(String(user?.id || ""));
  post.syncLockedUntil = null;
  await post.save();
  await notifySocialPostOutcome(post);
  return serializeSocialPost(post);
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
  try {
    await provider.updatePost(post.externalPostId, {
      scheduledFor: next,
      timezone: post.timezone || DEFAULT_TIMEZONE,
    });
  } catch (error) {
    throw toUserError(error, "update");
  }
  await SocialPost.updateOne(
    { _id: post._id },
    {
      $set: {
        scheduledFor: next,
        updatedBy: toObjectIdOrNull(String(userId || "")),
      },
    },
  );
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
