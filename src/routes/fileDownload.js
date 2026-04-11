import express from "express";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import convert from "heic-convert";
import sharp from "sharp";
import FileTransfer from "../models/FileTransfer.js";
import User from "../models/User.js";
import logger from "../utils/logger.js";
import { sendDownloadNotificationEmail } from "../utils/mailer.js";

const router = express.Router();

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
