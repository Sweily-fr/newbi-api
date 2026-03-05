import FileTransfer from "../models/FileTransfer.js";
import AccessGrant from "../models/AccessGrant.js";
import DownloadEvent from "../models/DownloadEvent.js";
import User from "../models/User.js";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import logger from "../utils/logger.js";
import { sendDownloadNotificationEmail } from "../utils/mailer.js";

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
    console.log("🔐 Route authorize appelée avec params:", req.params);
    console.log("🔐 Route authorize appelée avec body:", req.body);

    const { transferId } = req.params;
    const { fileId, email } = req.body;

    // Vérifier que transferId est valide
    if (!transferId) {
      console.log("❌ transferId manquant");
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

    console.log("🔍 Recherche du transfert avec ID:", transferId);

    // Vérifier que le transfert existe
    const fileTransfer =
      await FileTransfer.findById(transferId).populate("files");
    console.log("🔍 Transfert trouvé:", fileTransfer ? "OUI" : "NON");
    if (!fileTransfer) {
      return res.status(404).json({
        success: false,
        error: "Transfert non trouvé",
      });
    }

    // Si pas de paiement requis, autoriser directement
    if (!fileTransfer.isPaymentRequired) {
      return await generateDownloadUrls(
        res,
        fileTransfer,
        fileId,
        email,
        buyerIp,
        buyerUserAgent
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

    console.log("🔍 Statut du transfert:", {
      isPaymentRequired: fileTransfer.isPaymentRequired,
      isPaid: fileTransfer.isPaid,
      paymentAmount: fileTransfer.paymentAmount,
    });

    // Vérifier seulement si le transfert est payé globalement
    if (fileTransfer.isPaymentRequired && !fileTransfer.isPaid) {
      console.log("❌ Paiement requis mais non effectué");
      return res.status(402).json({
        success: false,
        error: "Paiement requis",
        requiresPayment: true,
        paymentAmount: fileTransfer.paymentAmount,
        paymentCurrency: fileTransfer.paymentCurrency,
      });
    }

    console.log("✅ Vérification paiement OK, détection activité suspecte...");

    // Détecter une activité suspecte
    const isSuspicious = await DownloadEvent.detectSuspiciousActivity(buyerIp);
    console.log("🔍 Activité suspecte détectée:", isSuspicious);

    if (isSuspicious) {
      logger.warn("🚨 Activité suspecte détectée", { buyerIp, email });
      return res.status(429).json({
        success: false,
        error: "Trop de téléchargements récents. Veuillez réessayer plus tard.",
      });
    }

    console.log("✅ Génération des URLs de téléchargement...");

    // Générer les URLs de téléchargement (sans AccessGrant)
    return await generateDownloadUrls(
      res,
      fileTransfer,
      fileId,
      email,
      buyerIp,
      buyerUserAgent,
      null
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
  accessGrant = null
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
      ? fileTransfer.files.filter((f) => f._id.toString() === fileId || f.fileId === fileId)
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

      // Générer l'URL selon le type de stockage
      if (file.downloadUrl && !file.downloadUrl.includes("undefined")) {
        // URL publique directe (temporaire)
        downloadUrl = file.downloadUrl;
      } else if (file.storageType === "r2" && file.r2Key) {
        // URL signée R2 courte
        const command = new GetObjectCommand({
          Bucket: process.env.TRANSFER_BUCKET,
          Key: file.r2Key,
        });

        downloadUrl = await getSignedUrl(s3Client, command, {
          expiresIn: urlExpirationMinutes * 60, // en secondes
        });
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

    await downloadEvent.markCompleted(duration);

    logger.info("✅ Téléchargement marqué comme terminé", {
      downloadEventId,
      fileName: downloadEvent.fileName,
      duration,
      isLastFile,
    });

    // Incrémenter le compteur + notification SEULEMENT pour le dernier fichier
    if (isLastFile) {
      try {
        const fileTransfer = await FileTransfer.findById(downloadEvent.transferId);
        if (fileTransfer) {
          // Incrémenter le compteur de téléchargements
          await fileTransfer.incrementDownloadCount();
          logger.info("📊 Compteur de téléchargements incrémenté (via lien public)", {
            transferId: downloadEvent.transferId,
            newCount: fileTransfer.downloadCount,
          });

          // Envoyer notification si activée
          if (fileTransfer.notifyOnDownload) {
            try {
              const owner = await User.findById(fileTransfer.userId);
              if (owner && owner.email) {
                const transferUrl = `${process.env.FRONTEND_URL}/dashboard/outils/transferts-fichiers`;
                const displayName =
                  fileTransfer.files.length > 1
                    ? `${fileTransfer.files.length} fichiers`
                    : fileTransfer.files[0]?.originalName || downloadEvent.fileName;

                await sendDownloadNotificationEmail(owner.email, {
                  fileName: displayName,
                  downloadDate: new Date(),
                  filesCount: fileTransfer.files.length,
                  shareLink: fileTransfer.shareLink,
                  transferUrl,
                });
                logger.info("📧 Notification de téléchargement envoyée", {
                  ownerEmail: owner.email,
                  filesCount: fileTransfer.files.length,
                });
              }
            } catch (emailError) {
              logger.error("❌ Erreur envoi notification téléchargement:", emailError);
            }
          }
        }
      } catch (countError) {
        logger.error("❌ Erreur incrémentation compteur:", countError);
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

    const stats = await DownloadEvent.getDownloadStats(transferId);
    const recentDownloads = await DownloadEvent.getRecentDownloads(
      transferId,
      20
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
