import SocialPostMedia from "../../models/SocialPostMedia.js";
import logger from "../../utils/logger.js";
import { toObjectIdOrNull } from "../../utils/objectIdString.js";
import storage from "./socialMediaStorage.js";
import { notFoundError, userError } from "./socialPostMessages.js";
import {
  UNSUPPORTED_VIDEO_MESSAGE,
  VIDEO_DIRECT_ONLY_MESSAGE,
  VIDEO_MAX_INPUT_BYTES,
  VIDEO_TOO_LARGE_MESSAGE,
  isAcceptedVideoFile,
} from "./socialPostRules.js";
import { isAnyDirectNetworkReady } from "./socialProviders.js";
import { enqueueVideoProcessing } from "./socialVideoProcessing.js";

/**
 * Envoi d'une vidéo de post en morceaux (startSocialVideoUpload,
 * uploadSocialVideoChunk, completeSocialVideoUpload).
 *
 * Pourquoi des morceaux : la limite de 100 Mo de graphqlUploadMiddleware et
 * le délai des requêtes de Node sur les connexions lentes. Les instances
 * PM2 sont en cluster : chaque morceau peut arriver sur une instance
 * différente, d'où l'envoi multipart R2 (l'état est dans la base et chez
 * R2, jamais en mémoire). Morceaux de 8 Mo (R2 exige des parties de même
 * taille, sauf la dernière, d'au moins 5 Mo).
 */

export const VIDEO_CHUNK_SIZE = 8 * 1024 * 1024;

const VIDEO_NOT_FOUND_MESSAGE = "Vidéo introuvable. Ajoutez-la de nouveau.";
const VIDEO_UPLOAD_UNAVAILABLE_MESSAGE =
  "La vidéo n'a pas pu être enregistrée. Réessayez dans quelques instants.";

/** Média → GraphQL (SocialPostMedia). */
export const serializeMedia = (media) => {
  const kind = media.kind || "image";
  const status = media.status || "ready";
  return {
    id: String(media._id || media.mediaId),
    kind,
    status,
    errorMessage: status === "failed" ? media.errorMessage || null : null,
    // Vide tant qu'une vidéo n'est pas prête
    url: status === "ready" ? media.url || "" : "",
    thumbnailUrl: media.thumbnailUrl || null,
    width: media.width ?? null,
    height: media.height ?? null,
    durationMs: media.durationMs ?? null,
    size: media.size ?? null,
    contentType:
      media.contentType || (kind === "video" ? "video/mp4" : "image/jpeg"),
  };
};

/** Vidéo possible : notre stockage et au moins un réseau en direct. */
function assertVideoAvailable() {
  if (!storage.isConfigured() || !isAnyDirectNetworkReady()) {
    throw userError(VIDEO_DIRECT_ONLY_MESSAGE);
  }
}

async function loadVideo(workspaceId, mediaId) {
  const id = toObjectIdOrNull(String(mediaId || ""));
  const media = id
    ? await SocialPostMedia.findOne({ _id: id, workspaceId, kind: "video" })
    : null;
  if (!media) throw notFoundError(VIDEO_NOT_FOUND_MESSAGE);
  return media;
}

// Nom du fichier gardé pour le suivi seulement : caractères de contrôle
// retirés, 200 caractères au plus
const cleanFileName = (value) =>
  Array.from(String(value || ""))
    .filter((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127)
    .join("")
    .slice(-200) || null;

/**
 * Ouvre l'envoi d'une vidéo : type et poids contrôlés, média « uploading »
 * et envoi multipart R2.
 * @returns {Promise<{media: object, chunkSize: number, chunkCount: number}>}
 */
export async function startVideoUpload({
  workspaceId,
  userId,
  fileName,
  size,
  contentType,
}) {
  assertVideoAvailable();
  if (!isAcceptedVideoFile({ fileName, contentType })) {
    throw userError(UNSUPPORTED_VIDEO_MESSAGE);
  }
  const bytes = Number(size);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw userError(UNSUPPORTED_VIDEO_MESSAGE);
  }
  if (bytes > VIDEO_MAX_INPUT_BYTES) throw userError(VIDEO_TOO_LARGE_MESSAGE);

  const chunkCount = Math.ceil(bytes / VIDEO_CHUNK_SIZE);
  let upload;
  try {
    upload = await storage.createVideoUpload({ contentType, workspaceId });
  } catch (error) {
    logger.error("[SocialVideo] Envoi multipart non ouvert:", error);
    throw userError(VIDEO_UPLOAD_UNAVAILABLE_MESSAGE);
  }
  const media = await SocialPostMedia.create({
    workspaceId,
    createdBy: toObjectIdOrNull(String(userId || "")),
    provider: "newbi",
    kind: "video",
    status: "uploading",
    url: "",
    size: bytes,
    contentType: String(contentType || "").slice(0, 100) || null,
    upload: {
      key: upload.key,
      uploadId: upload.uploadId,
      fileName: cleanFileName(fileName),
      chunkSize: VIDEO_CHUNK_SIZE,
      chunkCount,
      etags: Array(chunkCount).fill(null),
    },
  });
  return {
    media: serializeMedia(media),
    chunkSize: VIDEO_CHUNK_SIZE,
    chunkCount,
  };
}

