/**
 * Resolvers GraphQL pour les documents partagés
 */

import SharedDocument from "../models/SharedDocument.js";
import SharedFolder from "../models/SharedFolder.js";
import cloudflareService from "../services/cloudflareService.js";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import { GraphQLUpload } from "graphql-upload";
import path from "path";

const sharedDocumentResolvers = {
  Upload: GraphQLUpload,

  Query: {
    /**
     * Récupère les documents partagés d'un workspace
     */
    sharedDocuments: isAuthenticated(
      async (_, { workspaceId, filter, limit = 50, offset = 0 }, { user }) => {
        try {
          const query = { workspaceId };

          // Filtres optionnels
          if (filter) {
            if (filter.folderId !== undefined) {
              query.folderId = filter.folderId || null;
            }
            if (filter.status) {
              query.status = filter.status;
            }
            if (filter.tags && filter.tags.length > 0) {
              query.tags = { $in: filter.tags };
            }
            if (filter.search) {
              query.$or = [
                { name: { $regex: filter.search, $options: "i" } },
                { description: { $regex: filter.search, $options: "i" } },
                { tags: { $regex: filter.search, $options: "i" } },
              ];
            }
          }

          const documents = await SharedDocument.find(query)
            .sort({ createdAt: -1 })
            .skip(offset)
            .limit(limit + 1);

          const hasMore = documents.length > limit;
          const total = await SharedDocument.countDocuments(query);

          // Transformer les documents pour s'assurer que les dates sont en ISO string
          const transformedDocs = documents.slice(0, limit).map((doc) => {
            const docObj = doc.toObject();
            return {
              ...docObj,
              id: doc._id,
              createdAt: docObj.createdAt?.toISOString?.() || docObj.createdAt,
              updatedAt: docObj.updatedAt?.toISOString?.() || docObj.updatedAt,
            };
          });

          return {
            success: true,
            documents: transformedDocs,
            total,
            hasMore,
          };
        } catch (error) {
          console.error("❌ Erreur récupération documents:", error);
          return {
            success: false,
            message: error.message,
            documents: [],
            total: 0,
            hasMore: false,
          };
        }
      }
    ),

    /**
     * Récupère un document par ID
     */
    sharedDocument: isAuthenticated(
      async (_, { id, workspaceId }, { user }) => {
        try {
          const document = await SharedDocument.findOne({
            _id: id,
            workspaceId,
          });

          if (!document) {
            return {
              success: false,
              message: "Document non trouvé",
              document: null,
            };
          }

          return {
            success: true,
            document,
          };
        } catch (error) {
          console.error("❌ Erreur récupération document:", error);
          return {
            success: false,
            message: error.message,
            document: null,
          };
        }
      }
    ),

    /**
     * Récupère les dossiers d'un workspace
     */
    sharedFolders: isAuthenticated(async (_, { workspaceId }, { user }) => {
      try {
        const folders = await SharedFolder.find({ workspaceId }).sort({
          order: 1,
          name: 1,
        });

        // Ajouter le compte de documents pour chaque dossier
        const foldersWithCount = await Promise.all(
          folders.map(async (folder) => {
            const documentsCount = await SharedDocument.countDocuments({
              workspaceId,
              folderId: folder._id,
            });
            return {
              ...folder.toObject(),
              id: folder._id,
              documentsCount,
            };
          })
        );

        return {
          success: true,
          folders: foldersWithCount,
        };
      } catch (error) {
        console.error("❌ Erreur récupération dossiers:", error);
        return {
          success: false,
          message: error.message,
          folders: [],
        };
      }
    }),

    /**
     * Récupère un dossier par ID
     */
    sharedFolder: isAuthenticated(async (_, { id, workspaceId }, { user }) => {
      try {
        const folder = await SharedFolder.findOne({ _id: id, workspaceId });

        if (!folder) {
          return {
            success: false,
            message: "Dossier non trouvé",
            folder: null,
          };
        }

        const documentsCount = await SharedDocument.countDocuments({
          workspaceId,
          folderId: folder._id,
        });

        return {
          success: true,
          folder: {
            ...folder.toObject(),
            id: folder._id,
            documentsCount,
          },
        };
      } catch (error) {
        console.error("❌ Erreur récupération dossier:", error);
        return {
          success: false,
          message: error.message,
          folder: null,
        };
      }
    }),

    /**
     * Statistiques des documents partagés
     */
    sharedDocumentsStats: isAuthenticated(
      async (_, { workspaceId }, { user }) => {
        try {
          const [
            totalDocuments,
            pendingDocuments,
            classifiedDocuments,
            archivedDocuments,
            totalFolders,
            sizeAggregation,
          ] = await Promise.all([
            SharedDocument.countDocuments({ workspaceId }),
            SharedDocument.countDocuments({ workspaceId, status: "pending" }),
            SharedDocument.countDocuments({
              workspaceId,
              status: "classified",
            }),
            SharedDocument.countDocuments({ workspaceId, status: "archived" }),
            SharedFolder.countDocuments({ workspaceId }),
            SharedDocument.aggregate([
              { $match: { workspaceId: workspaceId } },
              { $group: { _id: null, totalSize: { $sum: "$fileSize" } } },
            ]),
          ]);

          const totalSize =
            sizeAggregation.length > 0 ? sizeAggregation[0].totalSize : 0;

          return {
            success: true,
            totalDocuments,
            pendingDocuments,
            classifiedDocuments,
            archivedDocuments,
            totalFolders,
            totalSize,
          };
        } catch (error) {
          console.error("❌ Erreur stats documents:", error);
          return {
            success: false,
            totalDocuments: 0,
            pendingDocuments: 0,
            classifiedDocuments: 0,
            archivedDocuments: 0,
            totalFolders: 0,
            totalSize: 0,
          };
        }
      }
    ),
  },

  Mutation: {
    /**
     * Upload un document partagé
     */
    uploadSharedDocument: isAuthenticated(
      async (
        _,
        { workspaceId, file, folderId, name, description, tags },
        { user }
      ) => {
        try {
          console.log(
            "📤 Upload document partagé pour workspace:",
            workspaceId
          );

          // Récupérer les informations du fichier
          const { createReadStream, filename, mimetype } = await file;

          // Lire le fichier en buffer
          const stream = createReadStream();
          const chunks = [];

          for await (const chunk of stream) {
            chunks.push(chunk);
          }

          const fileBuffer = Buffer.concat(chunks);
          const fileSize = fileBuffer.length;

          // Valider la taille du fichier (50MB max pour les documents)
          const maxSize = 50 * 1024 * 1024;
          if (fileSize > maxSize) {
            throw new Error(
              `Fichier trop volumineux. Taille maximum: ${maxSize / 1024 / 1024}MB`
            );
          }

          // Valider le type de fichier
          const allowedTypes = [
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/webp",
            "image/gif",
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/plain",
            "text/csv",
            "application/octet-stream",
          ];

          if (!allowedTypes.includes(mimetype)) {
            throw new Error(
              "Type de fichier non supporté. Types acceptés: Images, PDF, Word, Excel, CSV, TXT"
            );
          }

          // Upload vers Cloudflare R2
          const uploadResult = await cloudflareService.uploadImage(
            fileBuffer,
            filename,
            user.id,
            "sharedDocuments",
            workspaceId
          );

          // Extraire l'extension
          const fileExtension = path.extname(filename).toLowerCase().slice(1);

          // Créer le document en base
          const document = new SharedDocument({
            name: name || filename,
            originalName: filename,
            description: description || "",
            fileUrl: uploadResult.url,
            fileKey: uploadResult.key,
            mimeType: mimetype,
            fileSize,
            fileExtension,
            workspaceId,
            folderId: folderId || null,
            uploadedBy: user.id,
            uploadedByName: user.name || user.email,
            status: folderId ? "classified" : "pending",
            isSharedWithAccountant: true,
            tags: tags || [],
          });

          await document.save();

          console.log("✅ Document partagé créé:", document._id);

          const docObj = document.toObject();
          return {
            success: true,
            message: "Document uploadé avec succès",
            document: {
              ...docObj,
              id: document._id,
              createdAt:
                docObj.createdAt?.toISOString() || new Date().toISOString(),
              updatedAt:
                docObj.updatedAt?.toISOString() || new Date().toISOString(),
            },
          };
        } catch (error) {
          console.error("❌ Erreur upload document partagé:", error);
          return {
            success: false,
            message: error.message,
            document: null,
          };
        }
      }
    ),

    /**
     * Met à jour un document
     */
    updateSharedDocument: isAuthenticated(
      async (_, { id, workspaceId, input }, { user }) => {
        try {
          const document = await SharedDocument.findOneAndUpdate(
            { _id: id, workspaceId },
            { $set: input },
            { new: true }
          );

          if (!document) {
            return {
              success: false,
              message: "Document non trouvé",
              document: null,
            };
          }

          return {
            success: true,
            message: "Document mis à jour",
            document: {
              ...document.toObject(),
              id: document._id,
            },
          };
        } catch (error) {
          console.error("❌ Erreur mise à jour document:", error);
          return {
            success: false,
            message: error.message,
            document: null,
          };
        }
      }
    ),

    /**
     * Supprime un document
     */
    deleteSharedDocument: isAuthenticated(
      async (_, { id, workspaceId }, { user }) => {
        try {
          const document = await SharedDocument.findOne({
            _id: id,
            workspaceId,
          });

          if (!document) {
            return {
              success: false,
              message: "Document non trouvé",
            };
          }

          // Supprimer de Cloudflare R2
          try {
            await cloudflareService.deleteImage(document.fileKey);
          } catch (cloudflareError) {
            console.warn(
              "⚠️ Erreur suppression Cloudflare:",
              cloudflareError.message
            );
          }

          // Supprimer de la base
          await SharedDocument.deleteOne({ _id: id });

          return {
            success: true,
            message: "Document supprimé",
          };
        } catch (error) {
          console.error("❌ Erreur suppression document:", error);
          return {
            success: false,
            message: error.message,
          };
        }
      }
    ),

    /**
     * Supprime plusieurs documents
     */
    deleteSharedDocuments: isAuthenticated(
      async (_, { ids, workspaceId }, { user }) => {
        try {
          const documents = await SharedDocument.find({
            _id: { $in: ids },
            workspaceId,
          });

          // Supprimer de Cloudflare R2
          for (const doc of documents) {
            try {
              await cloudflareService.deleteImage(doc.fileKey);
            } catch (cloudflareError) {
              console.warn(
                "⚠️ Erreur suppression Cloudflare:",
                cloudflareError.message
              );
            }
          }

          // Supprimer de la base
          await SharedDocument.deleteMany({
            _id: { $in: ids },
            workspaceId,
          });

          return {
            success: true,
            message: `${documents.length} document(s) supprimé(s)`,
          };
        } catch (error) {
          console.error("❌ Erreur suppression documents:", error);
          return {
            success: false,
            message: error.message,
          };
        }
      }
    ),

    /**
     * Déplace des documents vers un dossier
     */
    moveSharedDocuments: isAuthenticated(
      async (_, { ids, workspaceId, targetFolderId }, { user }) => {
        try {
          const result = await SharedDocument.updateMany(
            { _id: { $in: ids }, workspaceId },
            {
              $set: {
                folderId: targetFolderId || null,
                status: targetFolderId ? "classified" : "pending",
              },
            }
          );

          return {
            success: true,
            message: `${result.modifiedCount} document(s) déplacé(s)`,
            movedCount: result.modifiedCount,
          };
        } catch (error) {
          console.error("❌ Erreur déplacement documents:", error);
          return {
            success: false,
            message: error.message,
            movedCount: 0,
          };
        }
      }
    ),

    /**
     * Ajoute un commentaire à un document
     */
    addDocumentComment: isAuthenticated(
      async (_, { workspaceId, input }, { user }) => {
        try {
          const document = await SharedDocument.findOneAndUpdate(
            { _id: input.documentId, workspaceId },
            {
              $push: {
                comments: {
                  text: input.text,
                  authorId: user.id,
                  authorName: user.name || user.email,
                  createdAt: new Date(),
                },
              },
            },
            { new: true }
          );

          if (!document) {
            return {
              success: false,
              message: "Document non trouvé",
              document: null,
            };
          }

          return {
            success: true,
            message: "Commentaire ajouté",
            document: {
              ...document.toObject(),
              id: document._id,
            },
          };
        } catch (error) {
          console.error("❌ Erreur ajout commentaire:", error);
          return {
            success: false,
            message: error.message,
            document: null,
          };
        }
      }
    ),

    /**
     * Crée un dossier
     */
    createSharedFolder: isAuthenticated(
      async (_, { workspaceId, input }, { user }) => {
        try {
          // Vérifier si un dossier avec le même nom existe déjà
          const existing = await SharedFolder.findOne({
            workspaceId,
            name: input.name,
            parentId: input.parentId || null,
          });

          if (existing) {
            return {
              success: false,
              message: "Un dossier avec ce nom existe déjà",
              folder: null,
            };
          }

          // Récupérer l'ordre max
          const maxOrder = await SharedFolder.findOne({ workspaceId })
            .sort({ order: -1 })
            .select("order");

          const folder = new SharedFolder({
            ...input,
            workspaceId,
            createdBy: user.id,
            order: (maxOrder?.order || 0) + 1,
          });

          await folder.save();

          return {
            success: true,
            message: "Dossier créé",
            folder: {
              ...folder.toObject(),
              id: folder._id,
              documentsCount: 0,
            },
          };
        } catch (error) {
          console.error("❌ Erreur création dossier:", error);
          return {
            success: false,
            message: error.message,
            folder: null,
          };
        }
      }
    ),

    /**
     * Met à jour un dossier
     */
    updateSharedFolder: isAuthenticated(
      async (_, { id, workspaceId, input }, { user }) => {
        try {
          const folder = await SharedFolder.findOne({ _id: id, workspaceId });

          if (!folder) {
            return {
              success: false,
              message: "Dossier non trouvé",
              folder: null,
            };
          }

          if (folder.isSystem) {
            return {
              success: false,
              message: "Ce dossier système ne peut pas être modifié",
              folder: null,
            };
          }

          const updatedFolder = await SharedFolder.findOneAndUpdate(
            { _id: id, workspaceId },
            { $set: input },
            { new: true }
          );

          const documentsCount = await SharedDocument.countDocuments({
            workspaceId,
            folderId: id,
          });

          return {
            success: true,
            message: "Dossier mis à jour",
            folder: {
              ...updatedFolder.toObject(),
              id: updatedFolder._id,
              documentsCount,
            },
          };
        } catch (error) {
          console.error("❌ Erreur mise à jour dossier:", error);
          return {
            success: false,
            message: error.message,
            folder: null,
          };
        }
      }
    ),

    /**
     * Supprime un dossier
     */
    deleteSharedFolder: isAuthenticated(
      async (_, { id, workspaceId }, { user }) => {
        try {
          const folder = await SharedFolder.findOne({ _id: id, workspaceId });

          if (!folder) {
            return {
              success: false,
              message: "Dossier non trouvé",
            };
          }

          if (folder.isSystem) {
            return {
              success: false,
              message: "Ce dossier système ne peut pas être supprimé",
            };
          }

          // Déplacer les documents vers "Documents à classer"
          await SharedDocument.updateMany(
            { workspaceId, folderId: id },
            { $set: { folderId: null, status: "pending" } }
          );

          // Supprimer le dossier
          await SharedFolder.deleteOne({ _id: id });

          return {
            success: true,
            message: "Dossier supprimé",
          };
        } catch (error) {
          console.error("❌ Erreur suppression dossier:", error);
          return {
            success: false,
            message: error.message,
          };
        }
      }
    ),
  },

  // Resolvers de champs
  SharedDocument: {
    id: (parent) => parent._id || parent.id,
    folder: async (parent) => {
      if (!parent.folderId) return null;
      return await SharedFolder.findById(parent.folderId);
    },
  },

  SharedFolder: {
    id: (parent) => parent._id || parent.id,
    parent: async (parent) => {
      if (!parent.parentId) return null;
      return await SharedFolder.findById(parent.parentId);
    },
  },
};

export default sharedDocumentResolvers;
