import { ApolloError, UserInputError } from "apollo-server-express";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import {
  saveChunkToR2,
  areAllChunksReceivedOnR2,
  reconstructFileFromR2,
  cleanupChunksFromR2,
  uploadFileDirectToR2,
  uploadBase64FileToR2,
} from "../utils/chunkUploadR2Utils.js";
import cloudflareTransferService from "../services/cloudflareTransferService.js";
import FileTransfer from "../models/FileTransfer.js";
import { v4 as uuidv4 } from "uuid";
import { checkSubscriptionActive } from "../middlewares/rbac.js";

// Cache temporaire pour stocker les métadonnées des fichiers uploadés (avec TTL)
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const fileMetadataCache = new Map();
const cacheTimers = new Map();

function setCacheEntry(key, value) {
  fileMetadataCache.set(key, value);
  if (cacheTimers.has(key)) clearTimeout(cacheTimers.get(key));
  cacheTimers.set(
    key,
    setTimeout(() => {
      fileMetadataCache.delete(key);
      cacheTimers.delete(key);
    }, CACHE_TTL),
  );
}

function deleteCacheEntry(key) {
  fileMetadataCache.delete(key);
  if (cacheTimers.has(key)) {
    clearTimeout(cacheTimers.get(key));
    cacheTimers.delete(key);
  }
}

const getFileInfoByTransferId = async (fileId) => {
  // D'abord, vérifier le cache temporaire
  if (fileMetadataCache.has(fileId)) {
    const cachedInfo = fileMetadataCache.get(fileId);
    return cachedInfo;
  }

  // Rechercher par fileId dans les fichiers existants
  let fileTransfer = await FileTransfer.findOne({
    "files.fileId": fileId,
    uploadMethod: "chunk",
    storageType: "r2",
  });

  if (!fileTransfer) {
    // Fallback: rechercher par originalName (compatibilité)
    fileTransfer = await FileTransfer.findOne({
      "files.originalName": fileId,
      uploadMethod: "chunk",
    });
  }

  if (!fileTransfer) {
    throw new Error(`Transfert de fichier non trouvé pour fileId: ${fileId}`);
  }

  // Trouver le fichier spécifique
  let fileInfo = fileTransfer.files.find((file) => file.fileId === fileId);
  if (!fileInfo) {
    fileInfo = fileTransfer.files.find((file) => file.originalName === fileId);
  }

  if (!fileInfo) {
    throw new Error(
      `Fichier spécifique non trouvé dans le transfert: ${fileId}`,
    );
  }

  return fileInfo;
};

