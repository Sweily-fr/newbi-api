import crypto from "crypto";
import fs from "fs";
import { pipeline } from "stream/promises";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

/**
 * Stockage des images de posts : bucket R2 SOCIAL_MEDIA_BUCKET (privé ou
 * non), servi par l'API elle-même sous
 * `${NEXT_PUBLIC_API_URL}/social-media/<id>.jpg` (routes/social-media.js).
 *
 * Pourquoi une route de l'API plutôt qu'une adresse r2.dev : TikTok
 * n'accepte que des images d'un domaine vérifié chez lui, sans
 * redirection. api.newbi.fr est couvert par la vérification DNS de
 * newbi.fr (chez OVH), alors qu'un domaine personnalisé R2 exigerait que le
 * DNS de newbi.fr passe chez Cloudflare. Instagram et Facebook vont aussi
 * chercher l'image à cette adresse ; LinkedIn et X reçoivent les octets
 * (relus directement dans R2).
 *
 * Vidéos : original envoyé en morceaux (envoi multipart R2 sous
 * social/uploads/<uuid>, les morceaux arrivent sur des instances PM2
 * différentes), préparé en MP4 sous social/<id>.mp4 (+ vignette
 * social/<id>.jpg), servi avec prise en charge des plages (Range) et relu
 * par plages pour LinkedIn et X (jamais tout en mémoire).
 */

const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
// Photos TikTok : 1080p au plus (petit côté 1080, grand côté 1920)
const TIKTOK_MAX_SHORT_SIDE = 1080;
const TIKTOK_MAX_LONG_SIDE = 1920;
export const MEDIA_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEDIA_ROUTE = "/social-media/";

let client = null;

