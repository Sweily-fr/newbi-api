/**
 * Resolvers GraphQL pour l'upload de documents vers Cloudflare
 */

import cloudflareService from '../services/cloudflareService.js';
import { GraphQLUpload } from 'graphql-upload';

const documentUploadResolvers = {
  Upload: GraphQLUpload,

  Mutation: {
    /**
     * Upload un document vers Cloudflare R2
     */
    uploadDocument: async (_, { file }, { user }) => {
      try {
        console.log('📤 Début upload document vers Cloudflare...');

        // Vérifier l'authentification
        if (!user) {
          throw new Error('Utilisateur non authentifié');
        }

        // Récupérer les informations du fichier
        const { createReadStream, filename, mimetype, encoding } = await file;
        
        console.log('📄 Informations fichier:', {
          filename,
          mimetype,
          encoding
        });

        // Lire le fichier en buffer
        const stream = createReadStream();
        const chunks = [];
        
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        
        const fileBuffer = Buffer.concat(chunks);
        const fileSize = fileBuffer.length;
        
        console.log('📊 Taille fichier:', fileSize, 'bytes');

        // Valider la taille du fichier (10MB max)
        const maxSize = 10 * 1024 * 1024; // 10MB
        if (fileSize > maxSize) {
          throw new Error(`Fichier trop volumineux. Taille maximum: ${maxSize / 1024 / 1024}MB`);
        }

        // Valider le type de fichier
        const allowedTypes = [
          'image/jpeg',
          'image/jpg', 
          'image/png',
          'image/webp',
          'application/pdf',
          'application/octet-stream' // Support pour les fichiers dont le MIME type n'est pas détecté correctement
        ];

        if (!allowedTypes.includes(mimetype)) {
          throw new Error('Type de fichier non supporté. Types acceptés: JPEG, PNG, WebP, PDF');
        }

        // Upload vers Cloudflare R2
        console.log('☁️ Upload vers Cloudflare R2...');
        const uploadResult = await cloudflareService.uploadImage(
          fileBuffer,
          filename,
          user.id,
          'documents' // Type de dossier pour les documents généraux
        );

        console.log('✅ Document uploadé avec succès:', uploadResult.url);

        return {
          success: true,
          key: uploadResult.key,
          url: uploadResult.url,
          contentType: uploadResult.contentType,
          fileName: filename,
          fileSize: fileSize,
          message: 'Document uploadé avec succès'
        };

      } catch (error) {
        console.error('❌ Erreur upload document:', error);
        
        return {
          success: false,
          key: null,
          url: null,
          contentType: null,
          fileName: null,
          fileSize: null,
          message: error.message || 'Erreur lors de l\'upload du document'
        };
      }
    }
  }
};

export default documentUploadResolvers;
