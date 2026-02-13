/**
 * Service Cloudflare R2 pour la gestion des images
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import path from "path";
import dotenv from "dotenv";
import crypto from "crypto";

// Charger les variables d'environnement
dotenv.config();

class CloudflareService {
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

    this.bucketName = process.env.USER_IMAGE_BUCKET;
    this.publicUrl = process.env.USER_IMAGE_URL; // URL publique de votre domaine custom

    // Configuration spécifique pour l'OCR
    this.ocrBucketName = process.env.OCR_BUCKET;
    this.ocrPublicUrl = process.env.OCR_URL;

    // Configuration spécifique pour les signatures mail
    this.signatureBucketName =
      process.env.SIGNATURE_BUCKET || "image-signature-staging";
    this.signaturePublicUrl =
      process.env.SIGNATURE_URL ||
      "https://pub-f4c5982b836541739955ba7662828aa2.r2.dev";

    // Configuration spécifique pour les images de profil
    this.profileBucketName =
      process.env.PROFILE_IMAGE_BUCKET || "profil-staging";
    this.profilePublicUrl =
      process.env.PROFILE_IMAGE_URL ||
      "https://pub-47fd700687d247b786fdd97634f23e12.r2.dev";

    // Configuration spécifique pour les images d'entreprise
    this.companyImagesBucketName =
      process.env.COMPANY_IMAGE_BUCKET || "image-company-staging";
    this.companyImagesPublicUrl =
      process.env.COMPANY_IMAGE_URL ||
      "https://pub-f609a47148ad4ae39fe95fc7b850fc03.r2.dev";

    // Configuration spécifique pour les factures importées
    this.importedInvoicesBucketName =
      process.env.IMPORTED_INVOICES_BUCKET || "imported-invoices-staging";
    this.importedInvoicesPublicUrl =
      process.env.IMPORTED_INVOICES_URL ||
      "https://pub-e4f26dbdae324a3eb3a2c49ed9723c1d.r2.dev";

    // Configuration spécifique pour les justificatifs de dépenses
    this.receiptsBucketName = process.env.RECEIPTS_BUCKET || "receipts-staging";
    this.receiptsPublicUrl =
      process.env.RECEIPTS_URL || "https://pub-receipts.r2.dev";

    // Configuration spécifique pour les documents partagés
    this.sharedDocumentsBucketName =
      process.env.SHARED_DOCUMENTS_BUCKET || "shared-documents-staging";
    this.sharedDocumentsPublicUrl =
      process.env.SHARED_DOCUMENTS_URL || "https://pub-shared-docs.r2.dev";

    if (!this.bucketName) {
      throw new Error("Configuration manquante: USER_IMAGE_BUCKET");
    }

    // Logs de configuration pour debug
    console.log("🔧 CloudflareService - Configuration chargée:");
    console.log("  - Endpoint:", process.env.R2_API_URL);
    console.log("  - User Images:", this.bucketName, "→", this.publicUrl);
    console.log(
      "  - Profile Images:",
      this.profileBucketName,
      "→",
      this.profilePublicUrl
    );
    console.log(
      "  - Company Images:",
      this.companyImagesBucketName,
      "→",
      this.companyImagesPublicUrl
    );
    console.log(
      "  - Signatures:",
      this.signatureBucketName,
      "→",
      this.signaturePublicUrl
    );
    console.log("  - OCR:", this.ocrBucketName, "→", this.ocrPublicUrl);
    console.log(
      "  - Imported Invoices:",
      this.importedInvoicesBucketName,
      "→",
      this.importedInvoicesPublicUrl
    );
    console.log(
      "  - Receipts:",
      this.receiptsBucketName,
      "→",
      this.receiptsPublicUrl
    );
    console.log(
      "  - Shared Documents:",
      this.sharedDocumentsBucketName,
      "→",
      this.sharedDocumentsPublicUrl
    );
  }

  /**
   * Nettoie un nom de fichier pour les headers HTTP
   * @param {string} fileName - Nom original du fichier
   * @returns {string} - Nom de fichier nettoyé
   */
  sanitizeFileName(fileName) {
    if (!fileName) return "unknown";

    // Remplacer les caractères spéciaux par des tirets
    return fileName.replace(/[^\w\d.-]/g, "-");
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
  async uploadImage(
    fileBuffer,
    fileName,
    userId,
    imageType = "profile",
    organizationId = null,
    signatureId = null
  ) {
    try {
      // Générer une clé unique pour l'image
      const uniqueId = crypto.randomUUID();

      // Déterminer le chemin selon le type de fichier
      const fileExtension = path.extname(fileName).toLowerCase();
      let key;

      switch (imageType) {
        case "imgProfil": {
          // Structure : idUser/idSignature/ImgProfil/fichier
          if (!signatureId) {
            throw new Error(
              "Signature ID requis pour les images de profil de signature"
            );
          }
          key = `${userId}/${signatureId}/ImgProfil/${uniqueId}${fileExtension}`;
          break;
        }
        case "logoReseau": {
          // Structure : idUser/idSignature/logoReseau/fichier
          if (!signatureId) {
            throw new Error(
              "Signature ID requis pour les logos réseaux sociaux"
            );
          }
          key = `${userId}/${signatureId}/logoReseau/${uniqueId}${fileExtension}`;
          break;
        }
        case "imgCompany": {
          // Pour les logos d'entreprise - Structure: image-company/{idOrganisation}/{NomImage}
          if (!organizationId) {
            throw new Error(
              "Organization ID requis pour les logos d'entreprise"
            );
          }
          // Garder le nom original du fichier (nettoyé)
          const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
          key = `${organizationId}/${sanitizedName}`;
          break;
        }
        case "ocr": {
          // Pour les reçus OCR, organiser par organisation (ID organisation uniquement)
          if (!organizationId) {
            throw new Error("Organization ID requis pour les uploads OCR");
          }
          key = `${organizationId}/${uniqueId}${fileExtension}`;
          break;
        }
        case "temp": {
          // Pour les uploads temporaires (reçus optionnels avant sauvegarde)
          // Structure: temp/{userId}/{uniqueId}
          key = `temp/${userId}/${uniqueId}${fileExtension}`;
          break;
        }
        case "documents": {
          // Pour les documents généraux
          key = `documents/${userId}/${uniqueId}${fileExtension}`;
          break;
        }
        case "importedInvoice": {
          // Pour les factures importées, organiser par organisation
          if (!organizationId) {
            throw new Error(
              "Organization ID requis pour les factures importées"
            );
          }
          key = `${organizationId}/${uniqueId}${fileExtension}`;
          break;
        }
        case "receipt": {
          // Pour les justificatifs de dépenses, organiser par organisation
          // Structure: {organizationId}/{uniqueId}-receipt.ext
          if (!organizationId) {
            throw new Error("Organization ID requis pour les justificatifs");
          }
          key = `${organizationId}/${uniqueId}-receipt${fileExtension}`;
          break;
        }
        case "sharedDocuments": {
          // Pour les documents partagés, organiser par workspace
          // Structure: shared-documents/{workspaceId}/{uniqueId}.ext
          if (!organizationId) {
            throw new Error("Workspace ID requis pour les documents partagés");
          }
          key = `shared-documents/${organizationId}/${uniqueId}${fileExtension}`;
          break;
        }
        case "profile": {
          // Pour les images de profil - sans préfixe signatures/
          key = `${userId}/image/${uniqueId}${fileExtension}`;
          break;
        }
        case "visitorImage": {
          // Pour les images des visiteurs externes (Kanban public)
          // Structure: userVisitor/{visitorId}/{uniqueId}.ext
          // Le visitorId est passé via signatureId pour réutiliser le paramètre existant
          const visitorId = signatureId;
          if (!visitorId) {
            throw new Error("Visitor ID requis pour les images de visiteur");
          }
          key = `userVisitor/${visitorId}/${uniqueId}${fileExtension}`;
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
      if (imageType === "imgProfil" || imageType === "logoReseau") {
        targetBucket = this.signatureBucketName;
        targetPublicUrl = this.signaturePublicUrl;
      } else if (imageType === "imgCompany") {
        // Utiliser le bucket dédié aux images d'entreprise
        targetBucket = this.companyImagesBucketName || this.bucketName;
        targetPublicUrl = this.companyImagesPublicUrl || this.publicUrl;
        console.log("🏢 [COMPANY_LOGO] Upload vers bucket:", targetBucket);
        console.log("🌐 [COMPANY_LOGO] URL publique:", targetPublicUrl);
        console.log("🔑 [COMPANY_LOGO] Clé:", key);
      } else if (imageType === "ocr") {
        targetBucket = this.ocrBucketName || this.bucketName;
        targetPublicUrl = this.ocrPublicUrl || this.publicUrl;
      } else if (imageType === "temp") {
        // Les uploads temporaires utilisent aussi le bucket OCR
        targetBucket = this.ocrBucketName || this.bucketName;
        targetPublicUrl = this.ocrPublicUrl || this.publicUrl;
      } else if (imageType === "profile") {
        targetBucket = this.profileBucketName || this.bucketName;
        targetPublicUrl = this.profilePublicUrl || this.publicUrl;
      } else if (imageType === "importedInvoice") {
        targetBucket = this.importedInvoicesBucketName || this.bucketName;
        targetPublicUrl = this.importedInvoicesPublicUrl || this.publicUrl;
      } else if (imageType === "receipt") {
        // Bucket dédié aux justificatifs de dépenses
        targetBucket = this.receiptsBucketName || this.bucketName;
        targetPublicUrl = this.receiptsPublicUrl || this.publicUrl;
        console.log("🧾 [RECEIPT] Upload vers bucket:", targetBucket);
        console.log("🌐 [RECEIPT] URL publique:", targetPublicUrl);
        console.log("🔑 [RECEIPT] Clé:", key);
      } else if (imageType === "sharedDocuments") {
        // Bucket dédié aux documents partagés
        targetBucket = this.sharedDocumentsBucketName || this.bucketName;
        targetPublicUrl = this.sharedDocumentsPublicUrl || this.publicUrl;
        console.log("📁 [SHARED_DOCS] Upload vers bucket:", targetBucket);
        console.log("🌐 [SHARED_DOCS] URL publique:", targetPublicUrl);
        console.log("🔑 [SHARED_DOCS] Clé:", key);
      } else if (imageType === "visitorImage") {
        // Bucket USER_IMAGE pour les images des visiteurs externes
        targetBucket = this.bucketName;
        targetPublicUrl = this.publicUrl;
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
        targetPublicUrl !== "https://your_image_bucket_public_url"
      ) {
        // Éviter les doubles barres obliques
        const cleanUrl = targetPublicUrl.endsWith("/")
          ? targetPublicUrl.slice(0, -1)
          : targetPublicUrl;
        imageUrl = `${cleanUrl}/${key}`;
      } else {
        // Fallback sur le proxy backend si pas d'URL publique configurée

        const keyParts = key.split("/");
        if (keyParts.length >= 3 && keyParts[0] === "signatures") {
          const userId = keyParts[1];
          const imageType = keyParts[2];
          const filename = keyParts.slice(3).join("/");

          const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
          imageUrl = `${baseUrl}/api/images/${userId}/${imageType}/${filename}`;
        } else {
          // Dernier fallback sur URL signée avec le bon bucket
          console.log(
            "🔐 CloudflareService - Fallback URL signée, bucket:",
            targetBucket
          );
          imageUrl = await this.getSignedUrlForBucket(key, targetBucket, 86400);
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
   * Promeut un fichier temporaire en fichier permanent (déplace de temp/ vers ocr/)
   * @param {string} tempKey - Clé du fichier temporaire (temp/userId/uniqueId.ext)
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<{key: string, url: string}>}
   */
  async promoteTemporaryFile(tempKey, organizationId) {
    try {
      console.log("🚀 CloudflareService - Promotion du fichier:", tempKey);

      if (!tempKey || !organizationId) {
        throw new Error("tempKey et organizationId sont requis");
      }

      // Extraire l'extension du fichier temporaire
      const fileExtension = tempKey.substring(tempKey.lastIndexOf("."));
      const crypto = await import("crypto");
      const uniqueId = crypto.default.randomUUID();

      // Nouvelle clé permanente dans le dossier ocr/
      const newKey = `${organizationId}/${uniqueId}${fileExtension}`;

      console.log("📋 CloudflareService - Ancien clé:", tempKey);
      console.log("📋 CloudflareService - Nouvelle clé:", newKey);

      // Lire le fichier temporaire
      const getCommand = new GetObjectCommand({
        Bucket: this.ocrBucketName,
        Key: tempKey,
      });

      const response = await this.client.send(getCommand);
      const fileBuffer = await response.Body.transformToByteArray();

      // Uploader le fichier à la nouvelle location
      const putCommand = new PutObjectCommand({
        Bucket: this.ocrBucketName,
        Key: newKey,
        Body: fileBuffer,
        ContentType: response.ContentType,
        Metadata: {
          organizationId: organizationId,
          imageType: "ocr",
          promotedAt: new Date().toISOString(),
          originalTempKey: tempKey,
        },
      });

      await this.client.send(putCommand);
      console.log(
        "✅ CloudflareService - Fichier uploadé à la nouvelle location"
      );

      // Supprimer le fichier temporaire
      const deleteCommand = new DeleteObjectCommand({
        Bucket: this.ocrBucketName,
        Key: tempKey,
      });

      await this.client.send(deleteCommand);
      console.log("🗑️ CloudflareService - Fichier temporaire supprimé");

      // Générer l'URL publique
      let imageUrl;
      if (
        this.ocrPublicUrl &&
        this.ocrPublicUrl !== "https://your_image_bucket_public_url"
      ) {
        const cleanUrl = this.ocrPublicUrl.endsWith("/")
          ? this.ocrPublicUrl.slice(0, -1)
          : this.ocrPublicUrl;
        imageUrl = `${cleanUrl}/${newKey}`;
      } else {
        imageUrl = await this.getSignedUrlForBucket(
          newKey,
          this.ocrBucketName,
          86400
        );
      }

      return {
        key: newKey,
        url: imageUrl,
      };
    } catch (error) {
      console.error("❌ CloudflareService - Erreur promotion:", error);
      throw new Error(`Échec de la promotion du fichier: ${error.message}`);
    }
  }

  /**
   * Upload un logo social vers la nouvelle structure de signatures
   * @param {Buffer} fileBuffer - Buffer de l'image
   * @param {string} fileName - Nom original du fichier
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @param {string} logoType - Type de logo ('facebook', 'linkedin', 'instagram', 'x')
   * @param {string} color - Couleur du logo (optionnel)
   * @returns {Promise<{key: string, url: string}>}
   */
  async uploadSocialLogo(
    fileBuffer,
    fileName,
    userId,
    signatureId,
    logoType,
    color = null
  ) {
    try {
      // Valider les paramètres requis
      if (!userId || !signatureId || !logoType) {
        throw new Error(
          "userId, signatureId et logoType sont requis pour l'upload de logos sociaux"
        );
      }

      // Valider le type de logo social
      const validLogoTypes = ["facebook", "instagram", "linkedin", "x"];
      if (!validLogoTypes.includes(logoType)) {
        throw new Error(
          `Type de logo invalide. Types supportés: ${validLogoTypes.join(", ")}`
        );
      }

      // Générer une clé unique pour l'image avec structure spécifique aux logos sociaux
      const uniqueId = crypto.randomUUID();
      const fileExtension = path.extname(fileName).toLowerCase();

      // Structure : userId/signatureId/logo/logoType/fichier
      const key = `${userId}/${signatureId}/logo/${logoType}/${uniqueId}${fileExtension}`;

      // Déterminer le content-type
      const contentType = this.getContentType(fileExtension);

      // Nettoyer le nom de fichier pour les headers HTTP
      const sanitizedFileName = this.sanitizeFileName(fileName);

      // Commande d'upload vers le bucket signatures
      const command = new PutObjectCommand({
        Bucket: this.signatureBucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
        Metadata: {
          userId: userId,
          signatureId: signatureId,
          logoType: logoType,
          imageType: "socialLogo",
          originalName: sanitizedFileName,
          uploadedAt: new Date().toISOString(),
          ...(color && { color: color }),
        },
      });

      await this.client.send(command);

      // Générer l'URL publique
      const cleanUrl = this.signaturePublicUrl.endsWith("/")
        ? this.signaturePublicUrl.slice(0, -1)
        : this.signaturePublicUrl;
      const imageUrl = `${cleanUrl}/${key}`;

      console.log(`✅ Logo social ${logoType} uploadé: ${imageUrl}`);

      return {
        key,
        url: imageUrl,
        contentType,
        logoType,
        color,
      };
    } catch (error) {
      console.error(`❌ Erreur upload logo social ${logoType}:`, error.message);
      throw new Error(
        `Échec de l'upload du logo social ${logoType}: ${error.message}`
      );
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
    let publicUrl = process.env.R2_PUBLIC_URL;
    if (key.includes("/ImgProfil/") || key.includes("/logoReseau/")) {
      publicUrl = this.signaturePublicUrl;
    }

    if (publicUrl && publicUrl !== "your_r2_public_url") {
      // Si URL publique configurée, utiliser l'URL publique directe
      return `${publicUrl}/${key}`;
    } else {
      // Sinon, générer une URL signée temporaire avec le bon bucket
      console.log("🔐 CloudflareService - Fallback sur URL signée");
      console.log(
        "🔍 CloudflareService - targetPublicUrl était:",
        targetPublicUrl
      );

      // Déterminer le bon bucket pour l'URL signée
      let targetBucket = this.bucketName;
      if (keyParts.length >= 2 && keyParts[1] === "image") {
        targetBucket = this.profileBucketName || this.bucketName;
      } else if (keyParts.length >= 2 && keyParts[1] === "company") {
        targetBucket = this.companyBucketName || this.bucketName;
      } else if (keyParts.length >= 1 && !key.includes("signatures")) {
        targetBucket = this.ocrBucketName || this.bucketName;
      }

      console.log(
        "🪣 CloudflareService - Bucket pour URL signée:",
        targetBucket
      );
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
      // Déterminer le bucket selon le type de clé
      let targetBucket = this.bucketName;
      if (key.includes("/ImgProfil/") || key.includes("/logoReseau/")) {
        targetBucket = this.signatureBucketName;
      }

      const command = new GetObjectCommand({
        Bucket: targetBucket,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.client, command, {
        expiresIn,
        // Ajouter des paramètres spécifiques à Cloudflare R2
        signableHeaders: new Set(["host"]),
        unhoistableHeaders: new Set(["x-amz-content-sha256"]),
      });

      console.log(
        `🌐 CloudflareService - URL signée générée: ${signedUrl.substring(
          0,
          100
        )}...`
      );
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
        `${userId}/${signatureId}/${imageType}/`,
      ];

      // Créer chaque dossier
      for (const folder of folders) {
        try {
          const command = new PutObjectCommand({
            Bucket: this.signatureBucketName || this.bucketName,
            Key: folder,
            Body: "",
            ContentType: "application/x-directory",
          });

          await this.client.send(command);
        } catch (error) {
          // Ignorer l'erreur si le dossier existe déjà
          if (
            error.name !== "BucketAlreadyOwnedByYou" &&
            error.code !== "BucketAlreadyOwnedByYou"
          ) {
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
      if (error.name === "NoSuchKey") {
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
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");

      // Convertir le type d'image en nom de dossier correct
      const folderName =
        folderType === "imgProfil" ? "ImgProfil" : "logoReseau";
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

      console.log(
        `🗑️ Suppression de ${listResponse.Contents.length} fichier(s)`
      );

      // Supprimer chaque fichier (y compris les marqueurs de dossiers)
      const deletePromises = listResponse.Contents.map((object) => {
        console.log(`🗑️ Suppression: ${object.Key}`);
        return this.deleteImage(object.Key, this.signatureBucketName);
      });

      await Promise.all(deletePromises);
      console.log(`✅ Dossier ${prefix} nettoyé avec succès`);
      return true;
    } catch (error) {
      console.warn("⚠️ Erreur suppression dossier:", error.message);
      // Ne pas faire échouer l'upload si la suppression échoue
      return false;
    }
  }

  /**
   * Supprime tous les logos sociaux d'une signature
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @returns {Promise<boolean>}
   */
  async deleteSocialLogos(userId, signatureId) {
    try {
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");

      // Préfixe pour tous les logos sociaux
      const prefix = `${userId}/${signatureId}/logo/`;

      console.log(`🗑️ Suppression des logos sociaux: ${prefix}`);

      // Lister tous les objets dans le dossier logo
      const listCommand = new ListObjectsV2Command({
        Bucket: this.signatureBucketName,
        Prefix: prefix,
      });

      const listResponse = await this.client.send(listCommand);

      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        console.log(`🗑️ Aucun logo social à supprimer dans: ${prefix}`);
        return true;
      }

      console.log(
        `🗑️ Suppression de ${listResponse.Contents.length} logo(s) social(aux)`
      );

      // Supprimer chaque fichier
      const deletePromises = listResponse.Contents.map((object) => {
        console.log(`🗑️ Suppression logo social: ${object.Key}`);
        return this.deleteImage(object.Key, this.signatureBucketName);
      });

      await Promise.all(deletePromises);
      console.log(`✅ Logos sociaux supprimés avec succès`);
      return true;
    } catch (error) {
      console.warn("⚠️ Erreur suppression logos sociaux:", error.message);
      return false;
    }
  }

  /**
   * Crée la structure de dossiers pour les logos sociaux
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @returns {Promise<void>}
   */
  async createSocialLogosStructure(userId, signatureId) {
    try {
      console.log(
        `📁 Création structure logos sociaux pour signature ${signatureId}`
      );

      // Créer les dossiers pour chaque réseau social
      const socialNetworks = ["facebook", "instagram", "linkedin", "x"];

      const foldersToCreate = [
        `${userId}/`,
        `${userId}/${signatureId}/`,
        `${userId}/${signatureId}/logo/`,
        ...socialNetworks.map(
          (network) => `${userId}/${signatureId}/logo/${network}/`
        ),
      ];

      for (const folderKey of foldersToCreate) {
        try {
          const command = new PutObjectCommand({
            Bucket: this.signatureBucketName,
            Key: folderKey,
            Body: Buffer.alloc(0), // Contenu vide
            ContentType: "application/x-directory",
            Metadata: {
              "folder-marker": "true",
              "folder-type": "social-logos",
            },
          });

          await this.client.send(command);
          console.log(`📁 Dossier créé: ${folderKey}`);
        } catch (error) {
          // Ignorer les erreurs si le dossier existe déjà
          console.log(`📁 Dossier existe déjà: ${folderKey}`);
        }
      }

      console.log(`✅ Structure logos sociaux créée`);
    } catch (error) {
      console.warn(
        "⚠️ Erreur création structure logos sociaux:",
        error.message
      );
      // Ne pas faire échouer le processus si la création des dossiers échoue
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
      const folderName = imageType === "imgProfil" ? "ImgProfil" : "logoReseau";

      // Créer des objets "marqueurs" pour les dossiers avec des clés se terminant par /
      // Cela aide Cloudflare R2 à reconnaître la structure de dossiers
      const foldersToCreate = [
        `${userId}/`,
        `${userId}/${signatureId}/`,
        `${userId}/${signatureId}/${folderName}/`,
      ];

      for (const folderKey of foldersToCreate) {
        try {
          const command = new PutObjectCommand({
            Bucket: this.signatureBucketName,
            Key: folderKey,
            Body: Buffer.alloc(0), // Contenu vide
            ContentType: "application/x-directory",
            Metadata: {
              "folder-marker": "true",
            },
          });

          await this.client.send(command);
          console.log(`📁 Dossier créé: ${folderKey}`);
        } catch (error) {
          // Ignorer les erreurs si le dossier existe déjà
          console.log(`📁 Dossier existe déjà: ${folderKey}`);
        }
      }
    } catch (error) {
      console.warn("⚠️ Erreur création dossiers:", error.message);
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
  async uploadSignatureImage(
    fileBuffer,
    fileName,
    userId,
    signatureId,
    imageType
  ) {
    try {
      console.log(
        `🚀 Début upload signature - userId: ${userId}, signatureId: ${signatureId}, imageType: ${imageType}`
      );

      // Validation des paramètres
      if (!signatureId) {
        throw new Error(
          "Signature ID requis pour l'upload d'images de signature"
        );
      }

      if (!["imgProfil", "logoReseau"].includes(imageType)) {
        throw new Error(
          "Type d'image invalide. Doit être 'imgProfil' ou 'logoReseau'"
        );
      }

      // Supprimer les anciennes images du même type
      console.log(`🗑️ Suppression des anciennes images pour ${imageType}`);
      await this.deleteSignatureFolder(userId, signatureId, imageType);

      // Cloudflare R2 créera automatiquement la structure de dossiers basée sur la clé du fichier
      console.log(
        "📁 Structure de dossiers sera créée automatiquement par Cloudflare R2"
      );

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
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".tiff": "image/tiff",
      ".tif": "image/tiff",
      ".bmp": "image/bmp",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".txt": "text/plain",
      ".csv": "text/csv",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".mov": "video/quicktime",
      ".avi": "video/x-msvideo",
      ".mkv": "video/x-matroska",
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

  /**
   * Upload une icône sociale personnalisée sur Cloudflare R2
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   * @param {string} platform - Plateforme (facebook, instagram, linkedin, x)
   * @param {Buffer} svgBuffer - Buffer du SVG
   * @param {string} fileName - Nom du fichier
   * @returns {Promise<string>} URL publique du fichier uploadé
   */
  async uploadCustomSocialIcon(
    userId,
    signatureId,
    platform,
    svgBuffer,
    fileName
  ) {
    try {
      if (!userId || !signatureId || !platform) {
        throw new Error(
          "userId, signatureId et platform sont requis pour les icônes personnalisées"
        );
      }

      // Structure : userId/signatureId/customSocialIcons/platform/fileName
      const key = `${userId}/${signatureId}/customSocialIcons/${platform}/${fileName}`;

      console.log(`📤 Upload icône personnalisée: ${key}`);

      const command = new PutObjectCommand({
        Bucket: this.signatureBucketName,
        Key: key,
        Body: svgBuffer,
        ContentType: "image/svg+xml",
        CacheControl: "public, max-age=31536000", // Cache 1 an
      });

      await this.client.send(command);

      const publicUrl = `${this.signaturePublicUrl}/${key}`;
      console.log(`✅ Icône personnalisée uploadée: ${publicUrl}`);

      return publicUrl;
    } catch (error) {
      console.error("❌ Erreur upload icône personnalisée:", error);
      throw new Error(
        `Erreur lors de l'upload de l'icône personnalisée: ${error.message}`
      );
    }
  }

  /**
   * Supprime toutes les icônes personnalisées d'une signature
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   */
  async deleteCustomSocialIcons(userId, signatureId) {
    try {
      if (!userId || !signatureId) {
        throw new Error("userId et signatureId sont requis");
      }

      const platforms = ["facebook", "instagram", "linkedin", "x"];

      for (const platform of platforms) {
        try {
          // Supprimer tous les fichiers du dossier de la plateforme
          const folderKey = `${userId}/${signatureId}/customSocialIcons/${platform}/`;

          // Note: En production, il faudrait lister les objets d'abord puis les supprimer
          // Pour simplifier, on supprime les fichiers les plus courants
          const commonFiles = [
            `${platform}-1877F2.svg`, // Facebook bleu
            `${platform}-E4405F.svg`, // Instagram rose
            `${platform}-0077B5.svg`, // LinkedIn bleu
            `${platform}-000000.svg`, // X noir
          ];

          for (const file of commonFiles) {
            const key = `${userId}/${signatureId}/customSocialIcons/${platform}/${file}`;
            try {
              const deleteCommand = new DeleteObjectCommand({
                Bucket: this.signatureBucketName,
                Key: key,
              });
              await this.client.send(deleteCommand);
            } catch (deleteError) {
              // Ignorer si le fichier n'existe pas
              if (deleteError.name !== "NoSuchKey") {
                console.warn(
                  `⚠️ Erreur suppression ${key}:`,
                  deleteError.message
                );
              }
            }
          }
        } catch (platformError) {
          console.warn(
            `⚠️ Erreur suppression plateforme ${platform}:`,
            platformError.message
          );
        }
      }

      console.log(
        `✅ Icônes personnalisées supprimées pour signature ${signatureId}`
      );
    } catch (error) {
      console.error("❌ Erreur suppression icônes personnalisées:", error);
      throw new Error(
        `Erreur lors de la suppression des icônes personnalisées: ${error.message}`
      );
    }
  }

  /**
   * Crée la structure de dossiers pour les icônes personnalisées
   * @param {string} userId - ID de l'utilisateur
   * @param {string} signatureId - ID de la signature
   */
  async createCustomSocialIconsStructure(userId, signatureId) {
    try {
      if (!userId || !signatureId) {
        throw new Error("userId et signatureId sont requis");
      }

      const platforms = ["facebook", "instagram", "linkedin", "x"];

      for (const platform of platforms) {
        const key = `${userId}/${signatureId}/customSocialIcons/${platform}/.keep`;

        const command = new PutObjectCommand({
          Bucket: this.signatureBucketName,
          Key: key,
          Body: Buffer.from(""),
          ContentType: "text/plain",
        });

        await this.client.send(command);
      }

      console.log(
        `✅ Structure icônes personnalisées créée pour signature ${signatureId}`
      );
    } catch (error) {
      console.error(
        "❌ Erreur création structure icônes personnalisées:",
        error
      );
      throw new Error(
        `Erreur lors de la création de la structure: ${error.message}`
      );
    }
  }

  /**
   * Lister les objets dans un préfixe donné
   * @param {string} prefix - Préfixe à rechercher (ex: "userId/")
   * @param {string} filter - Filtre supplémentaire (ex: "temp-")
   * @returns {Promise<Array>} Liste des objets trouvés
   */
  async listObjects(prefix, filter = "") {
    try {
      console.log(
        `📋 Listage des objets avec préfixe: ${prefix}, filtre: ${filter}`
      );

      const command = new ListObjectsV2Command({
        Bucket: this.signatureBucketName,
        Prefix: prefix,
        MaxKeys: 1000,
      });

      const response = await this.client.send(command);

      if (!response.Contents) {
        console.log("📋 Aucun objet trouvé");
        return [];
      }

      // Filtrer les résultats selon le filtre fourni
      const filteredObjects = response.Contents.filter((obj) => {
        if (!filter) return true;
        const keyParts = obj.Key.split("/");
        return keyParts.some((part) => part.includes(filter));
      }).map((obj) => {
        const keyParts = obj.Key.split("/");
        return {
          key: obj.Key,
          signatureId: keyParts[1], // Supposer que la structure est userId/signatureId/...
          lastModified: obj.LastModified,
          size: obj.Size,
        };
      });

      console.log(`📋 ${filteredObjects.length} objets trouvés après filtrage`);
      return filteredObjects;
    } catch (error) {
      console.error("❌ Erreur lors du listage des objets:", error);
      throw error;
    }
  }

  // ==========================================
  // MÉTHODES POUR LES IMAGES DES TÂCHES KANBAN
  // ==========================================

  /**
   * Configuration spécifique pour les images Kanban
   */
  get kanbanBucketName() {
    const bucket = process.env.KANBAN_BUCKET || "kanban-staging";
    return bucket;
  }

  get kanbanPublicUrl() {
    const url = process.env.KANBAN_URL;
    if (!url) {
      console.warn("⚠️ [KANBAN] KANBAN_URL non défini dans .env, utilisation de l'URL par défaut");
    }
    return url || "https://pub-kanban.r2.dev";
  }

  /**
   * Upload une image pour une tâche Kanban
   * Structure: kanban/{taskId}/{userId}/{uniqueId}.{ext}
   * @param {Buffer} fileBuffer - Buffer de l'image
   * @param {string} fileName - Nom original du fichier
   * @param {string} taskId - ID de la tâche
   * @param {string} userId - ID de l'utilisateur qui upload
   * @param {string} imageType - Type d'image ('description' ou 'comment')
   * @param {string} commentId - ID du commentaire (optionnel, si imageType === 'comment')
   * @returns {Promise<{key: string, url: string, contentType: string}>}
   */
  async uploadTaskImage(fileBuffer, fileName, taskId, userId, imageType = 'description', commentId = null) {
    try {
      console.log(`🚀 [KANBAN] Upload image - taskId: ${taskId}, userId: ${userId}, type: ${imageType}`);

      // Validation des paramètres
      if (!taskId || !userId) {
        throw new Error("taskId et userId sont requis pour l'upload d'images de tâche");
      }

      if (!['description', 'comment'].includes(imageType)) {
        throw new Error("Type d'image invalide. Doit être 'description' ou 'comment'");
      }

      // Générer une clé unique pour l'image
      const uniqueId = crypto.randomUUID();
      const fileExtension = path.extname(fileName).toLowerCase();

      // Structure de la clé selon le type
      let key;
      if (imageType === 'comment' && commentId) {
        // Structure: {taskId}/{userId}/comments/{commentId}/{uniqueId}.{ext}
        key = `${taskId}/${userId}/comments/${commentId}/${uniqueId}${fileExtension}`;
      } else {
        // Structure: {taskId}/{userId}/description/{uniqueId}.{ext}
        key = `${taskId}/${userId}/description/${uniqueId}${fileExtension}`;
      }

      // Déterminer le content-type
      const contentType = this.getContentType(fileExtension);

      // Nettoyer le nom de fichier pour les headers HTTP
      const sanitizedFileName = this.sanitizeFileName(fileName);

      console.log(`📤 [KANBAN] Upload vers bucket: ${this.kanbanBucketName}, clé: ${key}`);

      // Commande d'upload
      const command = new PutObjectCommand({
        Bucket: this.kanbanBucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
        Metadata: {
          taskId: taskId,
          userId: userId,
          imageType: imageType,
          originalName: sanitizedFileName,
          uploadedAt: new Date().toISOString(),
          ...(commentId && { commentId: commentId }),
        },
      });

      await this.client.send(command);

      // Générer l'URL publique
      let imageUrl;
      if (this.kanbanPublicUrl) {
        const cleanUrl = this.kanbanPublicUrl.endsWith("/")
          ? this.kanbanPublicUrl.slice(0, -1)
          : this.kanbanPublicUrl;
        imageUrl = `${cleanUrl}/${key}`;
      } else {
        // Fallback sur URL signée si pas d'URL publique configurée
        imageUrl = await this.getSignedUrlForBucket(key, this.kanbanBucketName, 86400 * 7); // 7 jours
      }

      console.log(`✅ [KANBAN] Image uploadée: ${imageUrl}`);

      return {
        key,
        url: imageUrl,
        contentType,
        fileName: sanitizedFileName,
        fileSize: fileBuffer.length,
      };
    } catch (error) {
      console.error(`❌ [KANBAN] Erreur upload image:`, error);
      throw new Error(`Échec de l'upload de l'image de tâche: ${error.message}`);
    }
  }

  /**
   * Supprime une image d'une tâche Kanban
   * @param {string} key - Clé de l'image à supprimer
   * @returns {Promise<boolean>}
   */
  async deleteTaskImage(key) {
    try {
      console.log(`🗑️ [KANBAN] Suppression image: ${key}`);

      const command = new DeleteObjectCommand({
        Bucket: this.kanbanBucketName,
        Key: key,
      });

      await this.client.send(command);
      console.log(`✅ [KANBAN] Image supprimée: ${key}`);
      return true;
    } catch (error) {
      if (error.name === "NoSuchKey") {
        console.log(`⚠️ [KANBAN] Image déjà supprimée ou inexistante: ${key}`);
        return true;
      }
      console.error(`❌ [KANBAN] Erreur suppression image:`, error);
      throw new Error(`Échec de la suppression de l'image: ${error.message}`);
    }
  }

  /**
   * Supprime toutes les images d'une tâche Kanban
   * @param {string} taskId - ID de la tâche
   * @returns {Promise<boolean>}
   */
  async deleteAllTaskImages(taskId) {
    try {
      console.log(`🗑️ [KANBAN] Suppression de toutes les images de la tâche: ${taskId}`);

      // Lister tous les objets avec le préfixe de la tâche
      const listCommand = new ListObjectsV2Command({
        Bucket: this.kanbanBucketName,
        Prefix: `${taskId}/`,
      });

      const listResponse = await this.client.send(listCommand);

      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        console.log(`📋 [KANBAN] Aucune image à supprimer pour la tâche: ${taskId}`);
        return true;
      }

      console.log(`🗑️ [KANBAN] Suppression de ${listResponse.Contents.length} image(s)`);

      // Supprimer chaque fichier
      const deletePromises = listResponse.Contents.map((object) => {
        return this.deleteTaskImage(object.Key);
      });

      await Promise.all(deletePromises);
      console.log(`✅ [KANBAN] Toutes les images de la tâche ${taskId} supprimées`);
      return true;
    } catch (error) {
      console.error(`❌ [KANBAN] Erreur suppression images tâche:`, error);
      throw new Error(`Échec de la suppression des images de la tâche: ${error.message}`);
    }
  }

  /**
   * Supprime toutes les images d'un commentaire
   * @param {string} taskId - ID de la tâche
   * @param {string} commentId - ID du commentaire
   * @returns {Promise<boolean>}
   */
  async deleteCommentImages(taskId, commentId) {
    try {
      console.log(`🗑️ [KANBAN] Suppression images du commentaire: ${commentId}`);

      // Lister tous les objets avec le préfixe du commentaire
      const listCommand = new ListObjectsV2Command({
        Bucket: this.kanbanBucketName,
        Prefix: `${taskId}/`,
      });

      const listResponse = await this.client.send(listCommand);

      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        return true;
      }

      // Filtrer les fichiers du commentaire spécifique
      const commentFiles = listResponse.Contents.filter((obj) =>
        obj.Key.includes(`/comments/${commentId}/`)
      );

      if (commentFiles.length === 0) {
        console.log(`📋 [KANBAN] Aucune image à supprimer pour le commentaire: ${commentId}`);
        return true;
      }

      console.log(`🗑️ [KANBAN] Suppression de ${commentFiles.length} image(s) du commentaire`);

      const deletePromises = commentFiles.map((object) => {
        return this.deleteTaskImage(object.Key);
      });

      await Promise.all(deletePromises);
      console.log(`✅ [KANBAN] Images du commentaire ${commentId} supprimées`);
      return true;
    } catch (error) {
      console.error(`❌ [KANBAN] Erreur suppression images commentaire:`, error);
      return false;
    }
  }

  /**
   * Récupère l'URL publique d'une image Kanban
   * @param {string} key - Clé de l'image
   * @returns {string}
   */
  getTaskImageUrl(key) {
    if (!key) return null;

    if (this.kanbanPublicUrl) {
      const cleanUrl = this.kanbanPublicUrl.endsWith("/")
        ? this.kanbanPublicUrl.slice(0, -1)
        : this.kanbanPublicUrl;
      return `${cleanUrl}/${key}`;
    }

    // Fallback - retourner la clé pour générer une URL signée plus tard
    return key;
  }

  /**
   * Supprime toutes les images d'un visiteur
   * @param {string} visitorId - ID du visiteur
   * @returns {Promise<boolean>}
   */
  async deleteVisitorImages(visitorId) {
    try {
      const prefix = `userVisitor/${visitorId}/`;

      const listCommand = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
      });

      const listResponse = await this.client.send(listCommand);

      if (!listResponse.Contents || listResponse.Contents.length === 0) {
        return true;
      }

      const deletePromises = listResponse.Contents.map((object) => {
        return this.deleteImage(object.Key, this.bucketName);
      });

      await Promise.all(deletePromises);
      return true;
    } catch (error) {
      console.error('❌ [VISITOR] Erreur suppression images visiteur:', error);
      return false;
    }
  }

  /**
   * Upload une image de visiteur sur Cloudflare
   * Supprime les anciennes images avant d'uploader la nouvelle
   * @param {Buffer} fileBuffer - Buffer de l'image
   * @param {string} fileName - Nom du fichier
   * @param {string} visitorId - ID du visiteur
   * @returns {Promise<{success: boolean, url: string}>}
   */
  async uploadVisitorImage(fileBuffer, fileName, visitorId) {
    try {
      // Supprimer les anciennes images du visiteur
      await this.deleteVisitorImages(visitorId);

      // Uploader la nouvelle image
      const result = await this.uploadImage(
        fileBuffer,
        fileName,
        'visitor', // userId placeholder
        'visitorImage',
        null, // organizationId
        visitorId // signatureId utilisé pour passer le visitorId
      );

      return {
        success: true,
        url: result.url,
        key: result.key
      };
    } catch (error) {
      console.error('❌ [VISITOR] Erreur upload image visiteur:', error);
      return {
        success: false,
        url: null,
        error: error.message
      };
    }
  }
}

// Instance singleton
const cloudflareService = new CloudflareService();

export default cloudflareService;
