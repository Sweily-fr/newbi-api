// Aperçu d'un transfert « filigrane (lecture seule) » : l'aperçu servait le
// fichier original complet (téléchargeable depuis le navigateur), alors que
// l'option est présentée comme une protection (téléchargement bloqué).
// Les images et les PDF sont désormais servis avec un filigrane posé par
// l'API ; une image est aussi réduite (1920 px au plus).
import sharp from "sharp";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";

export const WATERMARK_TEXT = "APERÇU - NEWBI";
// Au-delà, un PDF n'est pas chargé en mémoire pour être filigrané
export const WATERMARK_PDF_MAX_BYTES = 50 * 1024 * 1024;

const RASTER_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/tiff",
  "image/gif",
  "image/avif",
]);

/** Image filigranable par sharp (hors HEIC, converti à part). */
export const isWatermarkableImage = (file) =>
  RASTER_TYPES.has(String(file?.mimeType || "").toLowerCase()) ||
  /\.(jpe?g|png|webp|tiff?|gif|avif)$/i.test(file?.originalName || "");

export const isPdfFile = (file) =>
  String(file?.mimeType || "").toLowerCase() === "application/pdf" ||
  /\.pdf$/i.test(file?.originalName || "");

const escapeXml = (text) =>
  String(text).replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );

// Texte répété en diagonale sur toute l'image
const overlaySvg = (width, height, text) => {
  const fontSize = Math.max(18, Math.round(Math.min(width, height) / 14));
  const stepX = fontSize * 10;
  const stepY = fontSize * 4;
  const lines = [];
  for (let y = -height; y < height * 2; y += stepY) {
    for (let x = -width; x < width * 2; x += stepX) {
      lines.push(
        `<text x="${x}" y="${y}" font-size="${fontSize}">${escapeXml(text)}</text>`,
      );
    }
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<g transform="rotate(-30 ${width / 2} ${height / 2})" fill="#ffffff" fill-opacity="0.45" stroke="#000000" stroke-opacity="0.35" stroke-width="1" font-family="DejaVu Sans, Arial, sans-serif" font-weight="bold">` +
      lines.join("") +
      `</g></svg>`,
  );
};

/**
 * Image (buffer) réduite à 1920 px au plus, filigranée, en JPEG.
 * @returns {Promise<Buffer>}
 */
export async function watermarkImage(input, text = WATERMARK_TEXT) {
  // Buffer, ou flux lu au fil de l'eau (grandes images)
  const isStream = input && typeof input.pipe === "function";
  const resizer = (
    isStream
      ? sharp({ limitInputPixels: false })
      : sharp(input, { limitInputPixels: false })
  )
    .rotate()
    .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" });
  if (isStream) input.pipe(resizer);
  const { data, info } = await resizer.toBuffer({ resolveWithObject: true });
  return sharp(data)
    .composite([{ input: overlaySvg(info.width, info.height, text) }])
    .jpeg({ quality: 80, progressive: true })
    .toBuffer();
}

/**
 * PDF filigrané sur chaque page.
 * @returns {Promise<Buffer>}
 */
export async function watermarkPdf(input, text = WATERMARK_TEXT) {
  const pdf = await PDFDocument.load(input, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  // Police standard : caractères WinAnsi seulement
  const safeText = text.replace(/[^\x20-\x7e\u00a0-\u00ff]/g, "");
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const size = Math.max(16, Math.round(Math.min(width, height) / 12));
    const textWidth = font.widthOfTextAtSize(safeText, size);
    for (let y = -height; y < height * 1.5; y += size * 5) {
      for (let x = -width; x < width * 1.5; x += textWidth + size * 2) {
        page.drawText(safeText, {
          x,
          y,
          size,
          font,
          color: rgb(0.5, 0.5, 0.5),
          opacity: 0.3,
          rotate: degrees(30),
        });
      }
    }
  }
  return Buffer.from(await pdf.save());
}
