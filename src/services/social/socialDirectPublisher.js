import SocialAccount from "../../models/SocialAccount.js";
import SocialPost from "../../models/SocialPost.js";
import logger from "../../utils/logger.js";
import { DirectApiError } from "./direct/directHttp.js";
import {
  getFreshAccessToken,
  loadAccountWithTokens,
  markNeedsReconnect,
} from "./socialAccountCredentials.js";
import { directNetworkFor, isDirectNetworkReady } from "./socialProviders.js";
import {
  TERMINAL_STATUSES,
  notifySocialPostOutcome,
} from "./socialPostNotifications.js";

/**
 * Publication des cibles « direct » (nos propres applis chez les réseaux),
 * par le cron socialDirectPublishCron (instance PM2 0, chaque minute) et
 * par « Publier maintenant » dans la mutation.
 *
 * - Bail par cible (lockedUntil, comme les factures récurrentes) : une cible
 *   n'est envoyée que par celui qui l'a réservée, et l'écriture du résultat
 *   exige toujours ce bail (deux passes ne publient jamais deux fois).
 * - Erreur passagère : nouvel essai avec délai, 3 fois au plus ; erreur
 *   définitive : échec avec une errorCategory de socialPostMessages.js.
 * - Publication en deux temps (TikTok, et vidéos Instagram, LinkedIn, X) :
 *   envoi accepté, puis suivi par checkPublication du réseau jusqu'à la
 *   publication, sans jamais bloquer le cron pendant le traitement chez le
 *   réseau (état intermédiaire gardé dans processingRef).
 * - Stories (Instagram, Facebook) : une story par photo, la progression
 *   (storyIds) écrite sous le bail après chaque story publiée ; un nouvel
 *   essai ou « Réessayer » reprend après la dernière, jamais de story en
 *   double.
 * - Brouillon TikTok : terminé quand TikTok l'a livré dans l'appli du
 *   client (deliveredAs « draft », sans adresse de post).
 * - Statut global du post : agrégé depuis toutes ses cibles (Zernio et
 *   direct), notification de l'auteur une seule fois au statut final.
 */

// Au-delà de la plus longue publication possible (carrousel Instagram de
// 10 images, délais de 60 s) : un bail expiré veut dire un envoi interrompu
export const LOCK_MS = 15 * 60 * 1000;
// Premier envoi + 3 nouveaux essais
export const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 30 * 1000;
const CHECK_MS = 60 * 1000;
// Traitement chez le réseau au plus (sauf maxProcessingMs du réseau)
const MAX_PROCESSING_MS = 2 * 60 * 60 * 1000;
const TIKTOK_URL_WATCH_MS = 60 * 60 * 1000;
const RECHECK_MS = 2 * 60 * 1000;
const BATCH_SIZE = 25;

// Tarif X à la création d'un post (docs.x.com/x-api/getting-started/pricing)
const X_POST_COST_USD = 0.015;
const X_POST_WITH_URL_COST_USD = 0.2;
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/i;

export const isDirectTarget = (target) => target?.provider === "direct";

/** Fournisseur d'un post d'après ses cibles. */
export function postProviderOf(targets = []) {
  const direct = targets.filter(isDirectTarget).length;
  if (direct === 0) return "zernio";
  return direct === targets.length ? "direct" : "mixed";
}

/**
 * Statut global d'un post d'après ses cibles : annulé si tout est annulé,
 * en cours tant qu'une cible n'est pas terminée (programmé si rien n'a
 * commencé), sinon publié, en partie ou en échec (une cible annulée parmi
 * d'autres compte comme un échec, comme dans les notifications).
 */
export function aggregatePostStatus(post) {
  const statuses = (post.targets || []).map((t) => t.status || "pending");
  if (statuses.length === 0) return post.status;
  if (statuses.every((s) => s === "cancelled")) return "cancelled";
  if (statuses.some((s) => s === "publishing")) return "publishing";
  if (statuses.some((s) => s === "pending")) {
    const started = statuses.some((s) => s !== "pending");
    return started || post.status === "publishing" ? "publishing" : "scheduled";
  }
  const published = statuses.filter((s) => s === "published").length;
  if (published === statuses.length) return "published";
  return published === 0 ? "failed" : "partial";
}

