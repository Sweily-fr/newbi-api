import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import SocialPostMedia from "../../models/SocialPostMedia.js";
import logger from "../../utils/logger.js";
import storage from "./socialMediaStorage.js";
import { normalizeSocialImage } from "./socialPostImage.js";
import {
  VIDEO_MAX_DURATION_MS,
  VIDEO_MIN_DURATION_MS,
  VIDEO_TOO_LONG_MESSAGE,
  VIDEO_TOO_SHORT_MESSAGE,
  videoCoverOffsetMs,
} from "./socialPostRules.js";

/**
 * Préparation des vidéos de posts (ffprobe + ffmpeg) : chaque vidéo devient
 * un MP4 H.264 (yuv420p, AAC) accepté par les cinq réseaux, avec une
 * vignette JPEG.
 *
 * - Chemin rapide : vidéo déjà H.264 yuv420p (+ AAC ou sans son), 1920
 *   pixels au plus, 23 à 60 images/s, 25 Mb/s au plus, sans rotation :
 *   simple réécriture du conteneur (-c copy, +faststart).
 * - Sinon transcodage (libx264 veryfast crf 23, 6 Mb/s au plus, rotation
 *   appliquée, plus grand côté ramené à 1920, 24 à 60 images/s, AAC 128 kb/s
 *   48 kHz stéréo), deux fils, priorité abaissée, arrêt forcé après 15 min.
 *   Les vidéos HEVC d'iPhone passent par là (X et LinkedIn ne garantissent
 *   pas le HEVC).
 * - Métadonnées retirées (lieu de tournage des vidéos de téléphone).
 *
 * Bail de préparation (processingLockedUntil) : une seule instance prépare
 * une vidéo ; une préparation interrompue est reprise par le cron (instance
 * PM2 0), 2 essais au plus. Une instance prépare une vidéo à la fois.
 *
 * Binaires : ffmpeg-static et @ffprobe-installer/ffprobe (linux-x64 sur le
 * VPS, darwin-arm64 en local), ou FFMPEG_PATH / FFPROBE_PATH.
 */

const require = createRequire(import.meta.url);

export const MAX_PROCESSING_ATTEMPTS = 2;
// Au-delà du plus long transcodage (15 min) + téléchargement et dépôt
export const PROCESSING_LEASE_MS = 25 * 60 * 1000;
const RETRY_DELAY_MS = 60 * 1000;
const TRANSCODE_TIMEOUT_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 60 * 1000;
const THUMBNAIL_TIMEOUT_MS = 60 * 1000;
const UPLOAD_ABANDONED_MS = 24 * 60 * 60 * 1000;
const MAX_CONCURRENT = 1;

const MAX_SIDE = 1920;
const MIN_FPS = 24;
const MAX_FPS = 60;
const FAST_MIN_FPS = 23;
const FAST_MAX_BIT_RATE = 25 * 1000 * 1000;

export const VIDEO_UNREADABLE_MESSAGE = "Vidéo illisible ou endommagée.";
export const VIDEO_NO_IMAGE_MESSAGE =
  "Cette vidéo ne contient pas d'image lisible.";
export const VIDEO_TOO_SLOW_MESSAGE =
  "La préparation de la vidéo a pris trop de temps. Essayez une vidéo plus courte ou plus légère.";
export const VIDEO_TOOLS_MISSING_MESSAGE =
  "La préparation des vidéos est momentanément indisponible. Réessayez plus tard.";
export const VIDEO_PROCESSING_FAILED_MESSAGE =
  "La préparation de la vidéo a échoué. Ajoutez-la de nouveau.";
export const VIDEO_UPLOAD_ABANDONED_MESSAGE =
  "L'envoi de la vidéo n'a pas été terminé. Ajoutez-la de nouveau.";

/** Refus définitif (message français affiché tel quel), sans nouvel essai. */
export class VideoProcessingError extends Error {
  constructor(message, { cause = null } = {}) {
    super(message);
    this.name = "VideoProcessingError";
    this.cause = cause;
  }
}

// ── Binaires ───────────────────────────────────────────────────────────────

