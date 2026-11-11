import heicConvert from "heic-convert";
import sharp from "sharp";

/**
 * Images des posts programmés sur les réseaux sociaux.
 *
 * Chaque réseau a ses formats et son poids maximal (Facebook : 4 Mo, X :
 * 5 Mo, Instagram et LinkedIn : 8 Mo). Toute image est donc normalisée une
 * fois pour toutes : orientation EXIF appliquée, transparence aplatie sur du
 * blanc, plus grand côté ramené à 2 048 pixels, JPEG, et qualité réduite
 * jusqu'à passer sous 4 Mo. Les photos HEIC d'iPhone passent d'abord par
 * heic-convert, que sharp ne sait pas lire.
 */

export const SOCIAL_IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 2048;
const QUALITY_STEPS = [85, 78, 70, 62, 55];

export const UNSUPPORTED_IMAGE_MESSAGE =
  "Format d'image non pris en charge. Formats acceptés : JPEG, PNG, WebP et HEIC.";

/**
 * Type réel du fichier d'après ses premiers octets (le type annoncé par le
 * navigateur n'est pas une preuve).
 * @returns {"jpeg"|"png"|"webp"|"heic"|null}
 */
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }
  if (
    buffer[0] === 0x89 &&
    buffer.toString("ascii", 1, 4) === "PNG" &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a
  ) {
    return "png";
  }
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (buffer.toString("ascii", 4, 8) === "ftyp") {
    const brand = buffer.toString("ascii", 8, 12);
    if (
      ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(
        brand,
      )
    ) {
      return "heic";
    }
  }
  return null;
}

/**
 * Normalise une image envoyée pour un post.
 * @param {Buffer} buffer - octets reçus
 * @returns {Promise<{buffer: Buffer, width: number, height: number, contentType: string, size: number}>}
 * @throws {Error} code "UNSUPPORTED_IMAGE" | "IMAGE_TOO_LARGE" | "IMAGE_UNREADABLE"
 */
export async function normalizeSocialImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error(UNSUPPORTED_IMAGE_MESSAGE), {
      code: "UNSUPPORTED_IMAGE",
    });
  }
  if (buffer.length > SOCIAL_IMAGE_MAX_INPUT_BYTES) {
    throw Object.assign(new Error("Image trop lourde (20 Mo maximum)."), {
      code: "IMAGE_TOO_LARGE",
    });
  }
  const type = detectImageType(buffer);
  if (!type) {
    throw Object.assign(new Error(UNSUPPORTED_IMAGE_MESSAGE), {
      code: "UNSUPPORTED_IMAGE",
    });
  }

  try {
    const input =
      type === "heic"
        ? Buffer.from(await heicConvert({ buffer, format: "JPEG", quality: 1 }))
        : buffer;

    let result = null;
    for (const quality of QUALITY_STEPS) {
      result = await sharp(input, { failOn: "error" })
        .rotate()
        .resize(MAX_SIDE, MAX_SIDE, { fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      if (result.data.length <= MAX_OUTPUT_BYTES) break;
    }
    if (!result || result.data.length > MAX_OUTPUT_BYTES) {
      throw Object.assign(new Error("Image trop lourde après compression."), {
        code: "IMAGE_TOO_LARGE",
      });
    }
    return {
      buffer: result.data,
      width: result.info.width,
      height: result.info.height,
      contentType: "image/jpeg",
      size: result.data.length,
    };
  } catch (error) {
    if (error?.code === "IMAGE_TOO_LARGE") throw error;
    throw Object.assign(new Error("Image illisible ou endommagée."), {
      code: "IMAGE_UNREADABLE",
      cause: error,
    });
  }
}
