/**
 * Resolvers GraphQL pour les documents partagés
 */

import mongoose from "mongoose";
import SharedDocument from "../models/SharedDocument.js";
import SharedFolder from "../models/SharedFolder.js";
import SharedTag, { getDefaultTagColor } from "../models/SharedTag.js";
import cloudflareService from "../services/cloudflareService.js";
import {
  isAuthenticated,
  withWorkspace,
} from "../middlewares/better-auth-jwt.js";
import { withOrganization } from "../middlewares/rbac.js";
import { GraphQLUpload } from "graphql-upload";
import path from "path";
import crypto from "crypto";
import { checkSubscriptionActive } from "../middlewares/rbac.js";
import { getPubSub } from "../config/redis.js";

const { ObjectId } = mongoose.Types;

// === Subscription temps réel ===
const SHARED_DOCUMENTS_CHANGED = "SHARED_DOCUMENTS_CHANGED";

// Publie un événement « documents partagés modifiés » sur le canal du workspace.
// Non bloquant : toute erreur PubSub est avalée (le temps réel est optionnel).
// Exporté pour être appelé aussi par le service d'automatisation.
export function publishSharedDocsChanged(
  workspaceId,
  type = "UPDATED",
  documentId = null,
) {
  if (!workspaceId) return;
  const wsId = workspaceId.toString();
  try {
    const pubsub = getPubSub();
    pubsub
      .publish(`${SHARED_DOCUMENTS_CHANGED}_${wsId}`, {
        type,
        documentId: documentId ? documentId.toString() : null,
        workspaceId: wsId,
      })
      .catch(() => {});
  } catch {
    // PubSub indisponible — non bloquant
  }
}

// === Visibility helpers ===

function getEffectiveVisibility(folder, folderMap) {
  if (folder.visibility) {
    return {
      visibility: folder.visibility,
      allowedUserIds: (folder.allowedUserIds || []).map((id) => id.toString()),
      createdBy: folder.createdBy?.toString(),
    };
  }
  if (folder.parentId) {
    const parent = folderMap.get(folder.parentId.toString());
    if (parent) return getEffectiveVisibility(parent, folderMap);
  }
  return {
    visibility: "public",
    allowedUserIds: [],
    createdBy: folder.createdBy?.toString(),
  };
}

function canAccessFolder(userId, folder, effectiveVis) {
  if (effectiveVis.visibility === "public") return true;
  if (folder.createdBy?.toString() === userId) return true;
  if (effectiveVis.createdBy === userId) return true;
  return effectiveVis.allowedUserIds.includes(userId);
}

// === Registre de tags ===

/**
 * Enregistre (upsert) une liste de tags dans le registre du workspace.
 * Best-effort et non bloquant : une erreur ne doit jamais faire échouer
 * l'opération sur le document. Les tags déjà présents sont laissés tels quels
 * (on ne touche pas à leur couleur), seuls les nouveaux sont créés avec une
 * couleur de palette déterministe.
 */
