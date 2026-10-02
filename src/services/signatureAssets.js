/**
 * Assets des signatures v2 : icônes générées à la demande sur R2 et images
 * utilisateur (photo, logo, bandeau) traitées côté serveur avec sharp.
 *
 * Les icônes sont immuables : (kind, name, style, couleur) → un fichier PNG,
 * généré une fois puis servi depuis R2 pour toujours. C'est ce qui permet
 * une couleur libre sans manipulation manuelle du bucket.
 */

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
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

async function objectExists(key) {
  try {
    await cloudflareService.client.send(
      new HeadObjectCommand({ Bucket: ICONS_BUCKET, Key: key }),
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

/** Limites de traitement des images utilisateur. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const OUTPUT = {
  // Photo : carré recadré sur le sujet, 2x pour les écrans retina.
  PHOTO: async (image, { size = 160 } = {}) =>
    image.resize(size * 2, size * 2, { fit: "cover", position: "attention" }),
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
export async function processImage(buffer, kind, options = {}) {
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

  image = await OUTPUT[kind](image, options);

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
  options,
}) {
  const processed = await processImage(buffer, kind, options);
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
  options,
  timeoutMs = 5000,
}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_IMAGE_BYTES) throw new Error("Image trop lourde");
  const buffer = Buffer.from(await response.arrayBuffer());
  return storeSignatureImage({ buffer, kind, userId, signatureId, options });
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