const unlockedTarget = (now) => ({
  $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
});
const attemptDue = (now) => ({
  $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
});

/** Cible directe à traiter maintenant (filtre $elemMatch). */
export const dueTargetMatch = (now) => ({
  provider: "direct",
  $and: [
    unlockedTarget(now),
    attemptDue(now),
    {
      $or: [
        { status: "pending" },
        // Publication en deux temps en cours, ou envoi interrompu (bail
        // expiré)
        { status: "publishing" },
        // Adresse du post TikTok encore attendue
        { status: "published", urlCheckUntil: { $gt: now } },
      ],
    },
  ],
});

const isTargetDue = (target, now) => {
  if (!isDirectTarget(target)) return false;
  const time = now.getTime();
  if (target.lockedUntil && new Date(target.lockedUntil).getTime() > time)
    return false;
  if (target.nextAttemptAt && new Date(target.nextAttemptAt).getTime() > time) {
    return false;
  }
  if (target.status === "pending" || target.status === "publishing")
    return true;
  return (
    target.status === "published" &&
    target.urlCheckUntil &&
    new Date(target.urlCheckUntil).getTime() > time
  );
};

// ── Écritures sous bail ────────────────────────────────────────────────────

const positional = (fields) =>
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [`targets.$.${key}`, value]),
  );

/**
 * Réserve une cible (bail), et la passe en « publishing » pour un envoi.
 * @returns {Promise<{post: object, target: object, lockUntil: Date}|null>}
 */
async function claimTarget(postId, target, mode, now) {
  const lockUntil = new Date(now.getTime() + LOCK_MS);
  const set = { "targets.$.lockedUntil": lockUntil };
  const update = { $set: set };
  if (mode === "publish") {
    set["targets.$.status"] = "publishing";
    set.status = "publishing";
    update.$inc = { "targets.$.attempts": 1 };
    // Nouvel essai automatique vers X : un envoi facturé de plus, compté
    // dans la limite mensuelle (xPostQuota.js). Le premier envoi est déjà
    // compté par la cible elle-même.
    if (target.platform === "twitter" && (target.attempts || 0) >= 1) {
      update.$push = { xRetriedAt: now };
    }
  }
  const post = await SocialPost.findOneAndUpdate(
    {
      _id: postId,
      targets: {
        $elemMatch: {
          socialAccountId: target.socialAccountId,
          provider: "direct",
          status: target.status,
          $and: [unlockedTarget(now), attemptDue(now)],
        },
      },
    },
    update,
    { new: true },
  ).lean();
  if (!post) return null;
  const claimed = post.targets.find(
    (t) => String(t.socialAccountId) === String(target.socialAccountId),
  );
  return { post, target: claimed, lockUntil };
}

/** Écrit le résultat si le bail est toujours le nôtre. */
async function writeTarget(postId, target, lockUntil, fields) {
  const result = await SocialPost.updateOne(
    {
      _id: postId,
      targets: {
        $elemMatch: {
          socialAccountId: target.socialAccountId,
          lockedUntil: lockUntil,
        },
      },
    },
    { $set: positional({ ...fields, lockedUntil: null }) },
  );
  if (result.matchedCount === 0) {
    logger.warn(
      `[SocialDirect] Bail perdu sur la cible ${target.platform} du post ${postId}, résultat ignoré`,
    );
  }
  return result.matchedCount > 0;
}

/**
 * Progression d'une publication en plusieurs envois (stories), écrite SOUS
 * LE BAIL et sans le libérer. Bail perdu : l'envoi s'arrête (erreur
 * passagère), pour ne jamais publier deux fois la même story.
 */
async function saveTargetProgress(postId, target, lockUntil, { storyIds }) {
  const result = await SocialPost.updateOne(
    {
      _id: postId,
      targets: {
        $elemMatch: {
          socialAccountId: target.socialAccountId,
          lockedUntil: lockUntil,
        },
      },
    },
    { $set: { "targets.$.storyIds": storyIds } },
  );
  if (result.matchedCount === 0) {
    throw new DirectApiError(
      "Bail perdu pendant la publication des stories, envoi arrêté",
      { transient: true },
    );
  }
}