/** Taille attendue d'un morceau (le dernier peut être plus petit). */
export const expectedChunkSize = (size, chunkSize, index) =>
  Math.min(chunkSize, size - index * chunkSize);

async function readChunk(file, maxBytes) {
  const { createReadStream } = await file;
  const stream = createReadStream();
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) {
      stream.destroy();
      throw userError("Morceau de vidéo trop lourd. Réessayez.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Reçoit un morceau (index à partir de 0) et le dépose chez R2. Renvoyer
 * le même morceau le remplace (idempotent).
 */
export async function uploadVideoChunk({ workspaceId, mediaId, index, chunk }) {
  const media = await loadVideo(workspaceId, mediaId);
  if (media.status !== "uploading") {
    throw userError("Cette vidéo n'attend plus de morceau.");
  }
  const { chunkSize, chunkCount, key, uploadId } = media.upload || {};
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0 || position >= chunkCount) {
    throw userError("Morceau de vidéo invalide.");
  }
  const expected = expectedChunkSize(media.size, chunkSize, position);
  const body = await readChunk(chunk, chunkSize);
  if (body.length !== expected) {
    throw userError("Morceau de vidéo incomplet. Réessayez.");
  }
  let etag;
  try {
    etag = await storage.uploadVideoPart({
      key,
      uploadId,
      partNumber: position + 1,
      body,
    });
  } catch (error) {
    logger.warn(
      `[SocialVideo] Morceau ${position} de la vidéo ${media._id} non déposé : ${error.message}`,
    );
    throw userError(VIDEO_UPLOAD_UNAVAILABLE_MESSAGE);
  }
  const result = await SocialPostMedia.updateOne(
    { _id: media._id, status: "uploading" },
    { $set: { [`upload.etags.${position}`]: etag } },
  );
  if (result.matchedCount === 0) {
    throw userError("Cette vidéo n'attend plus de morceau.");
  }
  return true;
}

/**
 * Assemble les morceaux et lance la préparation (asynchrone, non
 * attendue) : renvoie le média « processing ». Déjà assemblée : renvoie son
 * état tel quel.
 */
export async function completeVideoUpload({ workspaceId, mediaId }) {
  const media = await loadVideo(workspaceId, mediaId);
  if (media.status !== "uploading") return serializeMedia(media);
  const { key, uploadId, chunkCount, etags = [] } = media.upload || {};
  const missing = Array.from({ length: chunkCount }, (_, i) => i).filter(
    (i) => !etags[i],
  );
  if (missing.length > 0) {
    throw userError("L'envoi de la vidéo est incomplet. Réessayez.");
  }
  try {
    await storage.completeVideoUpload({
      key,
      uploadId,
      etags: etags.slice(0, chunkCount),
    });
  } catch (error) {
    // Deux appels croisés : le premier a déjà assemblé la vidéo
    const fresh = await SocialPostMedia.findById(media._id).lean();
    if (fresh && fresh.status !== "uploading") return serializeMedia(fresh);
    logger.error(
      `[SocialVideo] Vidéo ${media._id} non assemblée dans le stockage:`,
      error,
    );
    throw userError(VIDEO_UPLOAD_UNAVAILABLE_MESSAGE);
  }
  const updated = await SocialPostMedia.findOneAndUpdate(
    { _id: media._id, status: "uploading" },
    {
      $set: {
        status: "processing",
        processingAttempts: 0,
        processingLockedUntil: null,
      },
    },
    { new: true },
  ).lean();
  const current = updated || (await SocialPostMedia.findById(media._id).lean());
  if (updated) enqueueVideoProcessing(updated._id);
  return serializeMedia(current);
}

/** Suivi d'un média de l'espace (préparation d'une vidéo), null si absent. */
export async function getPostMedia({ workspaceId, mediaId }) {
  const id = toObjectIdOrNull(String(mediaId || ""));
  const media = id
    ? await SocialPostMedia.findOne({ _id: id, workspaceId }).lean()
    : null;
  return media ? serializeMedia(media) : null;
}
