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
    // Debug: Vérifier les variables d'environnement
    console.log("🔧 Configuration Cloudflare R2 pour les transferts:");
    console.log("  TRANSFER_BUCKET_NAME:", process.env.TRANSFER_BUCKET_NAME || "app-transfers-prod");
    console.log("  TRANSFER_PUBLIC_URL:", process.env.TRANSFER_PUBLIC_URL);
    console.log("  AWS_S3_API_URL:", process.env.AWS_S3_API_URL);
    console.log(
      "  AWS_ACCESS_KEY_ID:",
      process.env.AWS_ACCESS_KEY_ID ? "✅ Définie" : "❌ Manquante"
    );
    console.log(
      "  AWS_SECRET_ACCESS_KEY:",
      process.env.AWS_SECRET_ACCESS_KEY ? "✅ Définie" : "❌ Manquante"
    );

    // Configuration Cloudflare R2 (compatible S3)
    this.client = new S3Client({
      region: "auto",
      endpoint: process.env.AWS_S3_API_URL,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    this.bucketName = process.env.TRANSFER_BUCKET_NAME || "app-transfers-prod";
    this.publicUrl = process.env.TRANSFER_PUBLIC_URL;

    if (!this.bucketName) {
      console.error("❌ ERREUR: TRANSFER_BUCKET_NAME n'est pas définie!");
      throw new Error("Configuration manquante: TRANSFER_BUCKET_NAME");
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
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    
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
      const contentType = mimeType || this.getContentType(path.extname(originalName));

      console.log(`📤 Upload fichier vers R2: ${key}`);
      console.log(`📊 Taille: ${fileBuffer.length} octets`);
      console.log(`📋 Type: ${contentType}`);

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
      if (this.publicUrl && this.publicUrl !== "https://your_transfer_bucket_public_url") {
        fileUrl = `${this.publicUrl}/${key}`;
        console.log("🌐 URL publique générée:", fileUrl);
      } else {
        // Utiliser une URL signée temporaire
        fileUrl = await this.getSignedUrl(key, 86400); // 24h
        console.log("🔗 URL signée générée");
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
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      
      const key = `temp/${year}/${month}/${day}/t_${transferId}/f_${fileId}/chunk_${chunkIndex}`;

      console.log(`📤 Upload chunk ${chunkIndex} vers R2: ${key}`);

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
      throw new Error(`Échec de l'upload du chunk ${chunkIndex}: ${error.message}`);
    }
  }

  /**
   * Reconstruit un fichier à partir de ses chunks sur R2
   * @param {string} transferId - ID du transfert
   * @param {string} fileId - ID du fichier
   * @param {string} originalName - Nom original du fichier
   * @param {number} totalChunks - Nombre total de chunks
   * @param {string} mimeType - Type MIME du fichier
   * @returns {Promise<{key: string, url: string, size: number}>}
   */
  async reconstructFileFromChunks(transferId, fileId, originalName, totalChunks, mimeType) {
    try {
      console.log(`🔧 Reconstruction du fichier ${fileId} à partir de ${totalChunks} chunks`);

      // Récupérer tous les chunks
      const chunks = [];
      let totalSize = 0;

      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');

      for (let i = 0; i < totalChunks; i++) {
        const chunkKey = `temp/${year}/${month}/${day}/t_${transferId}/f_${fileId}/chunk_${i}`;
        
        try {
          const getCommand = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: chunkKey,
          });

          const response = await this.client.send(getCommand);
          const chunkBuffer = Buffer.from(await response.Body.transformToByteArray());
          
          chunks.push(chunkBuffer);
          totalSize += chunkBuffer.length;
          
          console.log(`✅ Chunk ${i} récupéré: ${chunkBuffer.length} octets`);
        } catch (error) {
          console.error(`❌ Erreur récupération chunk ${i}:`, error);
          throw new Error(`Chunk ${i} manquant ou inaccessible`);
        }
      }

      // Concaténer tous les chunks
      const completeFileBuffer = Buffer.concat(chunks);
      console.log(`🔗 Fichier reconstruit: ${completeFileBuffer.length} octets`);

      // Upload du fichier complet
      const result = await this.uploadFile(completeFileBuffer, transferId, fileId, originalName, mimeType);

      // Nettoyer les chunks temporaires
      await this.cleanupChunks(transferId, fileId, totalChunks);

      return result;
    } catch (error) {
      console.error("Erreur reconstruction fichier:", error);
      throw new Error(`Échec de la reconstruction du fichier: ${error.message}`);
    }
  }

  /**
   * Nettoie les chunks temporaires après reconstruction
   * @param {string} transferId - ID du transfert
   * @param {string} fileId - ID du fichier
   * @param {number} totalChunks - Nombre total de chunks
   * @returns {Promise<void>}
   */
  async cleanupChunks(transferId, fileId, totalChunks) {
    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');

      for (let i = 0; i < totalChunks; i++) {
        const chunkKey = `temp/${year}/${month}/${day}/t_${transferId}/f_${fileId}/chunk_${i}`;
        
        try {
          const deleteCommand = new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: chunkKey,
          });

          await this.client.send(deleteCommand);
          console.log(`🗑️ Chunk ${i} supprimé`);
        } catch (error) {
          console.warn(`⚠️ Erreur suppression chunk ${i}:`, error.message);
        }
      }
    } catch (error) {
      console.error("Erreur nettoyage chunks:", error);
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

    if (this.publicUrl && this.publicUrl !== "https://your_transfer_bucket_public_url") {
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
      console.log("🔗 Génération URL signée pour:", key);

      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.client, command, {
        expiresIn,
        signableHeaders: new Set(["host"]),
        unhoistableHeaders: new Set(["x-amz-content-sha256"]),
      });

      console.log("✅ URL signée générée:", signedUrl.substring(0, 100) + "...");
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
      console.log(`🗑️ Fichier supprimé: ${key}`);
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
      if (error.name === 'NotFound') {
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
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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
    const size = typeof fileData === 'number' ? fileData : fileData.length;
    return size <= maxSize;
  }
}

// Instance singleton
const cloudflareTransferService = new CloudflareTransferService();

export default cloudflareTransferService;
