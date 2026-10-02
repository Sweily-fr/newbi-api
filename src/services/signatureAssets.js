/**
 * Assets des signatures v2 : icônes générées à la demande sur R2 et images
 * utilisateur (photo, logo, bandeau) traitées côté serveur avec sharp.
 *
 * Les icônes sont immuables : (kind, name, style, couleur) → un fichier PNG,
 * généré une fois puis servi depuis R2 pour toujours. C'est ce qui permet
 * une couleur libre sans manipulation manuelle du bucket. Les photos
 * détourées (rondes pour Outlook bureau) suivent le même principe.
 */

import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import heicDecode from "heic-decode";
import sharp from "sharp";
import cloudflareService from "./cloudflareService.js";
import logger from "../utils/logger.js";
import { ICONS_BUCKET, ICON_PNG_SIZE } from "./signatureRenderer/constants.js";
import {
  iconKey,
  iconSvg,
  iconUrl,
  SAMPLE_PHOTO_KEY,
  samplePhotoSvg,
} from "./signatureRenderer/icons.js";

/** Clés dont l'existence sur R2 a déjà été vérifiée dans ce processus. */
const knownKeys = new Set();

async function objectExists(key, bucket = ICONS_BUCKET) {
  try {
    await cloudflareService.client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    return true;
  } catch (error) {
    if (
      error?.$metadata?.httpStatusCode === 404 ||
      error?.name === "NotFound"
    ) {
      return false;
    }
    throw error;
  }
}

