/**
 * Routes pour le téléchargement des documents partagés
 * Permet de télécharger un dossier complet en ZIP
 */

import express from "express";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import convert from "heic-convert";
import sharp from "sharp";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import {
  streamFolderAsZip,
  streamSelectionAsZip,
  verifyFolderAccess,
  getDocumentsWithPaths,
  getSelectionInfo,
} from "../services/sharedDocumentZipService.js";
import SharedDocument from "../models/SharedDocument.js";
import logger from "../utils/logger.js";

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

const router = express.Router();

/**
 * GET /download-folder
 * Télécharge un dossier complet en ZIP
 * Query params: folderId, workspaceId
 */
router.get("/download-folder", async (req, res) => {
  try {
    // Authentification
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Non authentifié",
      });
    }

    const { folderId, workspaceId } = req.query;

    // Validation des paramètres
    if (!folderId || !workspaceId) {
      return res.status(400).json({
        success: false,
        message: "folderId et workspaceId sont requis",
      });
    }

    logger.info("📥 Demande téléchargement dossier ZIP", {
      folderId,
      workspaceId,
      userId: user._id,
    });

    // Vérifier l'accès au dossier
    const folder = await verifyFolderAccess(folderId, workspaceId);
    if (!folder) {
      return res.status(404).json({
        success: false,
        message: "Dossier non trouvé ou accès non autorisé",
      });
    }

    // Générer et streamer le ZIP
    await streamFolderAsZip(folderId, workspaceId, res);
  } catch (error) {
    logger.error("❌ Erreur téléchargement dossier ZIP:", error);

    // Si les headers n'ont pas encore été envoyés
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: error.message || "Erreur lors de la création du ZIP",
      });
    }
  }
});

/**
 * GET /folder-info
 * Récupère les informations d'un dossier (taille totale, nombre de fichiers)
 * Utile pour afficher une preview avant le téléchargement
 */
router.get("/folder-info", async (req, res) => {
  try {
    // Authentification
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Non authentifié",
      });
    }

    const { folderId, workspaceId } = req.query;

    // Validation des paramètres
    if (!folderId || !workspaceId) {
      return res.status(400).json({
        success: false,
        message: "folderId et workspaceId sont requis",
      });
    }

    // Vérifier l'accès au dossier
    const folder = await verifyFolderAccess(folderId, workspaceId);
    if (!folder) {
      return res.status(404).json({
        success: false,
        message: "Dossier non trouvé ou accès non autorisé",
      });
    }

    // Récupérer les informations
    const { totalSize, totalFiles, rootFolderName } = await getDocumentsWithPaths(
      folderId,
      workspaceId
    );

    return res.json({
      success: true,
      data: {
        folderName: rootFolderName,
        totalFiles,
        totalSize,
        totalSizeFormatted: formatFileSize(totalSize),
      },
    });
  } catch (error) {
    logger.error("❌ Erreur récupération info dossier:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erreur lors de la récupération des informations",
    });
  }
});

/**
 * POST /download-selection
 * Télécharge une sélection de dossiers et/ou documents en ZIP
 * Body: { folderIds, documentIds, excludedFolderIds, workspaceId }
 */
router.post("/download-selection", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Non authentifié",
      });
    }

    const { folderIds = [], documentIds = [], excludedFolderIds = [], workspaceId } = req.body;

    if (!workspaceId) {
      return res.status(400).json({
        success: false,
        message: "workspaceId est requis",
      });
    }

    if (folderIds.length === 0 && documentIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Au moins un dossier ou document doit être sélectionné",
      });
    }

    logger.info("📥 Demande téléchargement sélection ZIP", {
      folderIds,
      documentIds,
      excludedFolderIds,
      workspaceId,
      userId: user._id,
    });

    // Verify access to each folder
    for (const folderId of folderIds) {
      const folder = await verifyFolderAccess(folderId, workspaceId);
      if (!folder) {
        return res.status(404).json({
          success: false,
          message: `Dossier ${folderId} non trouvé ou accès non autorisé`,
        });
      }
    }

    // Verify access to each document
    if (documentIds.length > 0) {
      const docs = await SharedDocument.find({
        _id: { $in: documentIds },
        workspaceId,
      });
      if (docs.length !== documentIds.length) {
        return res.status(404).json({
          success: false,
          message: "Un ou plusieurs documents non trouvés ou accès non autorisé",
        });
      }
    }

    await streamSelectionAsZip({ folderIds, documentIds, excludedFolderIds, workspaceId }, res);
  } catch (error) {
    logger.error("❌ Erreur téléchargement sélection ZIP:", error);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: error.message || "Erreur lors de la création du ZIP",
      });
    }
  }
});

/**
 * POST /selection-info
 * Récupère les informations sur une sélection (sous-dossiers, taille, fichiers)
 * Body: { folderIds, documentIds, workspaceId }
 */
