import express from "express";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import convert from "heic-convert";
import sharp from "sharp";
import { readPsd, initializeCanvas } from "ag-psd";
import FileTransfer from "../models/FileTransfer.js";
import User from "../models/User.js";
import logger from "../utils/logger.js";
import { sendDownloadNotificationEmail } from "../utils/mailer.js";

const router = express.Router();

// ag-psd sans canvas : seule une factory ImageData est nécessaire pour
// extraire le composite aplati d'un PSD (données RGBA brutes)
initializeCanvas(
  () => {
    throw new Error("canvas non disponible côté serveur");
  },
  (width, height) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  }),
);

// Taille max d'un PSD pour tenter l'extraction du composite (mémoire)
const PSD_PREVIEW_MAX_BYTES = 450 * 1024 * 1024;

// Une seule conversion PSD à la fois pour borner la consommation mémoire
let psdConversionQueue = Promise.resolve();
const withPsdLock = (fn) => {
  const run = psdConversionQueue.then(fn, fn);
  psdConversionQueue = run.catch(() => {});
  return run;
};

// Cache mémoire pour les previews HEIC convertis (LRU simple, max 50 entrées, TTL 30 min)
const heicPreviewCache = new Map();
const HEIC_CACHE_MAX = 50;
const HEIC_CACHE_TTL = 30 * 60 * 1000;

function getCachedHeicPreview(key) {
  const entry = heicPreviewCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > HEIC_CACHE_TTL) {
    heicPreviewCache.delete(key);
    return null;
  }
  return entry.buffer;
}

function setCachedHeicPreview(key, buffer) {
  if (heicPreviewCache.size >= HEIC_CACHE_MAX) {
    const oldest = heicPreviewCache.keys().next().value;
    heicPreviewCache.delete(oldest);
  }
  heicPreviewCache.set(key, { buffer, ts: Date.now() });
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

// Route proxy pour télécharger les fichiers avec les bons headers
router.get("/download/:transferId/:fileId", async (req, res) => {
  try {
    const { transferId, fileId } = req.params;

    logger.info("📥 Demande de téléchargement proxy", { transferId, fileId });

    // Vérifier que le transfert existe et récupérer le fichier
    const fileTransfer =
      await FileTransfer.findById(transferId).populate("files");
    if (!fileTransfer) {
      return res.status(404).json({ error: "Transfert non trouvé" });
    }

    // Trouver le fichier spécifique (vérifie _id ou fileId)
    const file = fileTransfer.files.find(
      (f) => f._id.toString() === fileId || f.fileId === fileId,
    );
    if (!file) {
      return res.status(404).json({ error: "Fichier non trouvé" });
    }

    // Vérifier les permissions (paiement si requis)
    if (fileTransfer.isPaymentRequired && !fileTransfer.isPaid) {
      return res.status(402).json({ error: "Paiement requis" });
    }

    logger.info("📥 Téléchargement du fichier depuis R2", {
      fileName: file.originalName,
      r2Key: file.r2Key,
    });

    if (!file.r2Key) {
      return res
        .status(404)
        .json({ error: "Fichier non disponible (clé de stockage manquante)" });
    }

    // Récupérer le fichier depuis R2
    const command = new GetObjectCommand({
      Bucket: process.env.TRANSFER_BUCKET,
      Key: file.r2Key,
    });

    const response = await s3Client.send(command);

    // ✅ CORRECTION #1: Incrémenter le compteur de téléchargements
    // Cette ligne était manquante, causant le compteur toujours à 0
    await fileTransfer.incrementDownloadCount();
    logger.info("📊 Compteur de téléchargements incrémenté", {
      transferId,
      newCount: fileTransfer.downloadCount,
    });

    // ✅ Envoyer notification de téléchargement si activée
    if (fileTransfer.notifyOnDownload) {
      try {
        const owner = await User.findById(fileTransfer.userId);
        if (owner && owner.email) {
          const transferUrl = `${process.env.FRONTEND_URL}/dashboard/outils/transferts-fichiers`;
          await sendDownloadNotificationEmail(owner.email, {
            fileName: file.originalName,
            downloadDate: new Date(),
            filesCount: fileTransfer.files.length,
            shareLink: fileTransfer.shareLink,
            transferUrl,
          });
          logger.info("📧 Notification de téléchargement envoyée", {
            ownerEmail: owner.email,
            fileName: file.originalName,
          });
        }
      } catch (emailError) {
        logger.error(
          "❌ Erreur envoi notification téléchargement:",
          emailError,
        );
        // Ne pas bloquer le téléchargement si l'email échoue
      }
    }

    // Configurer les headers pour forcer le téléchargement
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(file.originalName)}"`,
    );
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", file.size);
    res.setHeader("Cache-Control", "no-cache");

    // Streamer le fichier vers le client
    response.Body.pipe(res);

    logger.info("✅ Fichier téléchargé avec succès", {
      fileName: file.originalName,
      size: file.size,
    });
  } catch (error) {
    logger.error("❌ Erreur téléchargement proxy:", error);
    res.status(500).json({ error: "Erreur lors du téléchargement" });
  }
});