/** Paramètres communs des appels au réseau pour une cible. */
const networkParams = (post, target, lockUntil) => ({
  content: post.content || "",
  media: post.media || [],
  tiktokSettings: post.tiktokSettings || null,
  instagramSettings: post.instagramSettings || null,
  facebookSettings: post.facebookSettings || null,
  workspaceId: post.workspaceId,
  progress: { storyIds: [...(target.storyIds || [])] },
  saveProgress: (progress) =>
    saveTargetProgress(post._id, target, lockUntil, progress),
});

// ── Erreurs ────────────────────────────────────────────────────────────────

const asDirectError = (error) =>
  error instanceof DirectApiError
    ? error
    : new DirectApiError(error?.message || "Erreur inattendue", {
        transient: true,
      });

const retryDelay = (attempts, error) =>
  Math.max(
    RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)],
    Math.min(error.retryAfterMs || 0, MAX_RETRY_AFTER_MS),
  );

const failedFields = (error) => ({
  status: "failed",
  errorCategory:
    error.category || (error.transient ? null : "platform_rejected"),
  // Message d'origine du réseau, traduit à l'affichage (targetErrorMessage)
  errorMessage:
    String(error.detail || error.message || "").slice(0, 500) || null,
  nextAttemptAt: null,
  urlCheckUntil: null,
  publishedAt: null,
});

// ── Traitement d'une cible ─────────────────────────────────────────────────

/**
 * Coût d'un envoi à X noté dans les journaux. La limite mensuelle par offre
 * compte les cibles X des posts, quel que soit le fournisseur
 * (xPostQuota.js) : rien n'est compté ici.
 */
function logXCost(post, content) {
  const withUrl = URL_PATTERN.test(content || "");
  const cost = withUrl ? X_POST_WITH_URL_COST_USD : X_POST_COST_USD;
  logger.info(
    `[SocialDirect] Post X publié pour l'espace ${post.workspaceId} : ${cost} $ facturés à Sweily${withUrl ? " (lien dans le texte)" : ""}`,
  );
}

/** Appel au réseau, avec un rafraîchissement du jeton s'il est refusé. */
async function callWithFreshToken(account, now, call) {
  let token = await getFreshAccessToken(account, { now });
  try {
    return await call(token);
  } catch (error) {
    if (!error?.authInvalid) throw error;
    // Jeton refusé avant sa date : un rafraîchissement peut le sauver
    token = await getFreshAccessToken(account, { now, force: true });
    return call(token);
  }
}

async function loadTargetAccount(post, target) {
  const account = await loadAccountWithTokens({
    _id: target.socialAccountId,
    workspaceId: post.workspaceId,
  });
  if (!account || account.deletedAt) return { missing: true };
  return { account };
}

