import logger from "../utils/logger.js";
/**
 * Resolvers GraphQL pour les documents partagés
 */

import mongoose from "mongoose";
import SharedDocument from "../models/SharedDocument.js";
import SharedFolder from "../models/SharedFolder.js";
import SharedTag, { getDefaultTagColor } from "../models/SharedTag.js";
import cloudflareService from "../services/cloudflareService.js";
import { buildSearchRegex } from "../utils/searchRegex.js";
import {
  requireAction,
  requireRead,
  requireWorkspaceLevel,
  resolveWorkspaceId,
  checkSubscriptionActive,
  getMemberRole,
  hasPermissionLevel,
} from "../middlewares/rbac.js";
import { getEffectiveLevelsFor } from "../services/organizationRoleService.js";
import { GraphQLUpload } from "graphql-upload";
import path from "path";
import crypto from "crypto";
import { getPubSub } from "../config/redis.js";
import {
  canAccessFolder,
  getEffectiveVisibility,
  sharedFolderAccessFor,
} from "../services/sharedFolderAccess.js";

const { ObjectId } = mongoose.Types;

// 🔐 Dossiers privés : un dossier ou un document auquel l'utilisateur n'a
// pas accès (visibility / allowedUserIds, voir services/sharedFolderAccess.js)
// se comporte comme introuvable dans toutes les queries et mutations, et
// n'entre pas dans les statistiques.
const DOCUMENT_NOT_FOUND = "Document non trouvé";
const FOLDER_NOT_FOUND = "Dossier non trouvé";

/** Identifiants des documents du lot visibles par l'utilisateur. */
async function visibleDocumentIds(context, workspaceId, ids) {
  const { canAccessDocument } = await sharedFolderAccessFor(
    context,
    workspaceId,
  );
  const documents = await SharedDocument.find(
    { _id: { $in: ids }, workspaceId },
    { folderId: 1, originalFolderId: 1 },
  );
  return documents.filter(canAccessDocument).map((doc) => doc._id);
}

/** Filtres excluant les éléments des dossiers inaccessibles. */
function visibilityFilters(inaccessibleFolderIds) {
  return {
    documents: {
      folderId: { $nin: inaccessibleFolderIds },
      originalFolderId: { $nin: inaccessibleFolderIds },
    },
    folders: { _id: { $nin: inaccessibleFolderIds } },
  };
}

// 🔐 Ferme l'IDOR cross-org de façon uniforme : valide l'appartenance à l'org
// et le droit de lecture du module « sharedDocuments » (requireRead) ET force
// le workspace VALIDÉ par RBAC à la place de args.workspaceId. Nécessaire car
// le header x-organization-id prime sur les args dans RBAC : sans ce forçage,
// header=orgA (dont on est membre) + args.workspaceId=orgB permettait
// d'atteindre orgB.
const scopedQuery = (fn) =>
  requireRead("sharedDocuments")(async (parent, args, context, info) =>
    fn(
      parent,
      {
        ...args,
        workspaceId: resolveWorkspaceId(args.workspaceId, context.workspaceId),
      },
      context,
      info,
    ),
  );

// checkSub : contrôle d'abonnement APRÈS RBAC (context.workspaceId validé).
// publish : notification temps réel sur le workspace validé.
// action : action requise sur le module « sharedDocuments » (create pour
// ajouter des documents et des dossiers ; edit pour modifier, déplacer,
// classer, restaurer ; delete pour la corbeille et les suppressions). Le
// contrôle d'abonnement reste celui de checkSub.
// Le nettoyage corbeille (emptyTrash / permanentlyDelete*) reste accessible sans
// abonnement actif — on le passe par scopedDeleteMutationNoSub.
const makeScopedMutation =
  ({ checkSub, action }) =>
  (fn) =>
    requireAction("sharedDocuments", action, {
      skipSubscriptionCheck: true,
    })(async (parent, args, context, info) => {
      if (checkSub) await checkSubscriptionActive(context);
      const workspaceId = resolveWorkspaceId(
        args.workspaceId,
        context.workspaceId,
      );
      const result = await fn(parent, { ...args, workspaceId }, context, info);
      if (checkSub) {
        publishSharedDocsChanged(workspaceId, info?.fieldName || "UPDATED");
      }
      return result;
    });

