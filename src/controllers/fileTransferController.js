import path from "path";
import fs from "fs";
import FileTransfer from "../models/FileTransfer.js";
import { createZipArchive } from "../utils/fileTransferUtils.js";
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const logger = console; // Utilisation de console comme logger de base

// Webhook Stripe pour les paiements
const handleStripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // 🔍 DEBUG: Logs pour diagnostiquer le problème
  console.log("🔔 Webhook reçu");
  console.log("📝 Headers:", JSON.stringify(req.headers, null, 2));
  console.log("🔑 Signature présente:", !!sig);
  console.log(
    "🔐 Secret configuré:",
    endpointSecret ? "Oui (whsec_...)" : "NON"
  );
  console.log("📦 Body type:", typeof req.body);
  console.log("📦 Body length:", req.body?.length || "N/A");

  let event;

  try {
    // Vérifier la signature du webhook
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log("✅ Signature vérifiée avec succès");
  } catch (err) {
    console.error("❌ Erreur de signature du webhook Stripe:", err.message);
    console.error(
      "💡 Vérifiez que le STRIPE_WEBHOOK_SECRET correspond au webhook configuré"
    );
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(
    "Données de l'événement:",
    JSON.stringify(event.data.object, null, 2)
  );

  let result = {
    status: "ignored",
    message: `Événement non géré: ${event.type}`,
  };

  // Gérer l'événement de paiement réussi
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    try {
      // Récupérer les métadonnées
      const { fileTransferId } = session.metadata;

      // Mettre à jour le transfert de fichiers
      const fileTransfer = await FileTransfer.findById(fileTransferId);

      if (fileTransfer) {
        await fileTransfer.markAsPaid(session.id);
        result = { status: "success", message: "Transfert marqué comme payé" };
      } else {
        result = {
          status: "error",
          message: "Transfert de fichiers non trouvé",
        };
      }
    } catch (error) {
      result = {
        status: "error",
        message: `Erreur lors du traitement du paiement: ${error.message}`,
      };
    }
  }
  // Gérer l'événement de frais d'application créé
  else if (event.type === "application_fee.created") {
    const fee = event.data.object;

    try {
      // Récupérer la charge associée
      const charge = fee.charge;

      // Récupérer la session de paiement associée à cette charge
      const paymentIntent = await stripe.paymentIntents.retrieve(
        fee.originating_transaction
      );

      if (
        paymentIntent &&
        paymentIntent.metadata &&
        paymentIntent.metadata.fileTransferId
      ) {
        const fileTransferId = paymentIntent.metadata.fileTransferId;

        // Mettre à jour le transfert de fichiers
        const fileTransfer = await FileTransfer.findById(fileTransferId);

        if (fileTransfer && !fileTransfer.isPaid) {
          await fileTransfer.markAsPaid(charge);
          result = {
            status: "success",
            message: "Transfert marqué comme payé via application_fee",
          };
        } else if (fileTransfer && fileTransfer.isPaid) {
          result = {
            status: "ignored",
            message: "Transfert déjà marqué comme payé",
          };
        } else {
          result = {
            status: "error",
            message: "Transfert de fichiers non trouvé",
          };
        }
      }
    } catch (error) {
      result = {
        status: "error",
        message: `Erreur lors du traitement des frais: ${error.message}`,
      };
    }
  }

  console.log("Résultat du traitement:", result);

  // Répondre pour confirmer la réception
  res.status(200).json({ received: true, result });
};

