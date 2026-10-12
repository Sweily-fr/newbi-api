import logger from "../utils/logger.js";
import { ApolloError, UserInputError } from "apollo-server-express";
import { requireTransferActionFromInput } from "./fileTransfer.js";
import { userBelongsToWorkspace } from "../utils/workspace-membership.js";
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
import { cacheGet, cacheSet, cacheDel } from "../config/redis.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";

// 🔐 Envoi des fichiers et création du transfert : même droit que
// createFileTransfer (« Créer » du module Transferts dans l'espace du
// transfert : input.workspaceId, sinon l'en-tête x-organization-id). Ces
// mutations n'exigeaient qu'un utilisateur connecté, un rôle sans ce droit
// pouvait donc créer des transferts depuis le desktop ou l'app mobile.
const requireTransferCreate = requireTransferActionFromInput("create");

// Cache temporaire pour stocker les métadonnées des fichiers uploadés (avec TTL).
// Le transfert n'est créé qu'une fois TOUS les fichiers envoyés : sur un lot
// de grosses vidéos envoyé en 4G, le premier fichier pouvait sortir du cache
// (30 min auparavant) avant la fin du dernier, et la création échouait
// (FILE_NOT_FOUND). 24 h couvre les envois les plus longs.
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 heures
const CACHE_TTL_SECONDS = 24 * 60 * 60; // idem en secondes pour Redis
// Cache mémoire L1 (rapide, mais local à l'instance PM2)
const fileMetadataCache = new Map();
const cacheTimers = new Map();

// Préfixe des clés Redis (cache L2 partagé entre toutes les instances PM2)
const redisMetaKey = (fileId) => `filetransfer:meta:${fileId}`;

async function setCacheEntry(key, value) {
  // L1 : mémoire locale
  fileMetadataCache.set(key, value);
  if (cacheTimers.has(key)) clearTimeout(cacheTimers.get(key));
  cacheTimers.set(
    key,
    setTimeout(() => {
      fileMetadataCache.delete(key);
      cacheTimers.delete(key);
    }, CACHE_TTL),
  );
  // L2 : Redis partagé — indispensable en mode cluster, l'upload et la
  // création de transfert pouvant être traités par des instances différentes.
  // On attend l'écriture pour qu'elle soit durable avant que la mutation
  // d'upload ne réponde au client (qui enchaîne sur la création du transfert).
  // Best-effort : cacheSet est silencieux si Redis est indisponible.
  await cacheSet(redisMetaKey(key), value, CACHE_TTL_SECONDS);
}

function deleteCacheEntry(key) {
  fileMetadataCache.delete(key);
  if (cacheTimers.has(key)) {
    clearTimeout(cacheTimers.get(key));
    cacheTimers.delete(key);
  }
  void cacheDel(redisMetaKey(key));
}

// Entrée du cache (mémoire puis Redis), sans la recherche de repli dans les
// transferts existants de getFileInfoByTransferId
async function getCacheEntry(key) {
  if (fileMetadataCache.has(key)) return fileMetadataCache.get(key);
  const redisInfo = await cacheGet(redisMetaKey(key));
  if (redisInfo) fileMetadataCache.set(key, redisInfo);
  return redisInfo || null;
}

// Envoi multipart démarré : clé R2, utilisateur et espace, gardés 24 h comme
// les métadonnées des fichiers, pour n'autoriser sa finalisation, son
// annulation ou sa reprise qu'à celui qui l'a démarré. Une fois finalisé,
// l'entrée reste (completedAt, fileId, result) : une finalisation rejouée
// (réponse perdue) renvoie le même résultat, et la reprise d'un envoi
// interrompu (app mobile fermée) sait que ce fichier est prêt.
const multipartCacheKey = (uploadId) => `multipart:${uploadId}`;

// Nombre maximal de parts d'un envoi multipart (limite S3/R2)
const MAX_MULTIPART_PARTS = 10000;

