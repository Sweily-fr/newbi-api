/**
 * Resolvers GraphQL pour l'upload d'images vers Cloudflare
 */

import { GraphQLUpload } from "graphql-upload";
import { isAuthenticated } from "../middlewares/auth.js";
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
        if (!key.includes(`signatures/${user.id}/`)) {
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
     * Upload une image de signature vers Cloudflare
     */
    uploadSignatureImage: isAuthenticated(
      async (_, { file, imageType = "profile" }, { user }) => {
        try {
          const { createReadStream, filename, mimetype } = await file;

          // Validation du type d'image
          if (!["profile", "company"].includes(imageType)) {
            throw createValidationError(
              'Type d\'image invalide. Utilisez "profile" ou "company"'
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

          // Upload vers Cloudflare
          const result = await cloudflareService.uploadImage(
            fileBuffer,
            filename,
            user.id,
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

          if (error.message.includes("Validation")) {
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
        if (!key.includes(`signatures/${user.id}/`)) {
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
          if (!key.includes(`signatures/${user.id}/`)) {
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
      try {
        console.log("🚀 Début suppression image profil pour user ID:", user.id);

        // Récupérer l'utilisateur complet depuis la base de données
        const userDoc = await User.findById(user.id);
        if (!userDoc) {
          console.log("❌ Utilisateur non trouvé dans la DB");
          throw createValidationError("Utilisateur non trouvé");
        }

        console.log("✅ Utilisateur trouvé dans la DB");

        // Vérifier toutes les sources possibles d'URL d'image de profil
        console.log("🔍 Debug userDoc.avatar:", userDoc);
        console.log(
          "🔍 Debug userDoc.profilePictureUrl:",
          userDoc.profilePictureUrl
        );

        const imageUrl = userDoc.avatar || userDoc.profilePictureUrl;

        if (!imageUrl) {
          console.log("❌ Aucune image de profil trouvée");
          throw createValidationError("Aucune image de profil à supprimer");
        }

        // Extraire la clé depuis l'URL
        // URL format: https://pub-afeb8647684e476ca05894fe1df797fb.r2.dev/user/68b4a618b1c6f619a457314c/profile.jpg
        const urlParts = imageUrl.split("/");
        const key = urlParts.slice(-3).join("/"); // user/userId/profile.jpg

        console.log("🔑 URL trouvée:", imageUrl);
        console.log("🔑 Clé extraite:", key);

        const success = await cloudflareService.deleteImage(key);

        if (success) {
          // Mettre à jour l'utilisateur pour supprimer le champ avatar
          await User.findByIdAndUpdate(user.id, {
            $unset: {
              avatar: 1,
              profilePictureUrl: 1,
              profilePictureKey: 1,
              "profile.profilePictureUrl": 1,
              "profile.profilePictureKey": 1,
            },
          });
        }

        return {
          success,
          message: success
            ? "Image de profil supprimée avec succès"
            : "Erreur lors de la suppression",
        };
      } catch (error) {
        console.error("Erreur suppression image profil utilisateur:", error);
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
        const validLogoTypes = ['facebook', 'linkedin', 'twitter', 'instagram'];
        if (!validLogoTypes.includes(logoType)) {
          throw createValidationError(
            'Type de logo invalide. Utilisez facebook, linkedin, twitter ou instagram'
          );
        }

        // Validation de la couleur (format hex)
        if (!color || !/^#[0-9A-F]{6}$/i.test(color)) {
          throw createValidationError(
            'Couleur invalide. Utilisez un format hexadécimal (#RRGGBB)'
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
        console.error("Erreur upload logo social:", error);

        if (error.message.includes("Validation")) {
          throw error;
        }

        throw createInternalServerError("Erreur lors de l'upload du logo social");
      }
    },
  },
};

export default imageUploadResolvers;