router.post("/selection-info", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Non authentifié",
      });
    }

    const { folderIds = [], documentIds = [], workspaceId } = req.body;

    if (!workspaceId) {
      return res.status(400).json({
        success: false,
        message: "workspaceId est requis",
      });
    }

    // Verify access
    for (const folderId of folderIds) {
      const folder = await verifyFolderAccess(folderId, workspaceId);
      if (!folder) {
        return res.status(404).json({
          success: false,
          message: `Dossier ${folderId} non trouvé ou accès non autorisé`,
        });
      }
    }

    const info = await getSelectionInfo({ folderIds, documentIds, workspaceId });

    return res.json({
      success: true,
      data: info,
    });
  } catch (error) {
    logger.error("❌ Erreur récupération info sélection:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Erreur lors de la récupération des informations",
    });
  }
});

/**
 * GET /download-file/:documentId
 * Télécharge un fichier individuel depuis R2
 * Query params: workspaceId
 */
router.get("/download-file/:documentId", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Non authentifié",
      });
    }

    const { documentId } = req.params;
    const { workspaceId } = req.query;

    if (!documentId || !workspaceId) {
      return res.status(400).json({
        success: false,
        message: "documentId et workspaceId sont requis",
      });
    }

    const document = await SharedDocument.findOne({
      _id: documentId,
      workspaceId,
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Document non trouvé ou accès non autorisé",
      });
    }

    logger.info("📥 Téléchargement fichier partagé depuis R2", {
      fileName: document.originalName,
      fileKey: document.fileKey,
    });

    const command = new GetObjectCommand({
      Bucket: process.env.SHARED_DOCUMENTS_BUCKET || "shared-documents-staging",
      Key: document.fileKey,
    });

    const response = await s3Client.send(command);

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(document.originalName || document.name)}"`
    );
    res.setHeader("Content-Type", document.mimeType || "application/octet-stream");
    if (document.fileSize) {
      res.setHeader("Content-Length", document.fileSize);
    }
    res.setHeader("Cache-Control", "no-cache");

    response.Body.pipe(res);

    logger.info("✅ Fichier partagé téléchargé", {
      fileName: document.originalName,
      size: document.fileSize,
    });
  } catch (error) {
    logger.error("❌ Erreur téléchargement fichier partagé:", error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Erreur lors du téléchargement",
      });
    }
  }
});

/**
 * GET /preview-file/:documentId
 * Prévisualise un fichier individuel (inline) depuis R2
 * Query params: workspaceId, token (optionnel, pour les src d'img/video/iframe)
 */
router.get("/preview-file/:documentId", async (req, res) => {
  try {
    // Accepter le token depuis le query param pour les src d'éléments HTML
    if (req.query.token && !req.headers.authorization) {
      req.headers.authorization = `Bearer ${req.query.token}`;
    }

    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Non authentifié",
      });
    }

    const { documentId } = req.params;
    const { workspaceId } = req.query;

    if (!documentId || !workspaceId) {
      return res.status(400).json({
        success: false,
        message: "documentId et workspaceId sont requis",
      });
    }

    const document = await SharedDocument.findOne({
      _id: documentId,
      workspaceId,
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Document non trouvé ou accès non autorisé",
      });
    }

    logger.info("👁️ Prévisualisation fichier partagé depuis R2", {
      fileName: document.originalName,
      fileKey: document.fileKey,
    });

    const command = new GetObjectCommand({
      Bucket: process.env.SHARED_DOCUMENTS_BUCKET || "shared-documents-staging",
      Key: document.fileKey,
    });

    const response = await s3Client.send(command);

    const isHeic = ["image/heic", "image/heif"].includes(
      document.mimeType?.toLowerCase()
    ) || /\.(heic|heif)$/i.test(document.originalName || "");

    if (isHeic) {
      const cacheKey = `preview:${documentId}`;
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

      const displayName = (document.originalName || document.name)
        .replace(/\.(heic|heif)$/i, ".jpg");

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(displayName)}"`);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Content-Length", jpegBuffer.length);
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", `frame-ancestors 'self' ${frontendUrl}`);
      res.removeHeader("X-Frame-Options");

      res.end(jpegBuffer);
    } else {
      const contentType = document.originalName?.toLowerCase().endsWith(".pdf")
        ? "application/pdf"
        : document.mimeType || "application/octet-stream";

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(document.originalName || document.name)}"`
      );
      res.setHeader("Content-Type", contentType);
      if (document.fileSize) {
        res.setHeader("Content-Length", document.fileSize);
      }
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", `frame-ancestors 'self' ${frontendUrl}`);
      res.removeHeader("X-Frame-Options");

      response.Body.pipe(res);
    }

    logger.info("✅ Fichier partagé prévisualisé", {
      fileName: document.originalName,
    });
  } catch (error) {
    logger.error("❌ Erreur prévisualisation fichier partagé:", error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: "Erreur lors de la prévisualisation",
      });
    }
  }
});

/**
 * Formate une taille de fichier en format lisible
 */
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default router;
