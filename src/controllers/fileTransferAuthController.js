import crypto from "crypto";
import FileTransfer from "../models/FileTransfer.js";
import DownloadEvent from "../models/DownloadEvent.js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import logger from "../utils/logger.js";
import { registerTransferDownload } from "../services/transferDownloadService.js";

// 🔐 Comparaison à temps constant du secret de partage (shareLink / accessKey).
function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Vérifie que la requête porte le vrai secret de partage du transfert et que
 * celui-ci est encore accessible. Renvoie null si OK, sinon { status, error }.
 */
function checkTransferShareSecret(fileTransfer, req) {
  const link = req.body?.link || req.query?.link;
  const key = req.body?.key || req.query?.key;
  if (
    !timingSafeEq(String(link || ""), fileTransfer.shareLink || "") ||
    !timingSafeEq(String(key || ""), fileTransfer.accessKey || "")
  ) {
    return { status: 403, error: "Lien ou clé d'accès invalide" };
  }
  if (
    typeof fileTransfer.isAccessible === "function" &&
    !fileTransfer.isAccessible()
  ) {
    return { status: 410, error: "Transfert expiré ou indisponible" };
  }
  return null;
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

// Autoriser le téléchargement après vérification du paiement
export const authorizeDownload = async (req, res) => {
  try {
    logger.debug("🔐 Route authorize appelée avec params:", req.params);
    logger.debug("🔐 Route authorize appelée avec body:", req.body);

    const { transferId } = req.params;
    const { fileId, email } = req.body;

    // Vérifier que transferId est valide
    if (!transferId) {
      logger.debug("❌ transferId manquant");
      return res.status(400).json({
        success: false,
        error: "ID de transfert manquant",
      });
    }

    // Récupérer l'IP et User-Agent
    const buyerIp =
      req.ip || req.connection.remoteAddress || req.headers["x-forwarded-for"];
    const buyerUserAgent = req.headers["user-agent"];

    logger.info("🔐 Demande d'autorisation de téléchargement", {
      transferId,
      fileId,
      email,
      buyerIp,
    });

    logger.debug("🔍 Recherche du transfert avec ID:", transferId);

    // Vérifier que le transfert existe
    const fileTransfer =
      await FileTransfer.findById(transferId).populate("files");
    logger.debug("🔍 Transfert trouvé:", fileTransfer ? "OUI" : "NON");
    if (!fileTransfer) {
      return res.status(404).json({
        success: false,
        error: "Transfert non trouvé",
      });
    }

    // 🔐 Exiger le secret de partage (shareLink + accessKey) + expiration :
    // le seul transferId (ObjectId devinable) ne suffit plus.
    const secretErr = checkTransferShareSecret(fileTransfer, req);
    if (secretErr) {
      return res
        .status(secretErr.status)
        .json({ success: false, error: secretErr.error });
    }

    // Si pas de paiement requis, autoriser directement
    if (!fileTransfer.isPaymentRequired) {
      return await generateDownloadUrls(
        res,
        fileTransfer,
        fileId,
        email,
        buyerIp,
        buyerUserAgent,
      );
    }

    // DÉSACTIVÉ : Vérification AccessGrant - Accès libre après paiement global
    // const accessGrant = await AccessGrant.findValidGrant(transferId, email, fileId);
    // if (!accessGrant) {
    //   return res.status(402).json({
    //     success: false,
    //     error: 'Paiement requis ou accès expiré',
    //     requiresPayment: true,
    //     paymentAmount: fileTransfer.paymentAmount,
    //     paymentCurrency: fileTransfer.paymentCurrency
    //   });
    // }

    // // Vérifier la validité de l'accès
    // if (!accessGrant.canDownload(fileId)) {
    //   return res.status(403).json({
    //     success: false,
    //     error: 'Accès non valide ou quota épuisé',
    //     remainingDownloads: accessGrant.remainingDownloads,
    //     expiresAt: accessGrant.expiresAt
    //   });
    // }

    logger.debug("🔍 Statut du transfert:", {
      isPaymentRequired: fileTransfer.isPaymentRequired,
      isPaid: fileTransfer.isPaid,
      paymentAmount: fileTransfer.paymentAmount,
    });

    // Vérifier seulement si le transfert est payé globalement
    if (fileTransfer.isPaymentRequired && !fileTransfer.isPaid) {
      logger.debug("❌ Paiement requis mais non effectué");
      return res.status(402).json({
        success: false,
        error: "Paiement requis",
        requiresPayment: true,
        paymentAmount: fileTransfer.paymentAmount,
        paymentCurrency: fileTransfer.paymentCurrency,
      });
    }

    logger.debug("✅ Vérification paiement OK, détection activité suspecte...");

    // Détecter une activité suspecte
    const isSuspicious = await DownloadEvent.detectSuspiciousActivity(buyerIp);
    logger.debug("🔍 Activité suspecte détectée:", isSuspicious);

    if (isSuspicious) {
      logger.warn("🚨 Activité suspecte détectée", { buyerIp, email });
      return res.status(429).json({
        success: false,
        error: "Trop de téléchargements récents. Veuillez réessayer plus tard.",
      });
    }

    logger.debug("✅ Génération des URLs de téléchargement...");

    // Générer les URLs de téléchargement (sans AccessGrant)
    return await generateDownloadUrls(
      res,
      fileTransfer,
      fileId,
      email,
      buyerIp,
      buyerUserAgent,
      null,
    );
  } catch (error) {
    console.error("❌ ERREUR DÉTAILLÉE dans authorizeDownload:", error);
    console.error("❌ Stack trace:", error.stack);
    logger.error("❌ Erreur autorisation téléchargement:", error);
    res.status(500).json({
      success: false,
      error: "Erreur interne du serveur",
    });
  }
};

async function generateDownloadUrls(
  res,
  fileTransfer,
  fileId,
  email,
  buyerIp,
  buyerUserAgent,
  accessGrant = null,
) {
  try {
    // Vérifier la configuration R2/S3
    if (!process.env.TRANSFER_BUCKET) {
      logger.error("❌ TRANSFER_BUCKET non configuré");
      return res.status(500).json({
        success: false,
        error: "Configuration de stockage manquante",
      });
    }
    const downloadUrls = [];
    const filesToProcess = fileId
      ? fileTransfer.files.filter(
          (f) => f._id.toString() === fileId || f.fileId === fileId,
        )
      : fileTransfer.files;

    if (filesToProcess.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Fichier non trouvé",
      });
    }

    // Générer une URL courte pour chaque fichier (2-5 minutes d'expiration)
    const urlExpirationMinutes = 3;
    const urlExpiresAt = new Date();
    urlExpiresAt.setMinutes(urlExpiresAt.getMinutes() + urlExpirationMinutes);

    for (const file of filesToProcess) {
      let downloadUrl;

      // Générer l'URL selon le type de stockage. Toujours signer une URL
      // fraîche pour R2 : l'URL stockée sur le fichier (file.downloadUrl)
      // est signée 24 h à l'upload et expire donc avant le transfert.
      if (file.storageType === "r2" && file.r2Key) {
        const command = new GetObjectCommand({
          Bucket: process.env.TRANSFER_BUCKET,
          Key: file.r2Key,
        });

        downloadUrl = await getSignedUrl(s3Client, command, {
          expiresIn: urlExpirationMinutes * 60, // en secondes
        });
      } else if (file.downloadUrl && !file.downloadUrl.includes("undefined")) {
        // URL publique directe (temporaire)
        downloadUrl = file.downloadUrl;
      } else {
        logger.error("❌ Impossible de générer URL pour fichier", {
          fileId: file._id,
          storageType: file.storageType,
        });
        continue;
      }

      // Logger l'événement de téléchargement
      const downloadEvent = await DownloadEvent.logDownload({
        accessGrantId: accessGrant?._id || null,
        transferId: fileTransfer._id,
        fileId: file._id,
        fileName: file.originalName,
        fileSize: file.size,
        downloadType: fileId ? "single" : "bulk",
        buyerEmail: email,
        buyerIp,
        buyerUserAgent,
        downloadUrl,
        urlExpiresAt,
      });

      downloadUrls.push({
        fileId: file._id,
        fileName: file.originalName,
        fileSize: file.size,
        downloadUrl,
        expiresAt: urlExpiresAt,
        downloadEventId: downloadEvent._id,
      });

      // Consommer un téléchargement si AccessGrant existe
      if (accessGrant) {
        await accessGrant.consumeDownload();
      }
    }

    logger.info("✅ URLs de téléchargement générées", {
      transferId: fileTransfer._id,
      filesCount: downloadUrls.length,
      email,
      expiresAt: urlExpiresAt,
    });

    res.json({
      success: true,
      downloads: downloadUrls,
      expiresAt: urlExpiresAt,
      remainingDownloads: accessGrant?.remainingDownloads || null,
    });
  } catch (error) {
    logger.error("❌ Erreur génération URLs:", error);
    throw error;
  }
}

