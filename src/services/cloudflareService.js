/**
 * Service pour gérer l'upload et la récupération d'images sur Cloudflare R2
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import crypto from "crypto";

// Charger les variables d'environnement
dotenv.config();

class CloudflareService {
  constructor() {
    // Configuration Cloudflare R2 (compatible S3) - utilise les variables AWS existantes
    this.client = new S3Client({
      region: "auto",
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
    
    // Configuration spécifique pour les images d'entreprise
    this.companyBucketName = process.env.AWS_S3_BUCKET_NAME_IMG_COMPANY;
    this.companyPublicUrl = process.env.COMPANY_IMAGES_PUBLIC_URL;
    
    // Configuration spécifique pour les images de profil
    this.profileBucketName = process.env.AWS_S3_BUCKET_NAME_IMG_PROFILE;
    this.profilePublicUrl = process.env.AWS_S3_API_URL_PROFILE || "https://pub-012a0ee1541743df9b78b220e9efac5e.r2.dev";
    
    console.log('🔧 CloudflareService - Variables profil:');
    console.log('   AWS_S3_BUCKET_NAME_IMG_PROFILE:', process.env.AWS_S3_BUCKET_NAME_IMG_PROFILE);
    console.log('   AWS_S3_API_URL_PROFILE:', process.env.AWS_S3_API_URL_PROFILE);
    console.log('   this.profilePublicUrl après init:', this.profilePublicUrl);

    if (!this.bucketName) {
      console.error("❌ ERREUR: IMAGE_BUCKET_NAME n'est pas définie!");
      throw new Error("Configuration manquante: IMAGE_BUCKET_NAME");
    }
  }

  /**
   * Nettoie un nom de fichier pour les headers HTTP
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
   * Upload une image vers Cloudflare R2
   * @param {Buffer} fileBuffer - Buffer de l'image
   * @param {string} fileName - Nom original du fichier
   * @param {string} userId - ID de l'utilisateur
   * @param {string} imageType - Type d'image ('profile' ou 'company')
   * @returns {Promise<{key: string, url: string}>}
   */
  async uploadImage(fileBuffer, fileName, userId, imageType = "profile", organizationId = null) {
    try {
      // Générer une clé unique pour l'image
      const fileExtension = path.extname(fileName).toLowerCase();
      const uniqueId = crypto.randomUUID();
      
      // Déterminer le chemin selon le type de fichier
      console.log('🔍 CloudflareService - imageType reçu:', imageType);
      let key;
      switch (imageType) {
        case 'ocr': {
          // Pour les reçus OCR, organiser par organisation (ID organisation uniquement)
          if (!organizationId) {
            throw new Error('Organization ID requis pour les uploads OCR');
          }
          console.log('🏢 CloudflareService - Organization ID pour OCR:', organizationId);
          key = `${organizationId}/${uniqueId}${fileExtension}`;
          break;
        }
        case 'imgCompany': {
          // Pour les logos d'entreprise
          const orgId = organizationId || userId;
          key = `${orgId}/company/${uniqueId}${fileExtension}`;
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

      console.log('📁 CloudflareService - Clé générée:', key);

      // Déterminer le bucket et l'URL publique selon le type
      let targetBucket, targetPublicUrl;
      if (imageType === 'ocr') {
        targetBucket = this.ocrBucketName || this.bucketName;
        targetPublicUrl = this.ocrPublicUrl || this.publicUrl;
        console.log('🪣 CloudflareService - Utilisation bucket OCR:', targetBucket);
      } else if (imageType === 'imgCompany') {
        targetBucket = this.companyBucketName || this.bucketName;
        targetPublicUrl = this.companyPublicUrl || this.publicUrl;
        console.log('🪣 CloudflareService - Utilisation bucket entreprise:', targetBucket);
      } else if (imageType === 'profile') {
        targetBucket = this.profileBucketName || this.bucketName;
        targetPublicUrl = this.profilePublicUrl || "https://pub-012a0ee1541743df9b78b220e9efac5e.r2.dev";
        console.log('🪣 CloudflareService - Utilisation bucket profil:', targetBucket);
        console.log('🌐 CloudflareService - URL publique profil:', targetPublicUrl);
      } else {
        targetBucket = this.bucketName;
        targetPublicUrl = this.publicUrl;
        console.log('🪣 CloudflareService - Utilisation bucket standard:', targetBucket);
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
        targetPublicUrl !== "https://your_image_bucket_public_url"
      ) {
        // Éviter les doubles barres obliques
        const cleanUrl = targetPublicUrl.endsWith('/') ? targetPublicUrl.slice(0, -1) : targetPublicUrl;
        imageUrl = `${cleanUrl}/${key}`;
        console.log('🌐 CloudflareService - URL générée:', imageUrl);
      } else {
        // Fallback sur le proxy backend si pas d'URL publique configurée

        const keyParts = key.split("/");
        if (keyParts.length >= 3 && keyParts[0] === "signatures") {
          const userId = keyParts[1];
          const imageType = keyParts[2];
          const filename = keyParts.slice(3).join("/");

          const baseUrl = process.env.BACKEND_URL || "http://localhost:4000";
          imageUrl = `${baseUrl}/api/images/${userId}/${imageType}/${filename}`;
        } else {
          // Dernier fallback sur URL signée avec le bon bucket
          console.log('🔐 CloudflareService - Fallback URL signée, bucket:', targetBucket);
          imageUrl = await this.getSignedUrlForBucket(key, targetBucket, 86400);
        }
      }

      return {
        key,
        url: imageUrl,
        contentType,
      };
    } catch (error) {
      console.error("Erreur upload Cloudflare:", error);
      throw new Error(`Échec de l'upload vers Cloudflare: ${error.message}`);
    }
  }

  /**
   * Upload un logo social vers le bucket logo-rs
   * @param {Buffer} fileBuffer - Buffer de l'image
   * @param {string} fileName - Nom original du fichier
   * @param {string} logoType - Type de logo ('facebook', 'linkedin', etc.)
   * @param {string} color - Couleur du logo
   * @returns {Promise<{key: string, url: string}>}
   */
  async uploadSocialLogo(fileBuffer, fileName, logoType, color) {
    try {
      // Configuration spécifique pour le bucket logo-rs
      const logoBucketName = process.env.LOGO_BUCKET_NAME || "logo-rs";
      const logoPublicUrl = process.env.LOGO_PUBLIC_URL;

      // Créer un client S3 spécifique pour les logos (même config mais différent bucket)
      const logoClient = new S3Client({
        region: "auto",
        endpoint: process.env.AWS_S3_API_URL,
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        },
      });

      // Générer une clé unique pour le logo social
      const fileExtension = path.extname(fileName).toLowerCase();
      const timestamp = Date.now();
      const colorHash = color.replace("#", "");
      const key = `social-logos/${logoType}/${colorHash}/${timestamp}${fileExtension}`;

      // Déterminer le content-type
      const contentType = this.getContentType(fileExtension);

      // Commande d'upload vers le bucket logo-rs
      const command = new PutObjectCommand({
        Bucket: logoBucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
        CacheControl: "public, max-age=31536000", // Cache 1 an
        Metadata: {
          logoType: logoType,
          color: color,
          uploadedAt: new Date().toISOString(),
        },
      });

      await logoClient.send(command);

      // Générer l'URL publique
      let imageUrl;
      if (logoPublicUrl) {
        imageUrl = `${logoPublicUrl}/${key}`;
      } else {
        // Fallback sur URL signée si pas d'URL publique
        imageUrl = await this.getSignedUrl(key, 86400);
      }

      return {
        key,
        url: imageUrl,
        contentType,
      };
    } catch (error) {
      console.error("Erreur upload logo social:", error);
      throw new Error(`Échec de l'upload du logo social: ${error.message}`);
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

    console.log('🔍 CloudflareService - getImageUrl appelée avec key:', key);

    // Déterminer l'URL publique appropriée selon le type d'image
    let targetPublicUrl = process.env.AWS_R2_PUBLIC_URL;

    // Analyser la clé pour déterminer le type d'image
    const keyParts = key.split("/");
    
    if (keyParts.length >= 2 && keyParts[1] === "image") {
      // Format: userId/image/filename -> Image de profil
      targetPublicUrl = process.env.AWS_S3_API_URL_PROFILE;
      console.log('👤 CloudflareService - Image de profil détectée');
      console.log('🌐 CloudflareService - URL publique profil:', targetPublicUrl);
      console.log('🔍 CloudflareService - Variable env AWS_S3_API_URL_PROFILE:', process.env.AWS_S3_API_URL_PROFILE);
    } else if (keyParts.length >= 2 && keyParts[1] === "company") {
      // Format: userId/company/filename -> Image d'entreprise
      targetPublicUrl = process.env.COMPANY_IMAGES_PUBLIC_URL;
      console.log('🏢 CloudflareService - Image d\'entreprise détectée');
    } else if (keyParts.length >= 1 && !key.includes("signatures")) {
      // Format: orgId/filename -> Image OCR
      targetPublicUrl = process.env.IMAGE_OCR_PUBLIC_URL;
      console.log('📄 CloudflareService - Image OCR détectée');
    } else if (key.includes("signatures")) {
      // Format signatures/userId/type/filename -> Image signature
      targetPublicUrl = process.env.IMAGE_PUBLIC_URL;
      console.log('✍️ CloudflareService - Image signature détectée');
    }

    if (
      targetPublicUrl &&
      targetPublicUrl !== "your_r2_public_url" &&
      targetPublicUrl !== undefined
    ) {
      // Si URL publique configurée, utiliser l'URL publique directe
      const finalUrl = `${targetPublicUrl}/${key}`;
      console.log('🌐 CloudflareService - URL finale générée:', finalUrl);
      return finalUrl;
    } else {
      // Sinon, générer une URL signée temporaire avec le bon bucket
      console.log('🔐 CloudflareService - Fallback sur URL signée');
      console.log('🔍 CloudflareService - targetPublicUrl était:', targetPublicUrl);
      
      // Déterminer le bon bucket pour l'URL signée
      let targetBucket = this.bucketName;
      if (keyParts.length >= 2 && keyParts[1] === "image") {
        targetBucket = this.profileBucketName || this.bucketName;
      } else if (keyParts.length >= 2 && keyParts[1] === "company") {
        targetBucket = this.companyBucketName || this.bucketName;
      } else if (keyParts.length >= 1 && !key.includes("signatures")) {
        targetBucket = this.ocrBucketName || this.bucketName;
      }
      
      console.log('🪣 CloudflareService - Bucket pour URL signée:', targetBucket);
      return await this.getSignedUrlForBucket(key, targetBucket, expiresIn);
    }
  }

  /**
   * Génère une URL signée temporaire pour l'accès privé
   * @param {string} key - Clé de l'image
   * @param {number} expiresIn - Durée de validité en secondes (défaut: 1h)
   * @returns {Promise<string>}
   */
  async getSignedUrl(key, expiresIn = 3600) {
    return await this.getSignedUrlForBucket(key, this.bucketName, expiresIn);
  }

  /**
   * Génère une URL signée temporaire pour un bucket spécifique
   * @param {string} key - Clé de l'image
   * @param {string} bucketName - Nom du bucket à utiliser
   * @param {number} expiresIn - Durée de validité en secondes (défaut: 1h)
   * @returns {Promise<string>}
   */
  async getSignedUrlForBucket(key, bucketName, expiresIn = 3600) {
    try {
      console.log(`🔐 CloudflareService - Génération URL signée pour bucket: ${bucketName}, key: ${key}`);
      
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.client, command, {
        expiresIn,
        // Ajouter des paramètres spécifiques à Cloudflare R2
        signableHeaders: new Set(["host"]),
        unhoistableHeaders: new Set(["x-amz-content-sha256"]),
      });

      console.log(`🌐 CloudflareService - URL signée générée: ${signedUrl.substring(0, 100)}...`);
      return signedUrl;
    } catch (error) {
      console.error("Erreur génération URL signée:", error);
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
      console.error("Erreur suppression Cloudflare:", error);
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
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf", // Support des PDF
      ".tiff": "image/tiff",
      ".tif": "image/tiff",
      ".bmp": "image/bmp",
    };

    return mimeTypes[extension] || "application/octet-stream";
  }

  /**
   * Valide si le fichier est une image supportée
   * @param {string} fileName - Nom du fichier
   * @returns {boolean}
   */
  isValidImageFile(fileName) {
    const validExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
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
