/**
 * Resolvers GraphQL pour l'upload d'images vers Cloudflare
 */

import { GraphQLUpload } from "graphql-upload";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import cloudflareService from "../services/cloudflareService.js";
import User from "../models/User.js";
import {
  createValidationError,
  createInternalServerError,
} from "../utils/errors.js";

const imageUploadResolvers = {
  Upload: GraphQLUpload,

  Query: {
    /**
     * Récupère l'URL d'une image stockée sur Cloudflare
     */
    getImageUrl: isAuthenticated(async (_, { key }, { user }) => {
      try {
        if (!key) {
          throw createValidationError("La clé de l'image est requise");
        }

        // Vérifier que l'image appartient à l'utilisateur (sécurité)
        if (!key.includes(`${user.id}/`)) {
          throw createValidationError("Accès non autorisé à cette image");
        }

        const url = cloudflareService.getImageUrl(key);

        return {
          key,
          url,
          success: true,
        };
      } catch (error) {
        console.error("Erreur récupération URL image:", error);
        throw error;
      }
    }),
  },

  Mutation: {
    /**
     * Upload une image de signature vers Cloudflare (nouvelle structure)
     */
    uploadSignatureImage: isAuthenticated(
      async (_, { file, imageType = "imgProfil", signatureId }, { user }) => {
        try {
          const { createReadStream, filename, mimetype } = await file;

          // Validation du signatureId
          if (!signatureId) {
            throw createValidationError("signatureId est requis pour l'upload d'images de signature");
          }

          // Validation du type d'image (nouvelle structure)
          if (!["imgProfil", "logoReseau"].includes(imageType)) {
            throw createValidationError(
              'Type d\'image invalide. Utilisez "imgProfil" ou "logoReseau"'
            );
          }

          // Validation du nom de fichier
          if (!cloudflareService.isValidImageFile(filename)) {
            throw createValidationError(
              "Format d'image non supporté. Utilisez JPG, PNG, GIF ou WebP"
            );
          }

          // Validation du MIME type
          if (!mimetype.startsWith("image/")) {
            throw createValidationError("Le fichier doit être une image");
          }

          // Lire le fichier en buffer
          const stream = createReadStream();
          const chunks = [];

          for await (const chunk of stream) {
            chunks.push(chunk);
          }

          const fileBuffer = Buffer.concat(chunks);

          // Validation de la taille
          if (!cloudflareService.isValidFileSize(fileBuffer)) {
            throw createValidationError(
              "L'image est trop volumineuse (max 5MB)"
            );
          }

          console.log(`🔄 Upload ${imageType} pour signature ${signatureId} par utilisateur ${user.id}`);

          // Upload vers Cloudflare avec la nouvelle méthode
          const result = await cloudflareService.uploadSignatureImage(
            fileBuffer,
            filename,
            user.id,
            signatureId,
            imageType
          );

          return {
            success: true,
            key: result.key,
            url: result.url,
            contentType: result.contentType,
            message: "Image uploadée avec succès",
          };
        } catch (error) {
          console.error("Erreur upload image signature:", error);

          if (error.message.includes("Validation") || error.message.includes("requis")) {
            throw error;
          }

          throw createInternalServerError("Erreur lors de l'upload de l'image");
        }
      }
    ),

    /**
     * Supprime une image de signature de Cloudflare
     */
    deleteSignatureImage: isAuthenticated(async (_, { key }, { user }) => {
      try {
        if (!key) {
          throw createValidationError("La clé de l'image est requise");
        }

        // Vérifier que l'image appartient à l'utilisateur (sécurité)
        if (!key.includes(`${user.id}/`)) {
          throw createValidationError("Accès non autorisé à cette image");
        }

        const success = await cloudflareService.deleteImage(key);

        return {
          success,
          message: success
            ? "Image supprimée avec succès"
            : "Erreur lors de la suppression",
        };
      } catch (error) {
        console.error("Erreur suppression image signature:", error);
        throw createInternalServerError(
          "Erreur lors de la suppression de l'image"
        );
      }
    }),

    /**
     * Génère une URL signée temporaire pour accès privé
     */
    generateSignedImageUrl: isAuthenticated(
      async (_, { key, expiresIn = 3600 }, { user }) => {
        try {
          if (!key) {
            throw createValidationError("La clé de l'image est requise");
          }

          // Vérifier que l'image appartient à l'utilisateur (sécurité)
          if (!key.includes(`${user.id}/`)) {
            throw createValidationError("Accès non autorisé à cette image");
          }

          const signedUrl = await cloudflareService.getSignedUrl(
            key,
            expiresIn
          );

          return {
            success: true,
            url: signedUrl,
            expiresIn,
            message: "URL signée générée avec succès",
          };
        } catch (error) {
          console.error("Erreur génération URL signée:", error);
          throw createInternalServerError(
            "Erreur lors de la récupération de l'URL de l'image"
          );
        }
      }
    ),

    /**
     * Upload une image de profil utilisateur vers Cloudflare R2
     */
    uploadUserProfileImage: isAuthenticated(async (_, { file }, { user }) => {
      try {
        const { createReadStream, filename, mimetype } = await file;

        // Validation du nom de fichier
        if (!cloudflareService.isValidImageFile(filename)) {
          throw createValidationError(
            "Format d'image non supporté. Utilisez JPG, PNG, GIF ou WebP"
          );
        }

        // Validation du MIME type
        if (!mimetype.startsWith("image/")) {
          throw createValidationError("Le fichier doit être une image");
        }

        const stream = createReadStream();
        const chunks = [];

        for await (const chunk of stream) {
          chunks.push(chunk);
        }

        const fileBuffer = Buffer.concat(chunks);

        // Validation de la taille
        if (!cloudflareService.isValidFileSize(fileBuffer)) {
          throw createValidationError("L'image est trop volumineuse (max 5MB)");
        }

        // Supprimer l'ancienne image si elle existe
        if (user.profilePictureKey) {
          try {
            await cloudflareService.deleteImage(user.profilePictureKey);
          } catch (error) {
            console.warn(
              "Impossible de supprimer l'ancienne image:",
              error.message
            );
          }
        }

        // Upload vers Cloudflare
        const result = await cloudflareService.uploadImage(
          fileBuffer,
          filename,
          user.id,
          "profile"
        );

        // Mettre à jour l'utilisateur avec la nouvelle URL dans le champ avatar
        await User.findByIdAndUpdate(user.id, {
          avatar: result.url,
          profilePictureUrl: result.url,
          profilePictureKey: result.key,
        });

        return {
          success: true,
          key: result.key,
          url: result.url,
          contentType: result.contentType,
          message: "Image de profil uploadée avec succès",
        };
      } catch (error) {
        console.error("Erreur upload image profil utilisateur:", error);

        if (error.message.includes("Validation")) {
          throw error;
        }

        throw createInternalServerError(
          "Erreur lors de l'upload de l'image de profil"
        );
      }
    }),

    /**
     * Supprime l'image de profil utilisateur de Cloudflare R2
     */
    deleteUserProfileImage: isAuthenticated(async (_, __, { user }) => {
      console.log(`🗑️ [DELETE_PROFILE_IMAGE] Début suppression pour utilisateur: ${user.id}`);
      
      try {
        // Récupérer l'utilisateur complet depuis la base de données
        const userDoc = await User.findById(user.id);
        if (!userDoc) {
          throw createValidationError("Utilisateur non trouvé");
        }

        const imageUrl = userDoc.avatar || userDoc.profilePictureUrl;
        console.log(`🖼️ [DELETE_PROFILE_IMAGE] URL image trouvée: ${imageUrl}`);

        if (!imageUrl) {
          console.log(`⚠️ [DELETE_PROFILE_IMAGE] Aucune image à supprimer`);
          return {
            success: true,
            message: "Aucune image de profil à supprimer",
          };
        }

        // Extraire la clé depuis l'URL
        // URL format: https://pub-012a0ee1541743df9b78b220e9efac5e.r2.dev/68cad81bb22506f4c701424d/image/034e23b0-7d87-4a8a-8e4f-dfdf87204131.webp
        const urlParts = imageUrl.split("/");
        const key = urlParts.slice(-3).join("/"); // userId/image/uniqueId.extension
        console.log(`🔑 [DELETE_PROFILE_IMAGE] Clé extraite: ${key}`);

        const success = await cloudflareService.deleteImage(key);
        console.log(`☁️ [DELETE_PROFILE_IMAGE] Suppression Cloudflare: ${success}`);

        if (success) {
          // Mettre à jour l'utilisateur pour supprimer le champ avatar
          const updateResult = await User.findByIdAndUpdate(user.id, {
            $unset: {
              avatar: 1,
              profilePictureUrl: 1,
              profilePictureKey: 1,
              "profile.profilePictureUrl": 1,
              "profile.profilePictureKey": 1,
            },
          });
          console.log(`💾 [DELETE_PROFILE_IMAGE] Base de données mise à jour`);
        }

        console.log(`✅ [DELETE_PROFILE_IMAGE] Suppression terminée, succès: ${success}`);
        return {
          success,
          message: success
            ? "Image de profil supprimée avec succès"
            : "Erreur lors de la suppression",
        };
      } catch (error) {
        console.error(`❌ [DELETE_PROFILE_IMAGE] Erreur:`, error);
        throw createInternalServerError(
          "Erreur lors de la suppression de l'image de profil"
        );
      }
    }),

    /**
     * Upload un logo social vers le bucket logo-rs
     */
    uploadSocialLogo: async (_, { file, logoType, color }) => {
      try {
        const { createReadStream, filename, mimetype } = await file;

        // Validation du type de logo
        const validLogoTypes = ["facebook", "linkedin", "twitter", "instagram"];
        if (!validLogoTypes.includes(logoType)) {
          throw createValidationError(
            "Type de logo invalide. Utilisez facebook, linkedin, twitter ou instagram"
          );
        }

        // Validation de la couleur (format hex)
        if (!color || !/^#[0-9A-F]{6}$/i.test(color)) {
          throw createValidationError(
            "Couleur invalide. Utilisez un format hexadécimal (#RRGGBB)"
          );
        }

        // Validation du nom de fichier
        if (!cloudflareService.isValidImageFile(filename)) {
          throw createValidationError(
            "Format d'image non supporté. Utilisez JPG, PNG, GIF ou WebP"
          );
        }

        // Validation du MIME type
        if (!mimetype.startsWith("image/")) {
          throw createValidationError("Le fichier doit être une image");
        }

        // Lire le fichier en buffer
        const stream = createReadStream();
        const chunks = [];

        for await (const chunk of stream) {
          chunks.push(chunk);
        }

        const fileBuffer = Buffer.concat(chunks);

        // Validation de la taille
        if (!cloudflareService.isValidFileSize(fileBuffer)) {
          throw createValidationError("L'image est trop volumineuse (max 5MB)");
        }

        // Upload vers le bucket logo-rs
        const result = await cloudflareService.uploadSocialLogo(
          fileBuffer,
          filename,
          logoType,
          color
        );

        return {
          success: true,
          key: result.key,
          url: result.url,
          contentType: result.contentType,
          message: "Logo social uploadé avec succès",
        };
      } catch (error) {
        if (error.message.includes("Validation")) {
          throw error;
        }

        throw createInternalServerError(
          "Erreur lors de l'upload du logo social"
        );
      }
    },
  },
};

export default imageUploadResolvers;