// Télécharger un fichier individuel
const downloadFile = async (req, res) => {
  try {
    // Utiliser req.query pour les paramètres de requête
    const { link: shareLink, key: accessKey, fileId } = req.query;

    logger.info(
      `[FileTransfer] Demande de téléchargement - shareLink: ${shareLink}, accessKey: ${
        accessKey ? "***" + accessKey.slice(-4) : "non fourni"
      }, fileId: ${fileId}`
    );

    if (!shareLink || !accessKey || !fileId) {
      logger.error(
        "[FileTransfer] Paramètres manquants pour le téléchargement"
      );
      return res.status(400).json({
        success: false,
        message: "Paramètres de téléchargement manquants",
      });
    }

    // Vérifier le transfert de fichiers
    const fileTransfer = await FileTransfer.findOne({
      shareLink,
      accessKey,
      status: "active",
      expiryDate: { $gt: new Date() },
    });

    if (!fileTransfer) {
      logger.error(
        `[FileTransfer] Transfert non trouvé ou expiré - shareLink: ${shareLink}`
      );
      return res.status(404).json({
        success: false,
        message: "Transfert non trouvé ou expiré",
      });
      return res.status(404).send("Transfert de fichiers non trouvé ou expiré");
    }

    logger.info(
      `[FileTransfer] Transfert trouvé - ID: ${fileTransfer._id}, status: ${fileTransfer.status}`
    );

    // Vérifier si le transfert est accessible
    if (!fileTransfer.isAccessible()) {
      logger.error(
        `[FileTransfer] Transfert non accessible - isPaid: ${fileTransfer.isPaid}, isPaymentRequired: ${fileTransfer.isPaymentRequired}`
      );
      return res.status(403).json({
        success: false,
        message:
          "Accès refusé. Le paiement est requis ou le transfert a expiré.",
      });
    }

    // Trouver le fichier demandé
    const file = fileTransfer.files.find((f) => f._id.toString() === fileId);

    if (!file) {
      logger.error(
        `[FileTransfer] Fichier non trouvé dans le transfert - fileId: ${fileId}`
      );
      logger.debug(
        `[FileTransfer] Fichiers disponibles: ${JSON.stringify(
          fileTransfer.files.map((f) => ({
            id: f._id.toString(),
            name: f.originalName,
          }))
        )}`
      );
      return res.status(404).json({
        success: false,
        message: "Fichier non trouvé dans le transfert",
      });
    }

    console.log(
      `[DEBUG] Fichier trouvé - Nom: ${file.originalName}, Type: ${file.mimeType}, Taille: ${file.size}`
    );

    // Construire le chemin du fichier
    const filePath = path.join(process.cwd(), "public", file.filePath);
    console.log(`[DEBUG] Chemin du fichier: ${filePath}`);

    // Vérifier si le fichier existe
    if (!fs.existsSync(filePath)) {
      console.log(
        `[ERROR] Fichier physique non trouvé sur le serveur: ${filePath}`
      );
      return res.status(404).send("Fichier non trouvé sur le serveur");
    }

    // Vérifier la taille du fichier
    const fileStats = fs.statSync(filePath);
    console.log(
      `[DEBUG] Taille du fichier sur disque: ${fileStats.size} octets`
    );

    if (fileStats.size === 0) {
      console.log(`[ERROR] Fichier vide sur le serveur: ${filePath}`);
      return res.status(500).send("Fichier vide sur le serveur");
    }

    // Incrémenter le compteur de téléchargements
    await fileTransfer.incrementDownloadCount();

    // Définir les en-têtes appropriés pour le téléchargement
    const contentType = file.mimeType || "application/octet-stream";
    const fileName = encodeURIComponent(file.originalName);

    console.log(
      `[DEBUG] En-têtes de réponse - Content-Type: ${contentType}, fileName: ${fileName}, Content-Length: ${fileStats.size}`
    );

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", fileStats.size);
    res.setHeader("Cache-Control", "no-cache");

    // Utiliser un stream pour envoyer le fichier au lieu de res.download
    // Cela évite les problèmes potentiels de mémoire tampon et de corruption
    const fileStream = fs.createReadStream(filePath);

    // Gérer les erreurs de stream
    fileStream.on("error", (err) => {
      console.error("[ERROR] Erreur de stream lors du téléchargement:", err);
      if (!res.headersSent) {
        res.status(500).send("Erreur lors de la lecture du fichier");
      }
    });

    // Gérer la fin du stream
    fileStream.on("end", () => {
      console.log(
        `[DEBUG] Téléchargement terminé avec succès - ${file.originalName}`
      );
    });

    // Pipe le stream vers la réponse
    fileStream.pipe(res);
  } catch (error) {
    console.error("[ERROR] Erreur lors du téléchargement du fichier:", error);
    if (!res.headersSent) {
      res
        .status(500)
        .send("Une erreur est survenue lors du téléchargement du fichier");
    }
  }
};

