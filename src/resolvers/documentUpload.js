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
    uploadDocument: async (_, { file, folderType }, { user }) => {
      try {
        console.log('🚀 DocumentUpload - Début upload avec folderType:', folderType);
        
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

        // Déterminer le type de dossier
        let finalFolderType = folderType || "documents"; // Utiliser le paramètre fourni ou "documents" par défaut

        // Si aucun folderType n'est fourni, utiliser la logique de détection automatique
        if (!folderType) {
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
            finalFolderType = "imgCompany";
          }
        }

        // Récupérer l'ID de l'organisation de l'utilisateur
        let organizationId = null;

        if (finalFolderType === "imgCompany" || finalFolderType === "ocr" || finalFolderType === "importedInvoice") {
          // Essayer différentes propriétés pour l'organizationId
          const rawOrgId =
            user.organizationId ||
            user.organization?.id ||
            user.organization?._id ||
            user.currentOrganizationId;
          
          // S'assurer que c'est une string et pas un objet
          if (rawOrgId) {
            organizationId = typeof rawOrgId === 'object' 
              ? (rawOrgId._id?.toString() || rawOrgId.id?.toString() || rawOrgId.toString())
              : rawOrgId.toString();
          }

          // Si pas trouvé, chercher dans la collection member
          if (!organizationId) {
            try {
              const mongoose = await import('mongoose');
              const ObjectId = mongoose.default.Types.ObjectId;
              
              // Convertir l'userId en ObjectId si nécessaire
              const userObjectId = typeof user.id === 'string' ? new ObjectId(user.id) : user.id;
              
              const memberRecord = await mongoose.default.connection.db
                .collection('member')
                .findOne({ userId: userObjectId });
              
              if (memberRecord && memberRecord.organizationId) {
                organizationId = memberRecord.organizationId.toString();
                console.log('🔍 DocumentUpload - Organization trouvée via collection member:', organizationId);
              } else {
                console.log('🔍 DocumentUpload - Aucun member trouvé pour userId:', user.id);
              }
            } catch (memberError) {
              console.error('❌ Erreur recherche member:', memberError);
            }
          }

          if (!organizationId) {
            if (finalFolderType === "ocr" || finalFolderType === "importedInvoice") {
              throw new Error("Organization ID requis pour les uploads OCR/factures importées. L'utilisateur doit être associé à une organisation.");
            }
            // Utiliser l'userId comme fallback uniquement pour les images d'entreprise
            organizationId = user.id;
          }
          
          console.log('🏢 DocumentUpload - Organization ID récupéré:', organizationId, 'pour type:', finalFolderType);
        }

        // Upload vers Cloudflare R2
        console.log('📤 DocumentUpload - Appel cloudflareService avec finalFolderType:', finalFolderType);
        const uploadResult = await cloudflareService.uploadImage(
          fileBuffer,
          filename,
          user.id,
          finalFolderType,
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
     * Promeut un fichier temporaire en fichier permanent (déplace de temp/ vers ocr/)
     */
    promoteTemporaryFile: isAuthenticated(async (_, { tempKey }, { user }) => {
      try {
        console.log('🚀 DocumentUpload - Promotion du fichier temporaire:', tempKey);
        
        // Récupérer l'ID de l'organisation de l'utilisateur
        let organizationId = null;
        organizationId =
          user.organizationId ||
          user.organization?.id ||
          user.organization ||
          user.currentOrganizationId;

        // Si pas trouvé, chercher dans la collection member
        if (!organizationId) {
          try {
            const mongoose = await import('mongoose');
            const ObjectId = mongoose.default.Types.ObjectId;
            
            const userObjectId = typeof user.id === 'string' ? new ObjectId(user.id) : user.id;
            
            const memberRecord = await mongoose.default.connection.db
              .collection('member')
              .findOne({ userId: userObjectId });
            
            if (memberRecord && memberRecord.organizationId) {
              organizationId = memberRecord.organizationId.toString();
            }
          } catch (memberError) {
            console.error('❌ Erreur recherche member:', memberError);
          }
        }

        if (!organizationId) {
          throw new Error('Organization ID requis pour promouvoir un fichier temporaire');
        }

        // Appeler le service pour déplacer le fichier
        const result = await cloudflareService.promoteTemporaryFile(tempKey, organizationId);

        return {
          success: true,
          key: result.key,
          url: result.url,
          message: 'Fichier promu avec succès',
        };
      } catch (error) {
        console.error('❌ Erreur promotion fichier:', error);

        return {
          success: false,
          key: null,
          url: null,
          message: error.message || 'Erreur lors de la promotion du fichier',
        };
      }
    }),

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