// Route pour prévisualiser un fichier
router.get("/preview/:transferId/:fileId", async (req, res) => {
  try {
    const { transferId, fileId } = req.params;

    logger.info("👁️ Demande de prévisualisation", { transferId, fileId });

    // Vérifier que le transfert existe
    const fileTransfer = await FileTransfer.findById(transferId);
    if (!fileTransfer) {
      return res.status(404).json({ error: "Transfert non trouvé" });
    }

    // Trouver le fichier spécifique (avant les checks d'autorisation pour
    // pouvoir appliquer l'exception zip)
    const file = fileTransfer.files.find(
      (f) => f._id.toString() === fileId || f.fileId === fileId,
    );
    if (!file) {
      return res.status(404).json({ error: "Fichier non trouvé" });
    }

    // Exception: les fichiers zip sont toujours fetchables via cette route
    // car le client les parse avec JSZip pour prévisualiser leurs entrées.
    // La vérification allowPreview ne s'applique qu'aux types directement
    // affichables (image, pdf, etc).
    const isZipFile =
      file.mimeType === "application/zip" ||
      /\.zip$/i.test(file.originalName || "");

    // Vérifier si la prévisualisation est autorisée
    if (fileTransfer.allowPreview === false && !isZipFile) {
      return res.status(403).json({ error: "Prévisualisation non autorisée" });
    }

    // Vérifier les permissions (paiement si requis)
    if (fileTransfer.isPaymentRequired && !fileTransfer.isPaid) {
      return res.status(402).json({ error: "Paiement requis" });
    }

    logger.info("👁️ Prévisualisation du fichier depuis R2", {
      fileName: file.originalName,
      r2Key: file.r2Key,
    });

    if (!file.r2Key) {
      return res
        .status(404)
        .json({ error: "Fichier non disponible (clé de stockage manquante)" });
    }

    // Récupérer le fichier depuis R2
    const command = new GetObjectCommand({
      Bucket: process.env.TRANSFER_BUCKET,
      Key: file.r2Key,
    });

    const response = await s3Client.send(command);

    const isHeic =
      ["image/heic", "image/heif"].includes(file.mimeType?.toLowerCase()) ||
      /\.(heic|heif)$/i.test(file.originalName || "");

    // Grandes images raster : servir l'original (parfois plusieurs centaines
    // de Mo) rend la preview inutilisable, surtout sur mobile — on sert une
    // version redimensionnée et mise en cache
    const isLargeRasterImage =
      !isHeic &&
      (file.size || 0) > 3 * 1024 * 1024 &&
      (/\.(jpe?g|png|webp|tiff?)$/i.test(file.originalName || "") ||
        ["image/jpeg", "image/png", "image/webp", "image/tiff"].includes(
          file.mimeType?.toLowerCase(),
        ));

    // Fichiers Photoshop déclarés (les PSD renommés en .jpg sont détectés
    // plus loin via leurs octets magiques quand sharp échoue)
    const isPsdByName =
      !isHeic &&
      (/\.psd$/i.test(file.originalName || "") ||
        [
          "image/vnd.adobe.photoshop",
          "application/x-photoshop",
          "application/photoshop",
        ].includes(file.mimeType?.toLowerCase()));

    if (isHeic) {
      // Convertir HEIC → JPEG pour compatibilité navigateur
      const cacheKey = `${transferId}:${fileId}`;
      let jpegBuffer = getCachedHeicPreview(cacheKey);

      if (!jpegBuffer) {
        // Sharp nécessite le buffer complet pour décoder le HEIC
        const chunks = [];
        for await (const chunk of response.Body) {
          chunks.push(chunk);
        }
        const inputBuffer = Buffer.concat(chunks);

        const rawJpeg = await convert({
          buffer: inputBuffer,
          format: "JPEG",
          quality: 0.85,
        });

        jpegBuffer = await sharp(rawJpeg)
          .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 80, progressive: true })
          .toBuffer();

        setCachedHeicPreview(cacheKey, jpegBuffer);
        logger.info("🖼️ HEIC converti et mis en cache", {
          cacheKey,
          size: jpegBuffer.length,
        });
      } else {
        // Consommer le stream R2 puisqu'on utilise le cache
        response.Body.destroy();
        logger.info("🖼️ HEIC servi depuis le cache", { cacheKey });
      }

      const displayName = (file.originalName || "image").replace(
        /\.(heic|heif)$/i,
        ".jpg",
      );

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(displayName)}"`,
      );
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", jpegBuffer.length);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      // CRUCIAL: sans CORP cross-origin, les <img>/<object>/<iframe>
      // cross-origin sont bloques par le navigateur (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin)
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        `frame-ancestors 'self' ${frontendUrl}`,
      );
      res.removeHeader("X-Frame-Options");

      res.end(jpegBuffer);
    } else if (isLargeRasterImage || isPsdByName) {
      const cacheKey = `${transferId}:${fileId}`;
      let jpegBuffer = getCachedHeicPreview(cacheKey);

      if (!jpegBuffer) {
        try {
          // limitInputPixels: false → accepte les très grandes affiches ;
          // pour le JPEG, libvips réduit à la volée (shrink-on-load) sans
          // charger toute l'image décodée en mémoire
          const transformer = sharp({ limitInputPixels: false })
            .rotate()
            .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 80, progressive: true });

          response.Body.pipe(transformer);
          jpegBuffer = await transformer.toBuffer();
        } catch (sharpError) {
          // Fichier non décodable par sharp : peut-être un PSD (souvent
          // renommé en .jpg par les utilisateurs). On tente d'extraire le
          // composite aplati Photoshop.
          response.Body.destroy();

          if ((file.size || 0) > PSD_PREVIEW_MAX_BYTES) {
            logger.warn("🖼️ Preview impossible, fichier trop volumineux", {
              fileName: file.originalName,
              size: file.size,
            });
            return res
              .status(415)
              .json({ error: "Format d'image non prévisualisable" });
          }

          try {
            jpegBuffer = await withPsdLock(async () => {
              // Nouveau stream R2 : le premier a été consommé par sharp
              const retry = await s3Client.send(command);
              const chunks = [];
              for await (const chunk of retry.Body) {
                chunks.push(chunk);
              }
              const inputBuffer = Buffer.concat(chunks);

              if (inputBuffer.subarray(0, 4).toString("latin1") !== "8BPS") {
                throw new Error("ni image raster ni PSD");
              }

              const psd = readPsd(inputBuffer, {
                skipLayerImageData: true,
                skipThumbnail: true,
                useImageData: true,
              });
              if (!psd?.imageData?.data) {
                throw new Error(
                  "PSD sans composite aplati (enregistré sans compatibilité)",
                );
              }

              const { width, height, data } = psd.imageData;
              return sharp(
                Buffer.from(data.buffer, data.byteOffset, data.byteLength),
                {
                  raw: { width, height, channels: 4 },
                  limitInputPixels: false,
                },
              )
                .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
                .jpeg({ quality: 80, progressive: true })
                .toBuffer();
            });
            logger.info("🖼️ Composite PSD extrait pour la preview", {
              fileName: file.originalName,
              previewSize: jpegBuffer.length,
            });
          } catch (psdError) {
            logger.warn("🖼️ Preview impossible, format non décodable", {
              fileName: file.originalName,
              sharpError: sharpError.message,
              psdError: psdError.message,
            });
            return res
              .status(415)
              .json({ error: "Format d'image non prévisualisable" });
          }
        }

        setCachedHeicPreview(cacheKey, jpegBuffer);
        logger.info("🖼️ Grande image redimensionnée et mise en cache", {
          cacheKey,
          originalSize: file.size,
          previewSize: jpegBuffer.length,
        });
      } else {
        // Consommer le stream R2 puisqu'on utilise le cache
        response.Body.destroy();
        logger.info("🖼️ Preview servie depuis le cache", { cacheKey });
      }

      const displayName = (file.originalName || "image").replace(
        /\.[^.]+$/,
        ".jpg",
      );

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(displayName)}"`,
      );
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", jpegBuffer.length);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      // CRUCIAL: sans CORP cross-origin, les <img>/<object>/<iframe>
      // cross-origin sont bloques par le navigateur (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin)
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        `frame-ancestors 'self' ${frontendUrl}`,
      );
      res.removeHeader("X-Frame-Options");

      res.end(jpegBuffer);
    } else {
      // Configurer les headers pour affichage inline (prévisualisation)
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(file.originalName)}"`,
      );
      // Pour les PDF, forcer le bon Content-Type
      const contentType = file.originalName?.toLowerCase().endsWith(".pdf")
        ? "application/pdf"
        : file.mimeType || "application/octet-stream";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", file.size);
      res.setHeader("Cache-Control", "public, max-age=3600");
      // Headers CORS pour permettre l'affichage dans un iframe
      res.setHeader("Access-Control-Allow-Origin", "*");
      // CRUCIAL: sans CORP cross-origin, les <img>/<object>/<iframe>
      // cross-origin sont bloques par le navigateur (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin)
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        `frame-ancestors 'self' ${frontendUrl}`,
      );
      res.removeHeader("X-Frame-Options");

      // Streamer le fichier vers le client
      response.Body.pipe(res);
    }

    logger.info("✅ Fichier prévisualisé avec succès", {
      fileName: file.originalName,
    });
  } catch (error) {
    logger.error("❌ Erreur prévisualisation:", error);
    res.status(500).json({ error: "Erreur lors de la prévisualisation" });
  }
});

export default router;