async function publishTarget(post, target, lockUntil, now) {
  const { account, missing } = await loadTargetAccount(post, target);
  if (missing) {
    // Compte déconnecté entre-temps : la cible ne partira plus
    await writeTarget(post._id, target, lockUntil, { status: "cancelled" });
    return "cancelled";
  }
  try {
    if (account.status !== "active") {
      throw new DirectApiError("Compte à reconnecter", {
        network: account.platform,
        category: "auth_expired",
        authInvalid: true,
      });
    }
    if (!isDirectNetworkReady(account.platform, account.connector)) {
      throw new DirectApiError("Appli du réseau non configurée", {
        network: account.platform,
        transient: true,
      });
    }
    const network = directNetworkFor(account.platform, account.connector);
    const result = await callWithFreshToken(account, now, (accessToken) =>
      network.publish({
        account,
        accessToken,
        ...networkParams(post, target, lockUntil),
      }),
    );

    if (result.status === "publishing") {
      // Publication acceptée, suivie aux tours suivants (TikTok, vidéos)
      if (result.username && result.username !== account.username) {
        await SocialAccount.updateOne(
          { _id: account._id },
          { $set: { username: result.username } },
        );
      }
      await writeTarget(post._id, target, lockUntil, {
        status: "publishing",
        externalPostId: result.externalPostId || null,
        processingRef: result.processingRef || null,
        submittedAt: now,
        nextAttemptAt: new Date(
          now.getTime() + (result.nextCheckMs ?? FIRST_CHECK_MS),
        ),
        errorMessage: null,
        errorCategory: null,
      });
      return "publishing";
    }

    await writeTarget(post._id, target, lockUntil, {
      status: "published",
      externalPostId: result.externalPostId || null,
      platformPostUrl: result.platformPostUrl || null,
      publishedAt: now,
      nextAttemptAt: null,
      errorMessage: null,
      errorCategory: null,
      ...(result.storyIds ? { storyIds: result.storyIds } : {}),
      ...(result.deliveredAs ? { deliveredAs: result.deliveredAs } : {}),
    });
    if (account.platform === "twitter") logXCost(post, post.content);
    logger.info(
      `[SocialDirect] Post ${post._id} publié sur ${account.platform} (compte ${account._id})`,
    );
    return "published";
  } catch (rawError) {
    const error = asDirectError(rawError);
    if (error.authInvalid) await markNeedsReconnect(account, error.message);
    const attempts = target.attempts || 1;
    if (error.transient && attempts < MAX_ATTEMPTS) {
      const delay = retryDelay(attempts, error);
      logger.warn(
        `[SocialDirect] Post ${post._id} sur ${account.platform} : erreur passagère (essai ${attempts}/${MAX_ATTEMPTS}), nouvel essai dans ${Math.round(delay / 1000)} s : ${error.message}`,
      );
      await writeTarget(post._id, target, lockUntil, {
        status: "pending",
        nextAttemptAt: new Date(now.getTime() + delay),
        errorMessage: null,
        errorCategory: null,
      });
      return "retry";
    }
    logger.warn(
      `[SocialDirect] Post ${post._id} en échec sur ${account.platform} (${error.category || "erreur"}) : ${error.message}`,
    );
    await writeTarget(post._id, target, lockUntil, failedFields(error));
    return "failed";
  }
}

const isVideoPost = (post) =>
  (post.media || []).some((media) => media?.kind === "video");

/**
 * Nouvelle publication complète après un état intermédiaire perdu chez le
 * réseau (conteneur Instagram expiré, jamais publié) : la cible repart
 * comme un nouvel essai, dans la limite des essais (stories déjà publiées
 * gardées).
 */
async function restartTarget(post, target, lockUntil, now, error) {
  const attempts = target.attempts || 1;
  if (attempts >= MAX_ATTEMPTS) {
    await writeTarget(post._id, target, lockUntil, failedFields(error));
    return "failed";
  }
  await writeTarget(post._id, target, lockUntil, {
    status: "pending",
    externalPostId: null,
    processingRef: null,
    submittedAt: null,
    nextAttemptAt: new Date(now.getTime() + retryDelay(attempts, error)),
    errorMessage: null,
    errorCategory: null,
  });
  return "retry";
}

/**
 * Suivi d'une publication en deux temps (TikTok, vidéos Instagram, LinkedIn
 * et X) : le réseau termine son traitement, puis checkPublication publie
 * (ou constate la publication) ; ou suivi de l'adresse d'un post TikTok.
 */
