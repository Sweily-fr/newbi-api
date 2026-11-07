/**
 * Envoi d'un fichier des documents partagés depuis R2 (aperçu et
 * téléchargement), commun aux routes des membres et à celles des liens
 * clients. L'appelant a déjà contrôlé l'accès au document.
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import convert from "heic-convert";
import sharp from "sharp";
import {
  contentDisposition,
  filePreviewHeaders,
  SHARED_PREVIEW_EXTRA_TYPES,
} from "../utils/fileSignature.js";

// Cache mémoire pour les previews HEIC convertis (LRU simple, max 50 entrées, TTL 30 min)
const previewCache = new Map();
const CACHE_MAX = 50;
const CACHE_TTL = 30 * 60 * 1000;

function getCachedPreview(key) {
  const entry = previewCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    previewCache.delete(key);
    return null;
  }
  return entry.buffer;
}

function setCachedPreview(key, buffer) {
  if (previewCache.size >= CACHE_MAX) {
    // Supprimer la plus ancienne entrée
    const oldest = previewCache.keys().next().value;
    previewCache.delete(oldest);
  }
  previewCache.set(key, { buffer, ts: Date.now() });
}

// Configuration R2
const s3Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_API_URL,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const fetchFromR2 = (document) =>
  s3Client.send(
    new GetObjectCommand({
      Bucket: process.env.SHARED_DOCUMENTS_BUCKET || "shared-documents-staging",
      Key: document.fileKey,
    }),
  );

/**
 * @param {object} document - SharedDocument
 * @param {object} res - réponse Express
 * @param {object} [options]
 * @param {string} [options.cacheControl]
 */
export async function streamDocumentDownload(
  document,
  res,
  { cacheControl = "no-cache" } = {},
) {
  const response = await fetchFromR2(document);

  res.setHeader(
    "Content-Disposition",
    contentDisposition("attachment", document.originalName || document.name),
  );
  res.setHeader(
    "Content-Type",
    document.mimeType || "application/octet-stream",
  );
  if (document.fileSize) {
    res.setHeader("Content-Length", document.fileSize);
  }
  res.setHeader("Cache-Control", cacheControl);

  response.Body.pipe(res);
}

/**
 * @param {object} document - SharedDocument
 * @param {object} res - réponse Express
 * @param {object} [options]
 * @param {string} [options.cacheControl]
 */
export async function streamDocumentPreview(
  document,
  res,
  { cacheControl = "public, max-age=3600" } = {},
) {
  const response = await fetchFromR2(document);

  const isHeic =
    ["image/heic", "image/heif"].includes(document.mimeType?.toLowerCase()) ||
    /\.(heic|heif)$/i.test(document.originalName || "");

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

  if (isHeic) {
    const cacheKey = `preview:${document._id}`;
    let jpegBuffer = getCachedPreview(cacheKey);

    if (!jpegBuffer) {
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const inputBuffer = Buffer.concat(chunks);

      // heic-convert pour décoder le HEIC, puis sharp pour resize/optimiser
      const rawJpeg = await convert({
        buffer: inputBuffer,
        format: "JPEG",
        quality: 0.85,
      });

      jpegBuffer = await sharp(rawJpeg)
        .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: true })
        .toBuffer();

      setCachedPreview(cacheKey, jpegBuffer);
    }

    const displayName = (document.originalName || document.name).replace(
      /\.(heic|heif)$/i,
      ".jpg",
    );

    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(displayName)}"`,
    );
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Length", jpegBuffer.length);
    res.setHeader("Cache-Control", cacheControl);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors 'self' ${frontendUrl}`,
    );
    res.removeHeader("X-Frame-Options");

    res.end(jpegBuffer);
    return;
  }

  const declaredType = document.originalName?.toLowerCase().endsWith(".pdf")
    ? "application/pdf"
    : document.mimeType;

  // Type annoncé à l'envoi : seuls les formats qui ne s'exécutent pas
  // (PDF, images matricielles, audio, vidéo, texte brut) sont servis en
  // ligne, sous ce type exact et sans détection par le navigateur. Le
  // reste (SVG, HTML, XML…) part en téléchargement.
  const headers = filePreviewHeaders({
    contentType: declaredType,
    filename: document.originalName || document.name,
    frameAncestors: `'self' ${frontendUrl}`,
    extraInlineTypes: SHARED_PREVIEW_EXTRA_TYPES,
  });
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  if (document.fileSize) {
    res.setHeader("Content-Length", document.fileSize);
  }
  res.setHeader("Cache-Control", cacheControl);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.removeHeader("X-Frame-Options");

  response.Body.pipe(res);
}
