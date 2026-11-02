import SocialAccount from "../../models/SocialAccount.js";
import SocialConnectState from "../../models/SocialConnectState.js";
import SocialPost from "../../models/SocialPost.js";
import SocialPostMedia from "../../models/SocialPostMedia.js";
import SocialProfile from "../../models/SocialProfile.js";
import logger from "../../utils/logger.js";
import storage, {
  imageKeyOf,
  ownMediaId,
  ownVideoId,
  tiktokCopyIdOf,
  videoKeyOf,
} from "./socialMediaStorage.js";

/**
 * Suppression des images et vidéos des posts : fichiers du bucket R2
 * (SOCIAL_MEDIA_BUCKET : image, vidéo, vignette, original de vidéo, copie
 * TikTok) et documents SocialPostMedia. Lancée par le cron de publication
 * directe (instance PM2 0).
 *
 * - Post supprimé (carte, colonne ou tableau, espace supprimé) :
 *   mediaPurgeAt posé à la suppression, médias supprimés au tour suivant
 *   du cron. Jamais pendant une publication en cours (bail, envoi en
 *   cours, adresse TikTok attendue) : repoussé de 10 minutes.
 * - Même moment, selon purgeAction : carte supprimée (« redact ») : texte,
 *   réglages, auteur et copies des noms des comptes effacés de la fiche ;
 *   espace supprimé (« delete ») : fiche supprimée après ses médias. Les
 *   posts supprimés avant (purgeAction null) ne perdent que leurs médias.
 * - Un média encore présent dans un autre post n'est pas supprimé : seul
 *   ce post le lâche, l'autre post le supprimera à son tour.
 * - Échec du stockage : nouvel essai une heure plus tard ; la suppression
 *   de la carte n'attend jamais le stockage.
 * - Médias jamais utilisés par un post (envoi abandonné, post non créé,
 *   vidéo en échec) ou retirés d'un post modifié : supprimés après 7 jours.
 * Un post supprimé avec sa carte garde une fiche réduite : dates, statut,
 * réseaux, identifiants des comptes, identifiants et adresses des
 * publications (limite mensuelle X : xPostQuota.js).
 */

export const ORPHAN_MEDIA_MS = 7 * 24 * 60 * 60 * 1000;
// Publication en cours : nouvel essai de la suppression plus tard
export const IN_FLIGHT_RETRY_MS = 10 * 60 * 1000;
// Échec du stockage : nouvel essai plus tard
export const FAILURE_RETRY_MS = 60 * 60 * 1000;
// Bail de suppression (au-delà, un tour interrompu est repris)
const PURGE_LEASE_MS = 15 * 60 * 1000;
// Cible restée en attente plus longtemps : publication abandonnée
const STUCK_TARGET_MS = 7 * 24 * 60 * 60 * 1000;
const POST_BATCH_SIZE = 20;
const ORPHAN_BATCH_SIZE = 50;

const isImage = (media, item) =>
  (media?.kind || item?.kind || "image") === "image";

/**
 * Clés R2 d'un média (document SocialPostMedia et/ou entrée du post) :
 * fichier, vignette, original de vidéo, copie TikTok d'une image. Les
 * adresses servies par notre route suffisent sans document.
 * @returns {string[]}
 */
export function mediaObjectKeys(media = null, item = null) {
  const keys = new Set();
  const add = (key) => {
    if (key) keys.add(key);
  };
  add(media?.key);
  add(media?.thumbnailKey);
  add(media?.upload?.key);
  for (const url of [media?.url, item?.url]) {
    if (!url) continue;
    const videoId = ownVideoId(url);
    const id = ownMediaId(url);
    if (videoId) add(videoKeyOf(videoId));
    else if (id) add(imageKeyOf(id));
    // Copie réduite déposée pour TikTok (prepareTikTokImage)
    if (!videoId && isImage(media, item)) add(imageKeyOf(tiktokCopyIdOf(url)));
  }
  for (const url of [media?.thumbnailUrl, item?.thumbnailUrl]) {
    const id = ownMediaId(url);
    if (id) add(imageKeyOf(id));
  }
  return [...keys];
}

async function deleteObjects(keys) {
  for (const key of keys) await storage.deleteObject(key);
}

/**
 * Une cible du post est encore en cours de publication : le réseau peut
 * encore lire ses médias (bail, envoi en cours, adresse TikTok attendue),
 * ou le suivi Zernio écrit le post (bail de synchronisation). Une cible
 * restée en attente plus de 7 jours après la date prévue ne compte plus.
 */
export function isPostPublishing(post, now = new Date()) {
  const time = now.getTime();
  const after = (date) => Boolean(date) && new Date(date).getTime() > time;
  if (after(post?.syncLockedUntil)) return true;
  const recent =
    new Date(post?.scheduledFor || 0).getTime() > time - STUCK_TARGET_MS;
  return (post?.targets || []).some(
    (target) =>
      after(target.lockedUntil) ||
      after(target.urlCheckUntil) ||
      (recent &&
        (target.status === "pending" || target.status === "publishing")),
  );
}