const existing = (file) => {
  try {
    return file && fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
};

/** Chemin de ffmpeg (FFMPEG_PATH, sinon ffmpeg-static), null si absent. */
export function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return existing(require("ffmpeg-static"));
  } catch {
    return null;
  }
}

/** Chemin de ffprobe (FFPROBE_PATH, sinon @ffprobe-installer), null si absent. */
export function ffprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  try {
    return existing(require("@ffprobe-installer/ffprobe").path);
  } catch {
    return null;
  }
}

/**
 * Lance un binaire et attend sa fin.
 * @returns {Promise<{stdout: string, stderr: string}>}
 * @throws {Error} code « TIMEOUT » (arrêt forcé), « EXIT » (code de sortie)
 *   ou « SIGNAL » (tué par le système)
 */
function runBinary(binary, args, { timeoutMs, lowPriority = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    if (lowPriority && child.pid) {
      try {
        os.setPriority(child.pid, 10);
      } catch {
        // Priorité non modifiable (droits) : la préparation continue
      }
    }
    const stdout = [];
    let stdoutSize = 0;
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      // Sortie JSON de ffprobe : bornée par prudence
      if (stdoutSize < 5 * 1024 * 1024) stdout.push(chunk);
      stdoutSize += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(error, { code: error.code || "SPAWN" }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(
          Object.assign(new Error(`${path.basename(binary)} arrêté (délai)`), {
            code: "TIMEOUT",
          }),
        );
      }
      if (code === 0) {
        return resolve({ stdout: Buffer.concat(stdout).toString(), stderr });
      }
      const error = new Error(
        `${path.basename(binary)} : ${signal ? `signal ${signal}` : `code ${code}`} ${stderr.slice(-500)}`,
      );
      error.code = signal ? "SIGNAL" : "EXIT";
      return reject(error);
    });
  });
}

/** Outils appelés par la préparation (remplaçables dans les tests). */
export const videoTools = {
  ffmpegPath,
  ffprobePath,
  async probe(file) {
    const binary = videoTools.ffprobePath();
    if (!binary) throw new VideoProcessingError(VIDEO_TOOLS_MISSING_MESSAGE);
    const { stdout } = await runBinary(
      binary,
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        file,
      ],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    return JSON.parse(stdout || "{}");
  },
  async ffmpeg(args, { timeoutMs = TRANSCODE_TIMEOUT_MS } = {}) {
    const binary = videoTools.ffmpegPath();
    if (!binary) throw new VideoProcessingError(VIDEO_TOOLS_MISSING_MESSAGE);
    return runBinary(binary, args, { timeoutMs, lowPriority: true });
  },
};

// ── Analyse ────────────────────────────────────────────────────────────────

const parseRatio = (value) => {
  const [num, den] = String(value || "")
    .split(/[/:]/)
    .map(Number);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (den === undefined) return num;
  return Number.isFinite(den) && den > 0 ? num / den : null;
};

