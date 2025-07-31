import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';

// Charger les variables d'environnement
dotenv.config();

// Configuration du client S3 pour Cloudflare R2
const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.AWS_S3_API_URL,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

class CloudflareService {
  constructor() {
    this.client = s3Client;
    this.bucketName = process.env.AWS_S3_BUCKET_NAME;
  }

  /**
   * Nettoie un nom de fichier pour les headers HTTP
   * @param {string} fileName - Nom original du fichier
   * @returns {string} - Nom de fichier nettoyé
   */
  sanitizeFileName(fileName) {
    if (!fileName) return 'unknown';
    
    // Remplacer les caractères problématiques par des underscores
    // et garder seulement les caractères alphanumériques, points, tirets et underscores
    return fileName
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_+/g, '_') // Remplacer les underscores multiples par un seul
      .replace(/^_|_$/g, '') // Supprimer les underscores en début/fin
      .substring(0, 100); // Limiter la longueur
  }

  /**
   * Détermine le content-type basé sur l'extension du fichier
   * @param {string} fileExtension - Extension du fichier
   * @returns {string} - Content-type MIME
   */
  getContentType(fileExtension) {
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff',
      '.bmp': 'image/bmp',
    };
    
    return mimeTypes[fileExtension] || 'application/octet-stream';
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

      // Nettoyer le nom de fichier pour les headers HTTP
      const sanitizedFileName = this.sanitizeFileName(fileName);
      console.log('📝 Nom de fichier original:', fileName);
      console.log('🧹 Nom de fichier nettoyé:', sanitizedFileName);

      // Commande d'upload
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
        Metadata: {
          userId: userId,
          imageType: imageType,
          originalName: sanitizedFileName, // Utiliser le nom nettoyé
          uploadedAt: new Date().toISOString(),
        },
      });

      await this.client.send(command);

      // Générer l'URL appropriée selon la configuration
      let imageUrl;
      
      // Utilisation directe des URLs publiques Cloudflare R2
      if (process.env.AWS_R2_PUBLIC_URL && process.env.AWS_R2_PUBLIC_URL !== 'your_r2_public_url') {
        imageUrl = `${process.env.AWS_R2_PUBLIC_URL}/${key}`;
        console.log('🌐 URL publique Cloudflare R2 générée:', imageUrl);
      } else {
        // Fallback sur le proxy backend si pas d'URL publique configurée
        console.log('🔗 Pas d\'URL publique configurée, utilisation du proxy pour:', key);
        
        const keyParts = key.split('/');
        if (keyParts.length >= 3 && keyParts[0] === 'signatures') {
          const userId = keyParts[1];
          const imageType = keyParts[2];
          const filename = keyParts.slice(3).join('/');
          
          const baseUrl = process.env.BACKEND_URL || 'http://localhost:4000';
          imageUrl = `${baseUrl}/api/images/${userId}/${imageType}/${filename}`;
          
          console.log('✅ URL proxy générée:', imageUrl);
        } else {
          // Dernier fallback sur URL signée
          console.log('⚠️ Structure de clé inattendue, fallback sur URL signée');
          imageUrl = await this.getSignedUrl(key, 86400);
        }
      }

      return {
        key,
        url: imageUrl,
        contentType,
      };
    } catch (error) {
      console.error('Erreur upload Cloudflare:', error);
      throw new Error(`Échec de l'upload vers Cloudflare: ${error.message}`);
    }
  }

  /**
   * Récupère l'URL d'une image (publique ou signée selon la configuration)
   * @param {string} key - Clé de l'image dans R2
   * @param {number} expiresIn - Durée de validité en secondes pour URL signée (défaut: 24h)
   * @returns {Promise<string>}
   */
  async getImageUrl(key, expiresIn = 86400) {
    if (!key) return null;
    
    if (process.env.AWS_R2_PUBLIC_URL && process.env.AWS_R2_PUBLIC_URL !== 'your_r2_public_url') {
      // Si URL publique configurée, utiliser l'URL publique directe
      return `${process.env.AWS_R2_PUBLIC_URL}/${key}`;
    } else {
      // Sinon, générer une URL signée temporaire
      return await this.getSignedUrl(key, expiresIn);
    }
  }

  /**
   * Génère une URL signée temporaire pour l'accès privé
   * @param {string} key - Clé de l'image
   * @param {number} expiresIn - Durée de validité en secondes (défaut: 1h)
   * @returns {Promise<string>}
   */
  async getSignedUrl(key, expiresIn = 3600) {
    try {
      console.log('🔗 Génération URL signée pour:', key);
      
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.client, command, { 
        expiresIn,
        // Ajouter des paramètres spécifiques à Cloudflare R2
        signableHeaders: new Set(['host']),
        unhoistableHeaders: new Set(['x-amz-content-sha256'])
      });
      
      console.log('✅ URL signée générée:', signedUrl.substring(0, 100) + '...');
      return signedUrl;
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

}

// Créer une instance unique du service
const cloudflareService = new CloudflareService();

// Exporter les fonctions pour compatibilité
export async function uploadFile(fileBuffer, fileName, userId, fileType = 'document') {
  return cloudflareService.uploadImage(fileBuffer, fileName, userId, fileType);
}

export async function deleteFile(key) {
  return cloudflareService.deleteImage(key);
}

export async function getSignedUrl(key, expiresIn = 3600) {
  return cloudflareService.getSignedUrl(key, expiresIn);
}

export async function getFileUrl(key) {
  if (process.env.AWS_R2_PUBLIC_URL) {
    return `${process.env.AWS_R2_PUBLIC_URL}/${key}`;
  }
  return cloudflareService.getSignedUrl(key);
}

// Exporter la classe et l'instance
export { CloudflareService };
export default cloudflareService;