export const PURGE_REDACT = "redact";
export const PURGE_DELETE = "delete";

/**
 * Champs effacés de la fiche d'un post supprimé : texte, réglages choisis
 * (confidentialité TikTok, formats, sons), auteur, copies des noms des
 * comptes, message d'erreur du réseau et état intermédiaire. Restent les
 * dates, le statut, les réseaux, les identifiants des comptes et les
 * identifiants et adresses des publications (limite mensuelle X).
 */
export const redactedPostFields = () => ({
  content: "",
  tiktokSettings: null,
  instagramSettings: null,
  facebookSettings: null,
  createdBy: null,
  updatedBy: null,
  "targets.$[].username": null,
  "targets.$[].displayName": null,
  "targets.$[].errorMessage": null,
  "targets.$[].processingRef": null,
});

/** Autre post qui utilise encore ce média (médias pas encore supprimés). */
const usedElsewhere = (post, item) => {
  const refs = [
    item.mediaId ? { "media.mediaId": item.mediaId } : null,
    item.url ? { "media.url": item.url } : null,
  ].filter(Boolean);
  if (refs.length === 0) return false;
  return SocialPost.exists({
    _id: { $ne: post._id },
    workspaceId: post.workspaceId,
    $or: refs,
  });
};

/**
 * Supprime les médias d'un post supprimé (bail, puis fichiers et
 * documents), efface ou supprime sa fiche selon purgeAction, ou repousse
 * le tout pendant une publication en cours.
 * @returns {Promise<"purged"|"deferred"|"failed"|"busy">}
 */
export async function purgePostMedia(postId, { now = new Date() } = {}) {
  const post = await SocialPost.findOneAndUpdate(
    { _id: postId, mediaPurgeAt: { $lte: now } },
    { $set: { mediaPurgeAt: new Date(now.getTime() + PURGE_LEASE_MS) } },
    { new: true, timestamps: false },
  ).lean();
  if (!post) return "busy";
  const retryAt = (delay) =>
    SocialPost.updateOne(
      { _id: post._id },
      { $set: { mediaPurgeAt: new Date(now.getTime() + delay) } },
      { timestamps: false },
    );

  if (isPostPublishing(post, now)) {
    await retryAt(IN_FLIGHT_RETRY_MS);
    return "deferred";
  }
  const action = post.purgeAction;
  try {
    // Texte et copies effacés tout de suite, sans attendre le stockage
    if (
      (action === PURGE_REDACT || action === PURGE_DELETE) &&
      !post.redactedAt
    ) {
      await SocialPost.updateOne(
        { _id: post._id },
        { $set: { ...redactedPostFields(), redactedAt: now } },
      );
    }
    let removed = 0;
    for (const item of post.media || []) {
      if (await usedElsewhere(post, item)) continue;
      const media = item.mediaId
        ? await SocialPostMedia.findOne({
            _id: item.mediaId,
            workspaceId: post.workspaceId,
          }).lean()
        : null;
      // Fichiers d'abord : un échec garde le document pour le nouvel essai
      await deleteObjects(mediaObjectKeys(media, item));
      if (media) await SocialPostMedia.deleteOne({ _id: media._id });
      removed += 1;
    }
    if (action === PURGE_DELETE) {
      // Espace supprimé : plus rien du post
      await SocialPost.deleteOne({ _id: post._id });
    } else {
      await SocialPost.updateOne(
        { _id: post._id },
        { $set: { media: [], mediaPurgeAt: null, mediaPurgedAt: now } },
      );
    }
    if (removed > 0) {
      logger.info(
        `[SocialMedia] Post ${post._id} supprimé : ${removed} média(s) effacé(s) du stockage`,
      );
    }
    return "purged";
  } catch (error) {
    logger.warn(
      `[SocialMedia] Médias du post ${post._id} non supprimés, nouvel essai dans une heure : ${error.message}`,
    );
    await retryAt(FAILURE_RETRY_MS);
    return "failed";
  }
}

/**
 * Un tour : médias des posts supprimés dont la date est venue.
 * @returns {Promise<{purged: number, deferred: number, failed: number}>}
 */
export async function purgeDeletedPostsMedia({
  now = new Date(),
  limit = POST_BATCH_SIZE,
} = {}) {
  const stats = { purged: 0, deferred: 0, failed: 0 };
  const posts = await SocialPost.find({ mediaPurgeAt: { $lte: now } })
    .select("_id")
    .sort({ mediaPurgeAt: 1 })
    .limit(limit)
    .lean();
  for (const { _id } of posts) {
    const outcome = await purgePostMedia(_id, { now }).catch((error) => {
      logger.error(`[SocialMedia] Nettoyage du post ${_id} en erreur:`, error);
      return "failed";
    });
    if (stats[outcome] !== undefined) stats[outcome] += 1;
  }
  return stats;
}

/**
 * Posts supprimés sans date de nettoyage (supprimés avant ce nettoyage, ou
 * par un autre chemin) : nettoyés au tour suivant.
 * @returns {Promise<number>}
 */
