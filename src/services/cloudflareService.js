/**
 * Service Cloudflare R2 pour la gestion des images
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import path from 'path';
import dotenv from 'dotenv';
import crypto from 'crypto';

// Charger les variables d'environnement
dotenv.config();

class CloudflareService {
  constructor() {
    // Configuration Cloudflare R2 (compatible S3) - utilise les variables AWS existantes
    this.client = new S3Client({
      region: 'auto',
      endpoint: process.env.AWS_S3_API_URL,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    this.bucketName = process.env.IMAGE_BUCKET_NAME;
    this.publicUrl = process.env.IMAGE_PUBLIC_URL; // URL publique de votre domaine custom
    
    // Configuration spécifique pour l'OCR
    this.ocrBucketName = process.env.IMAGE_OCR_BUCKET_NAME;
    this.ocrPublicUrl = process.env.IMAGE_OCR_PUBLIC_URL;
    
    // Configuration spécifique pour les signatures mail
    this.signatureBucketName = process.env.IMAGE_SIGNATURE_BUCKET_NAME || 'image-signature';
    this.signaturePublicUrl = process.env.IMAGE_SIGNATURE_PUBLIC_URL || 
      'https://pub-e2f65bd10e4e4c9dbfb9ccad034abd75.r2.dev';
    
    // Configuration spécifique pour les images de profil
    this.profileBucketName = process.env.AWS_S3_BUCKET_NAME_IMG_PROFILE;
    this.profilePublicUrl = process.env.AWS_S3_API_URL_PROFILE;
    
    if (!this.bucketName) {
      throw new Error('Configuration manquante: IMAGE_BUCKET_NAME');
    }
  }

  /**
   * Nettoie un nom de fichier pour les headers HTTP
   * @param {string} fileName - Nom original du fichier
   * @returns {string} - Nom de fichier nettoyé
   */
  sanitizeFileName(fileName) {
    if (!fileName) return 'unknown';

    // Remplacer les caractères spéciaux par des tirets
    return fileName.replace(/[^\w\d.-]/g, '-');
  }

  /**
   * Upload une image vers Cloudflare R2
   * @param {Buffer} fileBuffer - Buffer de l'image
   * @param {string} fileName - Nom original du fichier
   * @param {string} userId - ID de l'utilisateur
   * @param {string} imageType - Type d'image ('imgProfil', 'logoReseau', 'profile', etc.)
   * @param {string} organizationId - ID de l'organisation (optionnel)
   * @param {string} signatureId - ID de la signature (requis pour imgProfil et logoReseau)
   * @returns {Promise<{key: string, url: string}>}
   */
  async uploadImage(fileBuffer, fileName, userId, imageType = 'profile', organizationId = null, signatureId = null) {
    try {
      // Générer une clé unique pour l'image
      const uniqueId = crypto.randomUUID();
      
      // Déterminer le chemin selon le type de fichier
      const fileExtension = path.extname(fileName).toLowerCase();
      let key;
      
      switch (imageType) {
      case 'imgProfil': {
        // Structure : idUser/idSignature/ImgProfil/fichier
        if (!signatureId) {
          throw new Error('Signature ID requis pour les images de profil de signature');
        }
        key = `${userId}/${signatureId}/ImgProfil/${uniqueId}${fileExtension}`;
        break;
      }
      case 'logoReseau': {
        // Structure : idUser/idSignature/logoReseau/fichier
        if (!signatureId) {
          throw new Error('Signature ID requis pour les logos réseaux sociaux');
        }
        key = `${userId}/${signatureId}/logoReseau/${uniqueId}${fileExtension}`;
        break;
      }
      case 'ocr': {
        // Pour les reçus OCR, organiser par organisation (ID organisation uniquement)
        if (!organizationId) {
          throw new Error('Organization ID requis pour les uploads OCR');
        }
        key = `${organizationId}/${uniqueId}${fileExtension}`;
        break;
      }
      case 'documents': {
        // Pour les documents généraux
        key = `documents/${userId}/${uniqueId}${fileExtension}`;
        break;
      }
      case 'profile': {
        // Pour les images de profil - sans préfixe signatures/
        key = `${userId}/image/${uniqueId}${fileExtension}`;
        break;
      }
      default: {
        // Pour les signatures et autres (comportement par défaut)
        key = `signatures/${userId}/${imageType}/${uniqueId}${fileExtension}`;
        break;
      }
      }

      // Déterminer le bucket et l'URL publique selon le type
      let targetBucket, targetPublicUrl;
      if (imageType === 'imgProfil' || imageType === 'logoReseau') {
        targetBucket = this.signatureBucketName;
        targetPublicUrl = this.signaturePublicUrl;
      } else if (imageType === 'ocr') {
        targetBucket = this.ocrBucketName || this.bucketName;
        targetPublicUrl = this.ocrPublicUrl || this.publicUrl;
      } else if (imageType === 'profile') {
        targetBucket = this.profileBucketName || this.bucketName;
        targetPublicUrl = this.profilePublicUrl || this.publicUrl;
      } else {
        targetBucket = this.bucketName;
        targetPublicUrl = this.publicUrl;
      }

      // Déterminer le content-type
      const contentType = this.getContentType(fileExtension);

      // Nettoyer le nom de fichier pour les headers HTTP
      const sanitizedFileName = this.sanitizeFileName(fileName);

      // Commande d'upload
      const command = new PutObjectCommand({
        Bucket: targetBucket,
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
      if (
        targetPublicUrl &&
        targetPublicUrl !== 'https://your_image_bucket_public_url'
      ) {
        // Éviter les doubles barres obliques
        const cleanUrl = targetPublicUrl.endsWith('/') ? targetPublicUrl.slice(0, -1) : targetPublicUrl;
        imageUrl = `${cleanUrl}/${key}`;
      } else {
        // Fallback sur le proxy backend si pas d'URL publique configurée

        const keyParts = key.split('/');
        if (keyParts.length >= 3 && keyParts[0] === 'signatures') {
          const userId = keyParts[1];
          const imageType = keyParts[2];
          const filename = keyParts.slice(3).join('/');

          const baseUrl = process.env.BACKEND_URL || 'http://localhost:4000';
          imageUrl = `${baseUrl}/api/images/${userId}/${imageType}/${filename}`;
        } else {
          // Dernier fallback sur URL signée
          imageUrl = await this.getSignedUrl(key, 86400);
        }
      }

      return {
        key,
        url: imageUrl,
        contentType,
      };
    } catch (error) {
      throw new Error(`Échec de l'upload vers Cloudflare: ${error.message}`);
    }
  }

  /**
   * Upload un logo social vers la nouvelle structure de signatures
   * @param {Buffer} fileBuffer - Buffer de l'image
   * @param {string} fileName - Nom original du fichier
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @param {string} logoType - Type de logo ('facebook', 'linkedin', etc.)
   * @param {string} color - Couleur du logo (optionnel)
   * @returns {Promise<{key: string, url: string}>}
   */
  async uploadSocialLogo(fileBuffer, fileName, userId, signatureId, logoType, color = null) {
    try {
      // Valider les paramètres requis
      if (!userId || !signatureId || !logoType) {
        throw new Error('userId, signatureId et logoType sont requis pour l\'upload de logos sociaux');
      }

      // Utiliser la nouvelle méthode uploadSignatureImage avec le type logoReseau
      const result = await this.uploadSignatureImage(
        fileBuffer,
        fileName,
        userId,
        signatureId,
        'logoReseau'
      );
      return {
        ...result,
        logoType,
        color,
      };
    } catch (error) {
      // Erreur lors de l'upload du logo social
      throw new Error(`Échec de l'upload du logo social ${logoType}: ${error.message}`);
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

    // Déterminer l'URL publique selon le type de clé
    let publicUrl = process.env.AWS_R2_PUBLIC_URL;
    if (key.includes('/ImgProfil/') || key.includes('/logoReseau/')) {
      publicUrl = this.signaturePublicUrl;
    }

    if (publicUrl && publicUrl !== 'your_r2_public_url') {
      // Si URL publique configurée, utiliser l'URL publique directe
      return `${publicUrl}/${key}`;
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
      // Déterminer le bucket selon le type de clé
      let targetBucket = this.bucketName;
      if (key.includes('/ImgProfil/') || key.includes('/logoReseau/')) {
        targetBucket = this.signatureBucketName;
      }
      
      const command = new GetObjectCommand({
        Bucket: targetBucket,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.client, command, {
        expiresIn,
        // Ajouter des paramètres spécifiques à Cloudflare R2
        signableHeaders: new Set(['host']),
        unhoistableHeaders: new Set(['x-amz-content-sha256']),
      });

      return signedUrl;
    } catch (error) {
      throw new Error(`Échec de la génération d'URL signée: ${error.message}`);
    }
  }

  /**
   * Crée la structure de dossiers pour une signature
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @param {string} imageType - Type d'image ('imgProfil' ou 'logoReseau')
   * @returns {Promise<void>}
   */
  async createFolders(userId, signatureId, imageType) {
    try {
      // Définir les dossiers à créer
      const folders = [
        `${userId}/`,
        `${userId}/${signatureId}/`,
        `${userId}/${signatureId}/${imageType}/`
      ];
      
      // Créer chaque dossier
      for (const folder of folders) {
        try {
          const command = new PutObjectCommand({
            Bucket: this.signatureBucketName || this.bucketName,
            Key: folder,
            Body: '',
            ContentType: 'application/x-directory'
          });
          
          await this.client.send(command);
        } catch (error) {
          // Ignorer l'erreur si le dossier existe déjà
          if (error.name !== 'BucketAlreadyOwnedByYou' && error.code !== 'BucketAlreadyOwnedByYou') {
            // Ignorer les erreurs de dossier existant
          }
        }
      }
    } catch (error) {
      // Ne pas bloquer le processus si la création des dossiers échoue
      // L'erreur est ignorée intentionnellement
    }
  }

  /**
   * Supprime une image de Cloudflare R2
   * @param {string} key - Clé de l'image à supprimer
   * @param {string} bucketName - Nom du bucket (optionnel, utilise le bucket par défaut si non spécifié)
   * @returns {Promise<boolean>}
   */
  async deleteImage(key, bucketName = null) {
    try {
      const targetBucket = bucketName || this.bucketName;
      
      const command = new DeleteObjectCommand({
        Bucket: targetBucket,
        Key: key,
      });

      await this.client.send(command);
      return true;
    } catch (error) {
      // Ne pas faire échouer si l'image n'existe pas
      if (error.name === 'NoSuchKey') {
        return true;
      }
      throw new Error(`Échec de la suppression: ${error.message}`);
    }
  }

  /**
   * Supprime toutes les images d'un dossier spécifique (ImgProfil ou logoReseau)
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @param {string} folderType - Type de dossier ('ImgProfil' ou 'logoReseau')
   * @returns {Promise<boolean>}
   */
  async deleteSignatureFolder(userId, signatureId, folderType) {
    try {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      
      // Convertir le type d'image en nom de dossier correct
      const folderName = folderType === 'imgProfil' ? 'ImgProfil' : 'logoReseau';
      const prefix = `${userId}/${signatureId}/${folderName}/`;

      console.log(`🗑️ Suppression du dossier: ${prefix}`);

      // Lister tous les objets dans le dossier
      const listCommand = new ListObjectsV2Command({
        Bucket: this.signatureBucketName,
        Prefix: prefix,
      });

      const listResponse = await this.client.send(listCommand);
      
      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        console.log(`🗑️ Aucun fichier à supprimer dans: ${prefix}`);
        return true;
      }

      console.log(`🗑️ Suppression de ${listResponse.Contents.length} fichier(s)`);

      // Supprimer chaque fichier (y compris les marqueurs de dossiers)
      const deletePromises = listResponse.Contents.map((object) => {
        console.log(`🗑️ Suppression: ${object.Key}`);
        return this.deleteImage(object.Key, this.signatureBucketName);
      });

      await Promise.all(deletePromises);
      console.log(`✅ Dossier ${prefix} nettoyé avec succès`);
      return true;
    } catch (error) {
      console.warn('⚠️ Erreur suppression dossier:', error.message);
      // Ne pas faire échouer l'upload si la suppression échoue
      return false;
    }
  }

  /**
   * Crée les dossiers nécessaires pour la structure de signature
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @param {string} imageType - Type d'image ('imgProfil' ou 'logoReseau')
   */
  async createSignatureFolders(userId, signatureId, imageType) {
    try {
      const folderName = imageType === 'imgProfil' ? 'ImgProfil' : 'logoReseau';
      
      // Créer des objets "marqueurs" pour les dossiers avec des clés se terminant par /
      // Cela aide Cloudflare R2 à reconnaître la structure de dossiers
      const foldersToCreate = [
        `${userId}/`,
        `${userId}/${signatureId}/`,
        `${userId}/${signatureId}/${folderName}/`
      ];

      for (const folderKey of foldersToCreate) {
        try {
          const command = new PutObjectCommand({
            Bucket: this.signatureBucketName,
            Key: folderKey,
            Body: Buffer.alloc(0), // Contenu vide
            ContentType: 'application/x-directory',
            Metadata: {
              'folder-marker': 'true'
            }
          });

          await this.client.send(command);
          console.log(`📁 Dossier créé: ${folderKey}`);
        } catch (error) {
          // Ignorer les erreurs si le dossier existe déjà
          console.log(`📁 Dossier existe déjà: ${folderKey}`);
        }
      }
    } catch (error) {
      console.warn('⚠️ Erreur création dossiers:', error.message);
      // Ne pas faire échouer l'upload si la création des dossiers échoue
    }
  }

  /**
   * Télécharge une image de signature vers Cloudflare R2
   * @param {Buffer} fileBuffer - Le contenu du fichier à télécharger
   * @param {string} fileName - Le nom du fichier
   * @param {string} userId - L'ID de l'utilisateur
   * @param {string} signatureId - L'ID de la signature
   * @param {string} imageType - Le type d'image ('imgProfil' ou 'logoReseau')
   * @returns {Promise<Object>} - Les informations sur l'image téléchargée
   */
  async uploadSignatureImage(fileBuffer, fileName, userId, signatureId, imageType) {
    try {
      console.log(`🚀 Début upload signature - userId: ${userId}, signatureId: ${signatureId}, imageType: ${imageType}`);
      
      // Validation des paramètres
      if (!signatureId) {
        throw new Error('Signature ID requis pour l\'upload d\'images de signature');
      }
      
      if (!['imgProfil', 'logoReseau'].includes(imageType)) {
        throw new Error('Type d\'image invalide. Doit être \'imgProfil\' ou \'logoReseau\'');
      }

      // Supprimer les anciennes images du même type
      console.log(`🗑️ Suppression des anciennes images pour ${imageType}`);
      await this.deleteSignatureFolder(userId, signatureId, imageType);
      
      // Cloudflare R2 créera automatiquement la structure de dossiers basée sur la clé du fichier
      console.log('📁 Structure de dossiers sera créée automatiquement par Cloudflare R2');
      
      // Uploader la nouvelle image
      console.log(`📤 Upload de la nouvelle image`);
      const result = await this.uploadImage(
        fileBuffer, 
        fileName, 
        userId, 
        imageType, 
        null, // organizationId
        signatureId
      );
      
      console.log(`✅ Upload terminé avec succès:`, result);
      return result;
    } catch (error) {
      console.error(`❌ Erreur upload signature:`, error);
      throw new Error(`Échec de l'upload ${imageType}: ${error.message}`);
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
      '.pdf': 'application/pdf', // Support des PDF
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff',
      '.bmp': 'image/bmp',
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
