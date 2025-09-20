/**
 * Resolvers GraphQL pour l'upload de documents vers Cloudflare
 */

import cloudflareService from "../services/cloudflareService.js";
import { GraphQLUpload } from "graphql-upload";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";

const documentUploadResolvers = {
  Upload: GraphQLUpload,

  Mutation: {
    /**
     * Upload un document vers Cloudflare R2
     */
    uploadDocument: async (_, { file }, { user }) => {
      try {
        // Vérifier l'authentification
        if (!user) {
          throw new Error("Utilisateur non authentifié");
        }

        // Récupérer les informations du fichier
        const { createReadStream, filename, mimetype, encoding } = await file;

        // Lire le fichier en buffer
        const stream = createReadStream();
        const chunks = [];

        for await (const chunk of stream) {
          chunks.push(chunk);
        }

        const fileBuffer = Buffer.concat(chunks);
        const fileSize = fileBuffer.length;

        // Valider la taille du fichier (10MB max)
        const maxSize = 10 * 1024 * 1024; // 10MB
        if (fileSize > maxSize) {
          throw new Error(
            `Fichier trop volumineux. Taille maximum: ${
              maxSize / 1024 / 1024
            }MB`
          );
        }

        // Valider le type de fichier
        const allowedTypes = [
          "image/jpeg",
          "image/jpg",
          "image/png",
          "image/webp",
          "application/pdf",
          "application/octet-stream", // Support pour les fichiers dont le MIME type n'est pas détecté correctement
        ];

        if (!allowedTypes.includes(mimetype)) {
          throw new Error(
            "Type de fichier non supporté. Types acceptés: JPEG, PNG, WebP, PDF"
          );
        }

        // Déterminer le type de dossier selon le nom du fichier
        let folderType = "documents"; // Type par défaut

        // Détecter les logos d'entreprise par le nom du fichier
        const isCompanyLogo =
          filename.toLowerCase().includes("logo") ||
          filename.toLowerCase().includes("company") ||
          filename.toLowerCase().includes("entreprise");

        // Si c'est une image ET que le nom contient des mots-clés de logo
        const isImage = [
          "image/jpeg",
          "image/jpg",
          "image/png",
          "image/webp",
        ].includes(mimetype);

        if (isImage && isCompanyLogo) {
          folderType = "imgCompany";
        }

        // Récupérer l'ID de l'organisation de l'utilisateur
        let organizationId = null;

        if (folderType === "imgCompany") {
          // Essayer différentes propriétés pour l'organizationId
          organizationId =
            user.organizationId ||
            user.organization?.id ||
            user.organization ||
            user.currentOrganizationId;

          if (!organizationId) {
            // Utiliser l'userId comme fallback pour les images d'entreprise
            organizationId = user.id;
          }
        }

        // Upload vers Cloudflare R2
        const uploadResult = await cloudflareService.uploadImage(
          fileBuffer,
          filename,
          user.id,
          folderType,
          organizationId
        );

        return {
          success: true,
          key: uploadResult.key,
          url: uploadResult.url,
          contentType: uploadResult.contentType,
          fileName: filename,
          fileSize: fileSize,
          message: "Document uploadé avec succès",
        };
      } catch (error) {
        console.error("❌ Erreur upload document:", error);

        return {
          success: false,
          key: null,
          url: null,
          contentType: null,
          fileName: null,
          fileSize: null,
          message: error.message || "Erreur lors de l'upload du document",
        };
      }
    },

    /**
     * Supprime un document de Cloudflare R2
     */
    deleteDocument: isAuthenticated(async (_, { key }, { user }) => {
      try {
        // Supprimer de Cloudflare R2
        await cloudflareService.deleteImage(key);

        return {
          success: true,
          message: "Document supprimé avec succès",
        };
      } catch (error) {
        console.error("❌ Erreur suppression document:", error);

        return {
          success: false,
          message: error.message || "Erreur lors de la suppression du document",
        };
      }
    }),
  },
};

export default documentUploadResolvers;