export async function renderIconPng(spec, size = ICON_PNG_SIZE) {
  const svg = iconSvg(spec, size);
  if (!svg) return null;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * Garantit qu'une icône existe sur R2 et renvoie son URL publique.
 * Retourne l'URL même en cas d'échec réseau : le HTML reste valide et
 * l'icône sera générée à la prochaine demande.
 */
export async function ensureIcon(spec) {
  const key = iconKey(spec);
  const url = iconUrl(spec);
  if (knownKeys.has(key)) return url;

  try {
    if (await objectExists(key)) {
      knownKeys.add(key);
      return url;
    }
    const png = await renderIconPng(spec);
    if (!png) {
      logger.warn(`[signatureAssets] Icône inconnue ignorée : ${key}`);
      return url;
    }
    await cloudflareService.client.send(
      new PutObjectCommand({
        Bucket: ICONS_BUCKET,
        Key: key,
        Body: png,
        ContentType: "image/png",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
    knownKeys.add(key);
    logger.info(`[signatureAssets] Icône générée : ${key}`);
  } catch (error) {
    logger.error(
      `[signatureAssets] Impossible de garantir ${key} : ${error.message}`,
    );
  }
  return url;
}

/** Garantit la photo d'exemple des vignettes sur R2 (une fois par processus). */
let samplePhotoReady = false;
export async function ensureSamplePhoto() {
  if (samplePhotoReady) return;
  try {
    if (!(await objectExists(SAMPLE_PHOTO_KEY))) {
      const jpeg = await sharp(Buffer.from(samplePhotoSvg()))
        .jpeg({ quality: 88 })
        .toBuffer();
      await cloudflareService.client.send(
        new PutObjectCommand({
          Bucket: ICONS_BUCKET,
          Key: SAMPLE_PHOTO_KEY,
          Body: jpeg,
          ContentType: "image/jpeg",
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );
      logger.info(
        `[signatureAssets] Photo d'exemple générée : ${SAMPLE_PHOTO_KEY}`,
      );
    }
    samplePhotoReady = true;
  } catch (error) {
    logger.error(`[signatureAssets] Photo d'exemple : ${error.message}`);
  }
}

export async function ensureIcons(specs) {
  const unique = new Map(specs.map((s) => [iconKey(s), s]));
  await Promise.all([...unique.values()].map(ensureIcon));
}

// ── Photo détourée ────────────────────────────────────────────────────────
// Outlook bureau ignore border-radius, et Gmail retire au collage le VML qui
// arrondit la photo pour lui : une photo ronde y arrivait carrée. La photo
// est donc aussi servie déjà détourée (PNG à coins transparents, contour
// compris), sous une clé déterministe dans le dossier de la photo. Une
// variante n'est jamais supprimée : les e-mails déjà envoyés y renvoient.

/** Version du dessin : la changer régénère toutes les variantes. */
const ROUND_PHOTO_VERSION = "v1";
/** Variantes dont l'existence sur R2 est connue : clé → URL. */
const roundPhotos = new Map();
/** Générations en cours (une seule par variante) et échecs récents. */
const roundPending = new Map();
const roundFailed = new Map();
const ROUND_RETRY_MS = 10 * 60 * 1000;

/**
 * Clé et URL de la photo détourée pour un rendu donné (forme, taille,
 * contour), ou null si ce rendu n'en a pas besoin (photo carrée) ou si la
 * photo n'est pas une image de signature connue (sans clé, adresse
 * inattendue).
 */
function roundPhotoTarget(photo, { shape, size, border = 0, borderColor = "" }) {
  if (shape !== "circle" && shape !== "rounded") return null;
  const key = photo?.key;
  if (!key || !photo.url?.endsWith(`/${key}`)) return null;
  if (!(size > 0) || border < 0) return null;
  const color = border > 0 ? String(borderColor).toLowerCase() : "";
  if (border > 0 && !/^#[0-9a-f]{3,8}$/.test(color)) return null;
  const hash = createHash("sha1")
    .update([key, shape, size, border, color, ROUND_PHOTO_VERSION].join("|"))
    .digest("hex")
    .slice(0, 16);
  const target = `${key.slice(0, key.lastIndexOf("/") + 1)}round-${hash}.png`;
  return {
    key: target,
    url: `${photo.url.slice(0, photo.url.length - key.length)}${target}`,
  };
}

/**
 * Dessine la photo détourée en 2x : photo masquée (cercle, ou carré aux
 * coins arrondis à 15 % comme le CSS) et contour par-dessus, mesurés comme
 * une bordure CSS (taille + 2 x contour au total). PNG en palette : 15 à
 * 25 Ko, visuellement identique au PNG 24 bits.
 */
export async function renderRoundPhoto(source, { shape, size, border = 0, borderColor }) {
  const P = Math.round(size * 2);
  const B = Math.round(border * 2);
  const W = P + 2 * B;
  const outer = shape === "circle" ? W / 2 : Math.round(size * 0.15) * 2;
  const inner = Math.max(0, outer - B);
  // Sous le contour, la photo déborde d'un pixel : pas de liseré clair
  const bleed = B > 0 ? 1 : 0;
  const svg = (w, body) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${w}">${body}</svg>`,
    );
  const mask =
    shape === "circle"
      ? `<circle cx="${P / 2}" cy="${P / 2}" r="${P / 2 + bleed}" fill="#fff"/>`
      : `<rect x="${-bleed}" y="${-bleed}" width="${P + 2 * bleed}" height="${P + 2 * bleed}" rx="${inner + bleed}" fill="#fff"/>`;
  const face = await sharp(source, { failOn: "none" })
    .resize(P, P, { fit: "cover" })
    .ensureAlpha()
    .composite([{ input: svg(P, mask), blend: "dest-in" }])
    .png()
    .toBuffer();
  const layers = [{ input: face, left: B, top: B }];
  if (B > 0) {
    const ring =
      shape === "circle"
        ? `<circle cx="${W / 2}" cy="${W / 2}" r="${W / 2 - B / 2}" fill="none" stroke="${borderColor}" stroke-width="${B}"/>`
        : `<rect x="${B / 2}" y="${B / 2}" width="${W - B}" height="${W - B}" rx="${Math.max(0, outer - B / 2)}" fill="none" stroke="${borderColor}" stroke-width="${B}"/>`;
    layers.push({ input: svg(W, ring) });
  }
  return sharp({
    create: {
      width: W,
      height: W,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(layers)
    .png({ palette: true, quality: 90, compressionLevel: 9, effort: 10 })
    .toBuffer();
}

async function createRoundPhoto(photo, spec, target) {
  const Bucket = cloudflareService.signatureBucketName;
  try {
    if (!(await objectExists(target.key, Bucket))) {
      const source = await cloudflareService.client.send(
        new GetObjectCommand({ Bucket, Key: photo.key }),
        { abortSignal: AbortSignal.timeout(5000) },
      );
      const png = await renderRoundPhoto(
        Buffer.from(await source.Body.transformToByteArray()),
        spec,
      );
      await cloudflareService.client.send(
        new PutObjectCommand({
          Bucket,
          Key: target.key,
          Body: png,
          ContentType: "image/png",
          CacheControl: "public, max-age=31536000, immutable",
        }),
        { abortSignal: AbortSignal.timeout(10000) },
      );
      logger.info(`[signatureAssets] Photo détourée générée : ${target.key}`);
    }
    if (roundPhotos.size > 5000) roundPhotos.clear();
    roundPhotos.set(target.key, target.url);
    return target.url;
  } catch (error) {
    roundFailed.set(target.key, Date.now() + ROUND_RETRY_MS);
    logger.warn(
      `[signatureAssets] Photo détourée impossible (${target.key}) : ${error.message}`,
    );
    return null;
  }
}

/**
 * Garantit la photo détourée d'un rendu sur R2 et renvoie son URL, ou null
 * (photo carrée, échec) : le rendu garde alors l'arrondi CSS et le VML.
 * Ne lève jamais.
 */
export async function ensureRoundPhoto(photo, spec) {
  const target = roundPhotoTarget(photo, spec);
  if (!target) return null;
  if (roundPhotos.has(target.key)) return target.url;
  if ((roundFailed.get(target.key) || 0) > Date.now()) return null;
  if (!roundPending.has(target.key)) {
    roundPending.set(
      target.key,
      createRoundPhoto(photo, spec, target).finally(() =>
        roundPending.delete(target.key),
      ),
    );
  }
  return roundPending.get(target.key);
}

/**
 * URL de la photo détourée si elle existe déjà sur R2, sinon null : le HTML
 * copié ne renvoie jamais vers un fichier pas encore créé.
 */
export function roundPhotoUrl(photo, spec) {
  const target = roundPhotoTarget(photo, spec);
  return target && roundPhotos.has(target.key) ? target.url : null;
}

/** Limites de traitement des images utilisateur. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const OUTPUT = {
  // Photo : carré de 320 px recadré sur le sujet, 2x de la plus grande
  // taille réglable (160 px) : nette sur écran retina quelle que soit la
  // taille choisie ensuite. Une petite source est agrandie plutôt que
  // laissée non carrée (withoutEnlargement la déformerait à l'affichage).
  PHOTO: async (image) =>
    image.resize(320, 320, { fit: "cover", position: "attention" }),
  // Logo : contenu dans 600x300 (2x), jamais agrandi.
  LOGO: async (image) =>
    image.resize(600, 300, { fit: "inside", withoutEnlargement: true }),
  // Bandeau : largeur max 1200 (2x de 600), jamais agrandi.
  BANNER: async (image) =>
    image.resize(1200, undefined, { fit: "inside", withoutEnlargement: true }),
};

/**
 * Refus dû à l'image elle-même (format, taille, fichier abîmé) : son message
 * s'adresse à l'utilisateur, le détail technique reste dans `cause`.
 */
export class ImageInputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ImageInputError";
  }
}

const UNSUPPORTED_IMAGE =
  "Ce format d'image n'est pas pris en charge. Envoyez une image JPG, PNG ou WebP.";

/**
 * Une photo HEIC décodée à la fois par processus : le décodage occupe
 * jusqu'à ~270 Mo pour une photo de 24 Mpx.
 */
let heicQueue = Promise.resolve();
function decodeHeic(buffer) {
  const run = heicQueue.then(() => heicDecode({ buffer }));
  heicQueue = run.catch(() => {});
  return run;
}

/**
 * Photo HEIC (iPhone, AirDrop vers un Mac) : sharp ne lit que l'AVIF parmi
 * les HEIF. Décodée en pixels bruts (libheif applique la rotation), puis
 * traitée comme les autres images.
 */
async function openHeic(buffer) {
  let decoded;
  try {
    decoded = await decodeHeic(buffer);
  } catch (cause) {
    throw new ImageInputError(
      "Impossible de lire cette photo HEIC. Enregistrez-la en JPG ou en PNG, puis réessayez.",
      { cause },
    );
  }
  const { width, height, data } = decoded;
  return {
    image: sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels: 4 },
    }).removeAlpha(),
    meta: { width, height, hasAlpha: false },
  };
}

/**
 * Traite une image envoyée par l'utilisateur. Une image refusée lève une
 * ImageInputError, au message prêt à afficher.
 * @returns {{ buffer: Buffer, ext: string, contentType: string, width: number, height: number }}
 */
export async function processImage(buffer, kind) {
  if (!OUTPUT[kind]) throw new Error(`Type d'image inconnu : ${kind}`);
  if (!buffer || buffer.length === 0) throw new ImageInputError("Fichier vide");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new ImageInputError("Image trop volumineuse (10 Mo maximum)");
  }

  let image = sharp(buffer, { failOn: "none" });
  let meta;
  try {
    meta = await image.metadata();
  } catch (cause) {
    throw new ImageInputError(UNSUPPORTED_IMAGE, { cause });
  }
  if (meta.format === "heif" && meta.compression === "hevc") {
    ({ image, meta } = await openHeic(buffer));
  } else {
    image = image.rotate();
  }
  if (!meta.width || !meta.height) throw new ImageInputError("Image illisible");

  image = await OUTPUT[kind](image);

  // La transparence est conservée (PNG) quand la source en a : le logo
  // n'a pas de cadre blanc en mode sombre (un logo très foncé y devient en
  // revanche peu lisible). Sinon JPEG, plus léger, et une photo opaque
  // n'est jamais inversée.
  const keepAlpha = Boolean(meta.hasAlpha) && kind !== "PHOTO";
  const output = keepAlpha
    ? image.png({ compressionLevel: 9, palette: false })
    : image.jpeg({ quality: 86, mozjpeg: true });

  // Les métadonnées passent, le décodage peut encore échouer (format lu
  // à moitié, fichier tronqué)
  let data;
  let info;
  try {
    ({ data, info } = await output.toBuffer({ resolveWithObject: true }));
  } catch (cause) {
    throw new ImageInputError(UNSUPPORTED_IMAGE, { cause });
  }
  return {
    buffer: data,
    ext: keepAlpha ? "png" : "jpg",
    contentType: keepAlpha ? "image/png" : "image/jpeg",
    width: info.width,
    height: info.height,
  };
}

const R2_IMAGE_TYPE = {
  PHOTO: "imgProfil",
  LOGO: "logoReseau",
  BANNER: "banner",
};

/**
 * Traite puis envoie une image de signature sur R2. L'ancienne image du même
 * type est gardée : son URL figure dans la signature déjà installée et dans
 * les e-mails déjà envoyés, qui la perdraient sinon. Les fichiers partent
 * avec le compte.
 */
export async function storeSignatureImage({
  buffer,
  kind,
  userId,
  signatureId,
}) {
  const processed = await processImage(buffer, kind);
  const fileName = `${kind.toLowerCase()}-${Date.now()}.${processed.ext}`;
  const result = await cloudflareService.uploadSignatureImage(
    processed.buffer,
    fileName,
    String(userId),
    String(signatureId),
    R2_IMAGE_TYPE[kind],
    { keepPrevious: true },
  );
  return {
    url: result.url,
    key: result.key,
    width: processed.width,
    height: processed.height,
  };
}

/**
 * Importe une image distante (photo de profil de l'utilisateur) et la traite
 * comme un envoi. Délai court : la création d'une signature ne doit pas
 * attendre un hébergeur lent.
 */
export async function importSignatureImage({
  url,
  kind,
  userId,
  signatureId,
  timeoutMs = 5000,
}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_IMAGE_BYTES) throw new Error("Image trop lourde");
  const buffer = Buffer.from(await response.arrayBuffer());
  return storeSignatureImage({ buffer, kind, userId, signatureId });
}

/**
 * Supprime les images d'une signature. Réservé à la suppression du compte :
 * supprimer une signature ou en retirer une image garde les fichiers, que
 * les e-mails déjà envoyés affichent encore.
 */
export async function deleteSignatureImages(userId, signatureId) {
  for (const type of Object.values(R2_IMAGE_TYPE)) {
    try {
      await cloudflareService.deleteSignatureFolder(
        String(userId),
        String(signatureId),
        type,
      );
    } catch (error) {
      logger.warn(
        `[signatureAssets] Nettoyage ${type} ignoré : ${error.message}`,
      );
    }
  }
}
