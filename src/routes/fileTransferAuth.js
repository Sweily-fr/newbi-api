import express from "express";
import rateLimit from "express-rate-limit";
import {
  authorizeDownload,
  markDownloadCompleted,
  getDownloadStats,
} from "../controllers/fileTransferAuthController.js";
import { verifyTransferPassword } from "../controllers/fileTransferController.js";

const router = express.Router();

// 🔐 Le mot de passe protège désormais réellement les fichiers (jeton exigé
// au téléchargement) : on borne les essais par adresse IP
const verifyPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Trop de tentatives. Réessayez dans quelques minutes.",
  },
});

// Route d'autorisation de téléchargement
router.post("/:transferId/authorize", authorizeDownload);

// Route pour marquer un téléchargement comme terminé
router.post("/download-event/:downloadEventId/complete", markDownloadCompleted);

// Route pour obtenir les statistiques de téléchargement
router.get("/:transferId/stats", getDownloadStats);

// Route pour vérifier le mot de passe d'un transfert
router.post("/verify-password", verifyPasswordLimiter, verifyTransferPassword);

export default router;