// Télécharger tous les fichiers en tant qu'archive ZIP
const downloadAllFiles = async (req, res) => {
  try {
    const { link: shareLink, key: accessKey } = req.query;

    logger.info(
      `[FileTransfer] Demande de téléchargement groupé - shareLink: ${shareLink}, accessKey: ${
        accessKey ? "***" + accessKey.slice(-4) : "non fourni"
      }`
    );

    if (!shareLink || !accessKey) {
      logger.error(
        "[FileTransfer] Paramètres manquants pour le téléchargement groupé"
      );
      return res.status(400).json({
        success: false,
        message: "Paramètres de téléchargement manquants",
      });
    }

    // Vérifier le transfert de fichiers
    const fileTransfer = await FileTransfer.findOne({
      shareLink,
      accessKey,
      status: "active",
      expiryDate: { $gt: new Date() },
    });

    if (!fileTransfer) {
      logger.error(
        `[FileTransfer] Transfert non trouvé ou expiré - shareLink: ${shareLink}`
      );
      return res.status(404).json({
        success: false,
        message: "Transfert non trouvé ou expiré",
      });
    }

    logger.info(
      `[FileTransfer] Transfert trouvé - ID: ${fileTransfer._id}, nombre de fichiers: ${fileTransfer.files.length}`
    );

    // Vérifier si le transfert est accessible
    if (!fileTransfer.isAccessible()) {
      logger.error(
        `[FileTransfer] Transfert non accessible - isPaid: ${fileTransfer.isPaid}, isPaymentRequired: ${fileTransfer.isPaymentRequired}`
      );
      return res.status(403).json({
        success: false,
        message:
          "Accès refusé. Le paiement est requis ou le transfert a expiré.",
      });
    }

    // Vérifier si des fichiers existent
    if (!fileTransfer.files || fileTransfer.files.length === 0) {
      if (global.logger) {
        global.logger.error(
          `Aucun fichier à télécharger - ID: ${fileTransfer._id}`
        );
      }
      return res.status(404).send("Aucun fichier disponible pour ce transfert");
    }

    // Vérifier que tous les fichiers existent physiquement
    const missingFiles = [];
    for (const file of fileTransfer.files) {
      const filePath = path.join(process.cwd(), "public", file.filePath);
      if (!fs.existsSync(filePath)) {
        missingFiles.push(file.originalName);
      }
    }

    if (missingFiles.length > 0) {
      if (global.logger) {
        global.logger.error(`Fichiers manquants: ${missingFiles.join(", ")}`);
      }
      return res
        .status(404)
        .send(`Certains fichiers sont manquants: ${missingFiles.join(", ")}`);
    }

    try {
      // Créer une archive ZIP des fichiers
      const archivePath = await createZipArchive(
        fileTransfer.files,
        fileTransfer.userId
      );

      // Construire le chemin de l'archive
      const fullArchivePath = path.join(process.cwd(), "public", archivePath);

      // Vérifier si l'archive existe
      if (!fs.existsSync(fullArchivePath)) {
        if (global.logger) {
          global.logger.error(`Archive non créée: ${fullArchivePath}`);
        }
        return res.status(500).send("Erreur lors de la création de l'archive");
      }

      // Obtenir la taille de l'archive
      const archiveStats = fs.statSync(fullArchivePath);
      const archiveSize = archiveStats.size;

      if (archiveSize === 0) {
        if (global.logger) {
          global.logger.error(`Archive vide: ${fullArchivePath}`);
        }
        return res.status(500).send("L'archive créée est vide");
      }

      const archiveFileName = `newbi-files-${Date.now()}.zip`;

      if (global.logger) {
        global.logger.info(
          `Archive prête - Chemin: ${fullArchivePath}, Taille: ${archiveSize} octets`
        );
      }

      // Incrémenter le compteur de téléchargements
      await fileTransfer.incrementDownloadCount();

      // Définir les en-têtes appropriés pour le téléchargement
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(archiveFileName)}"`
      );
      res.setHeader("Content-Length", archiveSize);
      res.setHeader("Cache-Control", "no-cache");

      // Utiliser un stream pour envoyer l'archive
      const archiveStream = fs.createReadStream(fullArchivePath);

      // Gérer les erreurs de stream
      archiveStream.on("error", (err) => {
        if (global.logger) {
          global.logger.error(
            "Erreur de stream lors du téléchargement de l'archive:",
            err
          );
        }
        if (!res.headersSent) {
          res.status(500).send("Erreur lors de la lecture de l'archive");
        }
      });

      // Gérer la fin du téléchargement
      res.on("finish", () => {
        if (global.logger) {
          global.logger.info(`Téléchargement terminé: ${archiveFileName}`);
        }
        // Supprimer l'archive après le téléchargement
        setTimeout(() => {
          fs.unlink(fullArchivePath, (err) => {
            if (err && global.logger) {
              global.logger.error(
                "Erreur lors de la suppression de l'archive temporaire:",
                err
              );
            }
          });
        }, 60000); // Attendre 1 minute avant de supprimer
      });

      // Pipe le stream vers la réponse
      archiveStream.pipe(res);
    } catch (zipError) {
      if (global.logger) {
        global.logger.error(
          "Erreur lors de la création de l'archive ZIP:",
          zipError
        );
      }
      if (!res.headersSent) {
        res
          .status(500)
          .send(`Erreur lors de la création de l'archive: ${zipError.message}`);
      }
    }
  } catch (error) {
    if (global.logger) {
      global.logger.error("Erreur lors du téléchargement des fichiers:", error);
    }
    if (!res.headersSent) {
      res
        .status(500)
        .send("Une erreur est survenue lors du téléchargement des fichiers");
    }
  }
};

