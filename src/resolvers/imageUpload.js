import mongoose from "mongoose";
import logger from "../utils/logger.js";
/**
 * Resolvers GraphQL pour l'upload d'images vers Cloudflare
 */

import { GraphQLUpload } from "graphql-upload";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import { requireWorkspaceAction } from "../middlewares/rbac.js";
import cloudflareService from "../services/cloudflareService.js";
import User from "../models/User.js";
import {
  createValidationError,
  createInternalServerError,
} from "../utils/errors.js";

/**
 * Clé R2 d'une photo de profil de cet utilisateur (« <userId>/image/<fichier> »,
 * bucket des photos de profil), lue dans la clé enregistrée ou à défaut dans
 * l'URL. null pour toute autre clé : l'avatar est modifiable par le client et
 * pouvait désigner le fichier d'un autre compte, ou une image hébergée
 * ailleurs (photo Google).
 */
export function ownProfileImageKey(userId, { key, url } = {}) {
  let candidate = key;
  if (!candidate && typeof url === "string") {
    candidate = url.split("?")[0].split("/").slice(-3).join("/");
  }
  if (!candidate || !userId) return null;
  const prefix = `${userId}/image/`;
  if (!String(candidate).startsWith(prefix)) return null;
  const fileName = String(candidate).slice(prefix.length);
  if (!fileName || fileName.includes("/") || fileName.includes("..")) {
    return null;
  }
  return String(candidate);
}

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
        if (!String(key).startsWith(`${user.id}/`)) {
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
            throw createValidationError(
              "signatureId est requis pour l'upload d'images de signature",
            );
          }

          // Validation du type d'image (nouvelle structure)
          if (!["imgProfil", "logoReseau", "banner"].includes(imageType)) {
            throw createValidationError(
              'Type d\'image invalide. Utilisez "imgProfil", "logoReseau" ou "banner"',
            );
          }

          // Validation du nom de fichier
          if (!cloudflareService.isValidImageFile(filename)) {
            throw createValidationError(
              "Format d'image non supporté. Utilisez JPG, PNG, GIF ou WebP",
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
              "L'image est trop volumineuse (max 5MB)",
            );
          }

          logger.debug(
            `🔄 Upload ${imageType} pour signature ${signatureId} par utilisateur ${user.id}`,
          );

          // Upload vers Cloudflare avec la nouvelle méthode
          const result = await cloudflareService.uploadSignatureImage(
            fileBuffer,
            filename,
            user.id,
            signatureId,
            imageType,
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

          if (
            error.message.includes("Validation") ||
            error.message.includes("requis")
          ) {
            throw error;
          }

          throw createInternalServerError("Erreur lors de l'upload de l'image");
        }
      },
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
        if (!String(key).startsWith(`${user.id}/`)) {
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
          "Erreur lors de la suppression de l'image",
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
          if (!String(key).startsWith(`${user.id}/`)) {
            throw createValidationError("Accès non autorisé à cette image");
          }

          const signedUrl = await cloudflareService.getSignedUrl(
            key,
            expiresIn,
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
            "Erreur lors de la récupération de l'URL de l'image",
          );
        }
      },
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
            "Format d'image non supporté. Utilisez JPG, PNG, GIF ou WebP",
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

        // Supprimer l'ancienne image si elle existe (la sienne seulement,
        // dans le bucket des photos de profil où elle a été envoyée)
        const previous = await User.collection.findOne({
          _id: new mongoose.Types.ObjectId(String(user.id)),
        });
        const previousKey = ownProfileImageKey(user.id, {
          key: previous?.profilePictureKey || previous?.profile?.profilePictureKey,
          url: previous?.avatar || previous?.profilePictureUrl,
        });
        if (previousKey) {
          try {
            await cloudflareService.deleteImage(
              previousKey,
              cloudflareService.profileBucketName,
            );
          } catch (error) {
            console.warn(
              "Impossible de supprimer l'ancienne image:",
              error.message,
            );
          }
        }

        // Upload vers Cloudflare
        const result = await cloudflareService.uploadImage(
          fileBuffer,
          filename,
          user.id,
          "profile",
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
          "Erreur lors de l'upload de l'image de profil",
        );
      }
    }),

    /**
     * Supprime l'image de profil utilisateur de Cloudflare R2
     */
    deleteUserProfileImage: isAuthenticated(async (_, __, { user }) => {
      logger.debug(
        `🗑️ [DELETE_PROFILE_IMAGE] Début suppression pour utilisateur: ${user.id}`,
      );

      try {
        // Récupérer l'utilisateur complet depuis la base de données
        // Lecture brute : avatar est écrit par Better Auth hors du schéma
        const userDoc = await User.collection.findOne({
          _id: new mongoose.Types.ObjectId(String(user.id)),
        });
        if (!userDoc) {
          throw createValidationError("Utilisateur non trouvé");
        }

        const imageUrl = userDoc.avatar || userDoc.profilePictureUrl;
        logger.debug(
          `🖼️ [DELETE_PROFILE_IMAGE] URL image trouvée: ${imageUrl}`,
        );

        if (!imageUrl) {
          logger.debug("⚠️ [DELETE_PROFILE_IMAGE] Aucune image à supprimer");
          return {
            success: true,
            message: "Aucune image de profil à supprimer",
          };
        }

        // Clé « <userId>/image/<fichier> » de cet utilisateur seulement,
        // supprimée dans le bucket des photos de profil (celui de l'envoi).
        // Une image hébergée ailleurs ou appartenant à un autre compte n'est
        // pas touchée : seul le lien est retiré du profil.
        const key = ownProfileImageKey(user.id, {
          key: userDoc.profilePictureKey || userDoc.profile?.profilePictureKey,
          url: imageUrl,
        });
        logger.debug(`🔑 [DELETE_PROFILE_IMAGE] Clé extraite: ${key}`);

        const success = key
          ? await cloudflareService.deleteImage(
              key,
              cloudflareService.profileBucketName,
            )
          : true;
        logger.debug(
          `☁️ [DELETE_PROFILE_IMAGE] Suppression Cloudflare: ${success}`,
        );

        if (success) {
          // Mettre à jour l'utilisateur pour supprimer le champ avatar
          // (écriture brute : avatar, écrit par Better Auth, est hors du
          // schéma et Mongoose retirait ce champ de la mise à jour)
          await User.collection.updateOne({ _id: userDoc._id }, {
            $unset: {
              avatar: 1,
              profilePictureUrl: 1,
              profilePictureKey: 1,
              "profile.profilePictureUrl": 1,
              "profile.profilePictureKey": 1,
            },
          });
          logger.debug("💾 [DELETE_PROFILE_IMAGE] Base de données mise à jour");
        }

        logger.debug(
          `✅ [DELETE_PROFILE_IMAGE] Suppression terminée, succès: ${success}`,
        );
        return {
          success,
          message: success
            ? "Image de profil supprimée avec succès"
            : "Erreur lors de la suppression",
        };
      } catch (error) {
        console.error("❌ [DELETE_PROFILE_IMAGE] Erreur:", error);
        throw createInternalServerError(
          "Erreur lors de la suppression de l'image de profil",
        );
      }
    }),

    /**
     * Upload un logo social vers le bucket logo-rs
     */
    uploadSocialLogo: isAuthenticated(async (_, { file, logoType, color }) => {
      try {
        const { createReadStream, filename, mimetype } = await file;

        // Validation du type de logo
        const validLogoTypes = ["facebook", "linkedin", "twitter", "instagram"];
        if (!validLogoTypes.includes(logoType)) {
          throw createValidationError(
            "Type de logo invalide. Utilisez facebook, linkedin, twitter ou instagram",
          );
        }

        // Validation de la couleur (format hex)
        if (!color || !/^#[0-9A-F]{6}$/i.test(color)) {
          throw createValidationError(
            "Couleur invalide. Utilisez un format hexadécimal (#RRGGBB)",
          );
        }

        // Validation du nom de fichier
        if (!cloudflareService.isValidImageFile(filename)) {
          throw createValidationError(
            "Format d'image non supporté. Utilisez JPG, PNG, GIF ou WebP",
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
          color,
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
          "Erreur lors de l'upload du logo social",
        );
      }
    }),
  },
};

// Images des signatures de mail : droit d'écrire sur la page Signature de
// mail dans l'espace actif (créer ou modifier une signature ; la suppression
// d'une image accepte aussi « Supprimer »)
const SIGNATURE_IMAGE_ACTIONS = {
  uploadSignatureImage: ["create", "edit"],
  uploadSocialLogo: ["create", "edit"],
  deleteSignatureImage: ["create", "edit", "delete"],
};
Object.entries(SIGNATURE_IMAGE_ACTIONS).forEach(([name, actions]) => {
  const original = imageUploadResolvers.Mutation[name];
  if (original) {
    imageUploadResolvers.Mutation[name] = requireWorkspaceAction(
      "signatures",
      actions,
    )(original);
  }
});

export default imageUploadResolvers;
