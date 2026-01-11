// resolvers/taskImage.js
import { GraphQLUpload } from 'graphql-upload';
import { Task } from '../models/kanban.js';
import { withWorkspace } from '../middlewares/better-auth-jwt.js';
import cloudflareService from '../services/cloudflareService.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';

/**
 * Resolvers pour la gestion des images de tâches Kanban
 * Structure Cloudflare: kanban/{taskId}/{userId}/description/{uniqueId}.{ext}
 *                   ou: kanban/{taskId}/{userId}/comments/{commentId}/{uniqueId}.{ext}
 */

const taskImageResolvers = {
  // Type scalar pour l'upload de fichiers
  Upload: GraphQLUpload,

  Mutation: {
    /**
     * Upload une image pour la description d'une tâche
     */
    uploadTaskImage: withWorkspace(
      async (_, { taskId, file, imageType = 'description', workspaceId }, { user }) => {
        try {
          logger.info(`📤 [TaskImage] Upload image pour tâche ${taskId}, type: ${imageType}, workspaceId: ${workspaceId}`);

          // Vérifier que la tâche existe
          const task = await Task.findOne({ _id: taskId, workspaceId });
          logger.info(`📤 [TaskImage] Tâche trouvée: ${task ? 'OUI' : 'NON'}, images existantes: ${task?.images?.length || 0}`);
          if (!task) {
            logger.error(`❌ [TaskImage] Tâche non trouvée - taskId: ${taskId}, workspaceId: ${workspaceId}`);
            return {
              success: false,
              image: null,
              message: 'Tâche non trouvée'
            };
          }

          // Traiter le fichier uploadé
          const { createReadStream, filename, mimetype } = await file;
          const stream = createReadStream();
          const chunks = [];
          
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          const fileBuffer = Buffer.concat(chunks);

          // Valider le type de fichier
          const validMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          if (!validMimeTypes.includes(mimetype)) {
            return {
              success: false,
              image: null,
              message: 'Type de fichier non supporté. Utilisez JPEG, PNG, GIF ou WebP.'
            };
          }

          // Valider la taille (max 10MB)
          const maxSize = 10 * 1024 * 1024;
          if (fileBuffer.length > maxSize) {
            return {
              success: false,
              image: null,
              message: 'Fichier trop volumineux. Maximum 10MB.'
            };
          }

          // Upload vers Cloudflare R2
          const uploadResult = await cloudflareService.uploadTaskImage(
            fileBuffer,
            filename,
            taskId,
            user.id,
            imageType
          );

          // Créer l'objet image
          const newImage = {
            _id: new mongoose.Types.ObjectId(),
            key: uploadResult.key,
            url: uploadResult.url,
            fileName: uploadResult.fileName,
            fileSize: uploadResult.fileSize,
            contentType: uploadResult.contentType,
            uploadedBy: user.id,
            uploadedAt: new Date()
          };

          // Utiliser findOneAndUpdate avec $push pour garantir la persistance
          const updatedTask = await Task.findOneAndUpdate(
            { _id: taskId, workspaceId },
            { $push: { images: newImage } },
            { new: true }
          );

          if (!updatedTask) {
            logger.error(`❌ [TaskImage] Échec de la mise à jour de la tâche`);
            return {
              success: false,
              image: null,
              message: 'Échec de la mise à jour de la tâche'
            };
          }
          
          logger.info(`✅ [TaskImage] Total images dans la tâche: ${updatedTask.images?.length || 0}`);

          logger.info(`✅ [TaskImage] Image uploadée avec succès: ${newImage.url}`);

          return {
            success: true,
            image: {
              id: newImage._id.toString(),
              key: newImage.key,
              url: newImage.url,
              fileName: newImage.fileName,
              fileSize: newImage.fileSize,
              contentType: newImage.contentType,
              uploadedBy: newImage.uploadedBy,
              uploadedAt: newImage.uploadedAt
            },
            message: 'Image uploadée avec succès'
          };
        } catch (error) {
          logger.error(`❌ [TaskImage] Erreur upload:`, error);
          return {
            success: false,
            image: null,
            message: `Erreur lors de l'upload: ${error.message}`
          };
        }
      }
    ),

    /**
     * Supprime une image de la description d'une tâche
     */
    deleteTaskImage: withWorkspace(
      async (_, { taskId, imageId, workspaceId }, { user }) => {
        try {
          logger.info(`🗑️ [TaskImage] Suppression image ${imageId} de la tâche ${taskId}`);

          const task = await Task.findOne({ _id: taskId, workspaceId });
          if (!task) {
            throw new Error('Tâche non trouvée');
          }

          // Trouver l'image
          const imageIndex = task.images?.findIndex(
            img => img._id.toString() === imageId
          );

          if (imageIndex === -1 || imageIndex === undefined) {
            throw new Error('Image non trouvée');
          }

          const image = task.images[imageIndex];

          // Supprimer de Cloudflare R2
          await cloudflareService.deleteTaskImage(image.key);

          // Supprimer de la base de données
          task.images.splice(imageIndex, 1);
          await task.save();

          logger.info(`✅ [TaskImage] Image supprimée avec succès`);

          return task;
        } catch (error) {
          logger.error(`❌ [TaskImage] Erreur suppression:`, error);
          throw error;
        }
      }
    ),

    /**
     * Ajoute une image à partir d'une URL (pour les images déjà uploadées)
     */
    addTaskImageFromUrl: withWorkspace(
      async (_, { taskId, input, workspaceId }, { user }) => {
        try {
          logger.info(`📎 [TaskImage] Ajout image depuis URL pour tâche ${taskId}`);

          const task = await Task.findOne({ _id: taskId, workspaceId });
          if (!task) {
            throw new Error('Tâche non trouvée');
          }

          const newImage = {
            _id: new mongoose.Types.ObjectId(),
            key: input.key,
            url: input.url,
            fileName: input.fileName,
            fileSize: input.fileSize || 0,
            contentType: input.contentType || 'image/jpeg',
            uploadedBy: user.id,
            uploadedAt: new Date()
          };

          if (!task.images) {
            task.images = [];
          }
          task.images.push(newImage);
          await task.save();

          logger.info(`✅ [TaskImage] Image ajoutée avec succès`);

          return task;
        } catch (error) {
          logger.error(`❌ [TaskImage] Erreur ajout image:`, error);
          throw error;
        }
      }
    ),

    /**
     * Upload une image pour un commentaire
     */
    uploadCommentImage: withWorkspace(
      async (_, { taskId, commentId, file, workspaceId }, { user }) => {
        try {
          logger.info(`📤 [TaskImage] Upload image pour commentaire ${commentId}`);

          const task = await Task.findOne({ _id: taskId, workspaceId });
          if (!task) {
            return {
              success: false,
              image: null,
              message: 'Tâche non trouvée'
            };
          }

          // Trouver le commentaire
          const comment = task.comments?.find(c => c._id.toString() === commentId);
          if (!comment) {
            return {
              success: false,
              image: null,
              message: 'Commentaire non trouvé'
            };
          }

          // Traiter le fichier uploadé
          const { createReadStream, filename, mimetype } = await file;
          const stream = createReadStream();
          const chunks = [];
          
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          const fileBuffer = Buffer.concat(chunks);

          // Valider le type de fichier
          const validMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          if (!validMimeTypes.includes(mimetype)) {
            return {
              success: false,
              image: null,
              message: 'Type de fichier non supporté. Utilisez JPEG, PNG, GIF ou WebP.'
            };
          }

          // Valider la taille (max 10MB)
          const maxSize = 10 * 1024 * 1024;
          if (fileBuffer.length > maxSize) {
            return {
              success: false,
              image: null,
              message: 'Fichier trop volumineux. Maximum 10MB.'
            };
          }

          // Upload vers Cloudflare R2
          const uploadResult = await cloudflareService.uploadTaskImage(
            fileBuffer,
            filename,
            taskId,
            user.id,
            'comment',
            commentId
          );

          // Créer l'objet image
          const newImage = {
            _id: new mongoose.Types.ObjectId(),
            key: uploadResult.key,
            url: uploadResult.url,
            fileName: uploadResult.fileName,
            fileSize: uploadResult.fileSize,
            contentType: uploadResult.contentType,
            uploadedBy: user.id,
            uploadedAt: new Date()
          };

          // Utiliser findOneAndUpdate avec $push pour garantir la persistance
          const updatedTask = await Task.findOneAndUpdate(
            { 
              _id: taskId, 
              workspaceId,
              'comments._id': new mongoose.Types.ObjectId(commentId)
            },
            { 
              $push: { 'comments.$.images': newImage }
            },
            { new: true }
          );

          if (!updatedTask) {
            logger.error(`❌ [TaskImage] Échec de la mise à jour - tâche ou commentaire non trouvé`);
            return {
              success: false,
              image: null,
              message: 'Échec de la mise à jour du commentaire'
            };
          }

          // Trouver le commentaire mis à jour pour le log
          const updatedComment = updatedTask.comments.find(c => c._id.toString() === commentId);
          logger.info(`✅ [TaskImage] Image ajoutée au commentaire ${commentId}, total images: ${updatedComment?.images?.length || 0}`);

          logger.info(`✅ [TaskImage] Image de commentaire uploadée avec succès`);

          return {
            success: true,
            image: {
              id: newImage._id.toString(),
              key: newImage.key,
              url: newImage.url,
              fileName: newImage.fileName,
              fileSize: newImage.fileSize,
              contentType: newImage.contentType,
              uploadedBy: newImage.uploadedBy,
              uploadedAt: newImage.uploadedAt
            },
            message: 'Image uploadée avec succès'
          };
        } catch (error) {
          logger.error(`❌ [TaskImage] Erreur upload commentaire:`, error);
          return {
            success: false,
            image: null,
            message: `Erreur lors de l'upload: ${error.message}`
          };
        }
      }
    ),

    /**
     * Supprime une image d'un commentaire
     */
    deleteCommentImage: withWorkspace(
      async (_, { taskId, commentId, imageId, workspaceId }, { user }) => {
        try {
          logger.info(`🗑️ [TaskImage] Suppression image ${imageId} du commentaire ${commentId}`);

          const task = await Task.findOne({ _id: taskId, workspaceId });
          if (!task) {
            throw new Error('Tâche non trouvée');
          }

          // Trouver le commentaire
          const comment = task.comments?.find(c => c._id.toString() === commentId);
          if (!comment) {
            throw new Error('Commentaire non trouvé');
          }

          // Trouver l'image
          const imageIndex = comment.images?.findIndex(
            img => img._id.toString() === imageId
          );

          if (imageIndex === -1 || imageIndex === undefined) {
            throw new Error('Image non trouvée');
          }

          const image = comment.images[imageIndex];

          // Supprimer de Cloudflare R2
          await cloudflareService.deleteTaskImage(image.key);

          // Supprimer de la base de données
          comment.images.splice(imageIndex, 1);
          await task.save();

          logger.info(`✅ [TaskImage] Image de commentaire supprimée avec succès`);

          return task;
        } catch (error) {
          logger.error(`❌ [TaskImage] Erreur suppression commentaire:`, error);
          throw error;
        }
      }
    )
  }
};

export default taskImageResolvers;