async function checkTarget(post, target, lockUntil, now, mode) {
  const { account, missing } = await loadTargetAccount(post, target);
  const network = account
    ? directNetworkFor(account.platform, account.connector)
    : null;
  if (missing || !network?.checkPublication) {
    await writeTarget(post._id, target, lockUntil, {
      urlCheckUntil: null,
      nextAttemptAt: null,
    });
    return "skipped";
  }
  try {
    const result = await callWithFreshToken(account, now, (accessToken) =>
      network.checkPublication({
        account,
        accessToken,
        externalPostId: target.externalPostId,
        processingRef: target.processingRef || null,
        submittedAt: target.submittedAt || null,
        ...networkParams(post, target, lockUntil),
        now,
      }),
    );
    if (result.status === "published") {
      // Adresse attendue après la modération : TikTok seulement (pas pour
      // un brouillon, qui n'a pas de post)
      const watchUrl =
        account.platform === "tiktok" &&
        result.deliveredAs !== "draft" &&
        !result.platformPostUrl &&
        post.tiktokSettings?.privacyLevel === "PUBLIC_TO_EVERYONE";
      const fields = {
        status: "published",
        platformPostUrl:
          result.platformPostUrl || target.platformPostUrl || null,
        urlCheckUntil:
          mode === "url"
            ? result.platformPostUrl
              ? null
              : target.urlCheckUntil
            : watchUrl
              ? new Date(now.getTime() + TIKTOK_URL_WATCH_MS)
              : null,
        nextAttemptAt:
          watchUrl || (mode === "url" && !result.platformPostUrl)
            ? new Date(now.getTime() + RECHECK_MS)
            : null,
      };
      // Identifiant du post publié (TikTok garde son publish_id, relu pour
      // l'adresse)
      if (!target.externalPostId && result.externalPostId) {
        fields.externalPostId = result.externalPostId;
      }
      if (mode !== "url") {
        fields.publishedAt = now;
        fields.errorMessage = null;
        fields.errorCategory = null;
      }
      if (result.storyIds) fields.storyIds = result.storyIds;
      if (result.deliveredAs) fields.deliveredAs = result.deliveredAs;
      await writeTarget(post._id, target, lockUntil, fields);
      if (mode !== "url" && account.platform === "twitter") {
        logXCost(post, post.content);
      }
      if (mode !== "url") {
        logger.info(
          `[SocialDirect] Post ${post._id} publié sur ${account.platform} (compte ${account._id}) après traitement`,
        );
      }
      return "published";
    }
    const startedAt = new Date(
      target.submittedAt || post.scheduledFor,
    ).getTime();
    const maxProcessingMs = network.maxProcessingMs || MAX_PROCESSING_MS;
    if (mode === "check" && now.getTime() - startedAt > maxProcessingMs) {
      const video = isVideoPost(post);
      await writeTarget(
        post._id,
        target,
        lockUntil,
        failedFields(
          new DirectApiError(
            `${account.platform} n'a pas confirmé la publication`,
            {
              category: video
                ? "video_processing_timeout"
                : "platform_rejected",
              detail: "publication non confirmée",
            },
          ),
        ),
      );
      return "failed";
    }
    await writeTarget(post._id, target, lockUntil, {
      nextAttemptAt: new Date(now.getTime() + (result.nextCheckMs ?? CHECK_MS)),
      // État intermédiaire mis à jour par le réseau (au besoin)
      ...(result.processingRef ? { processingRef: result.processingRef } : {}),
    });
    return "publishing";
  } catch (rawError) {
    const error = asDirectError(rawError);
    if (error.authInvalid) await markNeedsReconnect(account, error.message);
    if (mode === "check" && error.restart) {
      logger.warn(
        `[SocialDirect] Publication à reprendre sur ${account.platform} (post ${post._id}) : ${error.message}`,
      );
      return restartTarget(post, target, lockUntil, now, error);
    }
    if (mode === "check" && !error.transient) {
      await writeTarget(post._id, target, lockUntil, failedFields(error));
      return "failed";
    }
    await writeTarget(post._id, target, lockUntil, {
      nextAttemptAt: new Date(now.getTime() + RECHECK_MS),
      ...(mode === "url" && !error.transient ? { urlCheckUntil: null } : {}),
    });
    return "retry";
  }
}

/**
 * Traite une cible directe due : envoi, suivi d'une publication en deux
 * temps, ou envoi interrompu (bail expiré sans résultat : marqué en échec,
 * jamais renvoyé, pour ne pas publier deux fois).
 */
async function processTarget(postId, target, now) {
  const mode =
    target.status === "pending"
      ? "publish"
      : target.status === "publishing"
        ? target.externalPostId || target.processingRef
          ? "check"
          : "stale"
        : "url";
  const claim = await claimTarget(postId, target, mode, now);
  if (!claim) return "busy";
  const { post, lockUntil } = claim;
  if (mode === "publish")
    return publishTarget(post, claim.target, lockUntil, now);
  if (mode === "stale") {
    logger.warn(
      `[SocialDirect] Envoi interrompu sur ${target.platform} (post ${postId}), résultat inconnu : marqué en échec sans nouvel envoi`,
    );
    await writeTarget(postId, claim.target, lockUntil, {
      ...failedFields(
        new DirectApiError("Envoi interrompu, résultat inconnu", {
          category: null,
        }),
      ),
      errorCategory: null,
    });
    return "failed";
  }
  return checkTarget(post, claim.target, lockUntil, now, mode);
}

/**
 * Statut global recalculé depuis les cibles, puis notification de l'auteur
 * s'il est final (une seule fois par statut).
 */
