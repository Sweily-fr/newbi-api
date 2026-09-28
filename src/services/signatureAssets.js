/**
 * Assets des signatures v2 : icônes générées à la demande sur R2 et images
 * utilisateur (photo, logo, bandeau) traitées côté serveur avec sharp.
 *
 * Les icônes sont immuables : (kind, name, style, couleur) → un fichier PNG,
 * généré une fois puis servi depuis R2 pour toujours. C'est ce qui permet
 * une couleur libre sans manipulation manuelle du bucket.
 */

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import cloudflareService from "./cloudflareService.js";
import logger from "../utils/logger.js";
import { ICONS_BUCKET, ICON_PNG_SIZE } from "./signatureRenderer/constants.js";
import { iconKey, iconSvg, iconUrl } from "./signatureRenderer/icons.js";

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
 * Traite une image envoyée par l'utilisateur.
 * @returns {{ buffer: Buffer, ext: string, contentType: string, width: number, height: number }}
 */
export async function processImage(buffer, kind, options = {}) {
  if (!OUTPUT[kind]) throw new Error(`Type d'image inconnu : ${kind}`);
  if (!buffer || buffer.length === 0) throw new Error("Fichier vide");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("Image trop volumineuse (10 Mo maximum)");
  }

  let image = sharp(buffer, { failOn: "none" }).rotate();
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error("Image illisible");

  image = await OUTPUT[kind](image, options);

  // La transparence est conservée (PNG) quand la source en a : c'est ce qui
  // permet aux clients mail en mode sombre d'adapter le logo. Sinon JPEG,
  // plus léger, et une photo opaque n'est jamais inversée.
  const keepAlpha = Boolean(meta.hasAlpha) && kind !== "PHOTO";
  const output = keepAlpha
    ? image.png({ compressionLevel: 9, palette: false })
    : image.jpeg({ quality: 86, mozjpeg: true });

  const { data, info } = await output.toBuffer({ resolveWithObject: true });
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
 * Traite puis envoie une image de signature sur R2. Supprime l'ancienne
 * image du même type (comportement de uploadSignatureImage).
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
  );
  return {
    url: result.url,
    key: result.key,
    width: processed.width,
    height: processed.height,
  };
}

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