const normalizeRotation = (value) => {
  const degrees = Math.round(Number(value) || 0);
  const normalized = ((degrees % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(normalized) ? normalized : 0;
};

/**
 * Sortie de ffprobe (-show_format -show_streams, JSON) → caractéristiques
 * utiles. Dimensions « affichées » : rapport des pixels et rotation
 * appliqués.
 * @returns {object|null} null s'il n'y a pas de piste vidéo
 */
export function analyzeProbe(data) {
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const video = streams.find(
    (stream) =>
      stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  if (!video || !video.width || !video.height) return null;
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const durationSec =
    Number(data?.format?.duration) || Number(video.duration) || 0;
  const rotationEntry = (video.side_data_list || []).find(
    (entry) => entry?.rotation !== undefined,
  );
  const rotation = normalizeRotation(
    rotationEntry ? rotationEntry.rotation : video.tags?.rotate,
  );
  const sar = parseRatio(video.sample_aspect_ratio) || 1;
  let displayWidth = Math.round(video.width * sar);
  let displayHeight = video.height;
  if (rotation === 90 || rotation === 270) {
    [displayWidth, displayHeight] = [displayHeight, displayWidth];
  }
  const fps =
    parseRatio(video.avg_frame_rate) || parseRatio(video.r_frame_rate) || 0;
  const size = Number(data?.format?.size) || 0;
  const bitRate =
    Number(data?.format?.bit_rate) ||
    Number(video.bit_rate) ||
    (durationSec > 0 && size ? Math.round((size * 8) / durationSec) : 0);
  return {
    durationMs: Math.round(durationSec * 1000),
    width: video.width,
    height: video.height,
    displayWidth,
    displayHeight,
    rotation,
    sar,
    fps,
    bitRate,
    videoCodec: String(video.codec_name || "").toLowerCase(),
    pixFmt: String(video.pix_fmt || "").toLowerCase(),
    hasAudio: Boolean(audio),
    audioCodec: audio ? String(audio.codec_name || "").toLowerCase() : null,
    audioSampleRate: audio ? Number(audio.sample_rate) || 0 : null,
    audioChannels: audio ? Number(audio.channels) || 0 : null,
  };
}

/** Vidéo déjà acceptable partout : réécriture du conteneur seulement. */
export function canRemux(info) {
  const audioOk =
    !info.hasAudio ||
    (info.audioCodec === "aac" &&
      info.audioSampleRate > 0 &&
      info.audioSampleRate <= 48000 &&
      info.audioChannels > 0 &&
      info.audioChannels <= 2);
  return (
    info.videoCodec === "h264" &&
    info.pixFmt === "yuv420p" &&
    audioOk &&
    info.rotation === 0 &&
    Math.abs(info.sar - 1) < 0.01 &&
    Math.max(info.displayWidth, info.displayHeight) <= MAX_SIDE &&
    info.fps >= FAST_MIN_FPS &&
    info.fps <= MAX_FPS &&
    info.bitRate > 0 &&
    info.bitRate <= FAST_MAX_BIT_RATE
  );
}

const even = (value) => Math.max(2, Math.floor(value / 2) * 2);

/** Dimensions de sortie : plus grand côté 1920 au plus, valeurs paires. */
export function targetDimensions(info) {
  const scale = Math.min(
    1,
    MAX_SIDE / Math.max(info.displayWidth, info.displayHeight),
  );
  return {
    width: even(Math.round(info.displayWidth * scale)),
    height: even(Math.round(info.displayHeight * scale)),
  };
}

/** Images/s de sortie ramenées dans [24, 60] (null : inchangées). */
export function targetFps(info) {
  if (!info.fps) return 30;
  if (info.fps > MAX_FPS) return MAX_FPS;
  if (info.fps < MIN_FPS) return MIN_FPS;
  return null;
}

const COMMON_INPUT = ["-hide_banner", "-nostdin", "-y"];
// Première piste vidéo et première piste son, sans sous-titres, données ni
// métadonnées (lieu de tournage)
const COMMON_MAPPING = [
  "-map",
  "0:v:0",
  "-map",
  "0:a:0?",
  "-map_metadata",
  "-1",
  "-sn",
  "-dn",
];

export function buildRemuxArgs(input, output) {
  return [
    ...COMMON_INPUT,
    "-i",
    input,
    ...COMMON_MAPPING,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ];
}

export function buildTranscodeArgs(input, output, info) {
  const { width, height } = targetDimensions(info);
  const fps = targetFps(info);
  const filters = [`scale=${width}:${height}`, "setsar=1"];
  if (fps) filters.push(`fps=${fps}`);
  const audio = info.hasAudio
    ? ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"]
    : ["-an"];
  return [
    ...COMMON_INPUT,
    "-i",
    input,
    ...COMMON_MAPPING,
    "-vf",
    filters.join(","),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-maxrate",
    "6M",
    "-bufsize",
    "12M",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    ...audio,
    "-movflags",
    "+faststart",
    "-threads",
    "2",
    "-max_muxing_queue_size",
    "1024",
    "-f",
    "mp4",
    output,
  ];
}

export function buildThumbnailArgs(input, output, offsetMs) {
  return [
    ...COMMON_INPUT,
    "-ss",
    (offsetMs / 1000).toFixed(3),
    "-i",
    input,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    output,
  ];
}

// ── Préparation d'un fichier ───────────────────────────────────────────────

/** Contrôles avant préparation (durée, piste vidéo), messages français. */
export function checkSourceVideo(info) {
  if (!info) throw new VideoProcessingError(VIDEO_NO_IMAGE_MESSAGE);
  if (!info.durationMs)
    throw new VideoProcessingError(VIDEO_UNREADABLE_MESSAGE);
  if (info.durationMs < VIDEO_MIN_DURATION_MS) {
    throw new VideoProcessingError(VIDEO_TOO_SHORT_MESSAGE);
  }
  if (info.durationMs > VIDEO_MAX_DURATION_MS) {
    throw new VideoProcessingError(VIDEO_TOO_LONG_MESSAGE);
  }
}

async function probeOrFail(file) {
  try {
    return await videoTools.probe(file);
  } catch (error) {
    if (error instanceof VideoProcessingError) throw error;
    if (error?.code === "EXIT" || error instanceof SyntaxError) {
      throw new VideoProcessingError(VIDEO_UNREADABLE_MESSAGE, {
        cause: error,
      });
    }
    throw error;
  }
}

/** Erreur de ffmpeg → refus définitif (vidéo en cause) ou erreur passagère. */
function ffmpegFailure(error) {
  if (error instanceof VideoProcessingError) return error;
  if (error?.code === "TIMEOUT") {
    return new VideoProcessingError(VIDEO_TOO_SLOW_MESSAGE, { cause: error });
  }
  if (error?.code === "EXIT") {
    return new VideoProcessingError(VIDEO_UNREADABLE_MESSAGE, {
      cause: error,
    });
  }
  // Tué par le système (mémoire…), binaire introuvable : nouvel essai
  return error;
}

/**
 * Prépare un fichier vidéo local : contrôles, MP4 H.264, vignette.
 * @returns {Promise<{output: string, thumbnail: string|null, width: number, height: number, durationMs: number, size: number, remuxed: boolean}>}
 * @throws {VideoProcessingError} refus définitif (message français)
 */
export async function prepareVideoFile(input, dir) {
  const info = analyzeProbe(await probeOrFail(input));
  checkSourceVideo(info);

  const output = path.join(dir, "output.mp4");
  let remuxed = false;
  if (canRemux(info)) {
    try {
      await videoTools.ffmpeg(buildRemuxArgs(input, output));
      remuxed = true;
    } catch (error) {
      logger.warn(
        `[SocialVideo] Réécriture du conteneur impossible, transcodage : ${error.message}`,
      );
    }
  }
  if (!remuxed) {
    try {
      await videoTools.ffmpeg(buildTranscodeArgs(input, output, info));
    } catch (error) {
      throw ffmpegFailure(error);
    }
  }

  const result = analyzeProbe(await probeOrFail(output));
  if (!result || result.videoCodec !== "h264" || !result.durationMs) {
    throw new VideoProcessingError(VIDEO_UNREADABLE_MESSAGE);
  }
  const { size } = await fs.promises.stat(output);

  // Vignette (aperçu, couverture) : à 1 s, ou à mi-durée d'une vidéo courte
  let thumbnail = path.join(dir, "thumbnail.jpg");
  const offsets = [videoCoverOffsetMs(result.durationMs), 0];
  let extracted = false;
  for (const offset of offsets) {
    try {
      await videoTools.ffmpeg(buildThumbnailArgs(output, thumbnail, offset), {
        timeoutMs: THUMBNAIL_TIMEOUT_MS,
      });
      if ((await fs.promises.stat(thumbnail)).size > 0) {
        extracted = true;
        break;
      }
    } catch (error) {
      logger.warn(`[SocialVideo] Vignette non extraite : ${error.message}`);
    }
  }
  if (!extracted) thumbnail = null;

  return {
    output,
    thumbnail,
    width: result.displayWidth,
    height: result.displayHeight,
    durationMs: result.durationMs,
    size,
    remuxed,
  };
}

// ── Préparation d'un média (bail, stockage) ────────────────────────────────

const due = (now) => ({
  $or: [
    { processingLockedUntil: null },
    { processingLockedUntil: { $lte: now } },
  ],
});

/** Écrit l'état d'une vidéo si le bail est toujours le nôtre. */
async function writeUnderLease(media, lockUntil, fields) {
  const result = await SocialPostMedia.updateOne(
    { _id: media._id, status: "processing", processingLockedUntil: lockUntil },
    { $set: fields },
  );
  if (result.matchedCount === 0) {
    logger.warn(
      `[SocialVideo] Bail perdu sur la vidéo ${media._id}, résultat ignoré`,
    );
  }
  return result.matchedCount > 0;
}

const deleteQuietly = (key) =>
  storage
    .deleteObject(key)
    .catch((error) =>
      logger.warn(
        `[SocialVideo] Fichier ${key} non supprimé : ${error.message}`,
      ),
    );

async function storeThumbnail(file, id, workspaceId) {
  if (!file) return null;
  try {
    const image = await normalizeSocialImage(await fs.promises.readFile(file));
    return await storage.storeImage({
      buffer: image.buffer,
      contentType: image.contentType,
      workspaceId,
      id,
    });
  } catch (error) {
    // Aperçu manquant : la vidéo reste publiable
    logger.warn(`[SocialVideo] Vignette non enregistrée : ${error.message}`);
    return null;
  }
}

/**
 * Prépare une vidéo envoyée (statut « processing ») : réservation par bail,
 * original téléchargé dans un fichier temporaire, préparation, dépôt du MP4
 * et de la vignette, original supprimé, média « ready ». Refus définitif :
 * « failed » avec un message français ; erreur passagère : nouvel essai par
 * le cron (2 essais au plus).
 * @returns {Promise<"ready"|"failed"|"retry"|"busy">}
 */
export async function processSocialVideo(mediaId, { now = new Date() } = {}) {
  const lockUntil = new Date(now.getTime() + PROCESSING_LEASE_MS);
  const media = await SocialPostMedia.findOneAndUpdate(
    {
      _id: mediaId,
      kind: "video",
      status: "processing",
      processingAttempts: { $lt: MAX_PROCESSING_ATTEMPTS },
      ...due(now),
    },
    {
      $set: { processingLockedUntil: lockUntil },
      $inc: { processingAttempts: 1 },
    },
    { new: true },
  ).lean();
  if (!media) return "busy";

  const startedAt = Date.now();
  let dir = null;
  try {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "newbi-video-"));
    const input = path.join(dir, "input");
    await storage.downloadToFile(media.upload?.key, input);
    const prepared = await prepareVideoFile(input, dir);

    const id = crypto.randomUUID();
    const stored = await storage.storeVideoFile({
      filePath: prepared.output,
      id,
      workspaceId: media.workspaceId,
    });
    const thumbnail = await storeThumbnail(
      prepared.thumbnail,
      id,
      media.workspaceId,
    );
    const written = await writeUnderLease(media, lockUntil, {
      status: "ready",
      url: stored.url,
      key: stored.key,
      thumbnailUrl: thumbnail?.url || null,
      thumbnailKey: thumbnail?.key || null,
      width: prepared.width,
      height: prepared.height,
      durationMs: prepared.durationMs,
      size: stored.size,
      contentType: "video/mp4",
      errorMessage: null,
      processingLockedUntil: null,
      processedAt: new Date(),
    });
    if (!written) {
      // Une autre instance a repris la vidéo : notre copie est en trop
      await deleteQuietly(stored.key);
      if (thumbnail) await deleteQuietly(thumbnail.key);
      return "busy";
    }
    await deleteQuietly(media.upload?.key);
    logger.info(
      `[SocialVideo] Vidéo ${media._id} prête (${prepared.remuxed ? "conteneur réécrit" : "transcodée"}, ${prepared.width}x${prepared.height}, ${Math.round(prepared.durationMs / 1000)} s, ${Math.round(stored.size / 1024 / 1024)} Mo) en ${Math.round((Date.now() - startedAt) / 1000)} s`,
    );
    return "ready";
  } catch (error) {
    const attempts = media.processingAttempts || 1;
    if (
      !(error instanceof VideoProcessingError) &&
      attempts < MAX_PROCESSING_ATTEMPTS
    ) {
      logger.warn(
        `[SocialVideo] Préparation de la vidéo ${media._id} interrompue (essai ${attempts}/${MAX_PROCESSING_ATTEMPTS}), nouvel essai par le cron : ${error.message}`,
      );
      await writeUnderLease(media, lockUntil, {
        processingLockedUntil: new Date(Date.now() + RETRY_DELAY_MS),
      });
      return "retry";
    }
    const message =
      error instanceof VideoProcessingError
        ? error.message
        : VIDEO_PROCESSING_FAILED_MESSAGE;
    if (error instanceof VideoProcessingError) {
      logger.info(
        `[SocialVideo] Vidéo ${media._id} refusée : ${message}${error.cause ? ` (${error.cause.message})` : ""}`,
      );
    } else {
      logger.error(
        `[SocialVideo] Préparation de la vidéo ${media._id} en échec:`,
        error,
      );
    }
    await writeUnderLease(media, lockUntil, {
      status: "failed",
      errorMessage: message,
      processingLockedUntil: null,
    });
    await deleteQuietly(media.upload?.key);
    return "failed";
  } finally {
    if (dir) {
      await fs.promises
        .rm(dir, { recursive: true, force: true })
        .catch(() => {});
    }
  }
}

// ── File d'attente de l'instance ───────────────────────────────────────────

const queue = [];
const queued = new Set();
let active = 0;

function drain() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift();
    active += 1;
    processSocialVideo(id)
      .catch((error) =>
        logger.error(`[SocialVideo] Vidéo ${id} non préparée:`, error),
      )
      .finally(() => {
        active -= 1;
        queued.delete(id);
        drain();
      });
  }
}

