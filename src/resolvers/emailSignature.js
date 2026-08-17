import EmailSignature from "../models/EmailSignature.js";
import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
// ✅ Import des wrappers RBAC
import {
  requireRead,
  requireWrite,
  requireDelete,
  requirePermission,
  requireActiveSubscription,
} from "../middlewares/rbac.js";
import {
  createNotFoundError,
  createAlreadyExistsError,
  createValidationError,
} from "../utils/errors.js";
import { deleteFile } from "../utils/fileUpload.js";
import cloudflareService from "../services/cloudflareService.js";
import { getPubSub } from "../config/redis.js";
import logger from "../utils/logger.js";

// Événement de subscription
const SIGNATURE_UPDATED = "SIGNATURE_UPDATED";

// Fonction utilitaire pour publier en toute sécurité
const safePublish = (channel, payload, context = "") => {
  try {
    const pubsub = getPubSub();
    pubsub.publish(channel, payload).catch((error) => {
      logger.error(`❌ [Signatures] Erreur publication ${context}:`, error);
    });
    logger.debug(`📢 [Signatures] ${context} publié sur ${channel}`);
  } catch (error) {
    logger.error(`❌ [Signatures] Erreur getPubSub ${context}:`, error);
  }
};

const emailSignatureResolvers = {
  Query: {
    // ✅ Protégé par RBAC - nécessite la permission "view" sur "signatures"
    getMyEmailSignatures: requireRead("signatures")(
      async (_, _args, context) => {
        const { user } = context;
        return EmailSignature.find({
          createdBy: user.id,
        }).sort({
          updatedAt: -1,
        });
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "view" sur "signatures"
    getEmailSignature: requireRead("signatures")(async (_, { id }, context) => {
      const { user } = context;
      const signature = await EmailSignature.findOne({
        _id: id,
        createdBy: user.id,
      });
      if (!signature) throw createNotFoundError("Signature email");
      return signature;
    }),

    // ✅ Protégé par RBAC - nécessite la permission "view" sur "signatures"
    getDefaultEmailSignature: requireRead("signatures")(
      async (_, _args, context) => {
        const { user } = context;
        const signature = await EmailSignature.findOne({
          createdBy: user.id,
          isDefault: true,
        });
        return signature;
      },
    ),
  },

  Mutation: {
    // ✅ Protégé par RBAC - nécessite la permission "create" sur "signatures"
    createEmailSignature: requireWrite("signatures")(
      async (_, { input }, context) => {
        const { user } = context;

        // Validation basique - seul le nom de signature est requis
        if (!input.signatureName || input.signatureName.trim() === "") {
          throw createValidationError("Le nom de la signature est requis");
        }

        // Vérifier si une signature avec ce nom existe déjà pour cet utilisateur
        const existingSignature = await EmailSignature.findOne({
          signatureName: input.signatureName,
          createdBy: user.id,
        });

        if (existingSignature) {
          throw createAlreadyExistsError(
            "signature email",
            "nom",
            input.signatureName,
          );
        }

        // Si c'est la première signature de l'utilisateur, la définir comme signature par défaut
        const signatureCount = await EmailSignature.countDocuments({
          createdBy: user.id,
        });
        const isFirstSignature = signatureCount === 0;

        // Préparer les données de la signature avec les valeurs par défaut
        const signatureData = {
          ...input,
          createdBy: user.id,
          isDefault:
            input.isDefault !== undefined ? input.isDefault : isFirstSignature,
        };

        const signature = new EmailSignature(signatureData);
        await signature.save();
        return signature;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "signatures"
    updateEmailSignature: requireWrite("signatures")(
      async (_, { input }, context) => {
        const { user } = context;
        const signature = await EmailSignature.findOne({
          _id: input.id,
          createdBy: user.id,
        });

        if (!signature) {
          throw createNotFoundError("Signature email");
        }

        // Validation basique - seul le nom de signature est requis
        if (!input.signatureName || input.signatureName.trim() === "") {
          throw createValidationError("Le nom de la signature est requis");
        }

        // Si le nom de la signature est modifié, vérifier qu'il n'existe pas déjà
        if (
          input.signatureName &&
          input.signatureName !== signature.signatureName
        ) {
          const existingSignature = await EmailSignature.findOne({
            signatureName: input.signatureName,
            createdBy: user.id,
            _id: { $ne: input.id },
          });

          if (existingSignature) {
            throw createAlreadyExistsError(
              "signature email",
              "nom",
              input.signatureName,
            );
          }
        }

        // Mettre à jour la signature avec les nouvelles données
        Object.keys(input).forEach((key) => {
          if (key !== "id" && input[key] !== undefined) {
            // Traitement spécial pour les objets imbriqués
            if (key === "colors" && input[key]) {
              signature.colors = { ...signature.colors, ...input[key] };
            } else if (key === "columnWidths" && input[key]) {
              signature.columnWidths = {
                ...signature.columnWidths,
                ...input[key],
              };
            } else if (key === "spacings" && input[key]) {
              signature.spacings = { ...signature.spacings, ...input[key] };
            } else if (key === "paddings" && input[key]) {
              signature.paddings = { ...signature.paddings, ...input[key] };
            } else if (key === "fontSize" && input[key]) {
              signature.fontSize = { ...signature.fontSize, ...input[key] };
            } else {
              signature[key] = input[key];
            }
          }
        });

        await signature.save();
        return signature;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "create" sur "signatures"
    // Duplication complète d'une signature : on clone TOUT le document Mongoose
    // côté serveur (tous les champs, y compris banner, containerStructure,
    // templateId, séparateurs, réseaux sociaux, etc.) plutôt que de dépendre
    // d'une requête frontend potentiellement incomplète.
    duplicateEmailSignature: requireWrite("signatures")(
      async (_, { id }, context) => {
        const { user } = context;

        // 1. Récupérer la signature source complète
        const source = await EmailSignature.findOne({
          _id: id,
          createdBy: user.id,
        });

        if (!source) {
          throw createNotFoundError("Signature email");
        }

        // 2. Cloner tous les champs du document
        const data = source.toObject();
        delete data._id;
        delete data.id;
        delete data.__v;
        delete data.createdAt;
        delete data.updatedAt;
        delete data.isDefault; // une copie n'est jamais la signature par défaut

        // 3. Générer un nom unique ("… - copie", "… - copie 2", …)
        const existingNames = (
          await EmailSignature.find({ createdBy: user.id }).select(
            "signatureName",
          )
        ).map((s) => s.signatureName);
        const takenNames = new Set(existingNames);
        const root = `${source.signatureName} - copie`;
        let newName = root;
        let suffix = 2;
        while (takenNames.has(newName)) {
          newName = `${root} ${suffix}`;
          suffix += 1;
        }

        // 4. Créer la nouvelle signature (sans les images dans un premier temps :
        //    on a besoin de son _id pour générer les nouvelles clés R2)
        const duplicate = new EmailSignature({
          ...data,
          signatureName: newName,
          isDefault: false,
          createdBy: user.id,
          workspaceId: source.workspaceId || user.id,
          // On repart de zéro sur les images, copiées juste après
          photo: undefined,
          photoKey: undefined,
          logo: undefined,
          logoKey: undefined,
          banner: undefined,
          bannerKey: undefined,
        });
        await duplicate.save();

        // 5. Copier les fichiers images vers de nouvelles clés indépendantes,
        //    pour que supprimer la signature source ne casse pas la copie.
        const imageFields = [
          { keyField: "photoKey", urlField: "photo" },
          { keyField: "logoKey", urlField: "logo" },
          { keyField: "bannerKey", urlField: "banner" },
        ];

        let imagesChanged = false;
        for (const { keyField, urlField } of imageFields) {
          const sourceKey = source[keyField];
          const sourceUrl = source[urlField];

          if (sourceKey) {
            try {
              const copied = await cloudflareService.copySignatureImage(
                sourceKey,
                user.id,
                duplicate._id.toString(),
              );
              duplicate[keyField] = copied.key;
              duplicate[urlField] = copied.url;
              imagesChanged = true;
            } catch (error) {
              // Best-effort : si la copie échoue, on réutilise l'image source
              // plutôt que de perdre l'image dans la duplication.
              logger.error(
                `❌ [Signatures] Échec copie image ${urlField} lors de la duplication:`,
                error,
              );
              duplicate[keyField] = sourceKey;
              duplicate[urlField] = sourceUrl;
              imagesChanged = true;
            }
          } else if (sourceUrl) {
            // Pas de clé R2 (URL externe par ex.) : on copie simplement l'URL
            duplicate[urlField] = sourceUrl;
            imagesChanged = true;
          }
        }

        if (imagesChanged) {
          await duplicate.save();
        }

        // Remarque : comme createEmailSignature, on ne publie pas d'événement
        // de subscription ici. La liste est rafraîchie côté client via
        // refetchQueries, ce qui évite un double toast sur le client initiateur.
        return duplicate;
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "delete" sur "signatures"
    deleteEmailSignature: requireDelete("signatures")(
      async (_, { id }, context) => {
        const { user } = context;
        try {
          // 1. Vérifier que la signature existe et appartient à l'utilisateur
          const signature = await EmailSignature.findOne({
            _id: id,
            createdBy: user.id,
          });

          if (!signature) {
            throw createNotFoundError("Signature email");
          }

          // 2. Gestion de la signature par défaut
          if (signature.isDefault) {
            const otherSignature = await EmailSignature.findOne({
              createdBy: user.id,
              _id: { $ne: id },
            }).sort({ updatedAt: -1 });

            if (otherSignature) {
              otherSignature.isDefault = true;
              await otherSignature.save();
            } else {
              logger.debug(
                "ℹ️ [BACKEND] Aucune autre signature trouvée pour définir comme par défaut",
              );
            }
          }

          // 3. Préparer la suppression des fichiers associés
          const filesToDelete = [];
          if (signature.photo) {
            filesToDelete.push(signature.photo);
          }

          if (signature.logo) {
            filesToDelete.push(signature.logo);
          }

          if (signature.banner) {
            filesToDelete.push(signature.banner);
          }

          // 4. Suppression des fichiers de manière séquentielle avec gestion d'erreur
          if (filesToDelete.length > 0) {
            for (const filePath of filesToDelete) {
              try {
                await deleteFile(filePath);
              } catch (error) {
                console.error(
                  `⚠️ [BACKEND] Échec de la suppression du fichier ${filePath}:`,
                  error.message,
                );
              }
            }
          } else {
            logger.debug("ℹ️ [BACKEND] Aucun fichier à supprimer");
          }

          const deleteResult = await EmailSignature.deleteOne({
            _id: id,
            createdBy: user.id,
          });

          if (deleteResult.deletedCount !== 1) {
            console.error(
              `❌ [BACKEND] Aucun document supprimé, deletedCount: ${deleteResult.deletedCount}`,
            );
            throw new Error("Aucune signature trouvée à supprimer");
          }

          // Publier l'événement de suppression
          safePublish(
            `${SIGNATURE_UPDATED}_${user.id}`,
            {
              type: "DELETED",
              signatureId: id,
              workspaceId: user.activeOrganizationId || user.id,
            },
            `Signature supprimée: ${id}`,
          );

          return true;
        } catch (error) {
          console.error("❌ [BACKEND] Erreur lors de la suppression:", error);

          if (error.extensions && error.extensions.code) {
            throw error;
          }

          const errorMessage =
            error.message ||
            "Une erreur est survenue lors de la suppression de la signature";
          console.error(`❌ [BACKEND] Erreur technique: ${errorMessage}`);
          throw new Error(errorMessage);
        }
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "delete" sur "signatures"
    deleteMultipleEmailSignatures: requireDelete("signatures")(
      async (_, { ids }, context) => {
        const { user } = context;
        try {
          logger.debug(
            `🗑️ [BACKEND] Suppression multiple de ${ids.length} signatures pour l'utilisateur ${user.id}`,
          );

          // 1. Vérifier que toutes les signatures existent et appartiennent à l'utilisateur
          const signatures = await EmailSignature.find({
            _id: { $in: ids },
            createdBy: user.id,
          });

          if (signatures.length !== ids.length) {
            throw createNotFoundError("Une ou plusieurs signatures");
          }

          // 2. Collecter tous les fichiers à supprimer
          const filesToDelete = [];
          signatures.forEach((signature) => {
            if (signature.photo) {
              filesToDelete.push(signature.photo);
            }
            if (signature.logo) {
              filesToDelete.push(signature.logo);
            }
            if (signature.banner) {
              filesToDelete.push(signature.banner);
            }
          });

          // 3. Supprimer les fichiers
          if (filesToDelete.length > 0) {
            for (const filePath of filesToDelete) {
              try {
                await deleteFile(filePath);
              } catch (error) {
                console.error(
                  `⚠️ [BACKEND] Échec de la suppression du fichier ${filePath}:`,
                  error.message,
                );
              }
            }
          }

          // 4. Supprimer les signatures de la base de données
          const deleteResult = await EmailSignature.deleteMany({
            _id: { $in: ids },
            createdBy: user.id,
          });

          logger.debug(
            `✅ [BACKEND] ${deleteResult.deletedCount} signatures supprimées`,
          );

          // 5. Publier les événements de suppression pour chaque signature
          ids.forEach((signatureId) => {
            safePublish(
              `${SIGNATURE_UPDATED}_${user.id}`,
              {
                type: "DELETED",
                signatureId,
                workspaceId: user.activeOrganizationId || user.id,
              },
              `Signature supprimée: ${signatureId}`,
            );
          });

          return deleteResult.deletedCount;
        } catch (error) {
          console.error(
            "❌ [BACKEND] Erreur lors de la suppression multiple:",
            error,
          );

          if (error.extensions && error.extensions.code) {
            throw error;
          }

          const errorMessage =
            error.message ||
            "Une erreur est survenue lors de la suppression des signatures";
          throw new Error(errorMessage);
        }
      },
    ),

    // ✅ Protégé par RBAC - nécessite la permission "set-default" sur "signatures"
    // Décision #13 (Lot 6) — modification de configuration utilisateur,
    // requiert un abonnement actif (ou trial app). Sans cette protection, un
    // user en lecture seule pouvait toujours changer sa signature par défaut.
    setDefaultEmailSignature: requirePermission(
      "signatures",
      "set-default",
    )(
      requireActiveSubscription(async (_, { id }, context) => {
        const { user } = context;
        const signature = await EmailSignature.findOne({
          _id: id,
          createdBy: user.id,
        });

        if (!signature) {
          throw createNotFoundError("Signature email");
        }

        // Définir cette signature comme signature par défaut
        signature.isDefault = true;
        await signature.save(); // Le middleware pre-save s'occupera de mettre à jour les autres signatures

        return signature;
      }),
    ),

    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "signatures"
    cleanupTemporaryFiles: requireWrite("signatures")(
      async (_, { userId, newSignatureId }, context) => {
        const { user } = context;
        try {
          logger.debug(
            "🗑️ Nettoyage des fichiers temporaires pour utilisateur:",
            userId,
          );
          logger.debug("🆔 Nouveau signatureId:", newSignatureId);

          // Vérifier que l'utilisateur peut nettoyer ses propres fichiers
          if (userId !== user.id) {
            throw createValidationError(
              "Vous ne pouvez nettoyer que vos propres fichiers",
            );
          }

          let deletedCount = 0;

          // Nettoyer les dossiers temporaires pour cet utilisateur
          const tempFolders = [`${userId}/temp-*`];

          for (const pattern of tempFolders) {
            try {
              // Lister tous les dossiers temporaires
              const tempFoldersList = await cloudflareService.listObjects(
                `${userId}/`,
                "temp-",
              );

              for (const folder of tempFoldersList) {
                // Supprimer chaque dossier temporaire trouvé
                const deleteResult =
                  await cloudflareService.deleteSignatureFolder(
                    userId,
                    folder.signatureId,
                    null,
                  );
                if (deleteResult.success) {
                  deletedCount += deleteResult.deletedCount || 1;
                  logger.debug(
                    `✅ Dossier temporaire supprimé: ${folder.signatureId}`,
                  );
                }
              }
            } catch (error) {
              console.warn(
                `⚠️ Erreur lors du nettoyage du pattern ${pattern}:`,
                error.message,
              );
            }
          }

          logger.debug(
            `✅ Nettoyage terminé. ${deletedCount} éléments supprimés.`,
          );

          return {
            success: true,
            deletedCount,
            message: `${deletedCount} fichiers temporaires supprimés avec succès`,
          };
        } catch (error) {
          console.error(
            "❌ Erreur lors du nettoyage des fichiers temporaires:",
            error,
          );
          return {
            success: false,
            deletedCount: 0,
            message: `Erreur lors du nettoyage: ${error.message}`,
          };
        }
      },
    ),
  },

  Subscription: {
    signatureUpdated: {
      subscribe: isAuthenticated((_, _args, { user }) => {
        try {
          const pubsub = getPubSub();
          // Chaque utilisateur s'abonne à ses propres mises à jour de signatures
          return pubsub.asyncIterableIterator([
            `${SIGNATURE_UPDATED}_${user.id}`,
          ]);
        } catch (error) {
          logger.error(
            "❌ [Signatures] Erreur subscription signatureUpdated:",
            error,
          );
          throw new Error("Subscription failed");
        }
      }),
      resolve: (payload) => {
        return payload;
      },
    },
  },
};

export default emailSignatureResolvers;
