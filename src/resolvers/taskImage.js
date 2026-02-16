// resolvers/taskImage.js
import { GraphQLUpload } from 'graphql-upload';
import { Task } from '../models/kanban.js';
import { withWorkspace } from '../middlewares/better-auth-jwt.js';
import cloudflareService from '../services/cloudflareService.js';
import logger from '../utils/logger.js';
import mongoose from 'mongoose';
import { getPubSub } from '../config/redis.js';

const TASK_UPDATED = "TASK_UPDATED";

// Publier en toute sécurité
const safePublish = (channel, payload, context = "") => {
  try {
    const pubsub = getPubSub();
    pubsub.publish(channel, payload).catch((error) => {
      logger.error(`❌ [TaskImage] Erreur publication ${context}:`, error);
    });
  } catch (error) {
    logger.error(`❌ [TaskImage] Erreur getPubSub ${context}:`, error);
  }
};

// Enrichir une tâche avec les infos utilisateur (import dynamique pour éviter la dépendance circulaire)
let _enrichTaskWithUserInfo = null;
const getEnrichFn = async () => {
  if (!_enrichTaskWithUserInfo) {
    const kanbanModule = await import('./kanban.js');
    _enrichTaskWithUserInfo = kanbanModule.enrichTaskWithUserInfo;
  }
  return _enrichTaskWithUserInfo;
};

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
          const validMimeTypes = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain', 'text/csv'
          ];
          if (!validMimeTypes.includes(mimetype)) {
            return {
              success: false,
              image: null,
              message: 'Type de fichier non supporté. Formats acceptés : images (JPEG, PNG, GIF, WebP), documents (PDF, Word, Excel, TXT, CSV).'
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

          // Valider la taille totale par tâche (max 50MB)
          const currentTotalSize = (task.images || []).reduce((sum, img) => sum + (img.fileSize || 0), 0);
          if (currentTotalSize + fileBuffer.length > 50 * 1024 * 1024) {
            return {
              success: false,
              image: null,
              message: 'Limite de stockage atteinte. Maximum 50MB par tâche.'
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

          // Activité pour l'ajout d'image
          const imageActivity = {
            _id: new mongoose.Types.ObjectId(),
            userId: user.id,
            type: 'updated',
            field: 'images',
            description: `a ajouté 1 image`,
            newValue: [{ fileName: uploadResult.fileName }],
            createdAt: new Date()
          };

          // Utiliser findOneAndUpdate avec $push pour garantir la persistance
          const updatedTask = await Task.findOneAndUpdate(
            { _id: taskId, workspaceId },
            { $push: { images: newImage, activity: imageActivity } },
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

          // Publier la mise à jour en temps réel
          try {
            const enrichFn = await getEnrichFn();
            const enrichedTask = await enrichFn(updatedTask);
            safePublish(
              `${TASK_UPDATED}_${workspaceId}_${enrichedTask.boardId}`,
              { type: "UPDATED", task: enrichedTask, boardId: enrichedTask.boardId, workspaceId },
              "Image ajoutée"
            );
          } catch (e) {
            logger.error(`❌ [TaskImage] Erreur publication:`, e);
          }

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

          // Ajouter l'activité de suppression
          task.activity.push({
            _id: new mongoose.Types.ObjectId(),
            userId: user.id,
            type: 'updated',
            field: 'images',
            description: `a supprimé 1 image`,
            oldValue: [{ fileName: image.fileName }],
            createdAt: new Date()
          });

          await task.save();

          logger.info(`✅ [TaskImage] Image supprimée avec succès`);

          // Publier la mise à jour en temps réel
          try {
            const enrichFn = await getEnrichFn();
            const enrichedTask = await enrichFn(task);
            safePublish(
              `${TASK_UPDATED}_${workspaceId}_${enrichedTask.boardId}`,
              { type: "UPDATED", task: enrichedTask, boardId: enrichedTask.boardId, workspaceId },
              "Image supprimée"
            );
          } catch (e) {
            logger.error(`❌ [TaskImage] Erreur publication:`, e);
          }

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

          // Ajouter l'activité
          task.activity.push({
            _id: new mongoose.Types.ObjectId(),
            userId: user.id,
            type: 'updated',
            field: 'images',
            description: `a ajouté 1 image`,
            newValue: [{ fileName: input.fileName }],
            createdAt: new Date()
          });

          await task.save();

          logger.info(`✅ [TaskImage] Image ajoutée avec succès`);

          // Publier la mise à jour en temps réel
          try {
            const enrichFn = await getEnrichFn();
            const enrichedTask = await enrichFn(task);
            safePublish(
              `${TASK_UPDATED}_${workspaceId}_${enrichedTask.boardId}`,
              { type: "UPDATED", task: enrichedTask, boardId: enrichedTask.boardId, workspaceId },
              "Image ajoutée depuis URL"
            );
          } catch (e) {
            logger.error(`❌ [TaskImage] Erreur publication:`, e);
          }

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
          const validMimeTypes = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain', 'text/csv'
          ];
          if (!validMimeTypes.includes(mimetype)) {
            return {
              success: false,
              image: null,
              message: 'Type de fichier non supporté. Formats acceptés : images (JPEG, PNG, GIF, WebP), documents (PDF, Word, Excel, TXT, CSV).'
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
