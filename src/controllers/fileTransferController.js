import path from "path";
import fs from "fs";
import FileTransfer from "../models/FileTransfer.js";
import { createZipArchive } from "../utils/fileTransferUtils.js";
import cloudflareTransferService from "../services/cloudflareTransferService.js";
import Stripe from "stripe";
import archiver from "archiver";
import { Readable } from "stream";

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
    endpointSecret ? "Oui (whsec_...)" : "NON",
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
      "💡 Vérifiez que le STRIPE_WEBHOOK_SECRET correspond au webhook configuré",
    );
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(
    "Données de l'événement:",
    JSON.stringify(event.data.object, null, 2),
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
        fee.originating_transaction,
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
      }, fileId: ${fileId}`,
    );

    if (!shareLink || !accessKey || !fileId) {
      logger.error(
        "[FileTransfer] Paramètres manquants pour le téléchargement",
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
        `[FileTransfer] Transfert non trouvé ou expiré - shareLink: ${shareLink}`,
      );
      return res.status(404).json({
        success: false,
        message: "Transfert non trouvé ou expiré",
      });
    }

    logger.info(
      `[FileTransfer] Transfert trouvé - ID: ${fileTransfer._id}, status: ${fileTransfer.status}`,
    );

    // Vérifier si le transfert est accessible
    if (!fileTransfer.isAccessible()) {
      logger.error(
        `[FileTransfer] Transfert non accessible - isPaid: ${fileTransfer.isPaid}, isPaymentRequired: ${fileTransfer.isPaymentRequired}`,
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
        `[FileTransfer] Fichier non trouvé dans le transfert - fileId: ${fileId}`,
      );
      return res.status(404).json({
        success: false,
        message: "Fichier non trouvé dans le transfert",
      });
    }

    console.log(
      `[DEBUG] Fichier trouvé - Nom: ${file.originalName}, Type: ${file.mimeType}, Taille: ${file.size}, Storage: ${file.storageType}`,
    );

    // Incrémenter le compteur de téléchargements
    await fileTransfer.incrementDownloadCount();

    // Définir les en-têtes appropriés pour le téléchargement
    const contentType = file.mimeType || "application/octet-stream";
    const fileName = encodeURIComponent(file.originalName);

    // Gérer selon le type de stockage
    if (file.storageType === "r2" && file.r2Key) {
      // Fichier stocké sur Cloudflare R2
      console.log(`[DEBUG] Téléchargement depuis R2: ${file.r2Key}`);

      try {
        // Générer une URL signée pour le téléchargement (5 minutes)
        const signedUrl = await cloudflareTransferService.getSignedUrl(
          file.r2Key,
          300,
        );

        // Rediriger vers l'URL signée
        console.log("[DEBUG] Redirection vers URL signée R2");
        return res.redirect(signedUrl);
      } catch (r2Error) {
        console.error("[ERROR] Erreur R2:", r2Error);
        return res.status(500).json({
          success: false,
          message: "Erreur lors de la récupération du fichier",
        });
      }
    } else {
      // Fichier stocké localement
      const filePath = path.join(process.cwd(), "public", file.filePath);
      console.log(`[DEBUG] Chemin du fichier local: ${filePath}`);

      // Vérifier si le fichier existe
      if (!fs.existsSync(filePath)) {
        console.log(
          `[ERROR] Fichier physique non trouvé sur le serveur: ${filePath}`,
        );
        return res.status(404).send("Fichier non trouvé sur le serveur");
      }

      // Vérifier la taille du fichier
      const fileStats = fs.statSync(filePath);
      console.log(
        `[DEBUG] Taille du fichier sur disque: ${fileStats.size} octets`,
      );

      if (fileStats.size === 0) {
        console.log(`[ERROR] Fichier vide sur le serveur: ${filePath}`);
        return res.status(500).send("Fichier vide sur le serveur");
      }

      console.log(
        `[DEBUG] En-têtes de réponse - Content-Type: ${contentType}, fileName: ${fileName}, Content-Length: ${fileStats.size}`,
      );

      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`,
      );
      res.setHeader("Content-Length", fileStats.size);
      res.setHeader("Cache-Control", "no-cache");

      // Utiliser un stream pour envoyer le fichier
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
          `[DEBUG] Téléchargement terminé avec succès - ${file.originalName}`,
        );
      });

      // Pipe le stream vers la réponse
      fileStream.pipe(res);
    }
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
      }`,
    );

    if (!shareLink || !accessKey) {
      logger.error(
        "[FileTransfer] Paramètres manquants pour le téléchargement groupé",
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
        `[FileTransfer] Transfert non trouvé ou expiré - shareLink: ${shareLink}`,
      );
      return res.status(404).json({
        success: false,
        message: "Transfert non trouvé ou expiré",
      });
    }

    logger.info(
      `[FileTransfer] Transfert trouvé - ID: ${fileTransfer._id}, nombre de fichiers: ${fileTransfer.files.length}`,
    );

    // Vérifier si le transfert est accessible
    if (!fileTransfer.isAccessible()) {
      logger.error(
        `[FileTransfer] Transfert non accessible - isPaid: ${fileTransfer.isPaid}, isPaymentRequired: ${fileTransfer.isPaymentRequired}`,
      );
      return res.status(403).json({
        success: false,
        message:
          "Accès refusé. Le paiement est requis ou le transfert a expiré.",
      });
    }

    // Vérifier si des fichiers existent
    if (!fileTransfer.files || fileTransfer.files.length === 0) {
      logger.error(`Aucun fichier à télécharger - ID: ${fileTransfer._id}`);
      return res.status(404).send("Aucun fichier disponible pour ce transfert");
    }

    // Séparer les fichiers locaux et R2
    const localFiles = fileTransfer.files.filter((f) => f.storageType !== "r2");
    const r2Files = fileTransfer.files.filter(
      (f) => f.storageType === "r2" && f.r2Key,
    );

    console.log(
      `[DEBUG] Fichiers locaux: ${localFiles.length}, Fichiers R2: ${r2Files.length}`,
    );

    // Vérifier que tous les fichiers locaux existent physiquement
    const missingLocalFiles = [];
    for (const file of localFiles) {
      const filePath = path.join(process.cwd(), "public", file.filePath);
      if (!fs.existsSync(filePath)) {
        missingLocalFiles.push(file.originalName);
      }
    }

    if (missingLocalFiles.length > 0) {
      logger.error(
        `Fichiers locaux manquants: ${missingLocalFiles.join(", ")}`,
      );
      return res
        .status(404)
        .send(
          `Certains fichiers sont manquants: ${missingLocalFiles.join(", ")}`,
        );
    }

    try {
      // Incrémenter le compteur de téléchargements
      await fileTransfer.incrementDownloadCount();

      const archiveFileName = `newbi-files-${Date.now()}.zip`;

      // Définir les en-têtes pour le streaming
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(archiveFileName)}"`,
      );
      res.setHeader("Cache-Control", "no-cache");

      // En mode store (aucune compression), la taille du ZIP est exactement
      // prévisible : par fichier, en-tête local 30+n octets, data descriptor
      // 16, entrée du répertoire central 46+n (n = longueur du nom), plus
      // EOCD 22 octets. Annoncer un Content-Length exact permet au navigateur
      // et au client d'afficher une vraie progression de téléchargement.
      // On ne l'annonce que dans le cas sûr : uniquement des fichiers R2,
      // noms ASCII, tailles connues, pas de zip64 (< 4 Go).
      const sizesKnown = r2Files.every(
        (f) => Number.isFinite(f.size) && f.size >= 0,
      );
      const asciiNames = r2Files.every((f) =>
        /^[\x20-\x7e]+$/.test(f.originalName || ""),
      );
      let expectedZipSize = null;
      if (
        localFiles.length === 0 &&
        r2Files.length > 0 &&
        sizesKnown &&
        asciiNames
      ) {
        expectedZipSize =
          r2Files.reduce(
            (acc, f) => acc + f.size + 92 + 2 * f.originalName.length,
            0,
          ) + 22;
        if (
          expectedZipSize < 0xfffffffe &&
          r2Files.every((f) => f.size < 0xfffffffe)
        ) {
          res.setHeader("Content-Length", expectedZipSize);
        } else {
          expectedZipSize = null;
        }
      }

      // Créer l'archive en streaming directement vers la réponse.
      // store: true → pas de compression (les fichiers transférés sont
      // généralement déjà compressés : images, vidéos, PDF), le streaming
      // n'est plus limité par le CPU
      const archive = archiver("zip", {
        store: true,
      });

      // Gérer les erreurs d'archivage
      archive.on("error", (err) => {
        logger.error("Erreur lors de la création de l'archive ZIP:", err);
        if (!res.headersSent) {
          res
            .status(500)
            .send(`Erreur lors de la création de l'archive: ${err.message}`);
        }
      });

      archive.on("end", () => {
        const written = archive.pointer();
        logger.info(
          `Archive ZIP terminée: ${archiveFileName} (${written} octets)`,
        );
        if (expectedZipSize !== null && written !== expectedZipSize) {
          logger.error(
            `[ZIP] Taille réelle (${written}) ≠ Content-Length annoncé (${expectedZipSize})`,
          );
        }
      });

      // Pipe l'archive vers la réponse
      archive.pipe(res);

      // Ajouter les fichiers locaux
      for (const file of localFiles) {
        const filePath = path.join(process.cwd(), "public", file.filePath);
        archive.file(filePath, { name: file.originalName });
        console.log(`[ZIP] Ajout fichier local: ${file.originalName}`);
      }

      // Ajouter les fichiers R2 en les streamant SÉQUENTIELLEMENT :
      // ouvrir tous les streams R2 d'un coup laisse les sockets suivants
      // inactifs pendant que l'archive consomme le premier fichier — R2
      // coupe la connexion (timeout) et le ZIP est livré tronqué avec un
      // statut 200. On n'ouvre donc chaque stream qu'au moment où l'archive
      // est prête à le consommer, et on attend que l'entrée soit finalisée
      // avant de passer à la suivante.
      const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");

      const s3Client = new S3Client({
        region: "auto",
        endpoint: process.env.R2_API_URL,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      });

      try {
        for (const file of r2Files) {
          console.log(
            `[ZIP] Ajout fichier R2: ${file.originalName} (${file.r2Key})`,
          );

          const command = new GetObjectCommand({
            Bucket: process.env.TRANSFER_BUCKET || "app-transfers-prod",
            Key: file.r2Key,
          });

          const response = await s3Client.send(command);

          const entryDone = new Promise((resolve, reject) => {
            const onEntry = (entry) => {
              if (entry.name === file.originalName) {
                archive.off("entry", onEntry);
                resolve();
              }
            };
            archive.on("entry", onEntry);
            response.Body.once("error", reject);
          });

          archive.append(response.Body, { name: file.originalName });
          await entryDone;
        }
      } catch (r2Error) {
        // Les headers sont déjà partis : impossible de renvoyer une erreur
        // HTTP. On coupe la connexion pour que le client voie un échec de
        // téléchargement plutôt qu'un ZIP incomplet marqué "terminé".
        logger.error(
          "[ZIP] Erreur streaming R2, archive interrompue:",
          r2Error,
        );
        archive.abort();
        res.destroy(r2Error);
        return;
      }

      // Finaliser l'archive
      await archive.finalize();
    } catch (zipError) {
      logger.error("Erreur lors de la création de l'archive ZIP:", zipError);
      if (!res.headersSent) {
        res
          .status(500)
          .send(`Erreur lors de la création de l'archive: ${zipError.message}`);
      }
    }
  } catch (error) {
    logger.error("Erreur lors du téléchargement des fichiers:", error);
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

    // Vérifier le mot de passe avec bcrypt
    const isPasswordValid = await fileTransfer.verifyPassword(password);

    if (isPasswordValid) {
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
      (f) => f.fileId === fileId || f._id.toString() === fileId,
    );

    if (!file) {
      return res.status(404).json({
        success: false,
        message: "Fichier non trouvé",
      });
    }

    // Si le fichier est sur R2, générer une URL signée pour la prévisualisation
    if (file.storageType === "r2" && file.r2Key) {
      const presignedUrl = await cloudflareTransferService.getSignedUrl(
        file.r2Key,
        3600, // 1 heure
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
      `inline; filename="${file.originalName}"`,
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
