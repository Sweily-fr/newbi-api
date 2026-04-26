import express from "express";
import mongoose from "mongoose";
import {
  cleanupExpiredFiles,
  markExpiredTransfersAndDeleteR2,
  deleteExpiredLocalFiles,
} from "../jobs/cleanupExpiredFiles.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * Middleware pour vérifier que l'utilisateur est un admin interne (Sweily/Newbi).
 * validateJWT (appliqué au mount dans server.js) set req.user = userId string.
 * TODO: Replace with proper admin role check from DB (e.g. User.isSystemAdmin flag)
 */
async function requireInternalAdmin(req, res, next) {
  try {
    const userId = req.user;
    if (!userId) {
      return res.status(401).json({ error: "Non authentifié" });
    }
    const User = mongoose.model("user");
    const user = await User.findById(userId).select("email").lean();
    if (
      !user?.email ||
      (!user.email.endsWith("@sweily.fr") && !user.email.endsWith("@newbi.fr"))
    ) {
      return res
        .status(403)
        .json({ error: "Accès réservé aux administrateurs internes" });
    }
    next();
  } catch (error) {
    logger.error("Erreur vérification admin:", error.message);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

/**
 * Route admin pour déclencher manuellement le nettoyage des fichiers expirés
 * Accessible uniquement aux administrateurs internes (email @sweily.fr ou @newbi.fr)
 */
router.post("/cleanup/run", requireInternalAdmin, async (req, res) => {
  try {
    logger.info("Déclenchement manuel du job de nettoyage");

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
    logger.error("Erreur lors du nettoyage manuel:", error);
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
router.post("/cleanup/mark-expired", requireInternalAdmin, async (req, res) => {
  try {
    logger.info("Marquage des transferts expirés");

    const result = await markExpiredTransfersAndDeleteR2();
    const markedCount = result.markedCount;

    res.json({
      success: true,
      message: `${markedCount} transferts marqués comme expirés`,
      markedCount,
    });
  } catch (error) {
    logger.error("Erreur lors du marquage:", error);
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
router.post("/cleanup/delete-files", requireInternalAdmin, async (req, res) => {
  try {
    logger.info("Suppression des fichiers expirés");

    const result = await deleteExpiredLocalFiles();

    res.json({
      success: true,
      message: "Fichiers supprimés avec succès",
      result: {
        deletedFiles: result.deletedFiles,
        failed: result.failedDeletions,
        spaceFreed: `${(result.freedBytes / 1024 / 1024).toFixed(2)} MB`,
      },
    });
  } catch (error) {
    logger.error("Erreur lors de la suppression:", error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la suppression",
      message: error.message,
    });
  }
});

export default router;
