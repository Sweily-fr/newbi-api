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
    // Debug: Vérifier les variables d'environnement
    console.log("🔧 Configuration Cloudflare R2:");
    console.log("  IMAGE_BUCKET_NAME:", process.env.IMAGE_BUCKET_NAME);
    console.log("  LOGO_BUCKET_NAME:", process.env.LOGO_BUCKET_NAME);
    console.log(
      "  AWS_S3_BUCKET_NAME_IMG_COMPANY:",
      process.env.AWS_S3_BUCKET_NAME_IMG_COMPANY
    );
    console.log("  AWS_S3_API_URL:", process.env.AWS_S3_API_URL);
    console.log(
      "  AWS_S3_API_URL_IMG_COMPANY:",
      process.env.AWS_S3_API_URL_IMG_COMPANY
    );
    console.log(
      "  AWS_ACCESS_KEY_ID:",
      process.env.AWS_ACCESS_KEY_ID ? "✅ Définie" : "❌ Manquante"
    );
    console.log(
      "  AWS_SECRET_ACCESS_KEY:",
      process.env.AWS_SECRET_ACCESS_KEY ? "✅ Définie" : "❌ Manquante"
    );
    console.log("  IMAGE_PUBLIC_URL:", process.env.IMAGE_PUBLIC_URL);
    console.log("  LOGO_PUBLIC_URL:", process.env.LOGO_PUBLIC_URL);
    console.log("  COMPANY_PUBLIC_URL:", process.env.COMPANY_IMAGES_PUBLIC_URL);

    // Configuration Cloudflare R2 (compatible S3) - utilise les variables AWS existantes
    this.client = new S3Client({
      region: "auto",
      endpoint: process.env.AWS_S3_API_URL,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    // Configuration des buckets séparés
    this.imageBucketName = process.env.IMAGE_BUCKET_NAME;
    this.logoBucketName = process.env.LOGO_BUCKET_NAME;
    this.companyBucketName = process.env.AWS_S3_BUCKET_NAME_IMG_COMPANY;
    this.imagePublicUrl = process.env.IMAGE_PUBLIC_URL;
    this.logoPublicUrl = process.env.LOGO_PUBLIC_URL;
    this.companyPublicUrl = process.env.COMPANY_IMAGES_PUBLIC_URL;

    // Client séparé pour le bucket des logos
    this.logoClient = new S3Client({
      region: "auto",
      endpoint: process.env.AWS_S3_API_URL,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    // Client spécifique pour les images d'entreprise
    this.companyClient = new S3Client({
      region: "auto",
      endpoint: process.env.AWS_S3_API_URL_IMG_COMPANY,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    if (!this.imageBucketName || !this.logoBucketName) {
      console.error(
        "❌ ERREUR: IMAGE_BUCKET_NAME ou LOGO_BUCKET_NAME manquant!"
      );
      throw new Error(
        "Configuration manquante: IMAGE_BUCKET_NAME et LOGO_BUCKET_NAME requis"
      );
    }

    if (!this.companyBucketName) {
      console.error("❌ ERREUR: AWS_S3_BUCKET_NAME_IMG_COMPANY manquant!");
      throw new Error(
        "Configuration manquante: AWS_S3_BUCKET_NAME_IMG_COMPANY requis"
      );
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
   * @param {string} imageType - Type d'image ('profile', 'company', ou 'imgCompany')
   * @param {string} organizationId - ID de l'organisation (optionnel)
   * @returns {Promise<{key: string, url: string}>}
   */
  async uploadImage(
    fileBuffer,
    fileName,
    userId,
    imageType = "profile",
    organizationId = null
  ) {
    try {
      // Générer une clé pour l'image
      const fileExtension = path.extname(fileName).toLowerCase();
      let key, bucketName, client;

      // Déterminer le bucket et la clé selon le type d'image
      if (imageType === "imgCompany" || imageType === "company") {
        // Pour les images d'entreprise : userId/logo.extension (clé fixe pour écraser)
        key = `${userId}/logo${fileExtension}`;
        bucketName = this.companyBucketName;
        client = this.companyClient;
        console.log("📁 Upload vers bucket entreprise:", bucketName);
        console.log("🏢 Utilisateur ID:", userId);
        console.log("🔄 Écrasement du logo existant avec la clé:", key);
      } else {
        // Pour les autres images : signatures/userId/imageType/uniqueId.extension (UUID pour éviter les conflits)
        const uniqueId = crypto.randomUUID();
        key = `signatures/${userId}/${imageType}/${uniqueId}${fileExtension}`;
        bucketName = this.imageBucketName;
        client = this.client;
        console.log("📁 Upload vers bucket signatures:", bucketName);
      }

      // Déterminer le content-type
      const contentType = this.getContentType(fileExtension);

      // Nettoyer le nom de fichier pour les headers HTTP
      const sanitizedFileName = this.sanitizeFileName(fileName);
      console.log("📝 Nom de fichier original:", fileName);
      console.log("🧹 Nom de fichier nettoyé:", sanitizedFileName);

      // Commande d'upload
      const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
        Metadata: {
          userId: userId,
          imageType: imageType,
          organizationId: organizationId || "",
          originalName: sanitizedFileName,
          uploadedAt: new Date().toISOString(),
        },
      });

      await client.send(command);

      // Générer l'URL appropriée selon la configuration
      let imageUrl;

      if (imageType === "imgCompany" || imageType === "company") {
        // Pour les images d'entreprise, utiliser l'URL publique configurée
        if (
          this.companyPublicUrl &&
          this.companyPublicUrl !== "https://your_company_bucket_public_url"
        ) {
          imageUrl = `${this.companyPublicUrl}/${key}`;
          console.log(
            "🌐 URL publique Cloudflare entreprise générée:",
            imageUrl
          );
        } else {
          // Fallback sur URL hardcodée si pas configurée
          imageUrl = `https://pub-157ce0fed50fe542bc92a07317a09205.r2.dev/${key}`;
          console.log(
            "🌐 URL publique Cloudflare entreprise (fallback):",
            imageUrl
          );
        }
      } else {
        // Utilisation directe des URLs publiques Cloudflare R2 pour les autres images
        if (
          this.imagePublicUrl &&
          this.imagePublicUrl !== "https://your_image_bucket_public_url"
        ) {
          imageUrl = `${this.imagePublicUrl}/${key}`;
          console.log("🌐 URL publique Cloudflare R2 générée:", imageUrl);
        } else {
          // Fallback sur le proxy backend si pas d'URL publique configurée
          console.log(
            "🔗 Pas d'URL publique configurée, utilisation du proxy pour:",
            key
          );

          const keyParts = key.split("/");
          if (keyParts.length >= 3 && keyParts[0] === "signatures") {
            const userId = keyParts[1];
            const imageType = keyParts[2];
            const filename = keyParts.slice(3).join("/");

            const baseUrl = process.env.BACKEND_URL || "http://localhost:4000";
            imageUrl = `${baseUrl}/api/images/${userId}/${imageType}/${filename}`;

            console.log("✅ URL proxy générée:", imageUrl);
          } else {
            // Dernier fallback sur URL signée
            console.log(
              "⚠️ Structure de clé inattendue, fallback sur URL signée"
            );
            imageUrl = await this.getSignedUrl(key, 86400, client, bucketName);
          }
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
   * Récupère l'URL d'une image (publique ou signée selon la configuration)
   * @param {string} key - Clé de l'image dans R2
   * @param {number} expiresIn - Durée de validité en secondes pour URL signée (défaut: 24h)
   * @returns {Promise<string>}
   */
  async getImageUrl(key, expiresIn = 86400) {
    if (!key) return null;

    if (
      process.env.AWS_R2_PUBLIC_URL &&
      process.env.AWS_R2_PUBLIC_URL !== "your_r2_public_url"
    ) {
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
   * @param {S3Client} client - Client S3 à utiliser (optionnel)
   * @param {string} bucketName - Nom du bucket (optionnel)
   * @returns {Promise<string>}
   */
  async getSignedUrl(key, expiresIn = 3600, client = null, bucketName = null) {
    try {
      console.log("🔗 Génération URL signée pour:", key);

      const s3Client = client || this.client;
      const bucket = bucketName || this.imageBucketName;

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const signedUrl = await getSignedUrl(s3Client, command, {
        expiresIn,
        // Ajouter des paramètres spécifiques à Cloudflare R2
        signableHeaders: new Set(["host"]),
        unhoistableHeaders: new Set(["x-amz-content-sha256"]),
      });

      console.log(
        "✅ URL signée générée:",
        signedUrl.substring(0, 100) + "..."
      );
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
        Bucket: this.imageBucketName,
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