// Valider un paiement
const validatePayment = async (req, res) => {
  try {
    const { shareLink, accessKey, sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).send("ID de session manquant");
    }

    // Vérifier la session de paiement
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).send("Le paiement n'a pas été effectué");
    }

    // Vérifier le transfert de fichiers
    const fileTransfer = await FileTransfer.findOne({
      shareLink,
      accessKey,
      status: "active",
      isPaymentRequired: true,
    });

    if (!fileTransfer) {
      return res.status(404).send("Transfert de fichiers non trouvé");
    }

    // Marquer comme payé si ce n'est pas déjà fait
    if (!fileTransfer.isPaid) {
      await fileTransfer.markAsPaid(sessionId);
    }

    // Rediriger vers la page de téléchargement
    res.redirect(`/file-transfer/download?share=${shareLink}&key=${accessKey}`);
  } catch (error) {
    console.error("Erreur lors de la validation du paiement:", error);
    res
      .status(500)
      .send("Une erreur est survenue lors de la validation du paiement");
  }
};

// Vérifier le mot de passe d'un transfert
const verifyTransferPassword = async (req, res) => {
  try {
    const { transferId, password } = req.body;

    if (!transferId || !password) {
      return res.status(400).json({
        success: false,
        message: "ID de transfert et mot de passe requis",
      });
    }

    const fileTransfer = await FileTransfer.findById(transferId);

    if (!fileTransfer) {
      return res.status(404).json({
        success: false,
        message: "Transfert non trouvé",
      });
    }

    if (!fileTransfer.passwordProtected) {
      return res.status(400).json({
        success: false,
        message: "Ce transfert n'est pas protégé par mot de passe",
      });
    }

    // Vérifier le mot de passe (comparaison simple pour l'instant)
    // TODO: Utiliser bcrypt pour une comparaison sécurisée
    if (fileTransfer.password === password) {
      return res.json({
        success: true,
        message: "Mot de passe correct",
      });
    } else {
      return res.status(401).json({
        success: false,
        message: "Mot de passe incorrect",
      });
    }
  } catch (error) {
    console.error("Erreur lors de la vérification du mot de passe:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la vérification du mot de passe",
    });
  }
};

// Prévisualiser un fichier
const previewFile = async (req, res) => {
  try {
    const { transferId, fileId } = req.params;

    const fileTransfer = await FileTransfer.findById(transferId);

    if (!fileTransfer) {
      return res.status(404).json({
        success: false,
        message: "Transfert non trouvé",
      });
    }

    // Vérifier si la prévisualisation est autorisée
    if (!fileTransfer.allowPreview) {
      return res.status(403).json({
        success: false,
        message: "La prévisualisation n'est pas autorisée pour ce transfert",
      });
    }

    // Trouver le fichier
    const file = fileTransfer.files.find(
      (f) => f.fileId === fileId || f._id.toString() === fileId
    );

    if (!file) {
      return res.status(404).json({
        success: false,
        message: "Fichier non trouvé",
      });
    }

    // Si le fichier est sur R2, générer une URL signée pour la prévisualisation
    if (file.storageType === "r2" && file.r2Key) {
      const { cloudflareTransferService } = await import(
        "../services/cloudflareTransferService.js"
      );

      const presignedUrl =
        await cloudflareTransferService.getPresignedDownloadUrl(
          file.r2Key,
          3600 // 1 heure
        );

      // Rediriger vers l'URL signée
      return res.redirect(presignedUrl);
    }

    // Sinon, servir le fichier local
    const filePath = path.join(process.cwd(), file.filePath);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: "Fichier non trouvé sur le serveur",
      });
    }

    res.setHeader("Content-Type", file.mimeType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${file.originalName}"`
    );

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (error) {
    console.error("Erreur lors de la prévisualisation:", error);
    return res.status(500).json({
      success: false,
      message: "Erreur lors de la prévisualisation du fichier",
    });
  }
};

export {
  handleStripeWebhook,
  downloadFile,
  downloadAllFiles,
  validatePayment,
  verifyTransferPassword,
  previewFile,
};