const userIdOf = (user) => String(user?._id || user?.id || "");

// Envoi que R2 ne connaît plus (annulé, ou purgé par R2)
const isNoSuchUpload = (error) =>
  error?.name === "NoSuchUpload" || error?.Code === "NoSuchUpload";

/**
 * Envoi multipart démarré par cet utilisateur, dans cet espace, pour cette
 * clé : FORBIDDEN sinon. Utilisé par completeMultipartUpload et
 * refreshMultipartUploadUrls ; abortMultipartUpload et
 * listMultipartUploadParts traitent un envoi inconnu sans erreur.
 * @returns {Promise<object|null>} l'entrée, null si l'envoi est inconnu
 */
async function findOwnedMultipartUpload(uploadId, key, user, workspaceId) {
  const entry = await getCacheEntry(multipartCacheKey(uploadId));
  if (!entry) return null;
  if (
    entry.key !== key ||
    entry.userId !== userIdOf(user) ||
    (entry.workspaceId || null) !== (workspaceId ? String(workspaceId) : null)
  ) {
    throw new AppError(
      "Cet envoi n'existe pas ou ne vous appartient pas.",
      ERROR_CODES.FORBIDDEN,
    );
  }
  return entry;
}

/**
 * Supprime de R2 les fichiers déjà finalisés d'un lot dont le transfert n'a
 * pas pu être créé : sans transfert, rien ne les référence ni ne les purge.
 * Seuls les fichiers envoyés par cet utilisateur (métadonnées en cache) et
 * absents de tout transfert enregistré sont supprimés.
 */
async function discardUploadedFiles(fileIds, user) {
  try {
    const uploaderId = userIdOf(user);
    const candidates = [];
    for (const fileId of fileIds || []) {
      const entry = await getCacheEntry(fileId);
      if (entry?.r2Key && uploaderId && entry.uploadedBy === uploaderId) {
        candidates.push({ fileId, r2Key: entry.r2Key });
      }
    }
    if (candidates.length === 0) return;

    const referenced = new Set(
      await FileTransfer.distinct("files.r2Key", {
        "files.r2Key": { $in: candidates.map((c) => c.r2Key) },
      }),
    );
    const orphans = candidates.filter((c) => !referenced.has(c.r2Key));
    if (orphans.length === 0) return;

    await cloudflareTransferService.deleteFiles(orphans.map((c) => c.r2Key));
    for (const { fileId } of orphans) deleteCacheEntry(fileId);
    logger.info(
      `🧹 ${orphans.length} fichier(s) d'un lot sans transfert supprimé(s) de R2`,
    );
  } catch (error) {
    logger.warn(
      `Nettoyage des fichiers d'un lot sans transfert impossible : ${error.message}`,
    );
  }
}