// Marquer un téléchargement comme terminé
export const markDownloadCompleted = async (req, res) => {
  try {
    const { downloadEventId } = req.params;
    const { duration, isLastFile } = req.body;

    const downloadEvent = await DownloadEvent.findById(downloadEventId);
    if (!downloadEvent) {
      return res.status(404).json({
        success: false,
        error: "Événement de téléchargement non trouvé",
      });
    }

    // 🔐 Exiger le secret de partage du transfert lié (anti-spam de notifications
    // et de faux compteurs à partir d'un downloadEventId deviné).
    const relatedTransfer = await FileTransfer.findById(
      downloadEvent.transferId,
    );
    if (relatedTransfer) {
      const secretErr = checkTransferShareSecret(relatedTransfer, req);
      if (secretErr) {
        return res
          .status(secretErr.status)
          .json({ success: false, error: secretErr.error });
      }
    }

    await downloadEvent.markCompleted(duration);

    logger.info("✅ Téléchargement marqué comme terminé", {
      downloadEventId,
      fileName: downloadEvent.fileName,
      duration,
      isLastFile,
    });

    // Comptage + notification une seule fois par téléchargement : au dernier
    // fichier, et dédoublonnés avec la route proxy déjà traversée pour chaque
    // fichier de la même session.
    if (isLastFile) {
      const fileTransfer = await FileTransfer.findById(
        downloadEvent.transferId,
      );
      if (fileTransfer) {
        await registerTransferDownload(fileTransfer, {
          req,
          fileName: downloadEvent.fileName,
        });
      }
    }

    res.json({ success: true });
  } catch (error) {
    logger.error(" Erreur marquage téléchargement:", error);
    res.status(500).json({
      success: false,
      error: "Erreur interne du serveur",
    });
  }
};

// Obtenir les statistiques de téléchargement
export const getDownloadStats = async (req, res) => {
  try {
    const { transferId } = req.params;

    // 🔐 Ces stats contiennent des PII de destinataires (emails, IP) : exiger le
    // secret de partage du transfert (pas seulement un transferId devinable).
    const fileTransfer = await FileTransfer.findById(transferId);
    if (!fileTransfer) {
      return res
        .status(404)
        .json({ success: false, error: "Transfert non trouvé" });
    }
    const secretErr = checkTransferShareSecret(fileTransfer, req);
    if (secretErr) {
      return res
        .status(secretErr.status)
        .json({ success: false, error: secretErr.error });
    }

    const stats = await DownloadEvent.getDownloadStats(transferId);
    const recentDownloads = await DownloadEvent.getRecentDownloads(
      transferId,
      20,
    );

    res.json({
      success: true,
      stats,
      recentDownloads,
    });
  } catch (error) {
    logger.error("❌ Erreur récupération stats:", error);
    res.status(500).json({
      success: false,
      error: "Erreur interne du serveur",
    });
  }
};
