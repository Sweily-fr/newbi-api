import express from "express";
import {
  cleanupExpiredFiles,
  markExpiredTransfers,
  deleteExpiredFiles,
} from "../jobs/cleanupExpiredFiles.js";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * Route admin pour déclencher manuellement le nettoyage des fichiers expirés
 * Accessible uniquement aux utilisateurs authentifiés
 */
router.post("/cleanup/run", async (req, res) => {
  try {
    logger.info("🚀 Déclenchement manuel du job de nettoyage");

    const result = await cleanupExpiredFiles();

    res.json({
      success: true,
      message: "Nettoyage exécuté avec succès",
      result: {
        transfersMarked: result.markedCount,
        filesDeleted: {
          local: result.deletedResult.localFiles,
          r2: result.deletedResult.r2Files,
          failed: result.deletedResult.failed,
          total: result.deletedResult.total,
        },
        spaceFreed: `${result.deletedResult.totalSizeMB} MB`,
      },
    });
  } catch (error) {
    logger.error("❌ Erreur lors du nettoyage manuel:", error);
    res.status(500).json({
      success: false,
      error: "Erreur lors du nettoyage",
      message: error.message,
    });
  }
});

/**
 * Route admin pour marquer les transferts expirés sans supprimer les fichiers
 */
router.post("/cleanup/mark-expired", async (req, res) => {
  try {
    logger.info("🏷️ Marquage des transferts expirés");

    const markedCount = await markExpiredTransfers();

    res.json({
      success: true,
      message: `${markedCount} transferts marqués comme expirés`,
      markedCount,
    });
  } catch (error) {
    logger.error("❌ Erreur lors du marquage:", error);
    res.status(500).json({
      success: false,
      error: "Erreur lors du marquage",
      message: error.message,
    });
  }
});

/**
 * Route admin pour supprimer uniquement les fichiers (sans marquer)
 */
router.post("/cleanup/delete-files", async (req, res) => {
  try {
    logger.info("🗑️ Suppression des fichiers expirés");

    const result = await deleteExpiredFiles();

    res.json({
      success: true,
      message: "Fichiers supprimés avec succès",
      result: {
        local: result.localFiles,
        r2: result.r2Files,
        failed: result.failed,
        total: result.total,
        spaceFreed: `${result.totalSizeMB} MB`,
      },
    });
  } catch (error) {
    logger.error("❌ Erreur lors de la suppression:", error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la suppression",
      message: error.message,
    });
  }
});

export default router;
