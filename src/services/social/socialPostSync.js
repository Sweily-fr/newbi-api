import SocialPost from "../../models/SocialPost.js";
import logger from "../../utils/logger.js";
import provider, { SocialProviderError } from "./providers/zernioProvider.js";
import { applyRemotePost } from "./socialPublishingService.js";
import {
  aggregatePostStatus,
  isDirectTarget,
} from "./socialDirectPublisher.js";
import {
  TERMINAL_STATUSES,
  notifySocialPostOutcome,
} from "./socialPostNotifications.js";

/**
 * Suivi des posts programmés chez Zernio (cron socialPostSyncCron,
 * instance PM2 0 ; les cibles « direct » sont suivies par
 * socialDirectPublisher.js) :
 * posts dont l'heure est passée et pas encore à un statut final, et posts
 * TikTok publiés dont l'adresse n'est pas encore connue (TikTok la donne
 * quelques minutes après, on la guette une heure).
 *
 * Chaque post est réservé atomiquement (bail syncLockedUntil, comme les
 * factures récurrentes) : deux tours ou deux instances ne le traitent
 * jamais en même temps. Une erreur réseau ou du fournisseur ne fait jamais
 * passer le post en échec : syncFailureCount augmente et on réessaie plus
 * tard.
 */

const LOCK_MS = 5 * 60 * 1000;
const BATCH_SIZE = 50;
const TIKTOK_URL_WINDOW_MS = 60 * 60 * 1000;
// Post en retard chez le fournisseur (file d'attente, limite de débit) :
// on l'interroge moins souvent au-delà d'une heure
const LATE_POST_MS = 60 * 60 * 1000;
const LATE_POST_RECHECK_MS = 15 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

const unlockedFilter = (now) => ({
  $or: [{ syncLockedUntil: null }, { syncLockedUntil: { $lte: now } }],
});

export const dueFilter = (now) => ({
  // Post Zernio seulement (un post tout en direct n'en a pas)
  externalPostId: { $nin: [null, ""] },
  $or: [
    {
      provider: { $ne: "mixed" },
      status: { $in: ["scheduled", "publishing"] },
      scheduledFor: { $lte: now },
    },
    {
      // Post mixte : tant que sa part Zernio n'est pas terminée
      provider: "mixed",
      status: { $in: ["scheduled", "publishing"] },
      scheduledFor: { $lte: now },
      targets: {
        $elemMatch: {
          provider: { $ne: "direct" },
          status: { $in: ["pending", "publishing"] },
        },
      },
    },
    {
      status: "published",
      targets: {
        $elemMatch: {
          provider: { $ne: "direct" },
          platform: "tiktok",
          status: "published",
          platformPostUrl: null,
          publishedAt: { $gte: new Date(now.getTime() - TIKTOK_URL_WINDOW_MS) },
        },
      },
    },
  ],
});

/** Synchronise un post déjà réservé. */
export async function syncOnePost(post, { now = new Date() } = {}) {
  let remote;
  try {
    remote = await provider.getPost(post.externalPostId);
  } catch (error) {
    if (error instanceof SocialProviderError && error.status === 404) {
      // Supprimé chez le fournisseur (hors Newbi) : il ne partira plus
      logger.warn(
        `[SocialPostSync] Post ${post._id} introuvable chez le fournisseur, annulé`,
      );
      const mixed = post.targets.some(isDirectTarget);
      post.targets.forEach((target) => {
        if (!isDirectTarget(target) && target.status !== "published") {
          target.status = "cancelled";
        }
      });
      // Post mixte : ses cibles directes partent quand même
      post.status = mixed ? aggregatePostStatus(post) : "cancelled";
      if (mixed) post.externalPostId = null;
      post.lastSyncedAt = now;
      post.syncLockedUntil = null;
      await post.save();
      await notifySocialPostOutcome(post);
      return { status: "cancelled" };
    }
    const failures = (post.syncFailureCount || 0) + 1;
    const backoff = Math.min(2 ** failures * 60 * 1000, MAX_BACKOFF_MS);
    await SocialPost.updateOne(
      { _id: post._id },
      {
        $set: { syncLockedUntil: new Date(now.getTime() + backoff) },
        $inc: { syncFailureCount: 1 },
      },
    );
    logger.warn(
      `[SocialPostSync] Post ${post._id} non synchronisé (essai ${failures}) : ${error.message}`,
    );
    return { status: "error" };
  }

  applyRemotePost(post, remote, now);
  const late =
    !TERMINAL_STATUSES.has(post.status) &&
    now.getTime() - new Date(post.scheduledFor).getTime() > LATE_POST_MS;
  post.lastSyncedAt = now;
  post.syncFailureCount = 0;
  post.syncLockedUntil = late
    ? new Date(now.getTime() + LATE_POST_RECHECK_MS)
    : null;
  await post.save();
  await notifySocialPostOutcome(post);
  return { status: post.status };
}

/**
 * Un tour de suivi : au plus `limit` posts.
 * @returns {Promise<{due: number, synced: number, errors: number}>}
 */
export async function syncDueSocialPosts({
  now = new Date(),
  limit = BATCH_SIZE,
} = {}) {
  const stats = { due: 0, synced: 0, errors: 0 };
  if (!provider.isConfigured()) return stats;

  const candidates = await SocialPost.find({
    $and: [dueFilter(now), unlockedFilter(now)],
  })
    .sort({ scheduledFor: 1 })
    .limit(limit)
    .select("_id")
    .lean();
  stats.due = candidates.length;

  for (const candidate of candidates) {
    const claimed = await SocialPost.findOneAndUpdate(
      { _id: candidate._id, ...unlockedFilter(now) },
      { $set: { syncLockedUntil: new Date(now.getTime() + LOCK_MS) } },
      { new: true },
    );
    if (!claimed) continue;
    try {
      const result = await syncOnePost(claimed, { now });
      if (result.status === "error") stats.errors += 1;
      else stats.synced += 1;
    } catch (error) {
      stats.errors += 1;
      logger.error(
        `[SocialPostSync] Erreur inattendue sur le post ${candidate._id}:`,
        error,
      );
    }
  }
  return stats;
}
