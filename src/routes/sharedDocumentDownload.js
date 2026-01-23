/**
 * Routes pour le téléchargement des documents partagés
 * Permet de télécharger un dossier complet en ZIP
 */

import express from "express";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import {
  streamFolderAsZip,
  verifyFolderAccess,
  getDocumentsWithPaths,
} from "../services/sharedDocumentZipService.js";
import logger from "../utils/logger.js";

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