const chunkUploadR2Resolvers = {
  Mutation: {
    // Démarrer un multipart upload natif S3/R2
    startMultipartUpload: isAuthenticated(
      async (
        _,
        { transferId, fileId, fileName, fileSize, mimeType, totalParts },
        { user },
      ) => {
        try {
          if (!transferId || !fileId || !fileName || !fileSize || !totalParts) {
            throw new UserInputError(
              "Paramètres manquants: transferId, fileId, fileName, fileSize ou totalParts",
            );
          }

          if (totalParts < 1 || totalParts > 10000) {
            throw new UserInputError(
              "Le nombre de parts doit être entre 1 et 10000",
            );
          }

          // Déterminer le type MIME si non fourni
          const ext = fileName.split(".").pop()?.toLowerCase();
          const mimeTypes = {
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            pdf: "application/pdf",
            doc: "application/msword",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            txt: "text/plain",
            zip: "application/zip",
            rar: "application/x-rar-compressed",
            "7z": "application/x-7z-compressed",
          };
          const finalMimeType =
            mimeType || mimeTypes[ext] || "application/octet-stream";

          console.log(
            `🚀 Démarrage Multipart Upload pour ${fileName} (${(
              fileSize /
              1024 /
              1024
            ).toFixed(2)} MB, ${totalParts} parts)`,
          );

          const result = await cloudflareTransferService.startMultipartUpload(
            transferId,
            fileId,
            fileName,
            fileSize,
            finalMimeType,
            totalParts,
          );

          return {
            uploadId: result.uploadId,
            key: result.key,
            presignedUrls: result.presignedUrls,
          };
        } catch (error) {
          console.error("❌ Erreur démarrage multipart upload:", error);

          if (error instanceof UserInputError) {
            throw error;
          }

          throw new ApolloError(
            "Une erreur est survenue lors du démarrage du multipart upload.",
            "MULTIPART_START_ERROR",
          );
        }
      },
    ),

    // Compléter un multipart upload
    completeMultipartUpload: isAuthenticated(
      async (_, { uploadId, key, parts, transferId, fileId }, { user }) => {
        try {
          if (!uploadId || !key || !parts || parts.length === 0) {
            throw new UserInputError(
              "Paramètres manquants: uploadId, key ou parts",
            );
          }

          console.log(
            `🔧 Finalisation Multipart Upload: ${key} (${parts.length} parts)`,
          );

          const result =
            await cloudflareTransferService.completeMultipartUpload(
              uploadId,
              key,
              parts,
            );

          // ✅ CORRECTION: Extraire le nom original en retirant le préfixe f_fileId_
          const keyFileName = key.split("/").pop(); // Ex: f_99bc5d90-b713-4250-be02-ab0ff68203d9_Capture.png
          const cleanOriginalName = keyFileName.replace(/^f_[a-f0-9-]+_/, ""); // Retirer f_fileId_

          console.log(
            `📝 Nettoyage du nom: "${keyFileName}" → "${cleanOriginalName}"`,
          );

          // Stocker les métadonnées dans le cache
          const fileMetadata = {
            originalName: cleanOriginalName, // ✅ Nom propre sans ID
            displayName: cleanOriginalName, // ✅ Nom propre sans ID
            fileName: keyFileName, // Nom complet avec ID pour le stockage
            filePath: result.url,
            r2Key: result.key,
            mimeType: "application/octet-stream",
            size: result.size,
            storageType: "r2",
            fileId: fileId,
            uploadedAt: new Date(),
          };

          setCacheEntry(fileId, fileMetadata);

          return {
            success: true,
            key: result.key,
            url: result.url,
            size: result.size,
            etag: result.etag,
            fileId: fileId,
          };
        } catch (error) {
          console.error("❌ Erreur finalisation multipart upload:", error);

          // En cas d'erreur, annuler le multipart upload
          if (uploadId && key) {
            try {
              await cloudflareTransferService.abortMultipartUpload(
                uploadId,
                key,
              );
            } catch (abortError) {
              console.error("Erreur annulation multipart:", abortError);
            }
          }

          if (error instanceof UserInputError) {
            throw error;
          }

          throw new ApolloError(
            "Une erreur est survenue lors de la finalisation du multipart upload.",
            "MULTIPART_COMPLETE_ERROR",
          );
        }
      },
    ),

    // Générer des URLs signées pour upload direct vers R2
    generatePresignedUploadUrls: isAuthenticated(
      async (_, { fileId, totalChunks, fileName }, { user }) => {
        try {
          if (!fileId || !fileName || !totalChunks) {
            throw new UserInputError(
              "Paramètres manquants: fileId, fileName ou totalChunks",
            );
          }

          if (totalChunks < 1 || totalChunks > 10000) {
            throw new UserInputError(
              "Le nombre de chunks doit être entre 1 et 10000",
            );
          }

          // Générer un transferId temporaire
          const transferId = `temp_${fileId}`;

          console.log(
            `🔑 Génération de ${totalChunks} URLs signées pour ${fileName}`,
          );

          // Générer toutes les URLs signées en parallèle
          const urlPromises = [];
          for (let i = 0; i < totalChunks; i++) {
            urlPromises.push(
              (async () => {
                const { uploadUrl, key, chunkIndex } =
                  await cloudflareTransferService.generatePresignedUploadUrl(
                    transferId,
                    fileId,
                    i,
                    fileName,
                    3600, // 1 heure de validité
                  );

                return {
                  chunkIndex,
                  uploadUrl,
                  key,
                };
              })(),
            );
          }

          const uploadUrls = await Promise.all(urlPromises);

          console.log(
            `✅ ${uploadUrls.length} URLs signées générées pour ${fileName}`,
          );

          return {
            fileId,
            transferId,
            uploadUrls,
            expiresIn: 3600,
          };
        } catch (error) {
          console.error("❌ Erreur génération URLs signées:", error);

          if (error instanceof UserInputError) {
            throw error;
          }

          throw new ApolloError(
            "Une erreur est survenue lors de la génération des URLs signées.",
            "PRESIGNED_URL_GENERATION_ERROR",
          );
        }
      },
    ),

    // Confirmer qu'un chunk a été uploadé directement vers R2
    confirmChunkUploadedToR2: isAuthenticated(
      async (
        _,
        { fileId, chunkIndex, totalChunks, fileName, fileSize },
        { user },
      ) => {
        try {
          if (!fileId || chunkIndex === undefined || !totalChunks) {
            throw new UserInputError(
              "Paramètres manquants: fileId, chunkIndex ou totalChunks",
            );
          }

          // Vérifier si c'est le dernier chunk
          const isLastChunk = chunkIndex === totalChunks - 1;

          let fileInfo = null;

          if (isLastChunk) {
            const transferId = `temp_${fileId}`;

            // Vérifier que tous les chunks sont présents
            const allChunksReceived = await areAllChunksReceivedOnR2(
              transferId,
              fileId,
              totalChunks,
            );

            if (!allChunksReceived) {
              throw new Error(
                `Tous les chunks ne sont pas présents pour le fichier ${fileId}`,
              );
            }

            // Déterminer le type MIME
            const ext = fileName.split(".").pop()?.toLowerCase();
            const mimeTypes = {
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              png: "image/png",
              pdf: "application/pdf",
              doc: "application/msword",
              docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              txt: "text/plain",
              zip: "application/zip",
            };
            const mimeType = mimeTypes[ext] || "application/octet-stream";

            // Reconstruire le fichier
            fileInfo = await reconstructFileFromR2(
              transferId,
              fileId,
              fileName,
              totalChunks,
              mimeType,
            );

            // Stocker les métadonnées dans le cache
            const fileMetadata = {
              originalName: fileInfo.originalName,
              displayName: fileInfo.displayName,
              fileName: fileInfo.fileName,
              filePath: fileInfo.filePath,
              r2Key: fileInfo.r2Key,
              mimeType: fileInfo.mimeType,
              size: fileInfo.size,
              storageType: "r2",
              fileId: fileId,
              uploadedAt: new Date(),
            };

            setCacheEntry(fileId, fileMetadata);
          }

          return {
            chunkReceived: true,
            fileCompleted: isLastChunk,
            fileId,
            fileName: fileInfo ? fileInfo.fileName : null,
            filePath: fileInfo ? fileInfo.filePath : null,
            storageType: "r2",
          };
        } catch (error) {
          console.error("❌ Erreur confirmation chunk:", error);

          if (error instanceof UserInputError) {
            throw error;
          }

          throw new ApolloError(
            "Une erreur est survenue lors de la confirmation du chunk.",
            "CHUNK_CONFIRMATION_ERROR",
          );
        }
      },
    ),

    // Uploader un chunk de fichier vers R2
    uploadFileChunkToR2: isAuthenticated(
      async (
        _,
        { chunk, fileId, chunkIndex, totalChunks, fileName, fileSize },
        { user },
      ) => {
        try {
          // Vérifier que les paramètres sont valides
          if (!fileId || !fileName) {
            throw new UserInputError(
              "Identifiant de fichier ou nom de fichier manquant",
            );
          }

          if (chunkIndex < 0 || chunkIndex >= totalChunks) {
            throw new UserInputError("Index de chunk invalide");
          }

          // Générer un transferId temporaire pour ce fichier
          const transferId = `temp_${fileId}`;

          // Sauvegarder le chunk sur R2
          const chunkInfo = await saveChunkToR2(
            chunk,
            fileId,
            chunkIndex,
            fileName,
            transferId,
          );

          // Vérifier si c'est le dernier chunk (index commence à 0)
          const isLastChunk = chunkIndex === totalChunks - 1;

          // Si tous les chunks sont reçus, reconstruire le fichier
          let fileInfo = null;
          let fileTransferId = null;

          if (isLastChunk) {
            // Double vérification : s'assurer que tous les chunks sont bien présents
            const allChunksReceived = await areAllChunksReceivedOnR2(
              transferId,
              fileId,
              totalChunks,
            );

            if (!allChunksReceived) {
              throw new Error(
                `Tous les chunks ne sont pas présents pour le fichier ${fileId}`,
              );
            }
            // Déterminer le type MIME
            const ext = fileName.split(".").pop()?.toLowerCase();
            const mimeTypes = {
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              png: "image/png",
              pdf: "application/pdf",
              doc: "application/msword",
              docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              txt: "text/plain",
              zip: "application/zip",
            };
            const mimeType = mimeTypes[ext] || "application/octet-stream";

            // Reconstruire le fichier à partir des chunks
            fileInfo = await reconstructFileFromR2(
              transferId,
              fileId,
              fileName,
              totalChunks,
              mimeType,
            );

            // Stocker les métadonnées du fichier dans le cache temporaire
            const fileMetadata = {
              originalName: fileInfo.originalName,
              displayName: fileInfo.displayName,
              fileName: fileInfo.fileName,
              filePath: fileInfo.filePath,
              r2Key: fileInfo.r2Key,
              mimeType: fileInfo.mimeType,
              size: fileInfo.size,
              storageType: "r2",
              fileId: fileId,
              uploadedAt: new Date(),
            };

            // Ajouter au cache temporaire pour la création du transfert
            setCacheEntry(fileId, fileMetadata);
          }

          return {
            chunkReceived: true,
            fileCompleted: isLastChunk,
            fileId,
            fileName: fileInfo ? fileInfo.fileName : null,
            filePath: fileInfo ? fileInfo.filePath : null,
            fileTransferId: fileTransferId,
            storageType: "r2",
          };
        } catch (error) {
          // En cas d'erreur, nettoyer les chunks temporaires
          await cleanupChunksFromR2(`temp_${fileId}`, fileId, totalChunks);

          if (error instanceof UserInputError) {
            throw error;
          }

          console.error("❌ Erreur lors de l'upload du chunk vers R2:", error);
          throw new ApolloError(
            "Une erreur est survenue lors de l'upload du chunk vers R2.",
            "CHUNK_UPLOAD_R2_ERROR",
          );
        }
      },
    ),

    // Créer un transfert de fichier à partir des IDs de fichiers déjà uploadés en chunks sur R2
    createFileTransferWithIdsR2: isAuthenticated(
      async (_, { fileIds, input }, { user }) => {
        try {
          // Vérifier que les IDs de fichiers sont fournis
          if (!fileIds || fileIds.length === 0) {
            throw new UserInputError("Aucun ID de fichier fourni");
          }

          // Récupérer les informations de chaque fichier
          const filesInfo = [];
          let totalSize = 0;

          for (const fileId of fileIds) {
            try {
              // Récupérer les informations du fichier à partir du transfert temporaire
              const fileInfo = await getFileInfoByTransferId(fileId);

              // Ajouter les informations du fichier à la liste
              filesInfo.push({
                originalName: fileInfo.originalName,
                displayName: fileInfo.displayName || fileInfo.originalName,
                fileName: fileInfo.fileName,
                filePath: fileInfo.filePath,
                r2Key: fileInfo.r2Key,
                mimeType: fileInfo.mimeType,
                size: fileInfo.size,
                storageType: "r2",
                fileId: fileInfo.fileId || fileId,
                uploadedAt: fileInfo.uploadedAt || new Date(),
              });

              // Ajouter la taille du fichier au total
              totalSize += fileInfo.size;
            } catch (error) {
              throw new ApolloError(
                `Impossible de récupérer les informations du fichier ${fileId}`,
                "FILE_NOT_FOUND",
              );
            }
          }

          // Définir les options du transfert de fichier
          const expiryDays = input?.expiryDays || 7;
          const workspaceId = input?.workspaceId || null;
          const paymentAmount = input?.paymentAmount || 0;
          const paymentCurrency =
            input?.paymentCurrency || input?.currency || "EUR";
          // isPaymentRequired doit être true si paymentAmount > 0 OU si explicitement défini à true
          const isPaymentRequired =
            paymentAmount > 0 ||
            input?.isPaymentRequired ||
            input?.requirePayment ||
            false;
          const recipientEmail = input?.recipientEmail || null;
          const message = input?.message || null;

          // Nouvelles options
          const notifyOnDownload = input?.notifyOnDownload || false;
          const passwordProtected = input?.passwordProtected || false;
          const password = input?.password || null;
          const allowPreview = input?.allowPreview !== false; // true par défaut
          const expiryReminderEnabled = input?.expiryReminderEnabled || false;
          const hasWatermark = input?.hasWatermark || false;

          // Créer un nouveau transfert de fichier
          const fileTransfer = new FileTransfer({
            userId: user.id,
            workspaceId,
            files: filesInfo,
            totalSize,
            status: "active",
            createdAt: new Date(),
            expiryDate: new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000),
            isPaymentRequired,
            paymentAmount,
            paymentCurrency,
            recipientEmail,
            message,
            uploadMethod: "chunk",
            // Nouvelles options
            notifyOnDownload,
            passwordProtected,
            password: passwordProtected ? password : null,
            allowPreview,
            expiryReminderEnabled,
            hasWatermark,
          });

          // Générer les liens de partage et clé d'accès
          await fileTransfer.generateShareCredentials();

          // Sauvegarder le transfert de fichier
          await fileTransfer.save();

          // Envoyer l'email si un destinataire est spécifié et si SMTP est configuré
          if (
            recipientEmail &&
            process.env.SMTP_HOST &&
            process.env.SMTP_USER &&
            process.env.SMTP_PASS
          ) {
            try {
              const { sendFileTransferEmail } =
                await import("../utils/mailer.js");

              const transferData = {
                shareLink: fileTransfer.shareLink,
                accessKey: fileTransfer.accessKey,
                senderName:
                  user.firstName && user.lastName
                    ? `${user.firstName} ${user.lastName}`
                    : user.email,
                message: message,
                files: filesInfo,
                expiryDate: fileTransfer.expiryDate,
              };

              const emailSent = await sendFileTransferEmail(
                recipientEmail,
                transferData,
              );

              if (emailSent) {
                console.log(
                  "📧 Email de transfert envoyé avec succès à:",
                  recipientEmail,
                );
              } else {
                console.warn(
                  "⚠️ Échec de l'envoi de l'email de transfert à:",
                  recipientEmail,
                );
              }
            } catch (emailError) {
              console.error(
                "❌ Erreur lors de l'envoi de l'email de transfert:",
                emailError,
              );
              // Ne pas faire échouer la création du transfert si l'email échoue
            }
          } else if (recipientEmail) {
            console.log(
              "📧 Email destinataire fourni mais SMTP non configuré. Lien de partage:",
              `${
                process.env.FRONTEND_URL || "http://localhost:3000"
              }/transfer/${fileTransfer.shareLink}?accessKey=${
                fileTransfer.accessKey
              }`,
            );
          }

          // Retourner le transfert de fichier créé
          return {
            fileTransfer,
            shareLink: fileTransfer.shareLink,
            accessKey: fileTransfer.accessKey,
          };
        } catch (error) {
          console.error(
            "❌ Erreur lors de la création du transfert de fichier R2:",
            error,
          );

          if (error instanceof UserInputError) {
            throw error;
          }

          throw new ApolloError(
            "Une erreur est survenue lors de la création du transfert de fichier R2.",
            "FILE_TRANSFER_R2_CREATION_ERROR",
          );
        }
      },
    ),

    // Upload direct d'un fichier vers R2
    uploadFileDirectToR2: isAuthenticated(
      async (_, { file, transferId }, { user }) => {
        try {
          if (!file) {
            throw new UserInputError("Aucun fichier fourni");
          }

          // Générer un ID unique pour le fichier
          const fileId = uuidv4();

          // Générer un transferId si non fourni
          if (!transferId) {
            transferId = uuidv4();
          }

          // Upload direct vers R2
          const fileInfo = await uploadFileDirectToR2(file, transferId, fileId);

          return {
            fileId,
            fileName: fileInfo.fileName,
            filePath: fileInfo.filePath,
            r2Key: fileInfo.r2Key,
            size: fileInfo.size,
            mimeType: fileInfo.mimeType,
            storageType: "r2",
          };
        } catch (error) {
          console.error("❌ Erreur lors de l'upload direct vers R2:", error);

          if (error instanceof UserInputError) {
            throw error;
          }

          throw new ApolloError(
            "Une erreur est survenue lors de l'upload direct vers R2.",
            "DIRECT_UPLOAD_R2_ERROR",
          );
        }
      },
    ),

    // Upload d'un fichier base64 vers R2
    uploadBase64FileToR2: isAuthenticated(
      async (_, { fileInput, transferId }, { user }) => {
        try {
          if (!fileInput) {
            throw new UserInputError("Aucune donnée de fichier fournie");
          }

          // Générer un ID unique pour le fichier
          const fileId = uuidv4();

          // Générer un transferId si non fourni
          if (!transferId) {
            transferId = uuidv4();
          }

          // Upload base64 vers R2
          const fileInfo = await uploadBase64FileToR2(
            fileInput,
            transferId,
            fileId,
          );

          return {
            fileId,
            fileName: fileInfo.fileName,
            filePath: fileInfo.filePath,
            r2Key: fileInfo.r2Key,
            size: fileInfo.size,
            mimeType: fileInfo.mimeType,
            storageType: "r2",
          };
        } catch (error) {
          console.error("❌ Erreur lors de l'upload base64 vers R2:", error);

          if (error instanceof UserInputError) {
            throw error;
          }

          throw new ApolloError(
            "Une erreur est survenue lors de l'upload base64 vers R2.",
            "BASE64_UPLOAD_R2_ERROR",
          );
        }
      },
    ),
  },
};

// ✅ Phase A.4 — Subscription check on all chunk upload R2 mutations
Object.keys(chunkUploadR2Resolvers.Mutation).forEach((name) => {
  const original = chunkUploadR2Resolvers.Mutation[name];
  chunkUploadR2Resolvers.Mutation[name] = async (
    parent,
    args,
    context,
    info,
  ) => {
    await checkSubscriptionActive(context);
    return original(parent, args, context, info);
  };
});

export default chunkUploadR2Resolvers;