export async function scheduleForgottenPostsPurge({ now = new Date() } = {}) {
  const result = await SocialPost.updateMany(
    { taskDeletedAt: { $ne: null }, mediaPurgeAt: null, mediaPurgedAt: null },
    { $set: { mediaPurgeAt: now } },
    { timestamps: false },
  );
  return result.modifiedCount || 0;
}

/**
 * Médias jamais utilisés par un post, ou retirés d'un post modifié, depuis
 * 7 jours : fichiers puis document supprimés. Un média trouvé dans un post
 * est marqué (attachedAt) et laissé à la suppression de ce post.
 * @returns {Promise<{deleted: number, kept: number, failed: number}>}
 */
export async function purgeOrphanMedia({
  now = new Date(),
  limit = ORPHAN_BATCH_SIZE,
} = {}) {
  const cutoff = new Date(now.getTime() - ORPHAN_MEDIA_MS);
  const stats = { deleted: 0, kept: 0, failed: 0 };
  const candidates = await SocialPostMedia.find({
    attachedAt: null,
    // Envois et préparations en cours : jamais (abandonnés : « failed »)
    status: { $in: ["ready", "failed"] },
    $or: [
      { detachedAt: { $lte: cutoff } },
      { detachedAt: null, createdAt: { $lte: cutoff } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  for (const media of candidates) {
    const refs = [
      { "media.mediaId": media._id },
      media.url ? { "media.url": media.url } : null,
    ].filter(Boolean);
    if (
      await SocialPost.exists({ workspaceId: media.workspaceId, $or: refs })
    ) {
      await SocialPostMedia.updateOne(
        { _id: media._id, attachedAt: null },
        { $set: { attachedAt: now, detachedAt: null } },
        { timestamps: false },
      );
      stats.kept += 1;
      continue;
    }
    try {
      await deleteObjects(mediaObjectKeys(media));
      await SocialPostMedia.deleteOne({ _id: media._id, attachedAt: null });
      stats.deleted += 1;
    } catch (error) {
      // Document gardé : nouvel essai au tour suivant
      stats.failed += 1;
      logger.warn(
        `[SocialMedia] Média ${media._id} non supprimé du stockage : ${error.message}`,
      );
    }
  }
  return stats;
}

/**
 * Médias retirés d'un post modifié : supprimés après 7 jours s'ils ne
 * servent plus dans aucun post (purgeOrphanMedia vérifie). Au mieux.
 */
export async function markMediaDetached(workspaceId, mediaIds, now) {
  const ids = (mediaIds || []).filter(Boolean);
  if (ids.length === 0) return;
  await SocialPostMedia.updateMany(
    { _id: { $in: ids }, workspaceId },
    { $set: { attachedAt: null, detachedAt: now } },
    { timestamps: false },
  ).catch((error) =>
    logger.warn(
      `[SocialMedia] Médias retirés d'un post non marqués : ${error.message}`,
    ),
  );
}

/**
 * Espace supprimé (suppression du compte de son dernier membre, rgpd.js) :
 * comptes déconnectés (accès révoqués au mieux, jetons effacés, posts
 * programmés annulés) puis leurs fiches supprimées avec le profil Zernio
 * et les connexions en cours ; posts confiés au cron, qui supprime leurs
 * médias puis leurs fiches (après une publication en cours) ; médias
 * jamais utilisés supprimés au nettoyage horaire suivant. Au mieux : ne
 * lève jamais d'erreur.
 * @returns {Promise<{accounts: number, posts: number}>}
 */
export async function purgeWorkspaceSocialData(workspaceId, now = new Date()) {
  const summary = { accounts: 0, posts: 0 };
  try {
    const { disconnectAllAccounts } =
      await import("./socialPublishingService.js");
    summary.accounts = await disconnectAllAccounts(workspaceId, now);
    // Fiches des comptes (le cron n'en a pas besoin pour les médias)
    await SocialAccount.deleteMany({ workspaceId });
    await SocialProfile.deleteMany({ workspaceId });
    await SocialConnectState.deleteMany({ workspaceId });
    await SocialPost.updateMany(
      { workspaceId, taskDeletedAt: null },
      { $set: { taskDeletedAt: now } },
    );
    // Toutes les fiches de l'espace, même déjà nettoyées : supprimées par
    // le cron après leurs médias
    const marked = await SocialPost.updateMany(
      { workspaceId },
      { $set: { purgeAction: PURGE_DELETE, mediaPurgeAt: now } },
      { timestamps: false },
    );
    summary.posts = marked.modifiedCount || 0;
    // Médias de l'espace : sans post, supprimés au nettoyage horaire
    // suivant (sans attendre 7 jours) ; ceux d'un post partent avec lui
    await SocialPostMedia.updateMany(
      { workspaceId },
      { $set: { attachedAt: null, detachedAt: new Date(0) } },
      { timestamps: false },
    );
  } catch (error) {
    logger.warn(
      `[SocialMedia] Données réseaux sociaux de l'espace ${workspaceId} non nettoyées : ${error.message}`,
    );
  }
  return summary;
}
