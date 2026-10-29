import crypto from "crypto";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
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

/** Identifiant d'une image servie par notre route (null sinon). */
export function ownMediaId(url) {
  if (typeof url !== "string") return null;
  const prefix = `${apiBase()}${MEDIA_ROUTE}`;
  if (!url.startsWith(prefix)) return null;
  const id = url.slice(prefix.length).replace(/\.jpg$/, "");
  return MEDIA_ID_PATTERN.test(id) ? id : null;
}

export const isOwnMediaUrl = (url) => Boolean(ownMediaId(url));

/**
 * Dépose une image (déjà normalisée en JPEG) et renvoie son adresse
 * publique (identifiant aléatoire, impossible à deviner).
 * @returns {Promise<{url: string, key: string}>}
 */
async function storeImage({ buffer, contentType = "image/jpeg", workspaceId }) {
  const id = crypto.randomUUID();
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
    if (
      error?.name === "NoSuchKey" ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw error;
  }
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
};

export default storage;
