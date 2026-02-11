import { ApolloError, UserInputError } from "apollo-server-express";
import FileTransfer from "../models/FileTransfer.js";
import SharedDocument from "../models/SharedDocument.js";
import SharedFolder from "../models/SharedFolder.js";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import {
  saveUploadedFile,
  saveBase64File,
  generateShareLink,
  generateAccessKey,
  calculateExpiryDate,
  deleteFile,
} from "../utils/fileTransferUtils.js";
import { getAllSubfolders, sanitizeFileName, buildFolderPath, sharedDocsS3Client, SHARED_DOCUMENTS_BUCKET } from "../services/sharedDocumentZipService.js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import cloudflareTransferService from "../services/cloudflareTransferService.js";
import crypto from "crypto";
import archiver from "archiver";
import { PassThrough } from "stream";
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
import constants from "../utils/constants.js";
const { BASE_URL } = constants;

// Taille maximale autorisée (5 GB en octets)
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;

export default {
  Query: {
    // Obtenir les transferts de fichiers de l'utilisateur connecté avec pagination
    myFileTransfers: isAuthenticated(
      async (_, { page = 1, limit = 10 }, { user }) => {
        try {
          // S'assurer que page et limit sont des nombres positifs
          const validPage = Math.max(1, page);
          const validLimit = Math.max(1, Math.min(100, limit)); // Limiter à 100 éléments maximum par page
          const skip = (validPage - 1) * validLimit;

          // Compter le nombre total d'éléments pour la pagination
          const totalItems = await FileTransfer.find({
            userId: user.id,
            status: { $ne: "deleted" },
          }).countDocuments();

          // Récupérer les transferts de fichiers avec pagination
          const fileTransfers = await FileTransfer.find({
            userId: user.id,
            status: { $ne: "deleted" },
          })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(validLimit);

          // Calculer les métadonnées de pagination
          const totalPages = Math.ceil(totalItems / validLimit);
          const hasNextPage = validPage < totalPages;

          // Retourner l'objet paginé
          return {
            items: fileTransfers,
            totalItems,
            currentPage: validPage,
            totalPages,
            hasNextPage,
          };
        } catch (error) {
          console.error(
            "Erreur lors de la récupération des transferts de fichiers:",
            error
          );
          throw new ApolloError(
            "Une erreur est survenue lors de la récupération des transferts de fichiers.",
            "FILE_TRANSFER_FETCH_ERROR"
          );
        }
      }
    ),

    // Obtenir les informations d'un transfert de fichiers par son ID
    fileTransferById: isAuthenticated(async (_, { id }, { user }) => {
      try {
        const fileTransfer = await FileTransfer.findOne({
          _id: id,
          userId: user.id,
          status: { $ne: "deleted" },
        });

        if (!fileTransfer) {
          throw new UserInputError("Transfert de fichiers non trouvé");
        }

        return fileTransfer;
      } catch (error) {
        if (error instanceof UserInputError) {
          throw error;
        }

        console.error(
          "Erreur lors de la récupération du transfert de fichiers:",
          error
        );
        throw new ApolloError(
          "Une erreur est survenue lors de la récupération du transfert de fichiers.",
          "FILE_TRANSFER_FETCH_ERROR"
        );
      }
    }),

    // Obtenir les informations d'un transfert de fichiers par son lien de partage et sa clé d'accès
    getFileTransferByLink: async (_, { shareLink, accessKey }) => {
      try {
        const fileTransfer = await FileTransfer.findOne({
          shareLink,
          accessKey,
          status: "active",
        });

        if (!fileTransfer) {
          return {
            success: false,
            message: "Lien de partage invalide ou expiré",
            fileTransfer: null,
          };
        }

        // Vérifier si le transfert est expiré
        if (fileTransfer.isExpired()) {
          return {
            success: false,
            message: "Ce lien de partage a expiré",
            fileTransfer: null,
          };
        }

        // Préparer les informations de paiement
        const paymentInfo = {
          isPaymentRequired: fileTransfer.isPaymentRequired,
          paymentAmount: fileTransfer.paymentAmount,
          paymentCurrency: fileTransfer.paymentCurrency,
          isPaid: fileTransfer.isPaid,
          checkoutUrl: null,
        };

        // Pour l'affichage frontend, utiliser isPaid pour indiquer si ce transfert a été payé
        // La vérification d'accès individuel se fait dans le contrôleur d'autorisation
        const isAccessible = fileTransfer.isAccessible();

        // Fonction pour nettoyer les noms de fichiers avec ID
        const cleanFileName = (fileName) => {
          if (!fileName) return fileName;
          // Retirer l'UUID au début: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx_
          const uuidPattern =
            /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_/i;
          return fileName.replace(uuidPattern, "");
        };

        // Préparer les informations du transfert avec URLs de téléchargement
        const filesWithDownloadUrls = fileTransfer.files.map((file) => ({
          ...file.toObject(),
          id: file._id.toString(), // Assurer que l'ID est présent
          originalName: cleanFileName(file.originalName), // ✅ Nettoyer le nom à la volée
          displayName: cleanFileName(file.displayName || file.originalName), // ✅ Nettoyer le displayName
          downloadUrl:
            file.storageType === "r2" ? file.filePath : file.filePath,
        }));

        const fileTransferInfo = {
          id: fileTransfer.id,
          files: filesWithDownloadUrls,
          totalSize: fileTransfer.totalSize,
          expiryDate: fileTransfer.expiryDate,
          isPaymentRequired: fileTransfer.isPaymentRequired,
          paymentAmount: fileTransfer.paymentAmount,
          paymentCurrency: fileTransfer.paymentCurrency,
          isPaid: fileTransfer.isPaid,
          status: fileTransfer.status,
          downloadCount: fileTransfer.downloadCount,
          paymentInfo,
          isAccessible,
          // Nouvelles options
          passwordProtected: fileTransfer.passwordProtected || false,
          allowPreview: fileTransfer.allowPreview !== false, // true par défaut
        };

        return {
          success: true,
          message: isAccessible
            ? "Transfert de fichiers accessible"
            : "Paiement requis pour accéder aux fichiers",
          fileTransfer: fileTransferInfo,
        };
      } catch (error) {
        console.error(
          "Erreur lors de la récupération du transfert de fichiers:",
          error
        );
        throw new ApolloError(
          "Une erreur est survenue lors de la récupération du transfert de fichiers.",
          "FILE_TRANSFER_FETCH_ERROR"
        );
      }
    },
  },

  Mutation: {
    // Créer un nouveau transfert de fichiers
    createFileTransfer: isAuthenticated(
      async (_, { files, input = {} }, { user }) => {
        try {
          // Vérifier que des fichiers ont été fournis
          if (!files || files.length === 0) {
            throw new UserInputError("Aucun fichier fourni");
          }

          // Extraire les options du transfert
          const {
            isPaymentRequired = false,
            paymentAmount = 0,
            paymentCurrency = "EUR",
            recipientEmail,
          } = input;

          // Vérifier les options de paiement
          if (isPaymentRequired && (!paymentAmount || paymentAmount <= 0)) {
            throw new UserInputError("Montant de paiement invalide");
          }

          // Générer le lien de partage et la clé d'accès
          const shareLink = generateShareLink();
          const accessKey = generateAccessKey();

          // Calculer la date d'expiration (48 heures par défaut)
          const expiryDate = calculateExpiryDate(2);

          // Sauvegarder les fichiers
          const uploadedFiles = [];
          let totalSize = 0;

          for (const file of files) {
            const fileData = await saveUploadedFile(file, user.id);
            uploadedFiles.push(fileData);
            totalSize += fileData.size;
          }

          // Vérifier la taille totale
          if (totalSize > MAX_FILE_SIZE) {
            // Supprimer les fichiers téléchargés
            for (const file of uploadedFiles) {
              deleteFile(file.filePath);
            }

            throw new UserInputError(
              "La taille totale des fichiers dépasse la limite de 100 GB"
            );
          }

          // Créer le transfert de fichiers
          const fileTransfer = new FileTransfer({
            userId: user.id,
            files: uploadedFiles,
            totalSize,
            shareLink,
            accessKey,
            expiryDate,
            isPaymentRequired,
            paymentAmount: isPaymentRequired ? paymentAmount : 0,
            paymentCurrency,
            recipientEmail,
          });

          await fileTransfer.save();

          return {
            success: true,
            message: "Transfert de fichiers créé avec succès",
            fileTransfer,
            shareLink,
            accessKey,
          };
        } catch (error) {
          if (error instanceof UserInputError) {
            throw error;
          }

          console.error(
            "Erreur lors de la création du transfert de fichiers:",
            error
          );
          throw new ApolloError(
            "Une erreur est survenue lors de la création du transfert de fichiers.",
            "FILE_TRANSFER_CREATION_ERROR"
          );
        }
      }
    ),

    // Supprimer un transfert de fichiers
    deleteFileTransfer: isAuthenticated(async (_, { id }, { user }) => {
      try {
        const fileTransfer = await FileTransfer.findOne({
          _id: id,
          userId: user.id,
        });

        if (!fileTransfer) {
          throw new UserInputError("Transfert de fichiers non trouvé");
        }

        // Marquer comme supprimé plutôt que de supprimer réellement
        fileTransfer.status = "deleted";
        await fileTransfer.save();

        // Supprimer les fichiers physiquement (optionnel, peut être fait par un job de nettoyage)
        for (const file of fileTransfer.files) {
          deleteFile(file.filePath);
        }

        return true;
      } catch (error) {
        if (error instanceof UserInputError) {
          throw error;
        }

        console.error(
          "Erreur lors de la suppression du transfert de fichiers:",
          error
        );
        throw new ApolloError(
          "Une erreur est survenue lors de la suppression du transfert de fichiers.",
          "FILE_TRANSFER_DELETION_ERROR"
        );
      }
    }),

    // Créer un nouveau transfert de fichiers avec des fichiers en base64
    createFileTransferBase64: isAuthenticated(
      async (_, { files, input = {} }, { user }) => {
        try {
          // Vérifier que des fichiers ont été fournis
          if (!files || files.length === 0) {
            throw new UserInputError("Aucun fichier fourni");
          }

          // Extraire les options du transfert
          const {
            expiryDays = 2, // 48 heures par défaut
            isPaymentRequired = false,
            paymentAmount = 0,
            paymentCurrency = "EUR",
            recipientEmail,
          } = input;

          // Vérifier les valeurs
          if (expiryDays <= 0) {
            throw new UserInputError(
              "La durée d'expiration doit être supérieure à 0"
            );
          }

          if (isPaymentRequired && paymentAmount <= 0) {
            throw new UserInputError(
              "Le montant du paiement doit être supérieur à 0"
            );
          }

          // Sauvegarder les fichiers
          const uploadedFiles = [];
          let totalSize = 0;

          for (const file of files) {
            const fileData = await saveBase64File(file, user.id);
            uploadedFiles.push(fileData);
            totalSize += fileData.size;
          }

          // Vérifier la taille totale
          if (totalSize > MAX_FILE_SIZE) {
            // Supprimer les fichiers téléchargés
            for (const file of uploadedFiles) {
              deleteFile(file.filePath);
            }

            throw new UserInputError(
              `La taille totale des fichiers dépasse la limite autorisée (${
                MAX_FILE_SIZE / (1024 * 1024 * 1024)
              } GB)`
            );
          }

          // Générer le lien de partage et la clé d'accès
          const shareLink = generateShareLink();
          const accessKey = generateAccessKey();
          const expiryDate = calculateExpiryDate(expiryDays);

          // Créer le transfert de fichiers
          const fileTransfer = new FileTransfer({
            userId: user.id,
            files: uploadedFiles,
            totalSize,
            shareLink,
            accessKey,
            expiryDate,
            isPaymentRequired,
            paymentAmount: isPaymentRequired ? paymentAmount : 0,
            paymentCurrency: isPaymentRequired ? paymentCurrency : "EUR",
            isPaid: false,
            status: "active",
            recipientEmail,
            downloadLink: `${shareLink}-${Date.now()}`, // Ajout d'un downloadLink unique pour éviter l'erreur d'index
          });

          await fileTransfer.save();

          return {
            success: true,
            message: "Transfert de fichiers créé avec succès",
            fileTransfer,
            shareLink,
            accessKey,
          };
        } catch (error) {
          if (error instanceof UserInputError) {
            throw error;
          }

          console.error(
            "Erreur lors de la création du transfert de fichiers (base64):",
            error
          );
          throw new ApolloError(
            "Une erreur est survenue lors de la création du transfert de fichiers.",
            "FILE_TRANSFER_CREATION_ERROR"
          );
        }
      }
    ),

    // Générer un lien de paiement pour un transfert de fichiers
    generateFileTransferPaymentLink: async (_, { shareLink, accessKey }) => {
      try {
        const fileTransfer = await FileTransfer.findOne({
          shareLink,
          accessKey,
          status: "active",
          isPaymentRequired: true,
          isPaid: false,
        });

        if (!fileTransfer) {
          return {
            success: false,
            message: "Transfert de fichiers non trouvé ou paiement non requis",
            checkoutUrl: null,
          };
        }

        // Vérifier si le transfert est expiré
        if (fileTransfer.isExpired()) {
          return {
            success: false,
            message: "Ce lien de partage a expiré",
            checkoutUrl: null,
          };
        }

        // Créer une session de paiement Stripe
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: fileTransfer.paymentCurrency.toLowerCase(),
                product_data: {
                  name: "Accès aux fichiers partagés",
                  description: `Accès à ${fileTransfer.files.length} fichier(s) partagé(s)`,
                },
                unit_amount: Math.round(fileTransfer.paymentAmount * 100), // Stripe utilise les centimes
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          // Créer un customer Stripe et envoyer le reçu à l'email saisi
          customer_creation: "always",
          invoice_creation: {
            enabled: true,
            invoice_data: {
              description: `Accès aux fichiers partagés - ${fileTransfer.files.length} fichier(s)`,
            },
          },
          success_url: `${BASE_URL}/file-transfer/success?share=${shareLink}&key=${accessKey}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${BASE_URL}/file-transfer/cancel?share=${shareLink}&key=${accessKey}`,
          metadata: {
            fileTransferId: fileTransfer.id,
            shareLink,
            accessKey,
          },
        });

        return {
          success: true,
          message: "Lien de paiement généré avec succès",
          checkoutUrl: session.url,
        };
      } catch (error) {
        console.error(
          "Erreur lors de la génération du lien de paiement:",
          error
        );
        throw new ApolloError(
          "Une erreur est survenue lors de la génération du lien de paiement.",
          "PAYMENT_LINK_GENERATION_ERROR"
        );
      }
    },

    // Créer un transfert de fichiers à partir de documents partagés (ZIP unique)
    createFileTransferFromSharedDocuments: isAuthenticated(
      async (_, { documentIds = [], folderIds = [], workspaceId, input = {} }, { user }) => {
        try {
          // Valider qu'au moins un document ou dossier est sélectionné
          if ((!documentIds || documentIds.length === 0) && (!folderIds || folderIds.length === 0)) {
            throw new UserInputError("Veuillez sélectionner au moins un document ou dossier");
          }

          // 1. Construire la liste de documents avec leurs chemins ZIP
          const allDocumentsToZip = []; // { document, zipPath }

          // Traiter chaque dossier sélectionné
          if (folderIds && folderIds.length > 0) {
            for (const folderId of folderIds) {
              const folders = await getAllSubfolders(folderId, workspaceId);
              if (folders.length === 0) continue;

              const filteredFolderIds = folders.map((f) => f._id);
              const folderMap = new Map();
              folders.forEach((f) => folderMap.set(f._id.toString(), f));

              const docs = await SharedDocument.find({
                workspaceId,
                folderId: { $in: filteredFolderIds },
                trashedAt: null,
              });

              const rootFolder = folderMap.get(folderId);
              const rootFolderName = rootFolder ? sanitizeFileName(rootFolder.name) : "dossier";

              for (const doc of docs) {
                const folder = folderMap.get(doc.folderId?.toString());
                const folderPath = folder ? buildFolderPath(folder, folderMap, folderId) : "";
                const fileName = sanitizeFileName(doc.originalName || doc.name);
                const zipPath = folderPath
                  ? `${rootFolderName}/${folderPath}/${fileName}`
                  : `${rootFolderName}/${fileName}`;

                allDocumentsToZip.push({ document: doc, zipPath });
              }
            }
          }

          // Traiter les documents individuels
          if (documentIds && documentIds.length > 0) {
            const individualDocs = await SharedDocument.find({
              _id: { $in: documentIds },
              workspaceId,
              trashedAt: null,
            });

            for (const doc of individualDocs) {
              const fileName = sanitizeFileName(doc.originalName || doc.name);
              allDocumentsToZip.push({ document: doc, zipPath: fileName });
            }
          }

          if (allDocumentsToZip.length === 0) {
            throw new UserInputError("Aucun document trouvé dans la sélection");
          }

          // 2. Dédupliquer les chemins ZIP
          const usedPaths = new Map();
          for (const item of allDocumentsToZip) {
            let zipPath = item.zipPath;
            if (usedPaths.has(zipPath)) {
              const count = usedPaths.get(zipPath) + 1;
              usedPaths.set(zipPath, count);
              const ext = zipPath.lastIndexOf(".");
              if (ext > 0) {
                zipPath = `${zipPath.substring(0, ext)} (${count})${zipPath.substring(ext)}`;
              } else {
                zipPath = `${zipPath} (${count})`;
              }
              item.zipPath = zipPath;
            } else {
              usedPaths.set(zipPath, 0);
            }
          }

          // 3. Créer le ZIP en mémoire
          const archive = archiver("zip", { zlib: { level: 6 } });
          const passThrough = new PassThrough();
          const chunks = [];

          passThrough.on("data", (chunk) => chunks.push(chunk));

          const streamFinished = new Promise((resolve, reject) => {
            passThrough.on("end", resolve);
            passThrough.on("error", reject);
            archive.on("error", reject);
          });

          archive.pipe(passThrough);

          for (const { document: doc, zipPath } of allDocumentsToZip) {
            const getCmd = new GetObjectCommand({
              Bucket: SHARED_DOCUMENTS_BUCKET,
              Key: doc.fileKey,
            });
            const srcResponse = await sharedDocsS3Client.send(getCmd);
            archive.append(srcResponse.Body, { name: zipPath });
          }

          await archive.finalize();
          await streamFinished;

          const zipBuffer = Buffer.concat(chunks);

          // 4. Déterminer le nom du ZIP
          let zipName;
          if (folderIds?.length === 1 && (!documentIds || documentIds.length === 0)) {
            // Un seul dossier sélectionné → utiliser son nom
            const rootFolder = await SharedFolder.findById(folderIds[0]);
            zipName = rootFolder ? `${sanitizeFileName(rootFolder.name)}.zip` : "Documents.zip";
          } else {
            zipName = "Documents.zip";
          }

          // 5. Upload le ZIP vers le bucket transfers
          const transferId = crypto.randomUUID();
          const fileId = crypto.randomUUID();

          const result = await cloudflareTransferService.uploadFile(
            zipBuffer,
            transferId,
            fileId,
            zipName,
            "application/zip"
          );

          const filesInfo = [{
            originalName: zipName,
            displayName: zipName,
            fileName: zipName,
            filePath: result.url,
            r2Key: result.key,
            mimeType: "application/zip",
            size: result.size,
            storageType: "r2",
            fileId,
            uploadedAt: new Date(),
          }];

          // 6. Options du transfert (allowPreview toujours false pour les ZIP depuis docs partagés)
          const expiryDays = input?.expiryDays || 7;
          const recipientEmail = input?.recipientEmail || null;
          const message = input?.message || null;
          const notifyOnDownload = input?.notifyOnDownload || false;
          const passwordProtected = input?.passwordProtected || false;
          const password = input?.password || null;
          const expiryReminderEnabled = input?.expiryReminderEnabled || false;
          const hasWatermark = input?.hasWatermark || false;
          const paymentAmount = input?.paymentAmount || 0;
          const paymentCurrency = input?.paymentCurrency || input?.currency || "EUR";
          const isPaymentRequired =
            paymentAmount > 0 || input?.isPaymentRequired || input?.requirePayment || false;

          // 7. Créer le FileTransfer avec un seul fichier (le ZIP)
          const fileTransfer = new FileTransfer({
            userId: user.id,
            files: filesInfo,
            totalSize: result.size,
            status: "active",
            createdAt: new Date(),
            expiryDate: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000),
            isPaymentRequired,
            paymentAmount,
            paymentCurrency,
            recipientEmail,
            message,
            uploadMethod: "shared-documents",
            notifyOnDownload,
            passwordProtected,
            password: passwordProtected ? password : null,
            allowPreview: false, // Toujours désactivé pour les transferts ZIP depuis docs partagés
            expiryReminderEnabled,
            hasWatermark,
          });

          // Générer les liens de partage
          await fileTransfer.generateShareCredentials();
          await fileTransfer.save();

          // Envoyer l'email si un destinataire est spécifié
          if (
            recipientEmail &&
            process.env.SMTP_HOST &&
            process.env.SMTP_USER &&
            process.env.SMTP_PASS
          ) {
            try {
              const { sendFileTransferEmail } = await import("../utils/mailer.js");

              const transferData = {
                shareLink: fileTransfer.shareLink,
                accessKey: fileTransfer.accessKey,
                senderName:
                  user.firstName && user.lastName
                    ? `${user.firstName} ${user.lastName}`
                    : user.email,
                message,
                files: filesInfo,
                expiryDate: fileTransfer.expiryDate,
              };

              await sendFileTransferEmail(recipientEmail, transferData);
              console.log("📧 Email de transfert (shared docs ZIP) envoyé à:", recipientEmail);
            } catch (emailError) {
              console.error("❌ Erreur envoi email transfert (shared docs):", emailError);
            }
          }

          return {
            fileTransfer,
            shareLink: fileTransfer.shareLink,
            accessKey: fileTransfer.accessKey,
          };
        } catch (error) {
          if (error instanceof UserInputError) {
            throw error;
          }

          console.error("❌ Erreur création transfert ZIP depuis documents partagés:", error);
          throw new ApolloError(
            "Une erreur est survenue lors de la création du transfert depuis les documents partagés.",
            "FILE_TRANSFER_FROM_SHARED_DOCS_ERROR"
          );
        }
      }
    ),
  },
};
