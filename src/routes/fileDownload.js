import express from "express";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import FileTransfer from "../models/FileTransfer.js";
import logger from "../utils/logger.js";

const router = express.Router();

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
    const fileTransfer = await FileTransfer.findById(transferId).populate(
      "files"
    );
    if (!fileTransfer) {
      return res.status(404).json({ error: "Transfert non trouvé" });
    }

    // Trouver le fichier spécifique
    const file = fileTransfer.files.find((f) => f._id.toString() === fileId);
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

    // Configurer les headers pour forcer le téléchargement
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(file.originalName)}"`
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

    // Vérifier si la prévisualisation est autorisée
    if (fileTransfer.allowPreview === false) {
      return res.status(403).json({ error: "Prévisualisation non autorisée" });
    }

    // Vérifier les permissions (paiement si requis)
    if (fileTransfer.isPaymentRequired && !fileTransfer.isPaid) {
      return res.status(402).json({ error: "Paiement requis" });
    }

    // Trouver le fichier spécifique
    const file = fileTransfer.files.find(
      (f) => f._id.toString() === fileId || f.fileId === fileId
    );
    if (!file) {
      return res.status(404).json({ error: "Fichier non trouvé" });
    }

    logger.info("👁️ Prévisualisation du fichier depuis R2", {
      fileName: file.originalName,
      r2Key: file.r2Key,
    });

    // Récupérer le fichier depuis R2
    const command = new GetObjectCommand({
      Bucket: process.env.TRANSFER_BUCKET,
      Key: file.r2Key,
    });

    const response = await s3Client.send(command);

    // Configurer les headers pour affichage inline (prévisualisation)
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(file.originalName)}"`
    );
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", file.size);
    res.setHeader("Cache-Control", "public, max-age=3600");

    // Streamer le fichier vers le client
    response.Body.pipe(res);

    logger.info("✅ Fichier prévisualisé avec succès", {
      fileName: file.originalName,
    });
  } catch (error) {
    logger.error("❌ Erreur prévisualisation:", error);
    res.status(500).json({ error: "Erreur lors de la prévisualisation" });
  }
});

export default router;