const apiBase = () =>
  (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000")
    .trim()
    .replace(/\/+$/, "");

export const isSocialMediaStorageConfigured = () =>
  Boolean(
    process.env.SOCIAL_MEDIA_BUCKET &&
    process.env.R2_API_URL &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY,
  );

const r2 = () => {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: process.env.R2_API_URL,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
};

const keyOf = (id) => `social/${id}.jpg`;
export const videoKeyOf = (id) => `social/${id}.mp4`;
export const videoUrlOf = (id) => `${apiBase()}${MEDIA_ROUTE}${id}.mp4`;

/** Identifiant d'une image ou d'une vidéo servie par notre route (null sinon). */
export function ownMediaId(url) {
  if (typeof url !== "string") return null;
  const prefix = `${apiBase()}${MEDIA_ROUTE}`;
  if (!url.startsWith(prefix)) return null;
  const id = url.slice(prefix.length).replace(/\.(jpg|mp4)$/, "");
  return MEDIA_ID_PATTERN.test(id) ? id : null;
}

export const isOwnMediaUrl = (url) => Boolean(ownMediaId(url));

/** Identifiant d'une vidéo servie par notre route (null sinon). */
export const ownVideoId = (url) =>
  typeof url === "string" && url.endsWith(".mp4") ? ownMediaId(url) : null;

const isNotFound = (error) =>
  error?.name === "NoSuchKey" ||
  error?.name === "NotFound" ||
  error?.$metadata?.httpStatusCode === 404;

/**
 * Dépose une image (déjà normalisée en JPEG) et renvoie son adresse
 * publique (identifiant aléatoire, impossible à deviner ; celui de sa
 * vidéo pour une vignette).
 * @returns {Promise<{url: string, key: string}>}
 */
async function storeImage({
  buffer,
  contentType = "image/jpeg",
  workspaceId,
  id = crypto.randomUUID(),
}) {
  await r2().send(
    new PutObjectCommand({
      Bucket: process.env.SOCIAL_MEDIA_BUCKET,
      Key: keyOf(id),
      Body: buffer,
      ContentType: contentType,
      Metadata: { workspaceId: String(workspaceId || "") },
    }),
  );
  return { url: `${apiBase()}${MEDIA_ROUTE}${id}.jpg`, key: keyOf(id) };
}

/**
 * Lit une image du bucket (route publique et envoi à LinkedIn ou X).
 * @returns {Promise<{body: any, contentType: string, contentLength: number|null}|null>}
 *   null si l'image n'existe pas
 */
async function readImage(id) {
  if (!MEDIA_ID_PATTERN.test(String(id || ""))) return null;
  try {
    const result = await r2().send(
      new GetObjectCommand({
        Bucket: process.env.SOCIAL_MEDIA_BUCKET,
        Key: keyOf(id),
      }),
    );
    return {
      body: result.Body,
      contentType: result.ContentType || "image/jpeg",
      contentLength: result.ContentLength ?? null,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

// ── Vidéos : envoi en morceaux ─────────────────────────────────────────────

/**
 * Ouvre l'envoi multipart d'un original de vidéo.
 * @returns {Promise<{key: string, uploadId: string}>}
 */
async function createVideoUpload({ contentType, workspaceId }) {
  const key = `social/uploads/${crypto.randomUUID()}`;
  const result = await r2().send(
    new CreateMultipartUploadCommand({
      Bucket: process.env.SOCIAL_MEDIA_BUCKET,
      Key: key,
      ContentType: contentType || "application/octet-stream",
      Metadata: { workspaceId: String(workspaceId || "") },
    }),
  );
  if (!result?.UploadId) throw new Error("Envoi multipart sans identifiant");
  return { key, uploadId: result.UploadId };
}

/** Dépose un morceau (PartNumber à partir de 1) et renvoie son ETag. */
async function uploadVideoPart({ key, uploadId, partNumber, body }) {
  const result = await r2().send(
    new UploadPartCommand({
      Bucket: process.env.SOCIAL_MEDIA_BUCKET,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: body,
      ContentLength: body.length,
    }),
  );
  if (!result?.ETag) throw new Error("Morceau déposé sans ETag");
  return result.ETag;
}

/** Assemble les morceaux (ETag par index, dans l'ordre). */
async function completeVideoUpload({ key, uploadId, etags }) {
  await r2().send(
    new CompleteMultipartUploadCommand({
      Bucket: process.env.SOCIAL_MEDIA_BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: etags.map((etag, index) => ({
          ETag: etag,
          PartNumber: index + 1,
        })),
      },
    }),
  );
}

async function abortVideoUpload({ key, uploadId }) {
  await r2().send(
    new AbortMultipartUploadCommand({
      Bucket: process.env.SOCIAL_MEDIA_BUCKET,
      Key: key,
      UploadId: uploadId,
    }),
  );
}

// ── Vidéos : fichiers et lectures par plage ────────────────────────────────

/** Copie un objet du bucket dans un fichier local (en flux). */
async function downloadToFile(key, filePath) {
  const result = await r2().send(
    new GetObjectCommand({ Bucket: process.env.SOCIAL_MEDIA_BUCKET, Key: key }),
  );
  if (!result?.Body) throw new Error("Objet vide dans le stockage");
  await pipeline(result.Body, fs.createWriteStream(filePath));
}

/**
 * Dépose la vidéo préparée (MP4) depuis un fichier local, en flux.
 * @returns {Promise<{url: string, key: string, size: number}>}
 */
async function storeVideoFile({ filePath, id, workspaceId }) {
  const { size } = await fs.promises.stat(filePath);
  await r2().send(
    new PutObjectCommand({
      Bucket: process.env.SOCIAL_MEDIA_BUCKET,
      Key: videoKeyOf(id),
      Body: fs.createReadStream(filePath),
      ContentLength: size,
      ContentType: "video/mp4",
      Metadata: { workspaceId: String(workspaceId || "") },
    }),
  );
  return { url: videoUrlOf(id), key: videoKeyOf(id), size };
}

/** Supprime un objet (au mieux : absent, rien à faire). */
async function deleteObject(key) {
  if (!key) return;
  try {
    await r2().send(
      new DeleteObjectCommand({
        Bucket: process.env.SOCIAL_MEDIA_BUCKET,
        Key: key,
      }),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * Poids d'une vidéo du bucket (null si elle n'existe pas). Les vidéos ne
 * changent jamais : poids gardé en mémoire (route Range, lue par plages).
 */
const sizeCache = new Map();
const SIZE_CACHE_MAX = 500;
async function videoSize(id) {
  if (!MEDIA_ID_PATTERN.test(String(id || ""))) return null;
  if (sizeCache.has(id)) return sizeCache.get(id);
  try {
    const head = await r2().send(
      new HeadObjectCommand({
        Bucket: process.env.SOCIAL_MEDIA_BUCKET,
        Key: videoKeyOf(id),
      }),
    );
    const size = Number(head?.ContentLength);
    if (!Number.isFinite(size)) return null;
    if (sizeCache.size >= SIZE_CACHE_MAX) {
      sizeCache.delete(sizeCache.keys().next().value);
    }
    sizeCache.set(id, size);
    return size;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Lit une vidéo du bucket, en entier ou une plage d'octets (bornes
 * incluses), pour la route publique.
 * @returns {Promise<{body: any, contentLength: number|null}|null>}
 */
async function readVideo(id, { start = null, end = null } = {}) {
  if (!MEDIA_ID_PATTERN.test(String(id || ""))) return null;
  try {
    const result = await r2().send(
      new GetObjectCommand({
        Bucket: process.env.SOCIAL_MEDIA_BUCKET,
        Key: videoKeyOf(id),
        ...(start !== null ? { Range: `bytes=${start}-${end ?? ""}` } : {}),
      }),
    );
    return {
      body: result.Body,
      contentLength: result.ContentLength ?? null,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Octets d'une plage de notre vidéo (bornes incluses) : envoi par morceaux
 * à LinkedIn et X (quelques Mo à la fois).
 * @returns {Promise<Buffer>}
 */
async function readVideoRange(url, start, end) {
  const id = ownVideoId(url);
  if (!id) throw new Error("Adresse de vidéo invalide");
  const video = await storage.readVideo(id, { start, end });
  if (!video) throw new Error("Vidéo introuvable dans le stockage");
  const buffer = await streamToBuffer(video.body);
  if (buffer.length !== end - start + 1) {
    throw new Error("Lecture incomplète de la vidéo");
  }
  return buffer;
}

async function streamToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Octets d'une image de post (la nôtre lue dans R2, sinon téléchargée). */
async function fetchImage(url) {
  const id = ownMediaId(url);
  if (id) {
    const stored = await storage.readImage(id);
    if (!stored) throw new Error("Image introuvable dans le stockage");
    return {
      buffer: await streamToBuffer(stored.body),
      contentType: stored.contentType,
    };
  }
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) {
    throw new Error("Adresse d'image invalide");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Image illisible (HTTP ${response.status})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_BYTES)
      throw new Error("Image trop lourde");
    return {
      buffer,
      contentType: response.headers?.get?.("content-type") || "image/jpeg",
    };
  } finally {
    clearTimeout(timer);
  }
}

const fitsTikTok = (width, height) =>
  Boolean(width && height) &&
  Math.min(width, height) <= TIKTOK_MAX_SHORT_SIDE &&
  Math.max(width, height) <= TIKTOK_MAX_LONG_SIDE;

/**
 * Adresse d'une image acceptable par TikTok : la nôtre telle quelle si elle
 * est déjà en 1080p au plus, sinon une copie réduite déposée dans le bucket
 * (la normalisation des posts va jusqu'à 2 048 pixels).
 * @returns {Promise<string>}
 */
async function prepareTikTokImage(media, workspaceId) {
  if (isOwnMediaUrl(media.url) && fitsTikTok(media.width, media.height)) {
    return media.url;
  }
  const { buffer } = await storage.fetchImage(media.url);
  const meta = await sharp(buffer).metadata();
  const landscape = (meta.width || 0) >= (meta.height || 0);
  const resized = await sharp(buffer)
    .rotate()
    .resize(
      landscape ? TIKTOK_MAX_LONG_SIDE : TIKTOK_MAX_SHORT_SIDE,
      landscape ? TIKTOK_MAX_SHORT_SIDE : TIKTOK_MAX_LONG_SIDE,
      { fit: "inside", withoutEnlargement: true },
    )
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  const stored = await storage.storeImage({ buffer: resized, workspaceId });
  return stored.url;
}

// Objet appelé par les autres modules (remplaçable dans les tests)
const storage = {
  isConfigured: isSocialMediaStorageConfigured,
  isOwnMediaUrl,
  storeImage,
  readImage,
  fetchImage,
  prepareTikTokImage,
  createVideoUpload,
  uploadVideoPart,
  completeVideoUpload,
  abortVideoUpload,
  downloadToFile,
  storeVideoFile,
  deleteObject,
  videoSize,
  readVideo,
  readVideoRange,
};

export default storage;