// 🔐 Fichier envoyé par cet utilisateur uniquement. Le fileId figure dans
// les fichiers d'un transfert remis à ses destinataires : la recherche de
// repli dans tous les transferts permettait à un destinataire de recréer à
// son nom un transfert avec les fichiers d'un autre, sans mot de passe ni
// paiement. Une entrée de cache sans uploadedBy (écrite avant cette
// version, 24 h au plus) reste acceptée.
const getFileInfoByTransferId = async (fileId, user) => {
  const uploaderId = userIdOf(user);
  if (!uploaderId) {
    throw new Error("Utilisateur requis pour retrouver un fichier envoyé");
  }

  // 1) Cache mémoire local (L1), puis 2) Redis partagé (L2) : couvre le cas
  //    cluster où l'upload a été traité par une autre instance que la
  //    création du transfert.
  const cachedInfo = await getCacheEntry(fileId);
  if (cachedInfo) {
    if (cachedInfo.uploadedBy && cachedInfo.uploadedBy !== uploaderId) {
      throw new Error(`Fichier ${fileId} envoyé par un autre utilisateur`);
    }
    return cachedInfo;
  }

  // 3) Repli : rechercher par fileId dans les transferts de cet utilisateur
  //    (storageType est porté par le sous-document `files`, pas la racine).
  let fileTransfer = await FileTransfer.findOne({
    userId: uploaderId,
    "files.fileId": fileId,
    uploadMethod: "chunk",
    "files.storageType": "r2",
  });

  if (!fileTransfer) {
    // Fallback: rechercher par originalName (compatibilité)
    fileTransfer = await FileTransfer.findOne({
      userId: uploaderId,
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
    startMultipartUpload: requireTransferCreate(
      async (
        _,
        { transferId, fileId, fileName, fileSize, mimeType, totalParts },
        { user, workspaceId },
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

          logger.debug(
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

          await setCacheEntry(multipartCacheKey(result.uploadId), {
            key: result.key,
            userId: userIdOf(user),
            workspaceId: workspaceId ? String(workspaceId) : null,
            fileId,
            transferId,
            totalParts,
            startedAt: Date.now(),
          });

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
    completeMultipartUpload: requireTransferCreate(
      async (
        _,
        { uploadId, key, parts, transferId, fileId },
        { user, workspaceId },
      ) => {
        if (!uploadId || !key || !parts || parts.length === 0) {
          throw new UserInputError(
            "Paramètres manquants: uploadId, key ou parts",
          );
        }

        // 🔐 Envoi démarré par l'appelant (mêmes règles que
        // abortMultipartUpload). Contrôlé hors du try : un refus ne doit
        // surtout pas déclencher l'annulation de l'envoi d'un autre.
        // Envoi inconnu (plus de 24 h, ou démarré avant cette version) :
        // refusé aussi, l'application relance l'envoi.
        const ownedUpload = await findOwnedMultipartUpload(
          uploadId,
          key,
          user,
          workspaceId,
        );
        if (!ownedUpload) {
          throw new AppError(
            "Cet envoi a expiré ou n'existe pas. Relancez l'envoi.",
            ERROR_CODES.FORBIDDEN,
          );
        }

        // Déjà finalisé (réponse perdue, ou reprise après une fermeture de
        // l'app) : même résultat, sans rappeler R2 ni annuler l'envoi
        if (ownedUpload.completedAt) {
          if (ownedUpload.fileId !== fileId || !ownedUpload.result) {
            throw new AppError(
              "Cet envoi est déjà finalisé.",
              ERROR_CODES.FORBIDDEN,
            );
          }
          return { success: true, ...ownedUpload.result, fileId };
        }

        try {
          logger.debug(
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

          logger.debug(
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
            uploadedBy: userIdOf(user),
          };

          await setCacheEntry(fileId, fileMetadata);
          // Envoi terminé : plus rien à annuler, mais la finalisation reste
          // connue (voir multipartCacheKey)
          const completedResult = {
            key: result.key,
            url: result.url,
            size: result.size,
            etag: result.etag || null,
          };
          await setCacheEntry(multipartCacheKey(uploadId), {
            ...ownedUpload,
            fileId,
            completedAt: Date.now(),
            result: completedResult,
          });

          return {
            success: true,
            ...completedResult,
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

    // Annuler un envoi multipart en cours (échec ou annulation côté client) :
    // sans cela, les parts déjà envoyées restaient stockées sur R2.
    // true : envoi annulé (R2 l'avait peut-être déjà purgé) ; false : envoi
    // inconnu (déjà finalisé, métadonnées expirées après 24 h ou envoi
    // démarré avant cette version) ; FORBIDDEN : envoi démarré par un autre
    // utilisateur, dans un autre espace, ou clé différente.
    abortMultipartUpload: requireTransferCreate(
      async (_, { uploadId, key }, { user, workspaceId }) => {
        if (!uploadId || !key) {
          throw new UserInputError("Paramètres manquants: uploadId ou key");
        }

        const entry = await findOwnedMultipartUpload(
          uploadId,
          key,
          user,
          workspaceId,
        );
        // Inconnu, ou déjà finalisé : plus rien à annuler (le fichier
        // finalisé n'est surtout pas touché)
        if (!entry || entry.completedAt) return false;

        try {
          await cloudflareTransferService.abortMultipartUpload(uploadId, key);
        } catch (error) {
          // Déjà terminé ou déjà annulé : plus rien à annuler
          if (!isNoSuchUpload(error)) {
            logger.error(
              `Erreur annulation multipart ${uploadId}: ${error.message}`,
            );
            throw new ApolloError(
              "Une erreur est survenue lors de l'annulation de l'envoi.",
              "MULTIPART_ABORT_ERROR",
            );
          }
        }

        deleteCacheEntry(multipartCacheKey(uploadId));
        return true;
      },
    ),

    // Reprise d'un envoi interrompu (app mobile fermée pendant l'envoi) :
    // parts déjà reçues par R2, pour ne renvoyer que les manquantes.
    // null : envoi inconnu (métadonnées expirées après 24 h, envoi annulé
    // ou démarré avant cette version), à recommencer ; completed : envoi
    // déjà finalisé, fichier prêt (fileId) ; FORBIDDEN : envoi d'un autre
    // utilisateur, d'un autre espace ou clé différente.
    listMultipartUploadParts: requireTransferCreate(
      async (_, { uploadId, key }, { user, workspaceId }) => {
        if (!uploadId || !key) {
          throw new UserInputError("Paramètres manquants: uploadId ou key");
        }

        const entry = await findOwnedMultipartUpload(
          uploadId,
          key,
          user,
          workspaceId,
        );
        if (!entry) return null;

        const summary = {
          fileId: entry.fileId || null,
          totalParts: Number.isInteger(entry.totalParts)
            ? entry.totalParts
            : null,
        };
        if (entry.completedAt) {
          return { ...summary, completed: true, parts: [] };
        }

        try {
          const parts =
            await cloudflareTransferService.listMultipartUploadParts(
              uploadId,
              key,
            );
          return { ...summary, completed: false, parts };
        } catch (error) {
          // Annulé ou purgé par R2 : rien à reprendre
          if (isNoSuchUpload(error)) {
            deleteCacheEntry(multipartCacheKey(uploadId));
            return null;
          }
          logger.error(
            `Erreur lecture des parts multipart ${uploadId}: ${error.message}`,
          );
          throw new ApolloError(
            "Une erreur est survenue lors de la lecture de l'envoi.",
            "MULTIPART_LIST_ERROR",
          );
        }
      },
    ),

    // Nouvelles URL présignées pour des parts d'un envoi en cours : à la
    // reprise d'un envoi interrompu, celles remises au démarrage ont pu
    // expirer (12 h). Mêmes contrôles que la finalisation ; l'envoi reste
    // borné par ses métadonnées (24 h après son démarrage).
    refreshMultipartUploadUrls: requireTransferCreate(
      async (_, { uploadId, key, partNumbers }, { user, workspaceId }) => {
        if (!uploadId || !key) {
          throw new UserInputError("Paramètres manquants: uploadId ou key");
        }
        if (!Array.isArray(partNumbers) || partNumbers.length === 0) {
          throw new UserInputError("Aucune part demandée");
        }

        const entry = await findOwnedMultipartUpload(
          uploadId,
          key,
          user,
          workspaceId,
        );
        if (!entry || entry.completedAt) {
          throw new AppError(
            "Cet envoi a expiré ou n'existe pas. Relancez l'envoi.",
            ERROR_CODES.FORBIDDEN,
          );
        }

        // Parts de cet envoi uniquement (nombre connu depuis son démarrage)
        const maxPart = Number.isInteger(entry.totalParts)
          ? entry.totalParts
          : MAX_MULTIPART_PARTS;
        const unique = [...new Set(partNumbers)];
        if (unique.some((n) => !Number.isInteger(n) || n < 1 || n > maxPart)) {
          throw new UserInputError("Numéro de part invalide");
        }

        try {
          return await cloudflareTransferService.generateMultipartPartUrls(
            uploadId,
            key,
            unique,
          );
        } catch (error) {
          logger.error(
            `Erreur génération des URL multipart ${uploadId}: ${error.message}`,
          );
          throw new ApolloError(
            "Une erreur est survenue lors de la préparation de l'envoi.",
            "MULTIPART_URLS_ERROR",
          );
        }
      },
    ),

    // Générer des URLs signées pour upload direct vers R2
    generatePresignedUploadUrls: requireTransferCreate(
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

          logger.debug(
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

          logger.debug(
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
    confirmChunkUploadedToR2: requireTransferCreate(
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
              uploadedBy: userIdOf(user),
            };

            await setCacheEntry(fileId, fileMetadata);
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
    uploadFileChunkToR2: requireTransferCreate(
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

          // 🔐 fileId injecté dans une clé R2 et un motif regex : format sûr requis.
          if (!/^[a-zA-Z0-9_-]{1,128}$/.test(fileId)) {
            throw new UserInputError("Identifiant de fichier invalide");
          }

          if (
            !Number.isInteger(totalChunks) ||
            totalChunks < 1 ||
            totalChunks > 100000
          ) {
            throw new UserInputError("Nombre de chunks invalide");
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
              uploadedBy: userIdOf(user),
            };

            // Ajouter au cache temporaire pour la création du transfert
            await setCacheEntry(fileId, fileMetadata);
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
    createFileTransferWithIdsR2: requireTransferCreate(
      async (_, { fileIds, input }, { user }) => {
        let transferSaved = false;
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
              const fileInfo = await getFileInfoByTransferId(fileId, user);

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
          // 🔐 Appartenance requise si un workspace est fourni.
          if (
            workspaceId &&
            !(await userBelongsToWorkspace(
              String(user.id || user._id),
              String(workspaceId),
            ))
          ) {
            throw new UserInputError(
              "Accès non autorisé à cet espace de travail",
            );
          }
          const paymentAmount = input?.paymentAmount || 0;
          const paymentCurrency =
            input?.paymentCurrency || input?.currency || "EUR";
          // isPaymentRequired doit être true si paymentAmount > 0 OU si explicitement défini à true
          const isPaymentRequired =
            paymentAmount > 0 ||
            input?.isPaymentRequired ||
            input?.requirePayment ||
            false;
          const title = input?.title?.trim() || null;
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
            title,
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
          transferSaved = true;

          // Les métadonnées temporaires ont été consommées : purger les caches
          // L1 (mémoire) et L2 (Redis) pour éviter toute réutilisation périmée.
          for (const fileId of fileIds) {
            deleteCacheEntry(fileId);
          }

          // Envoyer l'email si un destinataire est spécifié et si SMTP est configuré
          if (
            recipientEmail &&
            (process.env.RESEND_API_KEY ||
              (process.env.SMTP_HOST &&
                process.env.SMTP_USER &&
                process.env.SMTP_PASS))
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
                logger.debug(
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
            logger.debug(
              "📧 Email destinataire fourni mais SMTP non configuré. Lien de partage:",
              `${
                process.env.FRONTEND_URL || "http://localhost:3000"
              }/transfer/${fileTransfer.shareLink}?key=${
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

          // Transfert non créé : les fichiers déjà envoyés du lot sont
          // orphelins (l'application renvoie tout le lot pour réessayer)
          if (!transferSaved) {
            await discardUploadedFiles(fileIds, user);
          }

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
    uploadFileDirectToR2: requireTransferCreate(
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
    uploadBase64FileToR2: requireTransferCreate(
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
// (sauf l'annulation : libérer un envoi entamé reste permis abonnement échu)
Object.keys(chunkUploadR2Resolvers.Mutation).forEach((name) => {
  if (name === "abortMultipartUpload") return;
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
