/**
 * Service pour gérer l'upload et la récupération d'images sur Cloudflare R2
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import path from 'path';

class CloudflareService {
  constructor() {
    // Configuration Cloudflare R2 (compatible S3)
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      },
    });
    
    this.bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME || 'newbi-signatures';
    this.publicUrl = process.env.CLOUDFLARE_R2_PUBLIC_URL; // URL publique de votre domaine custom
  }

  /**
   * Upload une image vers Cloudflare R2
   * @param {Buffer} fileBuffer - Buffer de l'image
   * @param {string} fileName - Nom original du fichier
   * @param {string} userId - ID de l'utilisateur
   * @param {string} imageType - Type d'image ('profile' ou 'company')
   * @returns {Promise<{key: string, url: string}>}
   */
  async uploadImage(fileBuffer, fileName, userId, imageType = 'profile') {
    try {
      // Générer une clé unique pour l'image
      const fileExtension = path.extname(fileName).toLowerCase();
      const uniqueId = crypto.randomUUID();
      const key = `signatures/${userId}/${imageType}/${uniqueId}${fileExtension}`;

      // Déterminer le content-type
      const contentType = this.getContentType(fileExtension);

      // Commande d'upload
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
        Metadata: {
          userId: userId,
          imageType: imageType,
          originalName: fileName,
          uploadedAt: new Date().toISOString(),
        },
      });

      await this.client.send(command);

      // Construire l'URL publique
      const publicUrl = this.publicUrl 
        ? `${this.publicUrl}/${key}`
        : `https://${this.bucketName}.${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`;

      return {
        key,
        url: publicUrl,
        contentType,
      };
    } catch (error) {
      console.error('Erreur upload Cloudflare:', error);
      throw new Error(`Échec de l'upload vers Cloudflare: ${error.message}`);
    }
  }

  /**
   * Récupère l'URL publique d'une image
   * @param {string} key - Clé de l'image dans R2
   * @returns {string}
   */
  getImageUrl(key) {
    if (!key) return null;
    
    return this.publicUrl 
      ? `${this.publicUrl}/${key}`
      : `https://${this.bucketName}.${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`;
  }

  /**
   * Génère une URL signée temporaire pour l'accès privé
   * @param {string} key - Clé de l'image
   * @param {number} expiresIn - Durée de validité en secondes (défaut: 1h)
   * @returns {Promise<string>}
   */
  async getSignedUrl(key, expiresIn = 3600) {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      return await getSignedUrl(this.client, command, { expiresIn });
    } catch (error) {
      console.error('Erreur génération URL signée:', error);
      throw new Error(`Échec de la génération d'URL signée: ${error.message}`);
    }
  }

  /**
   * Supprime une image de Cloudflare R2
   * @param {string} key - Clé de l'image à supprimer
   * @returns {Promise<boolean>}
   */
  async deleteImage(key) {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.client.send(command);
      return true;
    } catch (error) {
      console.error('Erreur suppression Cloudflare:', error);
      throw new Error(`Échec de la suppression: ${error.message}`);
    }
  }

  /**
   * Détermine le content-type basé sur l'extension
   * @param {string} extension - Extension du fichier
   * @returns {string}
   */
  getContentType(extension) {
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
    };

    return mimeTypes[extension] || 'application/octet-stream';
  }

  /**
   * Valide si le fichier est une image supportée
   * @param {string} fileName - Nom du fichier
   * @returns {boolean}
   */
  isValidImageFile(fileName) {
    const validExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const extension = path.extname(fileName).toLowerCase();
    return validExtensions.includes(extension);
  }

  /**
   * Valide la taille du fichier (max 5MB pour les signatures)
   * @param {Buffer} fileBuffer - Buffer du fichier
   * @returns {boolean}
   */
  isValidFileSize(fileBuffer) {
    const maxSize = 5 * 1024 * 1024; // 5MB
    return fileBuffer.length <= maxSize;
  }
}

// Instance singleton
const cloudflareService = new CloudflareService();

export default cloudflareService;