const scopedCreateMutation = makeScopedMutation({
  checkSub: true,
  action: "create",
});
const scopedMutation = makeScopedMutation({ checkSub: true, action: "edit" });
const scopedDeleteMutation = makeScopedMutation({
  checkSub: true,
  action: "delete",
});
const scopedDeleteMutationNoSub = makeScopedMutation({
  checkSub: false,
  action: "delete",
});

// === Subscription temps réel ===
const SHARED_DOCUMENTS_CHANGED = "SHARED_DOCUMENTS_CHANGED";

// Abonnement temps réel : même choix d'espace que withWorkspace (argument
// d'abord) avec le droit de lecture des documents partagés
const subscribeSharedDocuments = requireWorkspaceLevel(
  "sharedDocuments",
  "read",
);

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

// Visibilité des dossiers : services/sharedFolderAccess.js (partagée avec les
// routes REST de téléchargement, les ZIP et les transferts)

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
    sharedDocuments: scopedQuery(
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
        context,
      ) => {
        try {
          // Dossiers privés inaccessibles (visibilité héritée comprise)
          const { canAccess, inaccessibleFolderIds } =
            await sharedFolderAccessFor(context, workspaceId);

          // Exclure les documents en corbeille
          const query = { workspaceId, trashedAt: null };

          // Exclure les documents des dossiers privés inaccessibles, y compris
          // sans filtre (la liste complète les renvoyait)
          if (filter?.folderId === undefined && inaccessibleFolderIds.length) {
            query.folderId = { $nin: inaccessibleFolderIds };
          }

          // Filtres optionnels
          if (filter) {
            if (filter.folderId !== undefined) {
              // Si le dossier demandé est inaccessible, retourner vide
              if (filter.folderId && !canAccess(filter.folderId)) {
                return {
                  success: true,
                  documents: [],
                  total: 0,
                  hasMore: false,
                };
              }
              query.folderId = filter.folderId || null;
            }
            if (filter.status) {
              query.status = filter.status;
            }
            if (filter.tags && filter.tags.length > 0) {
              query.tags = { $in: filter.tags };
            }
            if (filter.search) {
              // Saisie échappée, sans accents ni majuscules sauf searchExact
              const searchRegex = buildSearchRegex(filter.search, {
                exact: Boolean(filter.searchExact),
              });
              query.$or = [
                { name: searchRegex },
                { description: searchRegex },
                { tags: searchRegex },
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
    sharedDocument: scopedQuery(async (_, { id, workspaceId }, context) => {
      try {
        const document = await SharedDocument.findOne({
          _id: id,
          workspaceId,
        });
        const { canAccessDocument } = await sharedFolderAccessFor(
          context,
          workspaceId,
        );

        if (!document || !canAccessDocument(document)) {
          return {
            success: false,
            message: DOCUMENT_NOT_FOUND,
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
    }),

    /**
     * Récupère les dossiers d'un workspace (filtrés par visibilité)
     */
    sharedFolders: scopedQuery(async (_, { workspaceId }, { user }) => {
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
    sharedFolder: scopedQuery(async (_, { id, workspaceId }, context) => {
      try {
        const folder = await SharedFolder.findOne({ _id: id, workspaceId });
        const { canAccess } = await sharedFolderAccessFor(context, workspaceId);

        if (!folder || !canAccess(folder._id)) {
          return {
            success: false,
            message: FOLDER_NOT_FOUND,
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
    sharedDocumentsStats: scopedQuery(async (_, { workspaceId }, context) => {
      try {
        // Convertir workspaceId en ObjectId pour l'aggregation
        const workspaceObjectId = new ObjectId(workspaceId);
        // Ce que l'utilisateur ne voit pas (dossiers privés) n'est pas compté
        const { inaccessibleFolderIds } = await sharedFolderAccessFor(
          context,
          workspaceId,
        );
        const visible = visibilityFilters(inaccessibleFolderIds);

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
          SharedDocument.countDocuments({
            workspaceId,
            trashedAt: null,
            ...visible.documents,
          }),
          SharedDocument.countDocuments({
            workspaceId,
            status: "pending",
            trashedAt: null,
            ...visible.documents,
          }),
          SharedDocument.countDocuments({
            workspaceId,
            status: "classified",
            trashedAt: null,
            ...visible.documents,
          }),
          SharedDocument.countDocuments({
            workspaceId,
            status: "archived",
            trashedAt: null,
            ...visible.documents,
          }),
          SharedFolder.countDocuments({
            workspaceId,
            trashedAt: null,
            ...visible.folders,
          }),
          SharedDocument.aggregate([
            {
              $match: {
                workspaceId: workspaceObjectId,
                trashedAt: null,
                ...visible.documents,
              },
            },
            { $group: { _id: null, totalSize: { $sum: "$fileSize" } } },
          ]),
          // Stats corbeille
          SharedDocument.countDocuments({
            workspaceId,
            trashedAt: { $ne: null },
            ...visible.documents,
          }),
          SharedFolder.countDocuments({
            workspaceId,
            trashedAt: { $ne: null },
            ...visible.folders,
          }),
          SharedDocument.aggregate([
            {
              $match: {
                workspaceId: workspaceObjectId,
                trashedAt: { $ne: null },
                ...visible.documents,
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
    }),

    /**
     * Récupère les éléments de la corbeille
     */
    trashItems: scopedQuery(async (_, { workspaceId }, context) => {
      try {
        const workspaceObjectId = new ObjectId(workspaceId);
        // Éléments des dossiers privés inaccessibles : absents de la corbeille
        const { inaccessibleFolderIds } = await sharedFolderAccessFor(
          context,
          workspaceId,
        );
        const visible = visibilityFilters(inaccessibleFolderIds);

        const [documents, folders, sizeAggregation] = await Promise.all([
          SharedDocument.find({
            workspaceId,
            trashedAt: { $ne: null },
            ...visible.documents,
          }).sort({
            trashedAt: -1,
          }),
          SharedFolder.find({
            workspaceId,
            trashedAt: { $ne: null },
            ...visible.folders,
          }).sort({
            trashedAt: -1,
          }),
          SharedDocument.aggregate([
            {
              $match: {
                workspaceId: workspaceObjectId,
                trashedAt: { $ne: null },
                ...visible.documents,
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
    documentTags: scopedQuery(async (_, { workspaceId }, context) => {
      try {
        const wsId = new ObjectId(workspaceId);
        const { inaccessibleFolderIds } = await sharedFolderAccessFor(
          context,
          workspaceId,
        );

        // Compter les usages réels par tag (documents non en corbeille et
        // visibles : ceux des dossiers privés inaccessibles ne comptent pas)
        const usageAgg = await SharedDocument.aggregate([
          {
            $match: {
              workspaceId: wsId,
              trashedAt: null,
              ...visibilityFilters(inaccessibleFolderIds).documents,
            },
          },
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
    uploadSharedDocument: scopedCreateMutation(
      async (
        _,
        { workspaceId, file, folderId, name, description, tags },
        context,
      ) => {
        const { user } = context;
        try {
          logger.debug(
            "📤 Upload document partagé pour workspace:",
            workspaceId,
          );

          // Dossier cible d'un autre espace ou privé inaccessible : comme
          // introuvable
          if (folderId) {
            const { canTarget } = await sharedFolderAccessFor(
              context,
              workspaceId,
            );
            if (!canTarget(folderId)) {
              return {
                success: false,
                message: FOLDER_NOT_FOUND,
                document: null,
              };
            }
          }

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

          logger.debug("✅ Document partagé créé:", document._id);

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
    updateSharedDocument: scopedMutation(
      async (_, { id, workspaceId, input }, context) => {
        try {
          const access = await sharedFolderAccessFor(context, workspaceId);
          const existing = await SharedDocument.findOne({
            _id: id,
            workspaceId,
          });
          if (!access.canAccessDocument(existing)) {
            return {
              success: false,
              message: DOCUMENT_NOT_FOUND,
              document: null,
            };
          }
          // Déplacement vers un dossier d'un autre espace ou privé
          // inaccessible : refusé
          if (input?.folderId && !access.canTarget(input.folderId)) {
            return {
              success: false,
              message: FOLDER_NOT_FOUND,
              document: null,
            };
          }

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
    deleteSharedDocument: scopedDeleteMutation(
      async (_, { id, workspaceId }, context) => {
        try {
          const document = await SharedDocument.findOne({
            _id: id,
            workspaceId,
            trashedAt: null,
          });
          const { canAccessDocument } = await sharedFolderAccessFor(
            context,
            workspaceId,
          );

          if (!document || !canAccessDocument(document)) {
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
    deleteSharedDocuments: scopedDeleteMutation(
      async (_, { ids, workspaceId }, context) => {
        try {
          const { canAccessDocument } = await sharedFolderAccessFor(
            context,
            workspaceId,
          );
          const documents = (
            await SharedDocument.find({
              _id: { $in: ids },
              workspaceId,
              trashedAt: null,
            })
          ).filter(canAccessDocument);

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
    moveSharedDocuments: scopedMutation(
      async (_, { ids, workspaceId, targetFolderId }, context) => {
        try {
          // Dossier cible d'un autre espace ou privé inaccessible : refusé
          const { canTarget } = await sharedFolderAccessFor(
            context,
            workspaceId,
          );
          if (targetFolderId && !canTarget(targetFolderId)) {
            return { success: false, message: FOLDER_NOT_FOUND, movedCount: 0 };
          }
          const visibleIds = await visibleDocumentIds(
            context,
            workspaceId,
            ids,
          );

          const result = await SharedDocument.updateMany(
            { _id: { $in: visibleIds }, workspaceId },
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
    addDocumentComment: scopedMutation(
      async (_, { workspaceId, input }, context) => {
        const { user } = context;
        try {
          const [visibleId] = await visibleDocumentIds(context, workspaceId, [
            input.documentId,
          ]);
          if (!visibleId) {
            return {
              success: false,
              message: DOCUMENT_NOT_FOUND,
              document: null,
            };
          }

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
    bulkUpdateTags: scopedMutation(
      async (
        _,
        { ids: requestedIds, workspaceId, addTags, removeTags },
        context,
      ) => {
        try {
          // Documents des dossiers privés inaccessibles : ignorés
          const ids = await visibleDocumentIds(
            context,
            workspaceId,
            requestedIds,
          );
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
    createDocumentTag: scopedMutation(
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
    updateDocumentTag: scopedMutation(
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
    deleteDocumentTag: scopedDeleteMutation(
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
    createSharedFolder: scopedCreateMutation(
      async (_, { workspaceId, input }, context) => {
        const { user } = context;
        try {
          // Dossier parent d'un autre espace ou privé inaccessible : comme
          // introuvable
          if (input.parentId) {
            const { canTarget } = await sharedFolderAccessFor(
              context,
              workspaceId,
            );
            if (!canTarget(input.parentId)) {
              return {
                success: false,
                message: FOLDER_NOT_FOUND,
                folder: null,
              };
            }
          }

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
    updateSharedFolder: scopedMutation(
      async (_, { id, workspaceId, input }, context) => {
        try {
          const folder = await SharedFolder.findOne({ _id: id, workspaceId });
          const { canAccess, canTarget } = await sharedFolderAccessFor(
            context,
            workspaceId,
          );

          if (!folder || !canAccess(folder._id)) {
            return {
              success: false,
              message: FOLDER_NOT_FOUND,
              folder: null,
            };
          }

          // Déplacement sous un dossier d'un autre espace ou privé
          // inaccessible : refusé
          if (input.parentId && !canTarget(input.parentId)) {
            return { success: false, message: FOLDER_NOT_FOUND, folder: null };
          }

          // Visibilité : mêmes règles que updateFolderVisibility (le créateur,
          // ou pour un dossier système un rôle qui gère l'entreprise). Sans
          // ce contrôle, tout membre ayant accès au dossier le rendait public.
          if ("visibility" in input || "allowedUserIds" in input) {
            const userId =
              context.user._id?.toString() || context.user.id?.toString();
            const allowed = folder.isSystem
              ? context.permissions?.hasPermissionLevel("orgSettings", "write")
              : folder.createdBy?.toString() === userId;
            if (!allowed) {
              return {
                success: false,
                message: folder.isSystem
                  ? "Seul un administrateur peut modifier la visibilité des dossiers système"
                  : "Seul le créateur peut modifier la visibilité",
                folder: null,
              };
            }
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
    deleteSharedFolder: scopedDeleteMutation(
      async (_, { id, workspaceId }, context) => {
        try {
          const folder = await SharedFolder.findOne({
            _id: id,
            workspaceId,
            trashedAt: null,
          });
          const { canAccess } = await sharedFolderAccessFor(
            context,
            workspaceId,
          );

          if (!folder || !canAccess(folder._id)) {
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
    updateFolderVisibility: scopedMutation(
      async (_, { id, workspaceId, visibility, allowedUserIds }, context) => {
        const { user } = context;
        try {
          const folder = await SharedFolder.findOne({ _id: id, workspaceId });
          const { canAccess } = await sharedFolderAccessFor(
            context,
            workspaceId,
          );
          if (!folder || !canAccess(folder._id)) {
            return {
              success: false,
              message: FOLDER_NOT_FOUND,
              folder: null,
            };
          }

          const userId = user._id?.toString() || user.id?.toString();
          if (folder.isSystem) {
            // Dossiers système : configuration de l'espace, réservée aux rôles
            // qui gèrent les informations de l'entreprise (super admin et
            // administrateurs par défaut, comme avant les rôles personnalisés)
            if (
              !context.permissions?.hasPermissionLevel("orgSettings", "write")
            ) {
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
    restoreFromTrash: scopedMutation(
      async (_, { workspaceId, documentIds, folderIds }, context) => {
        try {
          let restoredDocuments = 0;
          let restoredFolders = 0;
          // Éléments des dossiers privés inaccessibles : comme introuvables
          const { canAccess, canAccessDocument } = await sharedFolderAccessFor(
            context,
            workspaceId,
          );

          // Restaurer les documents
          if (documentIds && documentIds.length > 0) {
            for (const docId of documentIds) {
              const doc = await SharedDocument.findOne({
                _id: docId,
                workspaceId,
                trashedAt: { $ne: null },
              });

              if (doc && canAccessDocument(doc)) {
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

              if (!folder || !canAccess(folder._id)) continue;

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
    emptyTrash: scopedDeleteMutationNoSub(
      async (_, { workspaceId }, context) => {
        try {
          // Seulement ce que l'utilisateur voit dans la corbeille : les
          // éléments des dossiers privés inaccessibles n'y sont pas
          const { inaccessibleFolderIds } = await sharedFolderAccessFor(
            context,
            workspaceId,
          );
          const visible = visibilityFilters(inaccessibleFolderIds);

          // Récupérer tous les documents en corbeille pour supprimer de R2
          const trashedDocs = await SharedDocument.find({
            workspaceId,
            trashedAt: { $ne: null },
            ...visible.documents,
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
            ...visible.documents,
          });

          // Supprimer définitivement les dossiers
          const deleteFoldersResult = await SharedFolder.deleteMany({
            workspaceId,
            trashedAt: { $ne: null },
            ...visible.folders,
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
      },
    ),

    /**
     * Supprime définitivement des documents (de la corbeille)
     */
    permanentlyDeleteDocuments: scopedDeleteMutationNoSub(
      async (_, { ids, workspaceId }, context) => {
        try {
          // Documents de la corbeille visibles par l'utilisateur seulement
          const { canAccessDocument } = await sharedFolderAccessFor(
            context,
            workspaceId,
          );
          const documents = (
            await SharedDocument.find({
              _id: { $in: ids },
              workspaceId,
              trashedAt: { $ne: null },
            })
          ).filter(canAccessDocument);

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

          // Supprimer de la base (ceux retrouvés ci-dessus seulement)
          await SharedDocument.deleteMany({
            _id: { $in: documents.map((doc) => doc._id) },
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
    permanentlyDeleteFolders: scopedDeleteMutationNoSub(
      async (_, { ids: requestedIds, workspaceId }, context) => {
        try {
          // Dossiers privés inaccessibles : comme introuvables
          const { canAccess } = await sharedFolderAccessFor(
            context,
            workspaceId,
          );
          // Suppression définitive réservée aux dossiers de la corbeille : un
          // dossier actif passe d'abord par la corbeille (deleteSharedFolder)
          const trashedFolders = await SharedFolder.find({
            _id: { $in: requestedIds.filter((id) => canAccess(id)) },
            workspaceId,
            trashedAt: { $ne: null },
          })
            .select("_id")
            .lean();
          const ids = trashedFolders.map((folder) => folder._id);

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

          // Supprimer les dossiers (ceux de la corbeille retrouvés ci-dessus)
          const result = await SharedFolder.deleteMany({
            _id: { $in: ids },
            workspaceId,
            trashedAt: { $ne: null },
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
    // Dossier de l'espace du document seulement
    folder: async (parent) => {
      if (!parent.folderId) return null;
      return await SharedFolder.findOne({
        _id: parent.folderId,
        workspaceId: parent.workspaceId,
      }).lean();
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
    parent: async (parent, _, context) => {
      if (!parent.parentId || !context?.user) return null;
      // Parent de l'espace du dossier seulement
      const folder = await SharedFolder.findOne({
        _id: parent.parentId,
        workspaceId: parent.workspaceId,
      }).lean();
      if (!folder) return null;
      // Parent privé inaccessible (sous-dossier public d'un dossier privé) :
      // ni son nom ni son existence
      const { canAccess } = await sharedFolderAccessFor(
        context,
        String(folder.workspaceId),
      );
      return canAccess(folder._id) ? folder : null;
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
    canManageVisibility: async (parent, _, context) => {
      if (!context.user) return false;
      const userId =
        context.user._id?.toString() || context.user.id?.toString();
      // Les dossiers système : seul un rôle qui gère les informations de
      // l'entreprise peut gérer la visibilité (même règle que
      // updateFolderVisibility).
      // 🔐 Le rôle est résolu en base (pas depuis le header x-user-role, qui est
      // client-contrôlé) — ce field resolver ne passe pas par RBAC.
      if (parent.isSystem) {
        if (!parent.workspaceId) return false;
        const wsId = parent.workspaceId.toString();
        // ⚡ Mémoïsation par requête : tous les dossiers d'une même liste
        // partagent (user, workspace), on évite ainsi un getMemberRole par dossier.
        const cacheKey = `${wsId}:${userId}`;
        context._sharedDocsManageCache ||= new Map();
        let canManage = context._sharedDocsManageCache.get(cacheKey);
        if (canManage === undefined) {
          const member = await getMemberRole(wsId, userId);
          canManage = false;
          if (member?.role) {
            const levels = await getEffectiveLevelsFor(wsId, member.role);
            canManage = hasPermissionLevel(
              member.role,
              "orgSettings",
              "write",
              levels,
            );
          }
          context._sharedDocsManageCache.set(cacheKey, canManage);
        }
        return canManage;
      }
      return parent.createdBy?.toString() === userId;
    },
  },

  Subscription: {
    // Émis dès qu'un document/dossier du workspace change (y compris via
    // automatisation côté serveur). Le canal encode le workspaceId, comme kanban.
    sharedDocumentsChanged: {
      subscribe: subscribeSharedDocuments(
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

// Le contrôle d'abonnement, la notification temps réel et l'exclusion du
// nettoyage corbeille sont désormais gérés par scopedMutation /
// scopedDeleteMutation / scopedDeleteMutationNoSub, APRÈS l'enrichissement
// RBAC (workspace validé).

export default sharedDocumentResolvers;