export async function refreshPostStatus(postId) {
  const post = await SocialPost.findById(postId);
  if (!post) return null;
  const next = aggregatePostStatus(post);
  if (next !== post.status) {
    const result = await SocialPost.updateOne(
      { _id: post._id, status: post.status },
      { $set: { status: next } },
    );
    if (result.matchedCount === 0) return post;
    post.status = next;
  }
  if (TERMINAL_STATUSES.has(post.status)) await notifySocialPostOutcome(post);
  return post;
}

/**
 * Publie tout de suite les cibles directes dues d'un post (« Publier
 * maintenant », nouvel essai) puis recalcule son statut.
 */
export async function publishDirectTargetsNow(
  postId,
  { now = new Date() } = {},
) {
  const post = await SocialPost.findById(postId).lean();
  if (!post) return null;
  for (const target of post.targets || []) {
    if (isTargetDue(target, now)) await processTarget(post._id, target, now);
  }
  return refreshPostStatus(post._id, now);
}

/**
 * Un tour du cron : cibles directes dues (au plus `limit` posts), puis
 * statuts restés en retard (écritures concurrentes) et notifications.
 * @returns {Promise<{posts: number, published: number, failed: number, retried: number}>}
 */
export async function publishDueDirectTargets({
  now = new Date(),
  limit = BATCH_SIZE,
} = {}) {
  const stats = { posts: 0, published: 0, failed: 0, retried: 0 };
  const candidates = await SocialPost.find({
    scheduledFor: { $lte: now },
    status: { $ne: "cancelled" },
    targets: { $elemMatch: dueTargetMatch(now) },
  })
    .sort({ scheduledFor: 1 })
    .limit(limit)
    .lean();
  stats.posts = candidates.length;

  for (const post of candidates) {
    for (const target of post.targets || []) {
      if (!isTargetDue(target, now)) continue;
      try {
        const outcome = await processTarget(post._id, target, now);
        if (outcome === "published") stats.published += 1;
        if (outcome === "failed") stats.failed += 1;
        if (outcome === "retry") stats.retried += 1;
      } catch (error) {
        logger.error(
          `[SocialDirect] Erreur inattendue sur le post ${post._id}:`,
          error,
        );
      }
    }
    await refreshPostStatus(post._id, now).catch((error) =>
      logger.error(
        `[SocialDirect] Statut du post ${post._id} non recalculé:`,
        error,
      ),
    );
  }

  // Statuts en retard (deux écritures croisées) et notifications manquées
  const lagging = await SocialPost.find({
    provider: { $in: ["direct", "mixed"] },
    $or: [
      {
        status: { $in: ["scheduled", "publishing"] },
        scheduledFor: { $lte: now },
        targets: {
          $not: { $elemMatch: { status: { $in: ["pending", "publishing"] } } },
        },
      },
      {
        status: { $in: [...TERMINAL_STATUSES] },
        $expr: { $ne: ["$notifiedStatus", "$status"] },
      },
    ],
  })
    .select("_id")
    .limit(limit)
    .lean();
  for (const { _id } of lagging) {
    await refreshPostStatus(_id, now).catch((error) =>
      logger.error(
        `[SocialDirect] Statut du post ${_id} non recalculé:`,
        error,
      ),
    );
  }
  return stats;
}

/**
 * Nouvel essai demandé par l'utilisateur : les cibles directes en échec
 * repartent (compteur d'essais remis à zéro). Les stories déjà publiées
 * (storyIds) sont gardées : la publication reprend après la dernière.
 * @returns {Promise<number>} nombre de cibles relancées
 */
export async function resetFailedDirectTargets(postId) {
  const result = await SocialPost.updateOne(
    { _id: postId },
    {
      $set: {
        "targets.$[t].status": "pending",
        "targets.$[t].attempts": 0,
        "targets.$[t].nextAttemptAt": null,
        "targets.$[t].lockedUntil": null,
        "targets.$[t].errorMessage": null,
        "targets.$[t].errorCategory": null,
        "targets.$[t].processingRef": null,
        status: "publishing",
      },
    },
    { arrayFilters: [{ "t.provider": "direct", "t.status": "failed" }] },
  );
  return result.modifiedCount;
}
