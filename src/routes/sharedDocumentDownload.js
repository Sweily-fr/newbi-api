/**
 * Routes pour le téléchargement des documents partagés
 * Permet de télécharger un dossier complet en ZIP
 */

import express from "express";
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