/**
 * Lance la préparation en arrière-plan (non attendue), une vidéo à la fois
 * par instance ; une vidéo déjà en attente ici n'est pas ajoutée deux fois.
 * @returns {boolean} true si la vidéo a été ajoutée à la file
 */
export function enqueueVideoProcessing(mediaId) {
  const id = String(mediaId);
  if (queued.has(id)) return false;
  queued.add(id);
  queue.push(id);
  drain();
  return true;
}

/**
 * Cron (instance 0, chaque minute) : vidéos aux essais épuisés passées en
 * échec, préparations interrompues reprises, envois abandonnés depuis
 * 24 h annulés.
 * @returns {Promise<{resumed: number, failed: number, abandoned: number}>}
 */
export async function maintainSocialVideos({
  now = new Date(),
  limit = 10,
} = {}) {
  const exhausted = await SocialPostMedia.updateMany(
    {
      kind: "video",
      status: "processing",
      processingAttempts: { $gte: MAX_PROCESSING_ATTEMPTS },
      ...due(now),
    },
    {
      $set: {
        status: "failed",
        errorMessage: VIDEO_PROCESSING_FAILED_MESSAGE,
        processingLockedUntil: null,
      },
    },
  );

  const pending = await SocialPostMedia.find({
    kind: "video",
    status: "processing",
    processingAttempts: { $lt: MAX_PROCESSING_ATTEMPTS },
    ...due(now),
  })
    .select("_id")
    .sort({ updatedAt: 1 })
    .limit(limit)
    .lean();
  let resumed = 0;
  for (const { _id } of pending) {
    if (enqueueVideoProcessing(_id)) resumed += 1;
  }

  const abandoned = await SocialPostMedia.find({
    kind: "video",
    status: "uploading",
    createdAt: { $lte: new Date(now.getTime() - UPLOAD_ABANDONED_MS) },
  })
    .limit(limit)
    .lean();
  for (const media of abandoned) {
    if (media.upload?.key && media.upload?.uploadId) {
      await storage
        .abortVideoUpload(media.upload)
        .catch((error) =>
          logger.warn(
            `[SocialVideo] Envoi ${media._id} non annulé dans le stockage : ${error.message}`,
          ),
        );
    }
    await SocialPostMedia.updateOne(
      { _id: media._id, status: "uploading" },
      {
        $set: {
          status: "failed",
          errorMessage: VIDEO_UPLOAD_ABANDONED_MESSAGE,
        },
      },
    );
  }
  return {
    resumed,
    failed: exhausted.modifiedCount || 0,
    abandoned: abandoned.length,
  };
}
