/**
 * Service pour gérer l'upload et la récupération de fichiers de transfert sur Cloudflare R2
 * Bucket: app-transfers-prod
 * Structure: prod/YYYY/MM/DD/t_<transfer_id>/f_<file_id>_<original_name>
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import crypto from "crypto";

// Charger les variables d'environnement
dotenv.config();

class CloudflareTransferService {
  constructor() {
    // Configuration Cloudflare R2 (compatible S3)
    this.client = new S3Client({
      region: "auto",
      endpoint: process.env.R2_API_URL,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });

    this.bucketName = process.env.TRANSFER_BUCKET || "app-transfers-prod";
    this.publicUrl = process.env.TRANSFER_URL;

    if (!this.bucketName) {
      console.error("❌ ERREUR: TRANSFER_BUCKET n'est pas définie!");
      throw new Error("Configuration manquante: TRANSFER_BUCKET");
    }
  }

  /**
   * Génère le chemin R2 selon la structure demandée
   * @param {string} transferId - ID du transfert
   * @param {string} fileId - ID du fichier
   * @param {string} originalName - Nom original du fichier
   * @returns {string} - Chemin R2
   */
  generateR2Path(transferId, fileId, originalName) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");

    // Nettoyer le nom original pour éviter les problèmes de chemin
    const sanitizedName = this.sanitizeFileName(originalName);

    return `prod/${year}/${month}/${day}/t_${transferId}/f_${fileId}_${sanitizedName}`;
  }

  /**
   * Nettoie un nom de fichier pour les chemins R2
   * @param {string} fileName - Nom original du fichier
   * @returns {string} - Nom de fichier nettoyé
   */
  sanitizeFileName(fileName) {
    if (!fileName) return "unknown";

    // Remplacer les caractères problématiques par des underscores
    // et garder seulement les caractères alphanumériques, points, tirets et underscores
    return fileName
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .replace(/_+/g, "_") // Remplacer les underscores multiples par un seul
      .replace(/^_|_$/g, "") // Supprimer les underscores en début/fin
      .substring(0, 100); // Limiter la longueur
  }

  /**
   * Upload un fichier vers Cloudflare R2
   * @param {Buffer} fileBuffer - Buffer du fichier
   * @param {string} transferId - ID du transfert
   * @param {string} fileId - ID du fichier
   * @param {string} originalName - Nom original du fichier
   * @param {string} mimeType - Type MIME du fichier
   * @returns {Promise<{key: string, url: string, size: number}>}
   */
  async uploadFile(fileBuffer, transferId, fileId, originalName, mimeType) {
    try {
      // Générer le chemin R2
      const key = this.generateR2Path(transferId, fileId, originalName);

      // Déterminer le content-type
      const contentType =
        mimeType || this.getContentType(path.extname(originalName));

      // Commande d'upload
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
        Metadata: {
          transferId: transferId,
          fileId: fileId,
          originalName: this.sanitizeFileName(originalName),
          uploadedAt: new Date().toISOString(),
        },
      });

      await this.client.send(command);

      // Générer l'URL d'accès
      let fileUrl;
      if (
        this.publicUrl &&
        this.publicUrl !== "https://your_transfer_bucket_public_url"
      ) {
        fileUrl = `${this.publicUrl}/${key}`;
      } else {
        // Utiliser une URL signée temporaire
        fileUrl = await this.getSignedUrl(key, 86400); // 24h
      }

      return {
        key,
        url: fileUrl,
        size: fileBuffer.length,
        contentType,
      };
    } catch (error) {
      console.error("Erreur upload Cloudflare R2:", error);
      throw new Error(`Échec de l'upload vers Cloudflare R2: ${error.message}`);
    }
  }

  /**
   * Génère une URL signée pour upload direct d'un chunk vers R2
   * @param {string} transferId - ID du transfert
   * @param {string} fileId - ID du fichier
   * @param {number} chunkIndex - Index du chunk
   * @param {string} originalName - Nom original du fichier
   * @param {number} expiresIn - Durée de validité en secondes (défaut: 1h)
   * @returns {Promise<{uploadUrl: string, key: string}>}
   */
  async generatePresignedUploadUrl(
    transferId,
    fileId,
    chunkIndex,
    originalName,
    expiresIn = 3600
  ) {
    try {
      // Générer le chemin pour le chunk temporaire
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");

      const key = `temp/${year}/${month}/${day}/t_${transferId}/f_${fileId}/chunk_${chunkIndex}`;

      // Créer la commande PUT
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        ContentType: "application/octet-stream",
        Metadata: {
          transferId: transferId,
          fileId: fileId,
          chunkIndex: chunkIndex.toString(),
          originalName: this.sanitizeFileName(originalName),
          uploadedAt: new Date().toISOString(),
        },
      });

      // Générer l'URL signée
      const uploadUrl = await getSignedUrl(this.client, command, {
        expiresIn,
      });

      console.log(`✅ URL signée générée pour chunk ${chunkIndex}: ${uploadUrl.substring(0, 100)}...`);

      return {
        uploadUrl,
        key,
        chunkIndex,
      };
    } catch (error) {
      console.error(
        `Erreur génération presigned URL pour chunk ${chunkIndex}:`,
        error
      );
      throw new Error(
        `Échec génération presigned URL: ${error.message}`
      );
    }
  }

  /**
   * Upload un chunk de fichier vers Cloudflare R2
   * @param {Buffer} chunkBuffer - Buffer du chunk
   * @param {string} transferId - ID du transfert
   * @param {string} fileId - ID du fichier
   * @param {number} chunkIndex - Index du chunk
   * @param {string} originalName - Nom original du fichier
   * @returns {Promise<{key: string, size: number}>}
   */
  async uploadChunk(chunkBuffer, transferId, fileId, chunkIndex, originalName) {
    try {
      // Générer le chemin pour le chunk temporaire
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");

      const key = `temp/${year}/${month}/${day}/t_${transferId}/f_${fileId}/chunk_${chunkIndex}`;

      // Commande d'upload
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: chunkBuffer,
        ContentType: "application/octet-stream",
        Metadata: {
          transferId: transferId,
          fileId: fileId,
          chunkIndex: chunkIndex.toString(),
          originalName: this.sanitizeFileName(originalName),
          uploadedAt: new Date().toISOString(),
        },
      });

      await this.client.send(command);

      return {
        key,
        size: chunkBuffer.length,
      };
    } catch (error) {
      console.error(`Erreur upload chunk ${chunkIndex}:`, error);
      throw new Error(
        `Échec de l'upload du chunk ${chunkIndex}: ${error.message}`
      );
    }
  }

  /**
   * Démarre un multipart upload et génère des presigned URLs pour chaque part
   * @param {string} transferId - ID du transfert
   * @param {string} fileId - ID du fichier
   * @param {string} fileName - Nom du fichier
   * @param {number} fileSize - Taille du fichier
   * @param {string} mimeType - Type MIME
   * @param {number} totalParts - Nombre total de parts
   * @returns {Promise<{uploadId: string, key: string, presignedUrls: Array}>}
   */
  async startMultipartUpload(
    transferId,
    fileId,
    fileName,
    fileSize,
    mimeType,
    totalParts
  ) {
    try {
      console.log(
        `🚀 Démarrage Multipart Upload: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB) en ${totalParts} parts`
      );

      // Générer le chemin final du fichier (pas de temp/)
      const finalKey = this.generateR2Path(transferId, fileId, fileName);
      const contentType = mimeType || this.getContentType(path.extname(fileName));

      // Créer le multipart upload
      const createCommand = new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: finalKey,
        ContentType: contentType,
        Metadata: {
          transferId: transferId,
          fileId: fileId,
          originalName: this.sanitizeFileName(fileName),
          uploadedAt: new Date().toISOString(),
        },
      });

      const createResponse = await this.client.send(createCommand);
      const uploadId = createResponse.UploadId;

      console.log(`📦 Multipart Upload créé: ${uploadId}`);

      // Générer des presigned URLs pour chaque part
      const presignedUrls = [];
      const urlPromises = [];

      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        urlPromises.push(
          (async () => {
            const uploadPartCommand = new UploadPartCommand({
              Bucket: this.bucketName,
              Key: finalKey,
              UploadId: uploadId,
              PartNumber: partNumber,
            });

            const presignedUrl = await getSignedUrl(
              this.client,
              uploadPartCommand,
              { expiresIn: 3600 }
            );

            return { partNumber, uploadUrl: presignedUrl };
          })()
        );
      }

      presignedUrls.push(...(await Promise.all(urlPromises)));

      console.log(`✅ ${presignedUrls.length} URLs presigned générées`);

      return {
        uploadId,
        key: finalKey,
        presignedUrls: presignedUrls.sort((a, b) => a.partNumber - b.partNumber),
      };
    } catch (error) {
      console.error("❌ Erreur démarrage multipart upload:", error);
      throw new Error(`Échec démarrage multipart: ${error.message}`);
    }
  }

  /**
   * Complète un multipart upload
   * @param {string} uploadId - ID du multipart upload
   * @param {string} key - Clé du fichier
   * @param {Array} parts - Liste des parts avec {partNumber, etag}
   * @returns {Promise<{key: string, url: string, size: number}>}
   */
  async completeMultipartUpload(uploadId, key, parts) {
    try {
      console.log(
        `🔧 Finalisation Multipart Upload: ${key} (${parts.length} parts)`
      );

      // Trier les parts par numéro
      const sortedParts = parts
        .sort((a, b) => a.partNumber - b.partNumber)
        .map(({ partNumber, etag }) => ({
          PartNumber: partNumber,
          ETag: etag.replace(/"/g, ""), // Enlever les guillemets si présents
        }));

      const completeCommand = new CompleteMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sortedParts,
        },
      });

      const response = await this.client.send(completeCommand);

      // Obtenir la taille du fichier
      const headCommand = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      const headResponse = await this.client.send(headCommand);
      const fileSize = headResponse.ContentLength;

      console.log(
        `✅ Multipart Upload complété: ${key} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`
      );

      // Générer l'URL d'accès
      let fileUrl;
      if (
        this.publicUrl &&
        this.publicUrl !== "https://your_transfer_bucket_public_url"
      ) {
        fileUrl = `${this.publicUrl}/${key}`;
      } else {
        fileUrl = await this.getSignedUrl(key, 86400);
      }

      return {
        key,
        url: fileUrl,
        size: fileSize,
        etag: response.ETag,
      };
    } catch (error) {
      console.error("❌ Erreur finalisation multipart upload:", error);
      throw new Error(`Échec finalisation multipart: ${error.message}`);
    }
  }

  /**
   * Annule un multipart upload
   * @param {string} uploadId - ID du multipart upload
   * @param {string} key - Clé du fichier
   */
  async abortMultipartUpload(uploadId, key) {
    try {
      const abortCommand = new AbortMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: key,
        UploadId: uploadId,
      });

      await this.client.send(abortCommand);
      console.log(`🗑️ Multipart Upload annulé: ${uploadId}`);
    } catch (error) {
      console.error("❌ Erreur annulation multipart upload:", error);
      throw error;
    }
  }

  /**
   * Reconstruit un fichier à partir de ses chunks sur R2 en utilisant Multipart Upload
   * @param {string} transferId - ID du transfert
   * @param {string} fileId - ID du fichier
   * @param {string} originalName - Nom original du fichier
   * @param {number} totalChunks - Nombre total de chunks
   * @param {string} mimeType - Type MIME du fichier
   * @returns {Promise<{key: string, url: string, size: number}>}
   * @deprecated Utiliser startMultipartUpload + completeMultipartUpload à la place
   */
  async reconstructFileFromChunks(
    transferId,
    fileId,
    originalName,
    totalChunks,
    mimeType
  ) {
    let uploadId = null;

    try {
      console.log(`🔧 Reconstruction du fichier ${originalName} avec Multipart Upload (${totalChunks} chunks)`);

      // Générer le chemin final du fichier
      const finalKey = this.generateR2Path(transferId, fileId, originalName);
      const contentType = mimeType || this.getContentType(path.extname(originalName));

      // Étape 1 : Créer un multipart upload
      const createCommand = new CreateMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: finalKey,
        ContentType: contentType,
        Metadata: {
          transferId: transferId,
          fileId: fileId,
          originalName: this.sanitizeFileName(originalName),
          uploadedAt: new Date().toISOString(),
        },
      });

      const createResponse = await this.client.send(createCommand);
      uploadId = createResponse.UploadId;

      console.log(`📦 Multipart Upload créé: ${uploadId}`);

      // Étape 2 : Copier chaque chunk comme une part du multipart upload
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");

      const uploadedParts = [];
      let totalSize = 0;

      // Uploader les parts en parallèle (par batch de 10)
      const BATCH_SIZE = 10;
      for (let i = 0; i < totalChunks; i += BATCH_SIZE) {
        const batchPromises = [];

        for (let j = i; j < Math.min(i + BATCH_SIZE, totalChunks); j++) {
          const chunkKey = `temp/${year}/${month}/${day}/t_${transferId}/f_${fileId}/chunk_${j}`;

          batchPromises.push(
            (async () => {
              try {
                // Récupérer le chunk
                const getCommand = new GetObjectCommand({
                  Bucket: this.bucketName,
                  Key: chunkKey,
                });

                const response = await this.client.send(getCommand);
                const chunkBuffer = Buffer.from(
                  await response.Body.transformToByteArray()
                );

                // Uploader comme part du multipart upload (les parts commencent à 1)
                const uploadPartCommand = new UploadPartCommand({
                  Bucket: this.bucketName,
                  Key: finalKey,
                  UploadId: uploadId,
                  PartNumber: j + 1,
                  Body: chunkBuffer,
                });

                const uploadPartResponse = await this.client.send(uploadPartCommand);

                return {
                  PartNumber: j + 1,
                  ETag: uploadPartResponse.ETag,
                  size: chunkBuffer.length,
                };
              } catch (error) {
                console.error(`❌ Erreur upload part ${j + 1}:`, error);
                throw new Error(`Part ${j + 1} échec: ${error.message}`);
              }
            })()
          );
        }

        // Attendre que le batch soit terminé
        const batchResults = await Promise.all(batchPromises);
        uploadedParts.push(...batchResults);

        // Calculer la taille totale
        batchResults.forEach(part => {
          totalSize += part.size;
        });

        console.log(`✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(totalChunks / BATCH_SIZE)} uploadé (${uploadedParts.length}/${totalChunks} parts)`);
      }

      // Étape 3 : Compléter le multipart upload
      const completeCommand = new CompleteMultipartUploadCommand({
        Bucket: this.bucketName,
        Key: finalKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: uploadedParts
            .sort((a, b) => a.PartNumber - b.PartNumber)
            .map(({ PartNumber, ETag }) => ({ PartNumber, ETag })),
        },
      });

      await this.client.send(completeCommand);

      console.log(`✅ Multipart Upload complété: ${finalKey} (${totalSize} octets)`);

      // Étape 4 : Nettoyer les chunks temporaires
      await this.cleanupChunks(transferId, fileId, totalChunks);

      // Générer l'URL d'accès
      let fileUrl;
      if (
        this.publicUrl &&
        this.publicUrl !== "https://your_transfer_bucket_public_url"
      ) {
        fileUrl = `${this.publicUrl}/${finalKey}`;
      } else {
        fileUrl = await this.getSignedUrl(finalKey, 86400);
      }

      return {
        key: finalKey,
        url: fileUrl,
        size: totalSize,
        contentType,
      };
    } catch (error) {
      console.error("❌ Erreur reconstruction fichier:", error);

      // En cas d'erreur, annuler le multipart upload
      if (uploadId) {
        try {
          const abortCommand = new AbortMultipartUploadCommand({
            Bucket: this.bucketName,
            Key: this.generateR2Path(transferId, fileId, originalName),
            UploadId: uploadId,
          });
          await this.client.send(abortCommand);
          console.log(`🗑️ Multipart Upload annulé: ${uploadId}`);
        } catch (abortError) {
          console.error("Erreur lors de l'annulation du multipart upload:", abortError);
        }
      }

      throw new Error(
        `Échec de la reconstruction du fichier: ${error.message}`
      );
    }
  }

  /**
   * Nettoie les chunks temporaires après reconstruction
   * Utilise listObjects pour trouver les chunks quel que soit leur date d'upload
   * @param {string} transferId - ID du transfert
   * @param {string} fileId - ID du fichier
   * @param {number} totalChunks - Nombre total de chunks (optionnel, utilisé pour fallback)
   * @returns {Promise<{deleted: number, errors: number}>}
   */
  async cleanupChunks(transferId, fileId, totalChunks = 0) {
    try {
      console.log(`🧹 Nettoyage des chunks pour transfert ${transferId}, fichier ${fileId}`);

      // Approche 1: Lister tous les objets correspondant au pattern
      // Cela fonctionne quel que soit le jour d'upload
      const prefix = `temp/`;
      const objects = await this.listObjects(prefix);

      // Filtrer les chunks correspondant au transferId et fileId
      const pattern = new RegExp(`t_${transferId}/f_${fileId}/chunk_`);
      const matchingChunks = objects.filter((obj) => pattern.test(obj.key));

      if (matchingChunks.length === 0) {
        console.log(`ℹ️ Aucun chunk trouvé pour fichier ${fileId}`);
        return { deleted: 0, errors: 0 };
      }

      console.log(`🗑️ ${matchingChunks.length} chunks à supprimer`);

      // Supprimer les chunks
      const keysToDelete = matchingChunks.map((obj) => obj.key);
      const result = await this.deleteFiles(keysToDelete);

      console.log(`✅ Chunks supprimés: ${result.deleted}/${keysToDelete.length}`);

      return result;
    } catch (error) {
      console.error("Erreur nettoyage chunks:", error);

      // Fallback: essayer avec la date actuelle si listObjects échoue
      if (totalChunks > 0) {
        console.log("⚠️ Fallback vers suppression par date actuelle");
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const day = String(now.getDate()).padStart(2, "0");

        let deleted = 0;
        let errors = 0;

        for (let i = 0; i < totalChunks; i++) {
          const chunkKey = `temp/${year}/${month}/${day}/t_${transferId}/f_${fileId}/chunk_${i}`;

          try {
            const deleteCommand = new DeleteObjectCommand({
              Bucket: this.bucketName,
              Key: chunkKey,
            });

            await this.client.send(deleteCommand);
            deleted++;
          } catch (deleteError) {
            errors++;
            console.warn(`⚠️ Erreur suppression chunk ${i}:`, deleteError.message);
          }
        }

        return { deleted, errors };
      }

      return { deleted: 0, errors: 1 };
    }
  }

  /**
   * Récupère l'URL d'un fichier (publique ou signée selon la configuration)
   * @param {string} key - Clé du fichier dans R2
   * @param {number} expiresIn - Durée de validité en secondes pour URL signée (défaut: 24h)
   * @returns {Promise<string>}
   */
  async getFileUrl(key, expiresIn = 86400) {
    if (!key) return null;

    if (
      this.publicUrl &&
      this.publicUrl !== "https://your_transfer_bucket_public_url"
    ) {
      // Si URL publique configurée, utiliser l'URL publique directe
      return `${this.publicUrl}/${key}`;
    } else {
      // Sinon, générer une URL signée temporaire
      return await this.getSignedUrl(key, expiresIn);
    }
  }

  /**
   * Génère une URL signée temporaire pour l'accès privé
   * @param {string} key - Clé du fichier
   * @param {number} expiresIn - Durée de validité en secondes (défaut: 1h)
   * @returns {Promise<string>}
   */
  async getSignedUrl(key, expiresIn = 3600) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.client, command, {
        expiresIn,
        signableHeaders: new Set(["host"]),
        unhoistableHeaders: new Set(["x-amz-content-sha256"]),
      });

      return signedUrl;
    } catch (error) {
      console.error("Erreur génération URL signée:", error);
      throw new Error(`Échec de la génération d'URL signée: ${error.message}`);
    }
  }

  /**
   * Supprime un fichier de Cloudflare R2
   * @param {string} key - Clé du fichier à supprimer
   * @returns {Promise<boolean>}
   */
  async deleteFile(key) {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.client.send(command);
      return true;
    } catch (error) {
      console.error("Erreur suppression Cloudflare R2:", error);
      throw new Error(`Échec de la suppression: ${error.message}`);
    }
  }

  /**
   * Vérifie si un fichier existe dans R2
   * @param {string} key - Clé du fichier
   * @returns {Promise<boolean>}
   */
  async fileExists(key) {
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.client.send(command);
      return true;
    } catch (error) {
      if (error.name === "NotFound") {
        return false;
      }
      throw error;
    }
  }

  /**
   * Détermine le content-type basé sur l'extension
   * @param {string} extension - Extension du fichier
   * @returns {string}
   */
  getContentType(extension) {
    const mimeTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".doc": "application/msword",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx":
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".txt": "text/plain",
      ".csv": "text/csv",
      ".zip": "application/zip",
      ".rar": "application/x-rar-compressed",
      ".7z": "application/x-7z-compressed",
      ".tar": "application/x-tar",
      ".gz": "application/gzip",
      ".mp4": "video/mp4",
      ".avi": "video/x-msvideo",
      ".mov": "video/quicktime",
      ".wmv": "video/x-ms-wmv",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".flac": "audio/flac",
      ".ogg": "audio/ogg",
      ".tiff": "image/tiff",
      ".tif": "image/tiff",
      ".bmp": "image/bmp",
      ".ico": "image/x-icon",
    };

    return mimeTypes[extension.toLowerCase()] || "application/octet-stream";
  }

  /**
   * Valide la taille du fichier (max 10GB pour les transferts)
   * @param {Buffer|number} fileData - Buffer du fichier ou taille en octets
   * @returns {boolean}
   */
  isValidFileSize(fileData) {
    const maxSize = 10 * 1024 * 1024 * 1024; // 10GB
    const size = typeof fileData === "number" ? fileData : fileData.length;
    return size <= maxSize;
  }

  /**
   * Liste les objets dans un préfixe donné
   * @param {string} prefix - Préfixe pour filtrer les objets
   * @param {number} maxKeys - Nombre maximum d'objets à retourner
   * @returns {Promise<Array<{key: string, lastModified: Date, size: number}>>}
   */
  async listObjects(prefix, maxKeys = 1000) {
    try {
      const objects = [];
      let continuationToken = undefined;

      do {
        const command = new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
          MaxKeys: maxKeys,
          ContinuationToken: continuationToken,
        });

        const response = await this.client.send(command);

        if (response.Contents) {
          objects.push(
            ...response.Contents.map((obj) => ({
              key: obj.Key,
              lastModified: obj.LastModified,
              size: obj.Size,
            }))
          );
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken);

      return objects;
    } catch (error) {
      console.error("Erreur listage objets R2:", error);
      throw new Error(`Échec du listage des objets: ${error.message}`);
    }
  }

  /**
   * Supprime plusieurs fichiers en une seule requête
   * @param {string[]} keys - Liste des clés à supprimer
   * @returns {Promise<{deleted: number, errors: number}>}
   */
  async deleteFiles(keys) {
    if (!keys || keys.length === 0) {
      return { deleted: 0, errors: 0 };
    }

    try {
      // S3 limite à 1000 objets par requête
      const BATCH_SIZE = 1000;
      let totalDeleted = 0;
      let totalErrors = 0;

      for (let i = 0; i < keys.length; i += BATCH_SIZE) {
        const batch = keys.slice(i, i + BATCH_SIZE);

        const command = new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            Quiet: false,
          },
        });

        const response = await this.client.send(command);

        totalDeleted += response.Deleted?.length || 0;
        totalErrors += response.Errors?.length || 0;

        if (response.Errors && response.Errors.length > 0) {
          console.warn("⚠️ Erreurs lors de la suppression batch:", response.Errors);
        }
      }

      return { deleted: totalDeleted, errors: totalErrors };
    } catch (error) {
      console.error("Erreur suppression batch R2:", error);
      throw new Error(`Échec de la suppression batch: ${error.message}`);
    }
  }

  /**
   * Nettoie les chunks orphelins (temp/) plus vieux que maxAgeHours
   * @param {number} maxAgeHours - Âge maximum en heures (défaut: 24h)
   * @returns {Promise<{deleted: number, errors: number, freedBytes: number}>}
   */
  async cleanupOrphanChunks(maxAgeHours = 24) {
    try {
      console.log(`🧹 Recherche des chunks orphelins (> ${maxAgeHours}h)...`);

      // Lister tous les objets dans temp/
      const objects = await this.listObjects("temp/");

      if (objects.length === 0) {
        console.log("✅ Aucun chunk temporaire trouvé");
        return { deleted: 0, errors: 0, freedBytes: 0 };
      }

      console.log(`📦 ${objects.length} objets temporaires trouvés`);

      // Filtrer les objets plus vieux que maxAgeHours
      const cutoffDate = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
      const oldChunks = objects.filter((obj) => obj.lastModified < cutoffDate);

      if (oldChunks.length === 0) {
        console.log(`✅ Aucun chunk orphelin (> ${maxAgeHours}h)`);
        return { deleted: 0, errors: 0, freedBytes: 0 };
      }

      console.log(`🗑️ ${oldChunks.length} chunks orphelins à supprimer`);

      // Calculer l'espace à libérer
      const freedBytes = oldChunks.reduce((acc, obj) => acc + (obj.size || 0), 0);

      // Supprimer les chunks
      const keysToDelete = oldChunks.map((obj) => obj.key);
      const result = await this.deleteFiles(keysToDelete);

      console.log(
        `✅ Nettoyage terminé: ${result.deleted} chunks supprimés, ${(freedBytes / 1024 / 1024).toFixed(2)} MB libérés`
      );

      return {
        deleted: result.deleted,
        errors: result.errors,
        freedBytes,
      };
    } catch (error) {
      console.error("❌ Erreur nettoyage chunks orphelins:", error);
      throw error;
    }
  }
}

// Instance singleton
const cloudflareTransferService = new CloudflareTransferService();

export default cloudflareTransferService;
