/**
 * Resolvers GraphQL pour l'upload d'images vers Cloudflare
 */

import { GraphQLUpload } from 'graphql-upload-minimal';
import { isAuthenticated } from '../middlewares/auth.js';
import cloudflareService from '../services/cloudflareService.js';
import { 
  createValidationError,
  createInternalError 
} from '../utils/errors.js';

const imageUploadResolvers = {
  Upload: GraphQLUpload,

  Query: {
    /**
     * Récupère l'URL d'une image stockée sur Cloudflare
     */
    getImageUrl: isAuthenticated(async (_, { key }, { user }) => {
      try {
        if (!key) {
          throw createValidationError('La clé de l\'image est requise');
        }

        // Vérifier que l'image appartient à l'utilisateur (sécurité)
        if (!key.includes(`signatures/${user.id}/`)) {
          throw createValidationError('Accès non autorisé à cette image');
        }

        const url = cloudflareService.getImageUrl(key);
        
        return {
          key,
          url,
          success: true,
        };
      } catch (error) {
        console.error('Erreur récupération URL image:', error);
        throw error;
      }
    }),
  },

  Mutation: {
    /**
     * Upload une image de signature vers Cloudflare
     */
    uploadSignatureImage: isAuthenticated(async (_, { file, imageType = 'profile' }, { user }) => {
      try {
        const { createReadStream, filename, mimetype } = await file;

        // Validation du type d'image
        if (!['profile', 'company'].includes(imageType)) {
          throw createValidationError('Type d\'image invalide. Utilisez "profile" ou "company"');
        }

        // Validation du nom de fichier
        if (!cloudflareService.isValidImageFile(filename)) {
          throw createValidationError('Format d\'image non supporté. Utilisez JPG, PNG, GIF ou WebP');
        }

        // Validation du MIME type
        if (!mimetype.startsWith('image/')) {
          throw createValidationError('Le fichier doit être une image');
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
          throw createValidationError('L\'image est trop volumineuse (max 5MB)');
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
          message: 'Image uploadée avec succès',
        };

      } catch (error) {
        console.error('Erreur upload image signature:', error);
        
        if (error.message.includes('Validation')) {
          throw error;
        }
        
        throw createInternalError('Erreur lors de l\'upload de l\'image');
      }
    }),

    /**
     * Supprime une image de signature de Cloudflare
     */
    deleteSignatureImage: isAuthenticated(async (_, { key }, { user }) => {
      try {
        if (!key) {
          throw createValidationError('La clé de l\'image est requise');
        }

        // Vérifier que l'image appartient à l'utilisateur (sécurité)
        if (!key.includes(`signatures/${user.id}/`)) {
          throw createValidationError('Accès non autorisé à cette image');
        }

        const success = await cloudflareService.deleteImage(key);

        return {
          success,
          message: success ? 'Image supprimée avec succès' : 'Erreur lors de la suppression',
        };

      } catch (error) {
        console.error('Erreur suppression image signature:', error);
        throw createInternalError('Erreur lors de la suppression de l\'image');
      }
    }),

    /**
     * Génère une URL signée temporaire pour accès privé
     */
    generateSignedImageUrl: isAuthenticated(async (_, { key, expiresIn = 3600 }, { user }) => {
      try {
        if (!key) {
          throw createValidationError('La clé de l\'image est requise');
        }

        // Vérifier que l'image appartient à l'utilisateur (sécurité)
        if (!key.includes(`signatures/${user.id}/`)) {
          throw createValidationError('Accès non autorisé à cette image');
        }

        const signedUrl = await cloudflareService.getSignedUrl(key, expiresIn);

        return {
          success: true,
          url: signedUrl,
          expiresIn,
          message: 'URL signée générée avec succès',
        };

      } catch (error) {
        console.error('Erreur génération URL signée:', error);
        throw createInternalError('Erreur lors de la génération de l\'URL signée');
      }
    }),
  },
};

export default imageUploadResolvers;