async function ensureTagsRegistered(workspaceId, tagNames) {
  if (!workspaceId || !Array.isArray(tagNames)) return;
  const names = [
    ...new Set(
      tagNames
        .map((t) => (typeof t === "string" ? t.trim() : ""))
        .filter(Boolean),
    ),
  ];
  if (names.length === 0) return;
  try {
    await SharedTag.bulkWrite(
      names.map((name) => ({
        updateOne: {
          filter: { workspaceId, name },
          update: {
            $setOnInsert: {
              workspaceId,
              name,
              color: getDefaultTagColor(name),
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  } catch (error) {
    // Conflit d'unicité possible en cas de course : non bloquant
    console.error("⚠️ ensureTagsRegistered:", error.message);
  }
}

const sharedDocumentResolvers = {
  Upload: GraphQLUpload,

  Query: {
    /**
     * Récupère les documents partagés d'un workspace (filtrés par visibilité des dossiers)
     */
    sharedDocuments: withOrganization(
      async (
        _,
        {
          workspaceId,
          filter,
          limit = 50,
          offset = 0,
          sortBy = "createdAt",
          sortOrder = "desc",
        },
        { user },
      ) => {
        try {
          const userId = user._id?.toString() || user.id?.toString();

          // Charger tous les dossiers pour vérifier la visibilité
          const allFolders = await SharedFolder.find({
            workspaceId,
            trashedAt: null,
          });
          const folderMap = new Map();
          for (const folder of allFolders) {
            folderMap.set(folder._id.toString(), folder);
          }

          // Calculer les dossiers inaccessibles
          const inaccessibleFolderIds = allFolders
            .filter((folder) => {
              const effectiveVis = getEffectiveVisibility(folder, folderMap);
              return !canAccessFolder(userId, folder, effectiveVis);
            })
            .map((f) => f._id);

          // Exclure les documents en corbeille
          const query = { workspaceId, trashedAt: null };

          // Filtres optionnels
          if (filter) {
            if (filter.folderId !== undefined) {
              // Si le dossier demandé est inaccessible, retourner vide
              if (
                filter.folderId &&
                inaccessibleFolderIds.some(
                  (id) => id.toString() === filter.folderId,
                )
              ) {
                return {
                  success: true,
                  documents: [],
                  total: 0,
                  hasMore: false,
                };
              }
              query.folderId = filter.folderId || null;
            } else if (inaccessibleFolderIds.length > 0) {
              // Exclure les documents des dossiers privés inaccessibles
              query.folderId = { $nin: inaccessibleFolderIds };
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

            // Filtres avancés
            // Filtre par type de fichier
            if (filter.fileType) {
              const mimeTypePatterns = {
                image: /^image\//,
                video: /^video\//,
                pdf: /^application\/pdf$/,
                document: /word|document|text\//,
                spreadsheet: /spreadsheet|excel|csv/,
              };
              const pattern = mimeTypePatterns[filter.fileType];
              if (pattern) {
                query.mimeType = { $regex: pattern };
              } else if (filter.fileType === "other") {
                // Tout sauf les types connus
                query.$and = query.$and || [];
                query.$and.push({
                  mimeType: {
                    $not: {
                      $regex:
                        /^image\/|^video\/|^application\/pdf$|word|document|text\/|spreadsheet|excel|csv/,
                    },
                  },
                });
              }
            }

            // Filtre par date
            if (filter.dateFrom || filter.dateTo) {
              query.createdAt = query.createdAt || {};
              if (filter.dateFrom) {
                query.createdAt.$gte = new Date(filter.dateFrom);
              }
              if (filter.dateTo) {
                // Ajouter un jour pour inclure toute la journée
                const endDate = new Date(filter.dateTo);
                endDate.setDate(endDate.getDate() + 1);
                query.createdAt.$lte = endDate;
              }
            }

            // Filtre par taille
            if (filter.minSize || filter.maxSize) {
              query.fileSize = query.fileSize || {};
              if (filter.minSize) {
                query.fileSize.$gte = filter.minSize;
              }
              if (filter.maxSize) {
                query.fileSize.$lte = filter.maxSize;
              }
            }
          }

          // Construire l'objet de tri
          const validSortFields = ["name", "fileSize", "createdAt"];
          const sortField = validSortFields.includes(sortBy)
            ? sortBy
            : "createdAt";
          const sortDirection = sortOrder === "asc" ? 1 : -1;
          const sortOptions = { [sortField]: sortDirection };

          const documents = await SharedDocument.find(query)
            .sort(sortOptions)
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
      },
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
      },
    ),

    /**
     * Récupère les dossiers d'un workspace (filtrés par visibilité)
     */
    sharedFolders: withOrganization(async (_, { workspaceId }, { user }) => {
      try {
        const userId = user._id?.toString() || user.id?.toString();

        // Exclure les dossiers en corbeille
        const folders = await SharedFolder.find({
          workspaceId,
          trashedAt: null,
        }).sort({
          order: 1,
          name: 1,
        });

        // Construire un folderMap pour résoudre la visibilité héritée
        const folderMap = new Map();
        for (const folder of folders) {
          folderMap.set(folder._id.toString(), folder);
        }

        // Filtrer les dossiers par visibilité
        const accessibleFolders = folders.filter((folder) => {
          const effectiveVis = getEffectiveVisibility(folder, folderMap);
          return canAccessFolder(userId, folder, effectiveVis);
        });

        // Compter les documents en une seule agrégation au lieu de N requêtes.
        // aggregate() ne caste PAS les types (contrairement à find/countDocuments) :
        // workspaceId arrive en string depuis GraphQL alors qu'il est stocké en
        // ObjectId, donc sans cast explicite le $match ne matche rien et tous les
        // documentsCount valent 0. On caste donc workspaceId en ObjectId.
        const folderIds = accessibleFolders.map((f) => f._id);
        const countResults = await SharedDocument.aggregate([
          {
            $match: {
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
              folderId: { $in: folderIds },
              trashedAt: null,
            },
          },
          { $group: { _id: "$folderId", count: { $sum: 1 } } },
        ]);
        const countMap = new Map(
          countResults.map((r) => [r._id.toString(), r.count]),
        );

        const foldersWithCount = accessibleFolders.map((folder) => ({
          ...folder.toObject(),
          id: folder._id,
          documentsCount: countMap.get(folder._id.toString()) || 0,
        }));

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
          // Convertir workspaceId en ObjectId pour l'aggregation
          const workspaceObjectId = new ObjectId(workspaceId);

          const [
            totalDocuments,
            pendingDocuments,
            classifiedDocuments,
            archivedDocuments,
            totalFolders,
            sizeAggregation,
            trashedDocuments,
            trashedFolders,
            trashedSizeAggregation,
          ] = await Promise.all([
            // Documents actifs (non en corbeille)
            SharedDocument.countDocuments({ workspaceId, trashedAt: null }),
            SharedDocument.countDocuments({
              workspaceId,
              status: "pending",
              trashedAt: null,
            }),
            SharedDocument.countDocuments({
              workspaceId,
              status: "classified",
              trashedAt: null,
            }),
            SharedDocument.countDocuments({
              workspaceId,
              status: "archived",
              trashedAt: null,
            }),
            SharedFolder.countDocuments({ workspaceId, trashedAt: null }),
            SharedDocument.aggregate([
              { $match: { workspaceId: workspaceObjectId, trashedAt: null } },
              { $group: { _id: null, totalSize: { $sum: "$fileSize" } } },
            ]),
            // Stats corbeille
            SharedDocument.countDocuments({
              workspaceId,
              trashedAt: { $ne: null },
            }),
            SharedFolder.countDocuments({
              workspaceId,
              trashedAt: { $ne: null },
            }),
            SharedDocument.aggregate([
              {
                $match: {
                  workspaceId: workspaceObjectId,
                  trashedAt: { $ne: null },
                },
              },
              { $group: { _id: null, totalSize: { $sum: "$fileSize" } } },
            ]),
          ]);

          const totalSize =
            sizeAggregation.length > 0 ? sizeAggregation[0].totalSize : 0;
          const trashedSize =
            trashedSizeAggregation.length > 0
              ? trashedSizeAggregation[0].totalSize
              : 0;

          return {
            success: true,
            totalDocuments,
            pendingDocuments,
            classifiedDocuments,
            archivedDocuments,
            totalFolders,
            totalSize,
            trashedDocuments,
            trashedFolders,
            trashedSize,
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
            trashedDocuments: 0,
            trashedFolders: 0,
            trashedSize: 0,
          };
        }
      },
    ),

    /**
     * Récupère les éléments de la corbeille
     */
    trashItems: isAuthenticated(async (_, { workspaceId }, { user }) => {
      try {
        const workspaceObjectId = new ObjectId(workspaceId);

        const [documents, folders, sizeAggregation] = await Promise.all([
          SharedDocument.find({ workspaceId, trashedAt: { $ne: null } }).sort({
            trashedAt: -1,
          }),
          SharedFolder.find({ workspaceId, trashedAt: { $ne: null } }).sort({
            trashedAt: -1,
          }),
          SharedDocument.aggregate([
            {
              $match: {
                workspaceId: workspaceObjectId,
                trashedAt: { $ne: null },
              },
            },
            { $group: { _id: null, totalSize: { $sum: "$fileSize" } } },
          ]),
        ]);

        const totalSize =
          sizeAggregation.length > 0 ? sizeAggregation[0].totalSize : 0;

        // Transformer les documents avec les jours restants
        const transformedDocs = documents.map((doc) => {
          const docObj = doc.toObject();
          return {
            ...docObj,
            id: doc._id,
            trashedAt: docObj.trashedAt?.toISOString(),
            createdAt: docObj.createdAt?.toISOString?.() || docObj.createdAt,
            updatedAt: docObj.updatedAt?.toISOString?.() || docObj.updatedAt,
          };
        });

        const transformedFolders = folders.map((folder) => {
          const folderObj = folder.toObject();
          return {
            ...folderObj,
            id: folder._id,
            trashedAt: folderObj.trashedAt?.toISOString(),
            createdAt:
              folderObj.createdAt?.toISOString?.() || folderObj.createdAt,
            updatedAt:
              folderObj.updatedAt?.toISOString?.() || folderObj.updatedAt,
          };
        });

        return {
          success: true,
          documents: transformedDocs,
          folders: transformedFolders,
          totalDocuments: documents.length,
          totalFolders: folders.length,
          totalSize,
        };
      } catch (error) {
        console.error("❌ Erreur récupération corbeille:", error);
        return {
          success: false,
          message: error.message,
          documents: [],
          folders: [],
          totalDocuments: 0,
          totalFolders: 0,
          totalSize: 0,
        };
      }
    }),
    /**
     * Registre de tags du workspace, avec nombre d'utilisations calculé en
     * direct par agrégation sur les documents (hors corbeille). Les tags
     * présents sur des documents mais absents du registre (legacy) sont
     * surfacés et auto-enregistrés.
     */
    documentTags: withOrganization(async (_, { workspaceId }, { user }) => {
      try {
        const wsId = new ObjectId(workspaceId);

        // Compter les usages réels par tag (documents non en corbeille)
        const usageAgg = await SharedDocument.aggregate([
          { $match: { workspaceId: wsId, trashedAt: null } },
          { $unwind: "$tags" },
          { $group: { _id: "$tags", count: { $sum: 1 } } },
        ]);
        const usageMap = new Map(usageAgg.map((u) => [u._id, u.count]));

        // Registre existant
        const registry = await SharedTag.find({ workspaceId }).lean();
        const registryNames = new Set(registry.map((t) => t.name));

        // Auto-enregistrer les tags présents sur des docs mais absents du registre
        const missing = [...usageMap.keys()].filter(
          (name) => name && !registryNames.has(name),
        );
        if (missing.length > 0) {
          await ensureTagsRegistered(workspaceId, missing);
          const created = await SharedTag.find({
            workspaceId,
            name: { $in: missing },
          }).lean();
          registry.push(...created);
        }

        const tags = registry
          .map((t) => ({
            id: t._id,
            name: t.name,
            color: t.color || getDefaultTagColor(t.name),
            usageCount: usageMap.get(t.name) || 0,
            createdAt: t.createdAt?.toISOString?.() || t.createdAt,
            updatedAt: t.updatedAt?.toISOString?.() || t.updatedAt,
          }))
          .sort(
            (a, b) =>
              b.usageCount - a.usageCount || a.name.localeCompare(b.name),
          );

        return { success: true, tags };
      } catch (error) {
        console.error("❌ Erreur récupération tags:", error);
        return { success: false, message: error.message, tags: [] };
      }
    }),
  },

  Mutation: {
    /**
     * Upload un document partagé
     */
    uploadSharedDocument: isAuthenticated(
      async (
        _,
        { workspaceId, file, folderId, name, description, tags },
        { user },
      ) => {
        try {
          console.log(
            "📤 Upload document partagé pour workspace:",
            workspaceId,
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
          const fileHash = crypto
            .createHash("sha256")
            .update(fileBuffer)
            .digest("hex");

          // Valider la taille du fichier (500MB pour les vidéos, 50MB pour le reste)
          const isVideo = mimetype?.startsWith("video/");
          const maxSize = isVideo ? 500 * 1024 * 1024 : 50 * 1024 * 1024;
          if (fileSize > maxSize) {
            throw new Error(
              `Fichier trop volumineux. Taille maximum: ${maxSize / 1024 / 1024}MB`,
            );
          }

          // Valider le type de fichier
          const allowedTypes = [
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/webp",
            "image/gif",
            "image/heic",
            "image/heif",
            "video/mp4",
            "video/webm",
            "video/quicktime",
            "video/x-msvideo",
            "video/x-matroska",
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
              "Type de fichier non supporté. Types acceptés: Images, Vidéos, PDF, Word, Excel, CSV, TXT",
            );
          }

          // Upload vers Cloudflare R2
          const uploadResult = await cloudflareService.uploadImage(
            fileBuffer,
            filename,
            user.id,
            "sharedDocuments",
            workspaceId,
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
            fileHash,
            workspaceId,
            folderId: folderId || null,
            uploadedBy: user.id,
            uploadedByName: user.name || user.email,
            status: folderId ? "classified" : "pending",
            isSharedWithAccountant: true,
            tags: tags || [],
          });

          await document.save();

          // Mémoriser les tags dans le registre du workspace
          await ensureTagsRegistered(workspaceId, document.tags);

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
      },
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
            { new: true },
          );

          if (!document) {
            return {
              success: false,
              message: "Document non trouvé",
              document: null,
            };
          }

          // Mémoriser les éventuels nouveaux tags dans le registre
          if (input.tags) {
            await ensureTagsRegistered(workspaceId, input.tags);
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
      },
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
            trashedAt: null,
          });

          if (!document) {
            return {
              success: false,
              message: "Document non trouvé",
            };
          }

          // Soft-delete : mettre en corbeille (suppression définitive dans 30 jours)
          await SharedDocument.updateOne(
            { _id: id },
            {
              $set: {
                trashedAt: new Date(),
                originalFolderId: document.folderId,
              },
            },
          );

          return {
            success: true,
            message: "Document déplacé vers la corbeille",
          };
        } catch (error) {
          console.error("❌ Erreur mise en corbeille document:", error);
          return {
            success: false,
            message: error.message,
          };
        }
      },
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
            trashedAt: null,
          });

          if (documents.length === 0) {
            return {
              success: false,
              message: "Aucun document trouvé",
            };
          }

          const now = new Date();

          // Soft-delete : mettre en corbeille en sauvegardant le dossier original
          for (const doc of documents) {
            await SharedDocument.updateOne(
              { _id: doc._id },
              {
                $set: {
                  trashedAt: now,
                  originalFolderId: doc.folderId,
                },
              },
            );
          }

          return {
            success: true,
            message: `${documents.length} document(s) déplacé(s) vers la corbeille`,
          };
        } catch (error) {
          console.error("❌ Erreur mise en corbeille documents:", error);
          return {
            success: false,
            message: error.message,
          };
        }
      },
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
            },
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
      },
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
            { new: true },
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
      },
    ),

    /**
     * Met à jour les tags de plusieurs documents
     */
    bulkUpdateTags: isAuthenticated(
      async (_, { ids, workspaceId, addTags, removeTags }, { user }) => {
        try {
          const updateOperations = {};

          // Ajouter des tags
          if (addTags && addTags.length > 0) {
            updateOperations.$addToSet = { tags: { $each: addTags } };
          }

          // Supprimer des tags
          if (removeTags && removeTags.length > 0) {
            updateOperations.$pull = { tags: { $in: removeTags } };
          }

          if (Object.keys(updateOperations).length === 0) {
            return {
              success: false,
              message: "Aucune modification demandée",
              updatedCount: 0,
            };
          }

          // Pour combiner $addToSet et $pull, on doit faire deux opérations
          let updatedCount = 0;

          if (addTags && addTags.length > 0) {
            const addResult = await SharedDocument.updateMany(
              { _id: { $in: ids }, workspaceId },
              { $addToSet: { tags: { $each: addTags } } },
            );
            updatedCount = addResult.modifiedCount;
            // Mémoriser les nouveaux tags dans le registre
            await ensureTagsRegistered(workspaceId, addTags);
          }

          if (removeTags && removeTags.length > 0) {
            const removeResult = await SharedDocument.updateMany(
              { _id: { $in: ids }, workspaceId },
              { $pull: { tags: { $in: removeTags } } },
            );
            updatedCount = Math.max(updatedCount, removeResult.modifiedCount);
          }

          return {
            success: true,
            message: `Tags mis à jour pour ${updatedCount} document(s)`,
            updatedCount,
          };
        } catch (error) {
          console.error("❌ Erreur mise à jour tags en masse:", error);
          return {
            success: false,
            message: error.message,
            updatedCount: 0,
          };
        }
      },
    ),

    /**
     * Crée un tag dans le registre du workspace
     */
    createDocumentTag: withOrganization(
      async (_, { workspaceId, name, color }, { user }) => {
        try {
          const trimmed = (name || "").trim();
          if (!trimmed) {
            return { success: false, message: "Nom de tag requis", tag: null };
          }

          // Upsert atomique : évite les erreurs de clé dupliquée si le tag est
          // auto-enregistré en parallèle (ensureTagsRegistered). La couleur
          // explicitement choisie reste prioritaire sur la couleur par défaut.
          const tag = await SharedTag.findOneAndUpdate(
            { workspaceId, name: trimmed },
            color
              ? {
                  $set: { color },
                  $setOnInsert: { workspaceId, name: trimmed },
                }
              : {
                  $setOnInsert: {
                    workspaceId,
                    name: trimmed,
                    color: getDefaultTagColor(trimmed),
                  },
                },
            { new: true, upsert: true },
          );

          return {
            success: true,
            message: "Tag enregistré",
            tag: { ...tag.toObject(), id: tag._id, usageCount: 0 },
          };
        } catch (error) {
          console.error("❌ Erreur création tag:", error);
          return { success: false, message: error.message, tag: null };
        }
      },
    ),

    /**
     * Met à jour un tag (renommage et/ou couleur). Le renommage est propagé
     * sur tous les documents du workspace.
     */
    updateDocumentTag: withOrganization(
      async (_, { workspaceId, id, name, color }, { user }) => {
        try {
          const tag = await SharedTag.findOne({ _id: id, workspaceId });
          if (!tag) {
            return { success: false, message: "Tag non trouvé", tag: null };
          }

          const oldName = tag.name;
          const newName = name != null ? name.trim() : oldName;

          if (!newName) {
            return { success: false, message: "Nom de tag requis", tag: null };
          }

          // Vérifier les collisions de nom (autre tag portant déjà ce nom)
          if (newName !== oldName) {
            const collision = await SharedTag.findOne({
              workspaceId,
              name: newName,
              _id: { $ne: tag._id },
            });
            if (collision) {
              return {
                success: false,
                message: "Un tag porte déjà ce nom",
                tag: null,
              };
            }
          }

          tag.name = newName;
          if (color != null) tag.color = color;
          await tag.save();

          // Propager le renommage sur les documents : on cible d'abord les docs
          // portant l'ancien tag, puis on retire l'ancien et ajoute le nouveau
          // (en deux temps pour éviter les doublons dans le tableau)
          if (newName !== oldName) {
            const affected = await SharedDocument.find(
              { workspaceId, tags: oldName },
              { _id: 1 },
            ).lean();
            const affectedIds = affected.map((d) => d._id);
            if (affectedIds.length > 0) {
              await SharedDocument.updateMany(
                { _id: { $in: affectedIds } },
                { $pull: { tags: oldName } },
              );
              await SharedDocument.updateMany(
                { _id: { $in: affectedIds } },
                { $addToSet: { tags: newName } },
              );
            }
          }

          return {
            success: true,
            message: "Tag mis à jour",
            tag: { ...tag.toObject(), id: tag._id },
          };
        } catch (error) {
          console.error("❌ Erreur mise à jour tag:", error);
          return { success: false, message: error.message, tag: null };
        }
      },
    ),

    /**
     * Supprime un tag du registre et le retire de tous les documents
     */
    deleteDocumentTag: withOrganization(
      async (_, { workspaceId, id }, { user }) => {
        try {
          const tag = await SharedTag.findOne({ _id: id, workspaceId });
          if (!tag) {
            return { success: false, message: "Tag non trouvé" };
          }

          await SharedDocument.updateMany(
            { workspaceId, tags: tag.name },
            { $pull: { tags: tag.name } },
          );
          await SharedTag.deleteOne({ _id: tag._id, workspaceId });

          return { success: true, message: "Tag supprimé" };
        } catch (error) {
          console.error("❌ Erreur suppression tag:", error);
          return { success: false, message: error.message };
        }
      },
    ),

    /**
     * Crée un dossier
     */
    createSharedFolder: withOrganization(
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
      },
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
            // System folders can be moved (parentId, order) but not renamed/modified
            const allowedKeys = ["parentId", "order"];
            const inputKeys = Object.keys(input);
            const hasOnlyAllowed = inputKeys.every((k) =>
              allowedKeys.includes(k),
            );
            if (!hasOnlyAllowed) {
              return {
                success: false,
                message: "Ce dossier système ne peut pas être modifié",
                folder: null,
              };
            }
          }

          const updatedFolder = await SharedFolder.findOneAndUpdate(
            { _id: id, workspaceId },
            { $set: input },
            { new: true },
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
      },
    ),

    /**
     * Met un dossier en corbeille (soft delete)
     * Les documents et sous-dossiers sont aussi mis en corbeille
     */
    deleteSharedFolder: isAuthenticated(
      async (_, { id, workspaceId }, { user }) => {
        try {
          const folder = await SharedFolder.findOne({
            _id: id,
            workspaceId,
            trashedAt: null,
          });

          if (!folder) {
            return {
              success: false,
              message: "Dossier non trouvé",
            };
          }

          const now = new Date();

          // Fonction récursive pour collecter tous les IDs de sous-dossiers
          const getAllSubfolderIds = async (parentId) => {
            const subfolders = await SharedFolder.find({
              workspaceId,
              parentId,
              trashedAt: null,
            });
            let allIds = subfolders.map((f) => f._id);

            for (const subfolder of subfolders) {
              const childIds = await getAllSubfolderIds(subfolder._id);
              allIds = allIds.concat(childIds);
            }

            return allIds;
          };

          // Collecter tous les IDs de sous-dossiers
          const subfolderIds = await getAllSubfolderIds(id);
          const allFolderIds = [id, ...subfolderIds];

          // Mettre tous les documents de ces dossiers en corbeille
          // Sauvegarder leur folderId original pour restauration
          const docsToTrash = await SharedDocument.find({
            workspaceId,
            folderId: { $in: allFolderIds },
            trashedAt: null,
          });

          for (const doc of docsToTrash) {
            await SharedDocument.updateOne(
              { _id: doc._id },
              {
                $set: {
                  trashedAt: now,
                  originalFolderId: doc.folderId,
                },
              },
            );
          }

          // Mettre tous les sous-dossiers en corbeille
          for (const subfolderId of subfolderIds) {
            const subfolder = await SharedFolder.findById(subfolderId);
            if (subfolder) {
              await SharedFolder.updateOne(
                { _id: subfolderId },
                {
                  $set: {
                    trashedAt: now,
                    originalParentId: subfolder.parentId,
                  },
                },
              );
            }
          }

          // Mettre le dossier principal en corbeille
          await SharedFolder.updateOne(
            { _id: id },
            {
              $set: {
                trashedAt: now,
                originalParentId: folder.parentId,
              },
            },
          );

          return {
            success: true,
            message: `Dossier et ${subfolderIds.length} sous-dossier(s) déplacés vers la corbeille. Suppression définitive dans 30 jours.`,
          };
        } catch (error) {
          console.error("❌ Erreur mise en corbeille dossier:", error);
          return {
            success: false,
            message: error.message,
          };
        }
      },
    ),

    /**
     * Met à jour la visibilité d'un dossier
     */
    updateFolderVisibility: withOrganization(
      async (_, { id, workspaceId, visibility, allowedUserIds }, context) => {
        const { user } = context;
        try {
          const folder = await SharedFolder.findOne({ _id: id, workspaceId });
          if (!folder) {
            return {
              success: false,
              message: "Dossier non trouvé",
              folder: null,
            };
          }

          const userId = user._id?.toString() || user.id?.toString();
          if (folder.isSystem) {
            const userRole = context.userRole;
            if (userRole !== "admin" && userRole !== "owner") {
              return {
                success: false,
                message:
                  "Seul un administrateur peut modifier la visibilité des dossiers système",
                folder: null,
              };
            }
          } else if (folder.createdBy?.toString() !== userId) {
            return {
              success: false,
              message: "Seul le créateur peut modifier la visibilité",
              folder: null,
            };
          }

          folder.visibility = visibility;
          folder.allowedUserIds =
            visibility === "private" ? allowedUserIds || [] : [];
          await folder.save();

          return {
            success: true,
            message: "Visibilité mise à jour",
            folder: { ...folder.toObject(), id: folder._id },
          };
        } catch (error) {
          console.error("❌ Erreur mise à jour visibilité:", error);
          return { success: false, message: error.message, folder: null };
        }
      },
    ),

    /**
     * Restaure des éléments depuis la corbeille
     */
    restoreFromTrash: isAuthenticated(
      async (_, { workspaceId, documentIds, folderIds }, { user }) => {
        try {
          let restoredDocuments = 0;
          let restoredFolders = 0;

          // Restaurer les documents
          if (documentIds && documentIds.length > 0) {
            for (const docId of documentIds) {
              const doc = await SharedDocument.findOne({
                _id: docId,
                workspaceId,
                trashedAt: { $ne: null },
              });

              if (doc) {
                // Vérifier si le dossier original existe encore et n'est pas en corbeille
                let targetFolderId = doc.originalFolderId;
                if (targetFolderId) {
                  const originalFolder = await SharedFolder.findOne({
                    _id: targetFolderId,
                    trashedAt: null,
                  });
                  if (!originalFolder) {
                    targetFolderId = null; // Dossier supprimé, mettre dans inbox
                  }
                }

                await SharedDocument.updateOne(
                  { _id: docId },
                  {
                    $set: {
                      trashedAt: null,
                      folderId: targetFolderId,
                      status: targetFolderId ? "classified" : "pending",
                    },
                    $unset: { originalFolderId: "" },
                  },
                );
                restoredDocuments++;
              }
            }
          }

          // Restaurer les dossiers
          if (folderIds && folderIds.length > 0) {
            // Collecte récursive de tous les sous-dossiers en corbeille d'un
            // dossier donné (via originalParentId, posé lors de la mise en
            // corbeille). Permet de restaurer toute l'arborescence et pas
            // seulement les fichiers directement contenus dans le dossier.
            const collectTrashedDescendants = async (parentId) => {
              const children = await SharedFolder.find({
                workspaceId,
                originalParentId: parentId,
                trashedAt: { $ne: null },
              });
              let all = [];
              for (const child of children) {
                all.push(child);
                all = all.concat(await collectTrashedDescendants(child._id));
              }
              return all;
            };

            const processedFolderIds = new Set();

            for (const folderId of folderIds) {
              if (processedFolderIds.has(folderId.toString())) continue;

              const folder = await SharedFolder.findOne({
                _id: folderId,
                workspaceId,
                trashedAt: { $ne: null },
              });

              if (!folder) continue;

              // Vérifier si le dossier parent original existe encore
              let targetParentId = folder.originalParentId;
              if (targetParentId) {
                const originalParent = await SharedFolder.findOne({
                  _id: targetParentId,
                  trashedAt: null,
                });
                if (!originalParent) {
                  targetParentId = null; // Parent supprimé, mettre à la racine
                }
              }

              // Restaurer le dossier racine vers son parent original
              await SharedFolder.updateOne(
                { _id: folderId },
                {
                  $set: {
                    trashedAt: null,
                    parentId: targetParentId,
                  },
                  $unset: { originalParentId: "" },
                },
              );
              processedFolderIds.add(folderId.toString());
              restoredFolders++;

              // Restaurer récursivement tous les sous-dossiers vers leur
              // parent original (qui fait partie de l'arborescence restaurée)
              const descendants = await collectTrashedDescendants(folderId);
              for (const sub of descendants) {
                if (processedFolderIds.has(sub._id.toString())) continue;
                await SharedFolder.updateOne(
                  { _id: sub._id },
                  {
                    $set: {
                      trashedAt: null,
                      parentId: sub.originalParentId,
                    },
                    $unset: { originalParentId: "" },
                  },
                );
                processedFolderIds.add(sub._id.toString());
                restoredFolders++;
              }

              // Restaurer les documents du dossier ET de tous ses sous-dossiers
              const allFolderIds = [folderId, ...descendants.map((f) => f._id)];
              const docsInFolders = await SharedDocument.find({
                workspaceId,
                originalFolderId: { $in: allFolderIds },
                trashedAt: { $ne: null },
              });

              for (const doc of docsInFolders) {
                await SharedDocument.updateOne(
                  { _id: doc._id },
                  {
                    $set: {
                      trashedAt: null,
                      folderId: doc.originalFolderId,
                      status: "classified",
                    },
                    $unset: { originalFolderId: "" },
                  },
                );
                restoredDocuments++;
              }
            }
          }

          return {
            success: true,
            message: `${restoredDocuments} document(s) et ${restoredFolders} dossier(s) restauré(s)`,
            restoredDocuments,
            restoredFolders,
          };
        } catch (error) {
          console.error("❌ Erreur restauration:", error);
          return {
            success: false,
            message: error.message,
            restoredDocuments: 0,
            restoredFolders: 0,
          };
        }
      },
    ),

    /**
     * Vide complètement la corbeille (suppression définitive)
     */
    emptyTrash: isAuthenticated(async (_, { workspaceId }, { user }) => {
      try {
        // Récupérer tous les documents en corbeille pour supprimer de R2
        const trashedDocs = await SharedDocument.find({
          workspaceId,
          trashedAt: { $ne: null },
        });

        // Supprimer les fichiers de Cloudflare R2
        for (const doc of trashedDocs) {
          try {
            await cloudflareService.deleteImage(doc.fileKey);
          } catch (cloudflareError) {
            console.warn(
              "⚠️ Erreur suppression Cloudflare:",
              cloudflareError.message,
            );
          }
        }

        // Supprimer définitivement les documents
        const deleteDocsResult = await SharedDocument.deleteMany({
          workspaceId,
          trashedAt: { $ne: null },
        });

        // Supprimer définitivement les dossiers
        const deleteFoldersResult = await SharedFolder.deleteMany({
          workspaceId,
          trashedAt: { $ne: null },
        });

        return {
          success: true,
          message: `Corbeille vidée: ${deleteDocsResult.deletedCount} document(s) et ${deleteFoldersResult.deletedCount} dossier(s) supprimé(s) définitivement`,
        };
      } catch (error) {
        console.error("❌ Erreur vidage corbeille:", error);
        return {
          success: false,
          message: error.message,
        };
      }
    }),

    /**
     * Supprime définitivement des documents (de la corbeille)
     */
    permanentlyDeleteDocuments: isAuthenticated(
      async (_, { ids, workspaceId }, { user }) => {
        try {
          const documents = await SharedDocument.find({
            _id: { $in: ids },
            workspaceId,
            trashedAt: { $ne: null },
          });

          // Supprimer de Cloudflare R2
          for (const doc of documents) {
            try {
              await cloudflareService.deleteImage(doc.fileKey);
            } catch (cloudflareError) {
              console.warn(
                "⚠️ Erreur suppression Cloudflare:",
                cloudflareError.message,
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
            message: `${documents.length} document(s) supprimé(s) définitivement`,
          };
        } catch (error) {
          console.error("❌ Erreur suppression définitive documents:", error);
          return {
            success: false,
            message: error.message,
          };
        }
      },
    ),

    /**
     * Supprime définitivement des dossiers (de la corbeille)
     */
    permanentlyDeleteFolders: isAuthenticated(
      async (_, { ids, workspaceId }, { user }) => {
        try {
          // Récupérer les documents dans ces dossiers pour supprimer de R2
          const docsInFolders = await SharedDocument.find({
            workspaceId,
            originalFolderId: { $in: ids },
            trashedAt: { $ne: null },
          });

          for (const doc of docsInFolders) {
            try {
              await cloudflareService.deleteImage(doc.fileKey);
            } catch (cloudflareError) {
              console.warn(
                "⚠️ Erreur suppression Cloudflare:",
                cloudflareError.message,
              );
            }
          }

          // Supprimer les documents
          await SharedDocument.deleteMany({
            workspaceId,
            originalFolderId: { $in: ids },
            trashedAt: { $ne: null },
          });

          // Supprimer les dossiers
          const result = await SharedFolder.deleteMany({
            _id: { $in: ids },
            workspaceId,
          });

          return {
            success: true,
            message: `${result.deletedCount} dossier(s) et ${docsInFolders.length} document(s) supprimé(s) définitivement`,
          };
        } catch (error) {
          console.error("❌ Erreur suppression définitive dossiers:", error);
          return {
            success: false,
            message: error.message,
          };
        }
      },
    ),
  },

  // Resolvers de champs
  SharedDocument: {
    id: (parent) => parent._id || parent.id,
    folder: async (parent) => {
      if (!parent.folderId) return null;
      return await SharedFolder.findById(parent.folderId).lean();
    },
    trashedAt: (parent) =>
      parent.trashedAt?.toISOString?.() || parent.trashedAt,
    daysUntilPermanentDeletion: (parent) => {
      if (!parent.trashedAt) return null;
      const trashedDate = new Date(parent.trashedAt);
      const deletionDate = new Date(
        trashedDate.getTime() + 30 * 24 * 60 * 60 * 1000,
      ); // +30 jours
      const now = new Date();
      const diffMs = deletionDate - now;
      const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
      return Math.max(0, diffDays);
    },
  },

  SharedFolder: {
    id: (parent) => parent._id || parent.id,
    parent: async (parent) => {
      if (!parent.parentId) return null;
      return await SharedFolder.findById(parent.parentId).lean();
    },
    trashedAt: (parent) =>
      parent.trashedAt?.toISOString?.() || parent.trashedAt,
    daysUntilPermanentDeletion: (parent) => {
      if (!parent.trashedAt) return null;
      const trashedDate = new Date(parent.trashedAt);
      const deletionDate = new Date(
        trashedDate.getTime() + 30 * 24 * 60 * 60 * 1000,
      ); // +30 jours
      const now = new Date();
      const diffMs = deletionDate - now;
      const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
      return Math.max(0, diffDays);
    },
    canManageVisibility: (parent, _, context) => {
      if (!context.user) return false;
      // Les dossiers système : seul un admin/owner peut gérer la visibilité
      if (parent.isSystem) {
        return context.userRole === "admin" || context.userRole === "owner";
      }
      const userId =
        context.user._id?.toString() || context.user.id?.toString();
      return parent.createdBy?.toString() === userId;
    },
  },

  Subscription: {
    // Émis dès qu'un document/dossier du workspace change (y compris via
    // automatisation côté serveur). Le canal encode le workspaceId, comme kanban.
    sharedDocumentsChanged: {
      subscribe: withWorkspace(
        (_, { workspaceId }, { workspaceId: contextWorkspaceId }) => {
          const finalWorkspaceId = workspaceId || contextWorkspaceId;
          const pubsub = getPubSub();
          return pubsub.asyncIterableIterator([
            `${SHARED_DOCUMENTS_CHANGED}_${finalWorkspaceId}`,
          ]);
        },
      ),
      resolve: (
        payload,
        { workspaceId },
        { workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        // Sécurité : filtrer par workspace (le canal le garantit déjà)
        if (String(payload.workspaceId) === String(finalWorkspaceId)) {
          return payload;
        }
        return null;
      },
    },
  },
};

// ✅ Phase A.4 — Subscription check on shared document mutations (exclude trash cleanup: emptyTrash, permanentlyDeleteDocuments, permanentlyDeleteFolders)
const SHARED_DOC_EXCLUDE = [
  "emptyTrash",
  "permanentlyDeleteDocuments",
  "permanentlyDeleteFolders",
];
const originalSharedDocMutations = sharedDocumentResolvers.Mutation;
sharedDocumentResolvers.Mutation = Object.fromEntries(
  Object.entries(originalSharedDocMutations).map(([name, fn]) => [
    name,
    SHARED_DOC_EXCLUDE.includes(name)
      ? fn
      : async (parent, args, context, info) => {
          await checkSubscriptionActive(context);
          const result = await fn(parent, args, context, info);
          // Notifier les clients abonnés (mise à jour temps réel des listes)
          publishSharedDocsChanged(args?.workspaceId, name);
          return result;
        },
  ]),
);

export default sharedDocumentResolvers;
