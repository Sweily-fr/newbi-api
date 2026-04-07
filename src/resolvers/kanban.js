// resolvers/kanban.js
import { Board, Column, Task } from "../models/kanban.js";
import { AuthenticationError } from "apollo-server-express";
import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import { getPubSub, cacheGet, cacheSet, cacheDel } from "../config/redis.js";
import logger from "../utils/logger.js";
import mongoose from "mongoose";
import User from "../models/User.js";
import { ObjectId } from "mongodb";
import { sendTaskAssignmentEmail, sendMentionEmail } from "../utils/mailer.js";
import Notification from "../models/Notification.js";
import { publishNotification } from "./notification.js";
import Client from "../models/Client.js";

// Événements de subscription
const BOARD_UPDATED = "BOARD_UPDATED";
const TASK_UPDATED = "TASK_UPDATED";
const COLUMN_UPDATED = "COLUMN_UPDATED";

// Clé de cache Redis pour les tâches d'un board
const boardTasksCacheKey = (boardId, workspaceId) =>
  `kanban:tasks:${workspaceId}:${boardId}`;

// Invalider le cache des tâches d'un board
const invalidateBoardTasksCache = async (boardId, workspaceId) => {
  await cacheDel(boardTasksCacheKey(boardId, workspaceId));
};

// Fonction utilitaire pour publier en toute sécurité
// Invalide automatiquement le cache Redis des tâches quand un événement TASK_ ou COLUMN_ est publié
const safePublish = (channel, payload, context = "") => {
  try {
    const pubsub = getPubSub();
    pubsub.publish(channel, payload).catch((error) => {
      logger.error(`❌ [Kanban] Erreur publication ${context}:`, error);
    });
    logger.debug(`📢 [Kanban] ${context} publié sur ${channel}`);

    // Invalider le cache des tâches si c'est un événement lié aux tâches ou colonnes
    const taskPayload = payload?.taskUpdated;
    const columnPayload = payload?.columnUpdated;
    if (taskPayload?.boardId && taskPayload?.workspaceId) {
      invalidateBoardTasksCache(taskPayload.boardId, taskPayload.workspaceId);
    } else if (columnPayload?.boardId && columnPayload?.workspaceId) {
      invalidateBoardTasksCache(
        columnPayload.boardId,
        columnPayload.workspaceId,
      );
    }
  } catch (error) {
    logger.error(`❌ [Kanban] Erreur getPubSub ${context}:`, error);
  }
};

// Fonction utilitaire pour enrichir une tâche avec les infos utilisateur dynamiques
const enrichTaskWithUserInfo = async (task) => {
  if (!task) return null;

  const db = mongoose.connection.db;
  const taskObj = task.toObject ? task.toObject() : task;

  // Collecter tous les userIds des commentaires et activités
  const allUserIds = new Set();
  const externalEmails = new Set();

  (taskObj.comments || []).forEach((c) => {
    // Si le commentaire a un userEmail, c'est un commentaire externe (visiteur)
    if (c.userEmail) {
      externalEmails.add(c.userEmail.toLowerCase());
    } else if (c.userId && !c.userId.startsWith("external_")) {
      // Sinon, c'est un commentaire d'utilisateur connecté
      allUserIds.add(c.userId);
    } else if (c.userId?.startsWith("external_")) {
      // Commentaire externe sans userEmail - extraire l'email du userId
      const emailFromUserId = c.userId.replace("external_", "");
      if (emailFromUserId && emailFromUserId.includes("@")) {
        externalEmails.add(emailFromUserId.toLowerCase());
      }
    }
  });
  (taskObj.activity || []).forEach((a) => {
    if (a.userId) allUserIds.add(a.userId);
  });

  // Récupérer les infos des utilisateurs (supporter les IDs string Better Auth ET ObjectId)
  let usersMap = {};
  if (allUserIds.size > 0) {
    try {
      const userStringIds = Array.from(allUserIds);
      const userObjectIds = [];
      userStringIds.forEach((uid) => {
        try {
          userObjectIds.push(new mongoose.Types.ObjectId(uid));
        } catch {
          /* invalid ObjectId */
        }
      });
      const users = await db
        .collection("user")
        .find({ _id: { $in: [...userStringIds, ...userObjectIds] } })
        .toArray();
      logger.info(
        `🔍 [enrichTask] ${users.length} utilisateurs trouvés pour ${userStringIds.length} IDs demandés`,
      );
      users.forEach((u) => {
        // Construire le nom complet à partir de name (prénom) et lastName (nom de famille)
        let displayName = "";
        if (u.name && u.lastName) {
          displayName = `${u.name} ${u.lastName}`;
        } else if (u.name) {
          displayName = u.name;
        } else if (u.lastName) {
          displayName = u.lastName;
        } else {
          displayName = u.email?.split("@")[0] || "Utilisateur";
        }
        // Prioriser u.image (Better Auth) avant u.avatar (ancien système)
        const userImage = u.image || u.avatar || null;
        logger.info(
          `📋 [enrichTask] User ${u._id.toString()}: name=${displayName}, image=${userImage ? "oui" : "non"}, u.image=${u.image ? "oui" : "non"}, u.avatar=${u.avatar ? "oui" : "non"}`,
        );
        usersMap[u._id.toString()] = { name: displayName, image: userImage };
      });
    } catch (error) {
      logger.error(
        "❌ [enrichTaskWithUserInfo] Erreur récupération utilisateurs:",
        error,
      );
    }
  }

  // Collecter les visitorIds des commentaires
  const visitorIds = new Set();
  (taskObj.comments || []).forEach((c) => {
    if (c.visitorId) {
      visitorIds.add(c.visitorId);
    }
  });

  // Récupérer les infos des visiteurs externes depuis PublicBoardShare et UserInvited
  let visitorsMap = {};
  logger.info(
    `🔍 [enrichTask] externalEmails: ${externalEmails.size}, visitorIds: ${visitorIds.size}, boardId: ${taskObj.boardId}`,
  );
  if ((externalEmails.size > 0 || visitorIds.size > 0) && taskObj.boardId) {
    try {
      // 1. Récupérer depuis PublicBoardShare (ancien système)
      const PublicBoardShare = mongoose.model("PublicBoardShare");
      const share = await PublicBoardShare.findOne({
        boardId: taskObj.boardId,
        isActive: true,
      });
      logger.info(
        `🔍 [enrichTask] Share trouvé: ${!!share}, visiteurs: ${share?.visitors?.length || 0}`,
      );
      if (share?.visitors) {
        share.visitors.forEach((v) => {
          // Indexer par ID et par email pour supporter les deux méthodes
          const visitorData = {
            name:
              v.name ||
              v.firstName ||
              (v.email ? v.email.split("@")[0] : "Visiteur"),
            image: v.image || null,
          };
          if (v._id) {
            visitorsMap[v._id.toString()] = visitorData;
            logger.debug(
              `📋 [enrichTask] Visiteur indexé par ID: ${v._id.toString()} -> ${visitorData.name}, image: ${visitorData.image ? "oui" : "non"}`,
            );
          }
          if (v.email) {
            visitorsMap[v.email.toLowerCase()] = visitorData;
          }
        });
      }

      // 2. Récupérer depuis UserInvited (nouveau système) pour enrichir/remplacer les données
      if (externalEmails.size > 0) {
        try {
          const UserInvited = mongoose.model("UserInvited");
          const invitedUsers = await UserInvited.find({
            email: { $in: Array.from(externalEmails) },
          }).lean();

          logger.info(
            `🔍 [enrichTask] ${invitedUsers.length} utilisateurs invités trouvés pour ${externalEmails.size} emails`,
          );

          invitedUsers.forEach((u) => {
            // Construire le nom complet
            let displayName = "";
            if (u.firstName && u.lastName) {
              displayName = `${u.firstName} ${u.lastName}`;
            } else if (u.name) {
              displayName = u.name;
            } else if (u.firstName) {
              displayName = u.firstName;
            } else if (u.lastName) {
              displayName = u.lastName;
            } else {
              displayName = u.email.split("@")[0];
            }

            const visitorData = {
              name: displayName,
              image: u.image || null,
            };

            // Indexer par email (clé primaire dans UserInvited)
            visitorsMap[u.email.toLowerCase()] = visitorData;
            logger.info(
              `📋 [enrichTask] UserInvited indexé: ${u.email} -> ${displayName}, image: ${u.image ? "oui" : "non"}`,
            );
          });
        } catch (error) {
          logger.error(
            "❌ [enrichTask] Erreur récupération UserInvited:",
            error,
          );
        }
      }
    } catch (error) {
      logger.error(
        "❌ [enrichTaskWithUserInfo] Erreur récupération visiteurs:",
        error,
      );
    }
  }

  // Enrichir les commentaires
  const enrichedComments = (taskObj.comments || []).map((c) => {
    // Commentaires externes (visiteurs) - TOUJOURS utiliser les infos du visiteur depuis PublicBoardShare
    if (
      c.visitorId ||
      c.userId?.startsWith("external_") ||
      c.isExternal ||
      c.userEmail
    ) {
      // Chercher le visiteur par visitorId en priorité, sinon par email
      let visitorInfo = null;
      if (c.visitorId && visitorsMap[c.visitorId]) {
        visitorInfo = visitorsMap[c.visitorId];
      } else {
        // Fallback: chercher par email
        let visitorEmail = c.userEmail;
        if (!visitorEmail && c.userId?.startsWith("external_")) {
          visitorEmail = c.userId.replace("external_", "");
        }
        if (visitorEmail) {
          visitorInfo = visitorsMap[visitorEmail.toLowerCase()];
        }
      }

      // Prioriser les infos du visiteur depuis PublicBoardShare (toujours à jour)
      const enrichedComment = {
        ...c,
        id: c._id?.toString() || c.id,
        userName: visitorInfo?.name || c.userName || "Visiteur",
        userImage:
          visitorInfo?.image !== undefined
            ? visitorInfo.image
            : c.userImage || null,
      };

      return enrichedComment;
    }
    // Commentaires utilisateurs connectés
    const userInfo = usersMap[c.userId];
    return {
      ...c,
      id: c._id?.toString() || c.id,
      userName: userInfo?.name || "Utilisateur",
      userImage: userInfo?.image || null,
    };
  });

  // Enrichir l'activité (fallback sur les valeurs stockées si l'utilisateur n'est pas trouvé en DB)
  const enrichedActivity = (taskObj.activity || []).map((a) => {
    const userInfo = usersMap[a.userId];
    return {
      ...a,
      id: a._id?.toString() || a.id,
      userName: userInfo?.name || a.userName || "Utilisateur",
      userImage:
        userInfo?.image !== undefined ? userInfo.image : a.userImage || null,
    };
  });

  return {
    ...taskObj,
    id: taskObj._id?.toString() || taskObj.id,
    comments: enrichedComments,
    activity: enrichedActivity,
  };
};

// Fonction utilitaire pour enrichir plusieurs tâches
const enrichTasksWithUserInfo = async (tasks) => {
  if (!tasks || tasks.length === 0) return [];

  const db = mongoose.connection.db;

  // Collecter tous les userIds et emails externes
  const allUserIds = new Set();
  const externalEmails = new Set();
  const visitorIds = new Set();
  let boardId = null;

  tasks.forEach((task) => {
    if (!boardId && task.boardId) boardId = task.boardId;
    (task.comments || []).forEach((c) => {
      if (c.visitorId) visitorIds.add(c.visitorId);
      if (c.userEmail) {
        externalEmails.add(c.userEmail.toLowerCase());
      } else if (c.userId?.startsWith("external_")) {
        const email = c.userId.replace("external_", "");
        if (email.includes("@")) externalEmails.add(email.toLowerCase());
      } else if (c.userId) {
        allUserIds.add(c.userId);
      }
    });
    (task.activity || []).forEach((a) => {
      if (a.userId) allUserIds.add(a.userId);
    });
  });

  // Récupérer les infos des utilisateurs (supporter les IDs string Better Auth ET ObjectId)
  let usersMap = {};
  if (allUserIds.size > 0) {
    try {
      const userStringIds = Array.from(allUserIds);
      const userObjectIds = [];
      userStringIds.forEach((uid) => {
        try {
          userObjectIds.push(new mongoose.Types.ObjectId(uid));
        } catch {
          /* invalid ObjectId */
        }
      });
      const users = await db
        .collection("user")
        .find({ _id: { $in: [...userStringIds, ...userObjectIds] } })
        .toArray();
      users.forEach((u) => {
        // Construire le nom complet à partir de name (prénom) et lastName (nom de famille)
        let displayName = "";
        if (u.name && u.lastName) {
          displayName = `${u.name} ${u.lastName}`;
        } else if (u.name) {
          displayName = u.name;
        } else if (u.lastName) {
          displayName = u.lastName;
        } else {
          displayName = u.email?.split("@")[0] || "Utilisateur";
        }
        // Prioriser u.image (Better Auth) avant u.avatar (ancien système)
        usersMap[u._id.toString()] = {
          name: displayName,
          image: u.image || u.avatar || null,
        };
      });
    } catch (error) {
      logger.error(
        "❌ [enrichTasksWithUserInfo] Erreur récupération utilisateurs:",
        error,
      );
    }
  }

  // Récupérer les infos des visiteurs depuis PublicBoardShare et UserInvited
  let visitorsMap = {};
  if ((externalEmails.size > 0 || visitorIds.size > 0) && boardId) {
    try {
      // 1. Récupérer depuis PublicBoardShare (ancien système)
      const PublicBoardShare = mongoose.model("PublicBoardShare");
      const share = await PublicBoardShare.findOne({ boardId, isActive: true });
      if (share?.visitors) {
        share.visitors.forEach((v) => {
          const visitorData = {
            name:
              v.name ||
              v.firstName ||
              (v.email ? v.email.split("@")[0] : "Visiteur"),
            image: v.image || null,
          };
          if (v._id) visitorsMap[v._id.toString()] = visitorData;
          if (v.email) visitorsMap[v.email.toLowerCase()] = visitorData;
        });
      }

      // 2. Récupérer depuis UserInvited (nouveau système) pour enrichir/remplacer les données
      if (externalEmails.size > 0) {
        try {
          const UserInvited = mongoose.model("UserInvited");
          const invitedUsers = await UserInvited.find({
            email: { $in: Array.from(externalEmails) },
          }).lean();

          invitedUsers.forEach((u) => {
            // Construire le nom complet
            let displayName = "";
            if (u.firstName && u.lastName) {
              displayName = `${u.firstName} ${u.lastName}`;
            } else if (u.name) {
              displayName = u.name;
            } else if (u.firstName) {
              displayName = u.firstName;
            } else if (u.lastName) {
              displayName = u.lastName;
            } else {
              displayName = u.email.split("@")[0];
            }

            const visitorData = {
              name: displayName,
              image: u.image || null,
            };

            // Indexer par email (clé primaire dans UserInvited)
            visitorsMap[u.email.toLowerCase()] = visitorData;
          });
        } catch (error) {
          logger.error(
            "❌ [enrichTasksWithUserInfo] Erreur récupération UserInvited:",
            error,
          );
        }
      }
    } catch (error) {
      logger.error(
        "❌ [enrichTasksWithUserInfo] Erreur récupération visiteurs:",
        error,
      );
    }
  }

  // Enrichir chaque tâche
  return tasks.map((task) => {
    const taskObj = task.toObject ? task.toObject() : task;

    const enrichedComments = (taskObj.comments || []).map((c) => {
      // Commentaires externes (visiteurs)
      if (
        c.visitorId ||
        c.userId?.startsWith("external_") ||
        c.isExternal ||
        c.userEmail
      ) {
        let visitorInfo = null;
        if (c.visitorId && visitorsMap[c.visitorId]) {
          visitorInfo = visitorsMap[c.visitorId];
        } else {
          let email = c.userEmail;
          if (!email && c.userId?.startsWith("external_")) {
            email = c.userId.replace("external_", "");
          }
          if (email) visitorInfo = visitorsMap[email.toLowerCase()];
        }
        return {
          ...c,
          id: c._id?.toString() || c.id,
          userName: visitorInfo?.name || c.userName || "Visiteur",
          userImage:
            visitorInfo?.image !== undefined
              ? visitorInfo.image
              : c.userImage || null,
        };
      }
      // Commentaires utilisateurs connectés
      const userInfo = usersMap[c.userId];
      return {
        ...c,
        id: c._id?.toString() || c.id,
        userName: userInfo?.name || "Utilisateur",
        userImage: userInfo?.image || null,
      };
    });

    const enrichedActivity = (taskObj.activity || []).map((a) => {
      const userInfo = usersMap[a.userId];
      return {
        ...a,
        id: a._id?.toString() || a.id,
        userName: userInfo?.name || a.userName || "Utilisateur",
        userImage:
          userInfo?.image !== undefined ? userInfo.image : a.userImage || null,
      };
    });

    return {
      ...taskObj,
      id: taskObj._id?.toString() || taskObj.id,
      comments: enrichedComments,
      activity: enrichedActivity,
    };
  });
};

const resolvers = {
  Query: {
    boards: withWorkspace(
      async (_, { workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        return await Board.find({ workspaceId: finalWorkspaceId })
          .sort({ createdAt: -1 })
          .limit(100);
      },
    ),

    organizationMembers: withWorkspace(
      async (_, { workspaceId }, { workspaceId: contextWorkspaceId, db }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          logger.info("🔍 [Kanban] organizationMembers appelé");
          logger.info(`🔍 [Kanban] workspaceId (args): ${workspaceId}`);
          logger.info(`🔍 [Kanban] contextWorkspaceId: ${contextWorkspaceId}`);
          logger.info(`🔍 [Kanban] finalWorkspaceId: ${finalWorkspaceId}`);
          logger.info(`🔍 [Kanban] db disponible: ${!!db}`);

          // Convertir le workspaceId en ObjectId pour la recherche
          let orgId;
          try {
            orgId =
              typeof finalWorkspaceId === "string"
                ? new ObjectId(finalWorkspaceId)
                : finalWorkspaceId;
            logger.info(`✅ [Kanban] orgId converti: ${orgId}`);
          } catch (conversionError) {
            logger.error(
              `❌ [Kanban] Erreur conversion ObjectId: ${conversionError.message}`,
            );
            return [];
          }

          logger.info(
            `🔍 [Kanban] Recherche membres pour organisation: ${orgId}`,
          );

          // 1. Récupérer l'organisation
          const organization = await db
            .collection("organization")
            .findOne({ _id: orgId });

          logger.info(
            `🔍 [Kanban] Résultat findOne organisation: ${
              organization ? "trouvée" : "non trouvée"
            }`,
          );

          if (!organization) {
            logger.warn(`⚠️ [Kanban] Organisation non trouvée: ${orgId}`);
            // Essayer de lister toutes les organisations pour déboguer
            const allOrgs = await db
              .collection("organization")
              .find({})
              .limit(5)
              .toArray();
            logger.info(
              `📋 [Kanban] Organisations en base (premiers 5): ${allOrgs
                .map((o) => o._id)
                .join(", ")}`,
            );
            return [];
          }

          logger.info(`🏢 [Kanban] Organisation trouvée: ${organization.name}`);

          // 2. Récupérer TOUS les membres (y compris owner) via la collection member
          // Better Auth stocke TOUS les membres dans la collection member, même l'owner
          const members = await db
            .collection("member")
            .find({
              organizationId: orgId,
            })
            .toArray();

          logger.info(
            `📋 [Kanban] ${members.length} membres trouvés (incluant owner)`,
          );

          if (members.length === 0) {
            logger.warn(
              `⚠️ [Kanban] Aucun membre trouvé pour l'organisation ${orgId}`,
            );
            return [];
          }

          // 3. Récupérer les IDs utilisateurs
          const userIds = members.map((m) => {
            const userId = m.userId;
            return typeof userId === "string" ? new ObjectId(userId) : userId;
          });

          logger.info(
            `👥 [Kanban] Recherche de ${userIds.length} utilisateurs`,
          );

          // 4. Récupérer les informations des utilisateurs
          const users = await db
            .collection("user")
            .find({
              _id: { $in: userIds },
            })
            .toArray();

          logger.info(`✅ [Kanban] ${users.length} utilisateurs trouvés`);

          // 5. Créer le résultat en combinant membres et users
          const result = members
            .map((member) => {
              const memberUserId = member.userId?.toString();
              const user = users.find((u) => u._id.toString() === memberUserId);

              if (!user) {
                logger.warn(
                  `⚠️ [Kanban] Utilisateur non trouvé pour member: ${memberUserId}`,
                );
                return null;
              }

              // Nettoyer l'image : Better Auth stocke dans 'image' ou 'avatar'
              const cleanImage =
                (user.image || user.avatar) &&
                (user.image || user.avatar) !== "null" &&
                (user.image || user.avatar) !== ""
                  ? user.image || user.avatar
                  : null;

              // Construire le nom complet
              let displayName = "";
              if (user.name && user.lastName) {
                displayName = `${user.name} ${user.lastName}`;
              } else if (user.name) {
                displayName = user.name;
              } else if (user.lastName) {
                displayName = user.lastName;
              } else {
                displayName = user.email || "Utilisateur inconnu";
              }

              return {
                id: memberUserId,
                name: displayName,
                email: user.email || "",
                image: cleanImage,
                role: member.role || "member",
              };
            })
            .filter(Boolean); // Retirer les null

          logger.info(`✅ [Kanban] Retour de ${result.length} membres`);
          logger.info(
            "📋 [Kanban] Détails:",
            result.map((r) => ({
              email: r.email,
              role: r.role,
              hasImage: !!r.image,
              image: r.image,
            })),
          );

          return result;
        } catch (error) {
          logger.error("❌ [Kanban] Erreur récupération membres:", error);
          logger.error("Stack:", error.stack);
          return [];
        }
      },
    ),

    usersInfo: async (_, { userIds }, { db }) => {
      try {
        if (!userIds || userIds.length === 0) {
          return [];
        }

        // Convertir les userIds en ObjectId
        const objectIds = userIds
          .map((id) => {
            try {
              return new ObjectId(id);
            } catch (e) {
              logger.warn(`⚠️ [Kanban] ID utilisateur invalide: ${id}`);
              return null;
            }
          })
          .filter(Boolean);

        if (objectIds.length === 0) {
          return [];
        }

        // Récupérer les infos des utilisateurs
        const users = await db
          .collection("user")
          .find({
            _id: { $in: objectIds },
          })
          .toArray();

        logger.info(
          `✅ [Kanban] Récupéré ${users.length} utilisateurs sur ${userIds.length} demandés`,
        );

        // Mapper les résultats
        return users.map((user) => {
          // Utiliser image OU avatar (Better Auth stocke dans 'image', ancien système dans 'avatar')
          const avatarUrl =
            (user.image || user.avatar) &&
            (user.image || user.avatar) !== "null" &&
            (user.image || user.avatar) !== ""
              ? user.image || user.avatar
              : null;

          // Construire le nom complet à partir de name (prénom) et lastName (nom de famille)
          let displayName = "";
          if (user.name && user.lastName) {
            displayName = `${user.name} ${user.lastName}`;
          } else if (user.name) {
            displayName = user.name;
          } else if (user.lastName) {
            displayName = user.lastName;
          } else {
            displayName = user.email || "Utilisateur inconnu";
          }

          return {
            id: user._id.toString(),
            name: displayName,
            email: user.email || "",
            image: avatarUrl,
          };
        });
      } catch (error) {
        logger.error(
          "❌ [Kanban] Erreur récupération infos utilisateurs:",
          error,
        );
        return [];
      }
    },

    board: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const board = await Board.findOne({
          _id: id,
          workspaceId: finalWorkspaceId,
        });
        if (!board) throw new Error("Board not found");
        return board;
      },
    ),

    columns: withWorkspace(
      async (
        _,
        { boardId, workspaceId },
        { workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        return await Column.find({
          boardId,
          workspaceId: finalWorkspaceId,
        })
          .sort("order")
          .limit(100);
      },
    ),

    column: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        return await Column.findOne({ _id: id, workspaceId: finalWorkspaceId });
      },
    ),

    tasks: withWorkspace(
      async (
        _,
        { boardId, columnId, workspaceId },
        { workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const query = { boardId, workspaceId: finalWorkspaceId };
        if (columnId) query.columnId = columnId;
        const tasks = await Task.find(query).sort("position").limit(1000);
        return await enrichTasksWithUserInfo(tasks);
      },
    ),

    task: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const task = await Task.findOne({
          _id: id,
          workspaceId: finalWorkspaceId,
        });
        return await enrichTaskWithUserInfo(task);
      },
    ),

    activeTimers: withWorkspace(
      async (_, { workspaceId }, { user, workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const db = mongoose.connection.db;

        // Récupérer toutes les tâches avec un timer actif
        // Filtrer pour n'afficher que les tâches où l'utilisateur est membre assigné
        const tasks = await Task.find({
          workspaceId: finalWorkspaceId,
          "timeTracking.isRunning": true,
        })
          .sort({ updatedAt: -1 })
          .limit(100);

        // Filtrer les tâches où l'utilisateur connecté est membre assigné
        let filteredTasks = tasks;
        if (user?.id) {
          filteredTasks = tasks.filter((task) => {
            const assignedMembers = task.assignedMembers || [];
            // Vérifier si l'utilisateur est dans les membres assignés
            return assignedMembers.some((member) => {
              const memberId = member?.userId || member?._id || member;
              return memberId?.toString() === user.id.toString();
            });
          });
        }

        // Collecter tous les memberIds uniques de toutes les tâches filtrées
        const allMemberIds = new Set();
        filteredTasks.forEach((task) => {
          const taskObj = task.toObject ? task.toObject() : task;
          (taskObj.assignedMembers || []).forEach((memberId) => {
            const memberIdStr = memberId?.toString() || memberId;
            if (memberIdStr) allMemberIds.add(memberIdStr);
          });
        });

        // Batch fetch : une seule requête pour tous les utilisateurs
        let usersMap = {};
        if (allMemberIds.size > 0) {
          try {
            const objectIds = Array.from(allMemberIds)
              .map((id) => {
                try {
                  return new mongoose.Types.ObjectId(id);
                } catch {
                  return null;
                }
              })
              .filter(Boolean);
            const users = await db
              .collection("user")
              .find({ _id: { $in: objectIds } })
              .toArray();
            users.forEach((u) => {
              const uid = u._id.toString();
              let displayName = "";
              if (u.name && u.lastName) displayName = `${u.name} ${u.lastName}`;
              else if (u.name) displayName = u.name;
              else if (u.lastName) displayName = u.lastName;
              else displayName = u.email || "Utilisateur";
              usersMap[uid] = {
                name: displayName,
                email: u.email,
                image: u.image || u.avatar || null,
              };
            });
          } catch (error) {
            logger.error(
              "❌ [activeTimers] Erreur batch fetch utilisateurs:",
              error,
            );
          }
        }

        // Enrichir les tâches avec les infos pré-chargées (sans requêtes supplémentaires)
        const enrichedTasks = filteredTasks.map((task) => {
          const taskObj = task.toObject ? task.toObject() : task;
          const assignedMemberIds = taskObj.assignedMembers || [];

          const enrichedMembers = assignedMemberIds.map((memberId) => {
            const memberIdStr = memberId?.toString() || memberId;
            const userData = usersMap[memberIdStr];
            if (userData) {
              return {
                id: memberIdStr,
                userId: memberIdStr,
                name: userData.name,
                email: userData.email,
                image: userData.image,
              };
            }
            return {
              id: memberIdStr,
              userId: memberIdStr,
              name: memberIdStr,
              email: null,
              image: null,
            };
          });

          return {
            ...taskObj,
            assignedMembersInfo: enrichedMembers,
          };
        });

        return enrichedTasks;
      },
    ),
  },

  Mutation: {
    // Board mutations
    createBoard: withWorkspace(
      async (
        _,
        { input, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        const board = new Board({
          ...input,
          userId: user.id,
          workspaceId: finalWorkspaceId,
        });

        const savedBoard = await board.save();

        // Créer automatiquement les 4 colonnes par défaut
        const defaultColumns = [
          { title: "À faire", color: "#8E8E93", order: 0 },
          { title: "En cours", color: "#f59e0b", order: 1 },
          { title: "En attente", color: "#8b5cf6", order: 2 },
          { title: "Terminées", color: "#10b981", order: 3 },
        ];

        try {
          for (let i = 0; i < defaultColumns.length; i++) {
            const columnData = defaultColumns[i];

            const column = new Column({
              title: columnData.title,
              color: columnData.color,
              order: columnData.order,
              boardId: savedBoard.id,
              userId: user.id,
              workspaceId: finalWorkspaceId,
            });

            await column.save();
          }
        } catch (error) {
          // Ne pas faire échouer la création du tableau si les colonnes échouent
        }

        // Publier l'événement de création de board
        safePublish(
          `${BOARD_UPDATED}_${finalWorkspaceId}`,
          {
            type: "CREATED",
            board: savedBoard,
            workspaceId: finalWorkspaceId,
          },
          "Board créé",
        );

        return savedBoard;
      },
    ),

    updateBoard: withWorkspace(
      async (
        _,
        { input, workspaceId },
        { workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const { boardMembers, ...rest } = input;
        const updateData = { ...rest, updatedAt: new Date() };
        if (boardMembers !== undefined) updateData.members = boardMembers;
        const board = await Board.findOneAndUpdate(
          { _id: input.id, workspaceId: finalWorkspaceId },
          updateData,
          { new: true },
        );
        if (!board) throw new Error("Board not found");

        // Publier l'événement de mise à jour de board
        safePublish(
          `${BOARD_UPDATED}_${finalWorkspaceId}`,
          {
            type: "UPDATED",
            board: board,
            workspaceId: finalWorkspaceId,
          },
          "Board mis à jour",
        );

        return board;
      },
    ),

    deleteBoard: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          // Supprimer les tâches associées au tableau
          await Task.deleteMany({ boardId: id, workspaceId: finalWorkspaceId });

          // Supprimer les colonnes associées au tableau
          await Column.deleteMany({
            boardId: id,
            workspaceId: finalWorkspaceId,
          });

          // Supprimer le tableau
          const result = await Board.deleteOne({
            _id: id,
            workspaceId: finalWorkspaceId,
          });

          if (result.deletedCount > 0) {
            // Publier l'événement de suppression de board
            safePublish(
              `${BOARD_UPDATED}_${finalWorkspaceId}`,
              {
                type: "DELETED",
                boardId: id,
                workspaceId: finalWorkspaceId,
              },
              "Board supprimé",
            );
          }

          return result.deletedCount > 0;
        } catch (error) {
          console.error("Error deleting board:", error);
          throw new Error("Failed to delete board");
        }
      },
    ),

    toggleBoardFavorite: withWorkspace(
      async (
        _,
        { boardId, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const board = await Board.findOne({
          _id: boardId,
          workspaceId: finalWorkspaceId,
        });
        if (!board) throw new Error("Board not found");

        const favs = board.favoritedBy || [];
        const isFav = favs.includes(user.id);
        if (isFav) {
          board.favoritedBy = favs.filter((uid) => uid !== user.id);
        } else {
          board.favoritedBy = [...favs, user.id];
        }
        await board.save();
        return board;
      },
    ),

    // Column mutations
    createColumn: withWorkspace(
      async (
        _,
        { input, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        const column = new Column({
          ...input,
          userId: user.id,
          workspaceId: finalWorkspaceId,
        });

        const savedColumn = await column.save();

        // Publier l'événement de création de colonne
        safePublish(
          `${COLUMN_UPDATED}_${finalWorkspaceId}_${savedColumn.boardId}`,
          {
            type: "CREATED",
            column: savedColumn,
            boardId: savedColumn.boardId,
            workspaceId: finalWorkspaceId,
          },
          "Colonne créée",
        );

        return savedColumn;
      },
    ),

    updateColumn: withWorkspace(
      async (
        _,
        { input, workspaceId },
        { workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const { id, ...updates } = input;
        const column = await Column.findOneAndUpdate(
          { _id: id, workspaceId: finalWorkspaceId },
          { ...updates, updatedAt: new Date() },
          { new: true },
        );
        if (!column) throw new Error("Column not found");

        // Publier l'événement de mise à jour de colonne
        safePublish(
          `${COLUMN_UPDATED}_${finalWorkspaceId}_${column.boardId}`,
          {
            type: "UPDATED",
            column: column,
            boardId: column.boardId,
            workspaceId: finalWorkspaceId,
          },
          "Colonne mise à jour",
        );

        return column;
      },
    ),

    deleteColumn: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          // Récupérer la colonne avant suppression pour avoir le boardId
          const column = await Column.findOne({
            _id: id,
            workspaceId: finalWorkspaceId,
          });
          if (!column) throw new Error("Column not found");

          // Supprimer les tâches associées à la colonne
          await Task.deleteMany({
            columnId: id,
            workspaceId: finalWorkspaceId,
          });

          // Supprimer la colonne
          const result = await Column.deleteOne({
            _id: id,
            workspaceId: finalWorkspaceId,
          });

          if (result.deletedCount > 0) {
            // Publier l'événement de suppression de colonne
            safePublish(
              `${COLUMN_UPDATED}_${finalWorkspaceId}_${column.boardId}`,
              {
                type: "DELETED",
                columnId: id,
                boardId: column.boardId,
                workspaceId: finalWorkspaceId,
              },
              "Colonne supprimée",
            );
          }

          return result.deletedCount > 0;
        } catch (error) {
          console.error("Error deleting column:", error);
          throw new Error("Failed to delete column");
        }
      },
    ),

    reorderColumns: withWorkspace(
      async (
        _,
        { columns, workspaceId },
        { workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          // Récupérer une colonne pour avoir le boardId
          const firstColumn = await Column.findOne({
            _id: columns[0],
            workspaceId: finalWorkspaceId,
          });
          if (!firstColumn) throw new Error("Column not found");

          const updatePromises = columns.map((id, index) =>
            Column.updateOne(
              { _id: id, workspaceId: finalWorkspaceId },
              { $set: { order: index, updatedAt: new Date() } },
            ),
          );

          await Promise.all(updatePromises);

          // Publier l'événement de réorganisation des colonnes
          safePublish(
            `${COLUMN_UPDATED}_${finalWorkspaceId}_${firstColumn.boardId}`,
            {
              type: "REORDERED",
              columns: columns,
              boardId: firstColumn.boardId,
              workspaceId: finalWorkspaceId,
            },
            "Colonnes réorganisées",
          );

          return true;
        } catch (error) {
          console.error("Error reordering columns:", error);
          throw new Error("Failed to reorder columns");
        }
      },
    ),

    // Task mutations
    createTask: withWorkspace(
      async (
        _,
        { input, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        // Nettoyer les IDs temporaires de la checklist
        const cleanedInput = { ...input };
        if (cleanedInput.checklist) {
          cleanedInput.checklist = cleanedInput.checklist.map((item) => {
            const cleanedItem = { ...item };
            // Supprimer les IDs temporaires (qui commencent par 'temp-')
            if (cleanedItem.id && cleanedItem.id.startsWith("temp-")) {
              delete cleanedItem.id;
            }
            return cleanedItem;
          });
        }

        // Calculer la position correcte en fonction des tâches existantes dans la colonne
        // Par défaut, ajouter en haut (position 0)
        let position = input.position !== undefined ? input.position : 0;

        // Récupérer les infos utilisateur pour l'activité de création
        const db = mongoose.connection.db;
        let creatorData = null;
        try {
          creatorData = await db.collection("user").findOne({ _id: user.id });
          if (!creatorData && /^[0-9a-fA-F]{24}$/.test(user.id)) {
            creatorData = await db
              .collection("user")
              .findOne({ _id: new ObjectId(user.id) });
          }
        } catch (e) {
          logger.warn("Could not fetch creator data:", e.message);
        }
        const creatorImage = creatorData?.image || creatorData?.avatar || null;
        const creatorName =
          creatorData?.name || user?.name || user?.email || "Utilisateur";

        // Décaler les tâches existantes pour faire de la place à la nouvelle position
        await Task.updateMany(
          {
            boardId: input.boardId,
            columnId: input.columnId,
            workspaceId: finalWorkspaceId,
            position: { $gte: position },
          },
          { $inc: { position: 1 } },
        );

        const task = new Task({
          ...cleanedInput,
          status: cleanedInput.status || cleanedInput.columnId,
          userId: user.id,
          workspaceId: finalWorkspaceId,
          position: position,
          activity: [
            {
              userId: user.id,
              userName: creatorName,
              userImage: creatorImage,
              type: "created",
              description: "a créé la tâche",
              createdAt: new Date(),
            },
          ],
        });
        const savedTask = await task.save();

        // Enrichir la tâche avec les infos utilisateur AVANT de publier
        const enrichedTask = await enrichTaskWithUserInfo(savedTask);

        // Publier l'événement de création de tâche avec la tâche enrichie
        safePublish(
          `${TASK_UPDATED}_${finalWorkspaceId}_${enrichedTask.boardId}`,
          {
            type: "CREATED",
            task: enrichedTask,
            boardId: enrichedTask.boardId,
            workspaceId: finalWorkspaceId,
          },
          "Tâche créée",
        );

        // Envoyer des notifications aux membres assignés lors de la création
        if (
          cleanedInput.assignedMembers &&
          cleanedInput.assignedMembers.length > 0
        ) {
          logger.info(
            `📧 [CreateTask] Envoi notifications pour ${cleanedInput.assignedMembers.length} membres assignés`,
          );

          // Capturer les données du créateur (déjà récupérées plus haut) pour la closure
          const notifCreatorImage =
            creatorData?.image ||
            creatorData?.avatar ||
            creatorData?.profile?.profilePicture ||
            creatorData?.profile?.profilePictureUrl ||
            null;
          const notifAssignerName =
            creatorData?.name ||
            user?.name ||
            user?.email ||
            "Un membre de l'équipe";

          (async () => {
            try {
              const db = mongoose.connection.db;

              // Récupérer les infos du board et de la colonne
              const board = await Board.findById(savedTask.boardId);
              const column = await Column.findById(savedTask.columnId);
              const boardName = board?.title || "Tableau sans nom";
              const columnName = column?.title || "Colonne";

              logger.info(
                `📧 [CreateTask] Board: ${boardName}, Column: ${columnName}, Assigner: ${notifAssignerName}`,
              );

              // Batch fetch : récupérer tous les membres assignés en une seule requête
              const memberIdsToNotify = cleanedInput.assignedMembers.filter(
                (mid) => mid !== user.id,
              );
              const memberObjectIds = memberIdsToNotify
                .map((mid) => {
                  try {
                    return new mongoose.Types.ObjectId(mid);
                  } catch {
                    return null;
                  }
                })
                .filter(Boolean);
              const allMembersData =
                memberObjectIds.length > 0
                  ? await db
                      .collection("user")
                      .find({ _id: { $in: memberObjectIds } })
                      .toArray()
                  : [];
              const membersDataMap = {};
              allMembersData.forEach((m) => {
                membersDataMap[m._id.toString()] = m;
              });

              // Envoyer les emails et notifications pour chaque membre assigné
              for (const memberId of memberIdsToNotify) {
                try {
                  const memberData = membersDataMap[memberId];

                  if (memberData?.email) {
                    const taskUrl = `${process.env.FRONTEND_URL}/dashboard/outils/kanban/${savedTask.boardId}?task=${savedTask._id}`;
                    const memberPrefs =
                      memberData?.notificationPreferences?.kanban_task_assigned;

                    // Envoyer l'email d'assignation (si la préférence n'est pas désactivée)
                    if (memberPrefs?.email !== false) {
                      await sendTaskAssignmentEmail(memberData.email, {
                        taskTitle: savedTask.title || "Sans titre",
                        taskDescription: savedTask.description || "",
                        boardName: boardName,
                        columnName: columnName,
                        assignerName: notifAssignerName,
                        assignerImage: notifCreatorImage,
                        dueDate: savedTask.dueDate,
                        priority: savedTask.priority || "medium",
                        taskUrl: taskUrl,
                      });
                      logger.info(
                        `📧 [CreateTask] Email d'assignation envoyé à ${memberData.email} pour la tâche "${savedTask.title}"`,
                      );
                    } else {
                      logger.info(
                        `📧 [CreateTask] Email désactivé par préférences pour ${memberData.email}`,
                      );
                    }

                    // Créer une notification dans la boîte de réception (si la préférence n'est pas désactivée)
                    if (memberPrefs?.push !== false) {
                      try {
                        const notification =
                          await Notification.createTaskAssignedNotification({
                            userId: memberId,
                            workspaceId: finalWorkspaceId,
                            taskId: savedTask._id,
                            taskTitle: savedTask.title || "Sans titre",
                            boardId: savedTask.boardId,
                            boardName: boardName,
                            columnName: columnName,
                            actorId: user?.id || user?._id,
                            actorName: notifAssignerName,
                            actorImage: notifCreatorImage,
                            url: taskUrl,
                          });

                        // Publier la notification en temps réel
                        await publishNotification(notification);
                        logger.info(
                          `🔔 [CreateTask] Notification créée pour ${memberData.email}`,
                        );
                      } catch (notifError) {
                        logger.error(
                          "❌ [CreateTask] Erreur création notification:",
                          notifError,
                        );
                      }
                    } else {
                      logger.info(
                        `🔔 [CreateTask] Notification push désactivée par préférences pour ${memberData.email}`,
                      );
                    }
                  }
                } catch (emailError) {
                  logger.error(
                    `❌ [CreateTask] Erreur envoi email à membre ${memberId}:`,
                    emailError,
                  );
                }
              }
            } catch (error) {
              logger.error(
                "❌ [CreateTask] Erreur lors de l'envoi des notifications d'assignation:",
                error,
              );
            }
          })();
        }

        return enrichedTask;
      },
    ),

    updateTask: withWorkspace(
      async (
        _,
        { input, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const { id, ...updates } = input;

        logger.info("📝 [UpdateTask] dueDate reçue:", input.dueDate);
        logger.info("📝 [UpdateTask] dueDate type:", typeof input.dueDate);

        // Récupérer la tâche avant modification pour comparer
        const oldTask = await Task.findOne({
          _id: id,
          workspaceId: finalWorkspaceId,
        });
        if (!oldTask) throw new Error("Task not found");

        // Fusionner timeTracking avec les valeurs existantes pour ne pas écraser startedBy, isRunning, entries, etc.
        if (updates.timeTracking) {
          updates.timeTracking = {
            ...(oldTask.timeTracking?.toObject
              ? oldTask.timeTracking.toObject()
              : oldTask.timeTracking || {}),
            ...updates.timeTracking,
          };
        }

        // Nettoyer les IDs temporaires de la checklist
        if (updates.checklist) {
          updates.checklist = updates.checklist.map((item) => {
            const cleanedItem = { ...item };
            // Supprimer les IDs temporaires (qui commencent par 'temp-')
            if (cleanedItem.id && cleanedItem.id.startsWith("temp-")) {
              delete cleanedItem.id;
            }
            return cleanedItem;
          });
        }

        // Récupérer les données utilisateur pour l'activité
        const db = mongoose.connection.db;
        let userData = null;
        if (user) {
          try {
            userData = await db.collection("user").findOne({ _id: user.id });
            if (!userData && /^[0-9a-fA-F]{24}$/.test(user.id)) {
              userData = await db.collection("user").findOne({
                _id: new mongoose.Types.ObjectId(user.id),
              });
            }
          } catch (e) {
            logger.warn("Could not fetch user data for activity:", e.message);
          }
        }
        const userImage =
          userData?.image ||
          userData?.avatar ||
          userData?.profile?.profilePicture ||
          userData?.profile?.profilePictureUrl ||
          null;

        // Tracker les changements et créer une entrée d'activité groupée
        const changes = [];

        // Titre modifié
        if (updates.title !== undefined) {
          const oldTitle = (oldTask.title || "").trim();
          const newTitle = (updates.title || "").trim();
          if (oldTitle !== newTitle) {
            changes.push("le titre");
          }
        }

        // Description modifiée
        if (updates.description !== undefined) {
          const oldDesc = (oldTask.description || "").trim();
          const newDesc = (updates.description || "").trim();
          if (oldDesc !== newDesc) {
            changes.push("la description");
          }
        }

        // Priorité modifiée - activité dédiée (comme les déplacements)
        let priorityActivity = null;
        if (
          updates.priority !== undefined &&
          updates.priority !== oldTask.priority
        ) {
          priorityActivity = {
            userId: user?.id,
            userName: userData?.name || user?.name || user?.email,
            userImage: userImage,
            type: "priority_changed",
            oldValue: oldTask.priority || "",
            newValue: updates.priority || "",
            description: "a modifié la priorité",
            createdAt: new Date(),
          };
        }

        // Fonction utilitaire pour formater une date en français
        const formatDateFr = (dateStr) => {
          const d = new Date(dateStr);
          return d.toLocaleDateString("fr-FR", {
            day: "numeric",
            month: "long",
            year: "numeric",
          });
        };

        // Date de début modifiée
        if (updates.startDate !== undefined) {
          const oldDate = oldTask.startDate
            ? new Date(oldTask.startDate).toISOString()
            : null;
          const newDate = updates.startDate
            ? new Date(updates.startDate).toISOString()
            : null;
          if (oldDate !== newDate) {
            if (!updates.startDate) {
              changes.push("supprimé la date de début");
            } else {
              changes.push(
                `la date de début → ${formatDateFr(updates.startDate)}`,
              );
            }
          }
        }

        // Date d'échéance modifiée
        if (updates.dueDate !== undefined) {
          const oldDate = oldTask.dueDate
            ? new Date(oldTask.dueDate).toISOString()
            : null;
          const newDate = updates.dueDate
            ? new Date(updates.dueDate).toISOString()
            : null;
          if (oldDate !== newDate) {
            if (!updates.dueDate) {
              changes.push("supprimé la date d'échéance");
            } else {
              changes.push(
                `la date d'échéance → ${formatDateFr(updates.dueDate)}`,
              );
            }
          }
        }

        // Colonne modifiée
        if (
          updates.columnId !== undefined &&
          updates.columnId !== oldTask.columnId
        ) {
          changes.push("la colonne");
        }

        // Tags modifiés — traités séparément pour avoir un verbe dédié
        let tagActivity = null;
        if (updates.tags !== undefined) {
          const oldTags = oldTask.tags || [];
          const newTags = updates.tags || [];
          const getTagName = (tag) =>
            typeof tag === "string" ? tag : tag?.name || tag;
          const oldTagNames = oldTags.map(getTagName);
          const newTagNames = newTags.map(getTagName);

          // Récupérer les objets tag complets (avec couleurs) pour ajoutés/supprimés
          const addedTagObjects = newTags.filter(
            (tag) => !oldTagNames.includes(getTagName(tag)),
          );
          const removedTagObjects = oldTags.filter(
            (tag) => !newTagNames.includes(getTagName(tag)),
          );

          if (addedTagObjects.length > 0 || removedTagObjects.length > 0) {
            const addedNames = addedTagObjects.map(getTagName);
            const removedNames = removedTagObjects.map(getTagName);
            let tagDescription;
            if (addedNames.length > 0 && removedNames.length === 0) {
              tagDescription = `a ajouté ${addedNames.length > 1 ? "les tags" : "le tag"} : ${addedNames.join(", ")}`;
            } else if (removedNames.length > 0 && addedNames.length === 0) {
              tagDescription = `a supprimé ${removedNames.length > 1 ? "les tags" : "le tag"} : ${removedNames.join(", ")}`;
            } else {
              tagDescription = "a modifié les tags";
            }
            tagActivity = {
              userId: user?.id,
              userName: userData?.name || user?.name || user?.email,
              userImage: userImage,
              type: "updated",
              field: "tags",
              description: tagDescription,
              // Stocker les objets tag complets avec couleurs
              newValue:
                addedTagObjects.length > 0
                  ? addedTagObjects.map((t) => ({
                      name: t.name,
                      bg: t.bg,
                      text: t.text,
                      border: t.border,
                    }))
                  : null,
              oldValue:
                removedTagObjects.length > 0
                  ? removedTagObjects.map((t) => ({
                      name: t.name,
                      bg: t.bg,
                      text: t.text,
                      border: t.border,
                    }))
                  : null,
              createdAt: new Date(),
            };
          }
        }

        // Membres assignés modifiés
        logger.info(
          `📧 [UpdateTask] updates.assignedMembers reçu: ${JSON.stringify(updates.assignedMembers)}`,
        );
        if (updates.assignedMembers !== undefined) {
          // Normaliser les IDs en strings et trier
          const normalizeMembers = (members) => {
            return (members || [])
              .map((m) => {
                // Si c'est un objet avec userId (format frontend)
                if (m && m.userId) return m.userId.toString();
                // Si c'est un objet avec _id (format MongoDB)
                if (m && m._id) return m._id.toString();
                // Si c'est déjà une string
                if (typeof m === "string") return m;
                // Si c'est un ObjectId
                if (m && m.toString) return m.toString();
                return String(m);
              })
              .filter(Boolean) // Enlever les valeurs vides
              .sort();
          };

          const oldMembers = normalizeMembers(oldTask.assignedMembers);
          const newMembers = normalizeMembers(updates.assignedMembers);

          logger.info(
            `📧 [UpdateTask] oldMembers: ${JSON.stringify(oldMembers)}, newMembers: ${JSON.stringify(newMembers)}`,
          );

          // Comparer les tableaux triés
          const hasChanged =
            oldMembers.length !== newMembers.length ||
            oldMembers.some((m, i) => m !== newMembers[i]);

          logger.info(`📧 [UpdateTask] hasChanged: ${hasChanged}`);

          if (hasChanged) {
            const addedMembers = newMembers.filter(
              (m) => !oldMembers.includes(m),
            );
            logger.info(
              `📧 [UpdateTask] addedMembers: ${JSON.stringify(addedMembers)}`,
            );
            const removedMembers = oldMembers.filter(
              (m) => !newMembers.includes(m),
            );

            if (addedMembers.length > 0) {
              // Ne PAS ajouter aux changes[] car on a une activité dédiée "assigned"
              // (sinon le bloc generic "updated" plus bas écraserait notre activité)
              // Ajouter une activité spécifique pour l'assignation avec les IDs des membres
              updates.activity = [
                ...(oldTask.activity || []),
                {
                  userId: user?.id,
                  userName: userData?.name || user?.name || user?.email,
                  userImage: userImage,
                  type: "assigned",
                  description: `assigné ${addedMembers.length} membre${
                    addedMembers.length > 1 ? "s" : ""
                  }`,
                  newValue: addedMembers, // Stocker les IDs des membres ajoutés
                  createdAt: new Date(),
                },
              ];

              // Envoyer des emails de notification aux membres assignés
              logger.info(
                `📧 [UpdateTask] Début envoi emails pour ${addedMembers.length} membres assignés: ${addedMembers.join(", ")}`,
              );
              (async () => {
                try {
                  // Récupérer les infos du board et de la colonne
                  const board = await Board.findById(oldTask.boardId);
                  logger.info(
                    `📧 [UpdateTask] oldTask.boardId: ${oldTask.boardId}, Board trouvé: ${board ? "OUI" : "NON"}, Board name: ${board?.title}`,
                  );
                  logger.info(
                    `📧 [UpdateTask] oldTask.columnId: ${oldTask.columnId}`,
                  );
                  const column = await Column.findById(oldTask.columnId);
                  logger.info(
                    `📧 [UpdateTask] Column trouvée: ${column ? "OUI" : "NON"}, Column title: ${column?.title}`,
                  );
                  const assignerName =
                    userData?.name ||
                    user?.name ||
                    user?.email ||
                    "Un membre de l'équipe";
                  const boardName = board?.title || "Tableau sans nom";
                  const columnName = column?.title || "Colonne";
                  logger.info(
                    `📧 [UpdateTask] Board: ${boardName}, Column: ${columnName}, Assigner: ${assignerName}`,
                  );

                  // Batch fetch : récupérer tous les membres ajoutés en une seule requête
                  const addedMemberObjectIds = addedMembers
                    .map((mid) => {
                      try {
                        return new mongoose.Types.ObjectId(mid);
                      } catch {
                        return null;
                      }
                    })
                    .filter(Boolean);
                  const allAddedMembersData =
                    addedMemberObjectIds.length > 0
                      ? await db
                          .collection("user")
                          .find({ _id: { $in: addedMemberObjectIds } })
                          .toArray()
                      : [];
                  const addedMembersDataMap = {};
                  allAddedMembersData.forEach((m) => {
                    addedMembersDataMap[m._id.toString()] = m;
                  });

                  for (const memberId of addedMembers) {
                    try {
                      const memberData = addedMembersDataMap[memberId];

                      if (memberData?.email) {
                        const taskUrl = `${process.env.FRONTEND_URL}/dashboard/outils/kanban/${oldTask.boardId}?task=${id}`;
                        const memberPrefs =
                          memberData?.notificationPreferences
                            ?.kanban_task_assigned;

                        // Envoyer l'email d'assignation (si la préférence n'est pas désactivée)
                        if (memberPrefs?.email !== false) {
                          await sendTaskAssignmentEmail(memberData.email, {
                            taskTitle: oldTask.title || "Sans titre",
                            taskDescription: oldTask.description || "",
                            boardName: boardName,
                            columnName: columnName,
                            assignerName: assignerName,
                            assignerImage: userImage || userData?.image || null,
                            dueDate: oldTask.dueDate || updates.dueDate,
                            priority:
                              oldTask.priority || updates.priority || "medium",
                            taskUrl: taskUrl,
                          });
                          logger.info(
                            `📧 [UpdateTask] Email d'assignation envoyé à ${memberData.email} pour la tâche "${oldTask.title}"`,
                          );
                        } else {
                          logger.info(
                            `📧 [UpdateTask] Email désactivé par préférences pour ${memberData.email}`,
                          );
                        }

                        // Créer une notification dans la boîte de réception (si la préférence n'est pas désactivée)
                        if (memberPrefs?.push !== false) {
                          try {
                            const notification =
                              await Notification.createTaskAssignedNotification(
                                {
                                  userId: memberId,
                                  workspaceId: finalWorkspaceId,
                                  taskId: oldTask._id,
                                  taskTitle: oldTask.title || "Sans titre",
                                  boardId: oldTask.boardId,
                                  boardName: boardName,
                                  columnName: columnName,
                                  actorId: user?.id || user?._id,
                                  actorName: assignerName,
                                  actorImage:
                                    userImage || userData?.image || null,
                                  url: taskUrl,
                                },
                              );

                            // Publier la notification en temps réel
                            await publishNotification(notification);
                            logger.info(
                              `🔔 [UpdateTask] Notification créée pour ${memberData.email}`,
                            );
                          } catch (notifError) {
                            logger.error(
                              "❌ [UpdateTask] Erreur création notification:",
                              notifError,
                            );
                          }
                        } else {
                          logger.info(
                            `🔔 [UpdateTask] Notification push désactivée par préférences pour ${memberData.email}`,
                          );
                        }
                      }
                    } catch (emailError) {
                      logger.error(
                        `❌ [UpdateTask] Erreur envoi email à membre ${memberId}:`,
                        emailError,
                      );
                    }
                  }
                } catch (error) {
                  logger.error(
                    "❌ [UpdateTask] Erreur lors de l'envoi des emails d'assignation:",
                    error,
                  );
                }
              })();
            }
            if (removedMembers.length > 0) {
              // Ne PAS ajouter aux changes[] car on a une activité dédiée "unassigned"
              // (sinon le bloc generic "updated" plus bas écraserait notre activité)
              // Ajouter une activité spécifique pour la désassignation
              updates.activity = [
                ...(updates.activity || oldTask.activity || []),
                {
                  userId: user?.id,
                  userName: userData?.name || user?.name || user?.email,
                  userImage: userImage,
                  type: "unassigned",
                  description: `désassigné ${removedMembers.length} membre${
                    removedMembers.length > 1 ? "s" : ""
                  }`,
                  oldValue: removedMembers, // Stocker les IDs des membres retirés
                  createdAt: new Date(),
                },
              ];
            }
          }
        }

        // Checklist modifiée — activité dédiée (comme les tags)
        let checklistActivity = null;
        if (updates.checklist !== undefined) {
          const oldChecklist = oldTask.checklist || [];
          const newChecklist = updates.checklist || [];

          // Comparer par texte pour détecter ajouts/suppressions
          const oldTexts = oldChecklist.map((i) => i.text);
          const newTexts = newChecklist.map((i) => i.text);
          const addedItems = newChecklist.filter(
            (i) => !oldTexts.includes(i.text),
          );
          const removedItems = oldChecklist.filter(
            (i) => !newTexts.includes(i.text),
          );

          // Détecter les changements de statut (completed/uncompleted)
          const completedItems = [];
          const uncompletedItems = [];
          newChecklist.forEach((newItem) => {
            const oldItem = oldChecklist.find((o) => o.text === newItem.text);
            if (oldItem) {
              if (!oldItem.completed && newItem.completed) {
                completedItems.push(newItem.text);
              } else if (oldItem.completed && !newItem.completed) {
                uncompletedItems.push(newItem.text);
              }
            }
          });

          const hasChanges =
            addedItems.length > 0 ||
            removedItems.length > 0 ||
            completedItems.length > 0 ||
            uncompletedItems.length > 0;
          if (hasChanges) {
            let checklistDescription;
            const parts = [];
            if (addedItems.length > 0) {
              parts.push(
                `a ajouté ${addedItems.length > 1 ? "les éléments" : "l'élément"} : ${addedItems.map((i) => i.text).join(" ;; ")}`,
              );
            }
            if (removedItems.length > 0) {
              parts.push(
                `a supprimé ${removedItems.length > 1 ? "les éléments" : "l'élément"} : ${removedItems.map((i) => i.text).join(" ;; ")}`,
              );
            }
            if (completedItems.length > 0) {
              parts.push(
                `a coché ${completedItems.length > 1 ? "les éléments" : "l'élément"} : ${completedItems.join(" ;; ")}`,
              );
            }
            if (uncompletedItems.length > 0) {
              parts.push(
                `a décoché ${uncompletedItems.length > 1 ? "les éléments" : "l'élément"} : ${uncompletedItems.join(" ;; ")}`,
              );
            }
            checklistDescription = parts.join(" et ");

            checklistActivity = {
              userId: user?.id,
              userName: userData?.name || user?.name || user?.email,
              userImage: userImage,
              type: "updated",
              field: "checklist",
              description: checklistDescription,
              createdAt: new Date(),
            };
          }
        }

        // Créer les entrées d'activité
        const newActivities = [];

        // Activité groupée pour les changements non-tags
        if (changes.length > 0) {
          const description =
            changes.length === 1
              ? `a modifié ${changes[0]}`
              : `a modifié ${changes.slice(0, -1).join(", ")} et ${
                  changes[changes.length - 1]
                }`;

          newActivities.push({
            userId: user?.id,
            userName: userData?.name || user?.name || user?.email,
            userImage: userImage,
            type: "updated",
            description: description,
            createdAt: new Date(),
          });
        }

        // Activité dédiée pour les tags
        if (tagActivity) {
          newActivities.push(tagActivity);
        }

        // Activité dédiée pour la checklist
        if (checklistActivity) {
          newActivities.push(checklistActivity);
        }

        // Activité dédiée pour la priorité
        if (priorityActivity) {
          newActivities.push(priorityActivity);
        }

        if (newActivities.length > 0) {
          // Utiliser updates.activity comme base s'il existe déjà (ex: activités assigned/unassigned)
          // sinon fallback sur oldTask.activity
          updates.activity = [
            ...(updates.activity || oldTask.activity || []),
            ...newActivities,
          ];
        }

        const task = await Task.findOneAndUpdate(
          { _id: id, workspaceId: finalWorkspaceId },
          { ...updates, updatedAt: new Date() },
          { new: true, runValidators: true },
        );
        if (!task) throw new Error("Task not found");

        logger.info("📝 [UpdateTask] Task après sauvegarde:", {
          dueDate: task.dueDate,
          dueDateType: typeof task.dueDate,
          dueDateISO: task.dueDate ? task.dueDate.toISOString() : null,
        });

        // Enrichir la tâche avec les infos utilisateur AVANT de publier
        // Cela garantit que les photos des visiteurs et commentaires sont incluses
        const enrichedTask = await enrichTaskWithUserInfo(task);

        // Publier l'événement de mise à jour de tâche avec la tâche enrichie
        safePublish(
          `${TASK_UPDATED}_${finalWorkspaceId}_${enrichedTask.boardId}`,
          {
            type: "UPDATED",
            task: enrichedTask,
            boardId: enrichedTask.boardId,
            workspaceId: finalWorkspaceId,
          },
          "Tâche mise à jour",
        );

        return enrichedTask;
      },
    ),

    deleteTask: withWorkspace(
      async (_, { id, workspaceId }, { workspaceId: contextWorkspaceId }) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        // Récupérer la tâche avant suppression pour avoir le boardId
        const task = await Task.findOne({
          _id: id,
          workspaceId: finalWorkspaceId,
        });
        if (!task) throw new Error("Task not found");

        const result = await Task.deleteOne({
          _id: id,
          workspaceId: finalWorkspaceId,
        });

        if (result.deletedCount > 0) {
          // Enrichir la tâche avant suppression pour inclure les commentaires avec photos
          const enrichedTask = await enrichTaskWithUserInfo(task);

          // Publier l'événement de suppression de tâche
          safePublish(
            `${TASK_UPDATED}_${finalWorkspaceId}_${enrichedTask.boardId}`,
            {
              type: "DELETED",
              task: enrichedTask,
              taskId: id,
              boardId: enrichedTask.boardId,
              workspaceId: finalWorkspaceId,
            },
            "Tâche supprimée",
          );
        }

        return result.deletedCount > 0;
      },
    ),

    moveTask: withWorkspace(
      async (
        _,
        { id, columnId, position, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          // Get the task to move
          let task = await Task.findOne({
            _id: id,
            workspaceId: finalWorkspaceId,
          });
          if (!task) throw new Error("Task not found");

          const oldColumnId = task.columnId;

          // Nettoyer assignedMembers pour s'assurer qu'on ne stocke que les IDs
          let cleanedAssignedMembers = task.assignedMembers;
          if (cleanedAssignedMembers && Array.isArray(cleanedAssignedMembers)) {
            cleanedAssignedMembers = cleanedAssignedMembers
              .map((member) => {
                // Si c'est un objet avec userId, retourner juste l'ID
                if (typeof member === "object" && member.userId) {
                  return member.userId;
                }
                // Sinon, c'est déjà un ID (string)
                return member;
              })
              .filter(Boolean);
          }

          // IMPORTANT: Récupérer les tâches de la colonne AVANT de mettre à jour la tâche
          // Mais EXCLURE la tâche qu'on est en train de déplacer (elle peut être dans la colonne cible si c'est un réordonnancement)
          let allTasksBeforeUpdate = await Task.find({
            boardId: task.boardId,
            columnId: columnId,
            workspaceId: finalWorkspaceId,
            _id: { $ne: id }, // Exclure la tâche qu'on déplace
          }).sort("position");

          console.log(
            "📊 [moveTask] Tâches de la colonne cible AVANT update (sans la tâche déplacée):",
            {
              columnId: columnId,
              tasksCount: allTasksBeforeUpdate.length,
              taskIds: allTasksBeforeUpdate.map((t) => t._id.toString()),
              excludedTaskId: id,
            },
          );

          // Préparer les updates
          const updates = {
            columnId: columnId,
            status: columnId,
            position: position,
            assignedMembers: cleanedAssignedMembers,
            updatedAt: new Date(),
          };

          // Ajouter une entrée d'activité si la colonne change
          if (oldColumnId !== columnId && user) {
            updates.$push = {
              activity: {
                userId: user.id,
                type: "moved",
                field: "columnId",
                oldValue: oldColumnId,
                newValue: columnId,
                description: "a déplacé la tâche",
                createdAt: new Date(),
              },
            };
          }

          // Utiliser updateOne pour éviter les problèmes de validation
          await Task.updateOne(
            { _id: id, workspaceId: finalWorkspaceId },
            { $set: updates, ...(updates.$push && { $push: updates.$push }) },
          );

          // Récupérer la tâche mise à jour
          task = await Task.findOne({ _id: id, workspaceId: finalWorkspaceId });

          // Utiliser les tâches récupérées AVANT la mise à jour (déjà sans la tâche déplacée)
          let allTasks = allTasksBeforeUpdate;

          console.log("📊 [moveTask] Avant réorganisation:", {
            taskId: id,
            targetPosition: position,
            tasksInColumn: allTasks.length,
            taskIds: allTasks.map((t) => ({
              id: t._id.toString(),
              pos: t.position,
            })),
          });

          // Insérer la tâche à la position spécifiée
          // allTasks ne contient déjà pas la tâche déplacée, donc on peut insérer directement
          const reorderedTasks = [
            ...allTasks.slice(0, position),
            task,
            ...allTasks.slice(position),
          ];

          console.log("📊 [moveTask] Après réorganisation:", {
            taskId: id,
            newPosition: reorderedTasks.findIndex(
              (t) => t._id.toString() === id,
            ),
            reorderedTaskIds: reorderedTasks.map((t, idx) => ({
              id: t._id.toString(),
              idx,
            })),
          });

          // Update positions of all tasks in the DESTINATION column
          const updatePromises = [];

          for (let i = 0; i < reorderedTasks.length; i++) {
            updatePromises.push(
              Task.updateOne(
                { _id: reorderedTasks[i]._id },
                { $set: { position: i, updatedAt: new Date() } },
              ),
            );
          }

          // Si la tâche a changé de colonne, recalculer aussi les positions dans la SOURCE
          if (oldColumnId !== columnId) {
            console.log("📊 [moveTask] Recalcul positions colonne source:", {
              oldColumnId,
              newColumnId: columnId,
            });

            // Récupérer toutes les tâches restantes dans la colonne source
            const sourceColumnTasks = await Task.find({
              boardId: task.boardId,
              columnId: oldColumnId,
              workspaceId: finalWorkspaceId,
              _id: { $ne: id }, // Exclure la tâche qu'on vient de déplacer
            }).sort("position");

            // Recalculer les positions dans la source (0, 1, 2, ...)
            for (let i = 0; i < sourceColumnTasks.length; i++) {
              updatePromises.push(
                Task.updateOne(
                  { _id: sourceColumnTasks[i]._id },
                  { $set: { position: i, updatedAt: new Date() } },
                ),
              );
            }

            console.log("📊 [moveTask] Positions recalculées colonne source:", {
              tasksCount: sourceColumnTasks.length,
              taskIds: sourceColumnTasks.map((t) => t._id.toString()),
            });
          }

          await Promise.all(updatePromises);

          // Publier UN SEUL événement pour la tâche principale déplacée
          // Les autres tâches réorganisées ne nécessitent pas de publication
          const updatedTask = await Task.findOne({ _id: id });
          console.log(
            "📢 [moveTask] Publication événement pour la tâche principale:",
            {
              taskId: updatedTask._id.toString(),
              position: updatedTask.position,
              columnId: updatedTask.columnId,
            },
          );

          // Enrichir la tâche déplacée pour inclure les commentaires avec photos
          const enrichedTask = await enrichTaskWithUserInfo(updatedTask);

          safePublish(
            `${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`,
            {
              type: "MOVED",
              task: enrichedTask,
              boardId: task.boardId,
              workspaceId: finalWorkspaceId,
            },
            "Tâche déplacée",
          );

          return task;
        } catch (error) {
          console.error("Error moving task:", error);
          throw new Error("Failed to move task");
        }
      },
    ),

    // Ajouter un commentaire
    addComment: withWorkspace(
      async (
        _,
        { taskId, input, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          logger.info("💬 [Kanban] Adding comment:", {
            taskId,
            workspaceId: finalWorkspaceId,
            userId: user?.id,
          });

          if (!user) {
            throw new Error("User not authenticated");
          }

          const task = await Task.findOne({
            _id: taskId,
            workspaceId: finalWorkspaceId,
          });
          if (!task) {
            logger.error("❌ [Kanban] Task not found:", taskId);
            throw new Error("Task not found");
          }

          // Stocker seulement l'userId, les infos (nom, avatar) seront récupérées dynamiquement au frontend
          const mentionedUserIds = input.mentionedUserIds || [];
          const comment = {
            userId: user.id,
            content: input.content || "",
            mentions: mentionedUserIds,
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          logger.info("💬 [Kanban] Commentaire créé:", {
            userId: comment.userId,
            content: comment.content,
            mentions: mentionedUserIds,
          });

          task.comments.push(comment);

          // Ajouter une entrée dans l'activité
          task.activity.push({
            userId: user.id,
            type: "comment_added",
            description: "a ajouté un commentaire",
            createdAt: new Date(),
          });

          await task.save();

          // Enrichir la tâche avec les infos utilisateur
          const enrichedTask = await enrichTaskWithUserInfo(task);

          // Publier l'événement avec la tâche enrichie
          safePublish(
            `${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`,
            {
              type: "COMMENT_ADDED",
              task: enrichedTask,
              taskId: task._id,
              boardId: task.boardId,
              workspaceId: finalWorkspaceId,
            },
            "Commentaire ajouté",
          );

          // Envoyer les notifications de mention (en arrière-plan)
          if (mentionedUserIds.length > 0) {
            logger.info(
              `📧 [Mention] Début traitement mentions: ${mentionedUserIds.length} mention(s) détectée(s) pour la tâche "${task.title}" (taskId: ${taskId})`,
            );
            logger.info(
              `📧 [Mention] IDs mentionnés: ${JSON.stringify(mentionedUserIds)}, auteur: ${user.id}`,
            );
            (async () => {
              try {
                const db = mongoose.connection.db;
                if (!db) {
                  logger.error(
                    "❌ [Mention] mongoose.connection.db est null/undefined!",
                  );
                  return;
                }

                // Récupérer les infos de l'auteur du commentaire
                const authorData = await db.collection("user").findOne({
                  _id: new mongoose.Types.ObjectId(user.id),
                });
                logger.info(
                  `📧 [Mention] Auteur trouvé: ${authorData ? authorData.email : "NON TROUVÉ"}`,
                );
                const authorName =
                  authorData?.name ||
                  user?.name ||
                  user?.email ||
                  "Un membre de l'équipe";
                const authorImage =
                  authorData?.image ||
                  authorData?.avatar ||
                  authorData?.profile?.profilePicture ||
                  null;

                // Récupérer les infos du board
                const board = await Board.findById(task.boardId);
                const boardName = board?.title || "Tableau sans nom";

                // Extraire un extrait du commentaire (texte brut, sans HTML)
                const commentExcerpt = (input.content || "")
                  .replace(/<[^>]*>/g, "")
                  .substring(0, 150);

                // Batch-load tous les utilisateurs mentionnés en une seule query (au lieu de N queries)
                const mentionedIds = mentionedUserIds
                  .filter((id) => id !== user.id) // Exclure l'auteur
                  .map((id) => new mongoose.Types.ObjectId(id));
                const mentionedUsers =
                  mentionedIds.length > 0
                    ? await db
                        .collection("user")
                        .find({ _id: { $in: mentionedIds } })
                        .toArray()
                    : [];
                const mentionedUserMap = new Map(
                  mentionedUsers.map((u) => [u._id.toString(), u]),
                );

                for (const mentionedUserId of mentionedUserIds) {
                  // Ne pas notifier l'auteur du commentaire
                  if (mentionedUserId === user.id) {
                    logger.info(
                      `📧 [Mention] Skip notification pour l'auteur ${mentionedUserId}`,
                    );
                    continue;
                  }

                  try {
                    const memberData = mentionedUserMap.get(mentionedUserId);
                    logger.info(
                      `📧 [Mention] Utilisateur mentionné trouvé: ${memberData ? memberData.email : "NON TROUVÉ"}`,
                    );

                    if (memberData?.email) {
                      const taskUrl = `${process.env.FRONTEND_URL}/dashboard/outils/kanban/${task.boardId}?task=${task._id}`;
                      logger.info(`📧 [Mention] URL tâche: ${taskUrl}`);
                      const memberPrefs =
                        memberData?.notificationPreferences?.kanban_mention;
                      logger.info(
                        `📧 [Mention] Préférences kanban_mention: ${JSON.stringify(memberPrefs)} (email: ${memberPrefs?.email}, push: ${memberPrefs?.push})`,
                      );

                      // Envoyer l'email de mention (si la préférence n'est pas désactivée)
                      if (memberPrefs?.email !== false) {
                        logger.info(
                          `📧 [Mention] Envoi email à ${memberData.email}...`,
                        );
                        const emailResult = await sendMentionEmail(
                          memberData.email,
                          {
                            actorName: authorName,
                            taskTitle: task.title || "Sans titre",
                            boardName: boardName,
                            commentExcerpt: commentExcerpt,
                            taskUrl: taskUrl,
                          },
                        );
                        logger.info(
                          `📧 [Mention] Résultat envoi email à ${memberData.email}: ${emailResult ? "SUCCÈS" : "ÉCHEC"}`,
                        );
                      } else {
                        logger.info(
                          `📧 [Mention] Email désactivé par préférence pour ${memberData.email}`,
                        );
                      }

                      // Créer une notification in-app (si la préférence n'est pas désactivée)
                      if (memberPrefs?.push !== false) {
                        try {
                          logger.info(
                            `🔔 [Mention] Création notification in-app pour ${mentionedUserId} (workspace: ${finalWorkspaceId})...`,
                          );
                          const notification =
                            await Notification.createMentionNotification({
                              userId: mentionedUserId,
                              workspaceId: finalWorkspaceId,
                              taskId: task._id,
                              taskTitle: task.title || "Sans titre",
                              boardId: task.boardId,
                              boardName: boardName,
                              actorId: user.id,
                              actorName: authorName,
                              actorImage: authorImage,
                              commentExcerpt: commentExcerpt,
                              url: taskUrl,
                            });
                          logger.info(
                            `🔔 [Mention] Notification créée: ${notification?._id} (type: ${notification?.type})`,
                          );

                          // Publier la notification en temps réel
                          await publishNotification(notification);
                          logger.info(
                            `🔔 [Mention] Notification publiée en temps réel pour ${memberData.email}`,
                          );
                        } catch (notifError) {
                          logger.error(
                            "❌ [Mention] Erreur création notification:",
                            notifError,
                          );
                        }
                      } else {
                        logger.info(
                          `🔔 [Mention] Push désactivé par préférence pour ${memberData.email}`,
                        );
                      }
                    } else {
                      logger.warn(
                        `⚠️ [Mention] Utilisateur ${mentionedUserId} n'a pas d'email ou non trouvé en base`,
                      );
                    }
                  } catch (memberError) {
                    logger.error(
                      `❌ [Mention] Erreur traitement mention pour ${mentionedUserId}:`,
                      memberError,
                    );
                  }
                }
                logger.info(
                  `📧 [Mention] Fin du traitement des mentions pour la tâche "${task.title}"`,
                );
              } catch (error) {
                logger.error(
                  "❌ [Mention] Erreur lors de l'envoi des notifications de mention:",
                  error,
                );
              }
            })();
          } else {
            logger.info(
              `📧 [Mention] Aucune mention dans ce commentaire (mentionedUserIds: ${JSON.stringify(input.mentionedUserIds)})`,
            );
          }

          return enrichedTask;
        } catch (error) {
          logger.error("Error adding comment:", error);
          throw new Error("Failed to add comment");
        }
      },
    ),

    // Modifier un commentaire
    updateComment: withWorkspace(
      async (
        _,
        { taskId, commentId, content, mentionedUserIds, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          const task = await Task.findOne({
            _id: taskId,
            workspaceId: finalWorkspaceId,
          });
          if (!task) throw new Error("Task not found");

          const comment = task.comments.id(commentId);
          if (!comment) throw new Error("Comment not found");

          // Vérifier que l'utilisateur est le créateur du commentaire
          if (comment.userId !== user.id) {
            throw new Error("Not authorized to edit this comment");
          }

          // Détecter les nouvelles mentions (pas déjà présentes dans le commentaire)
          const previousMentions = comment.mentions || [];
          const newMentionedUserIds = (mentionedUserIds || []).filter(
            (id) => !previousMentions.includes(id),
          );

          comment.content = content;
          comment.mentions = mentionedUserIds || [];
          comment.updatedAt = new Date();
          await task.save();

          // Enrichir la tâche
          const enrichedTask = await enrichTaskWithUserInfo(task);

          // Publier l'événement
          safePublish(
            `${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`,
            {
              type: "COMMENT_UPDATED",
              task: enrichedTask,
              taskId: task._id,
              boardId: task.boardId,
              workspaceId: finalWorkspaceId,
            },
            "Commentaire modifié",
          );

          // Envoyer les notifications pour les nouvelles mentions uniquement
          if (newMentionedUserIds.length > 0) {
            logger.info(
              `📧 [Mention-Update] ${newMentionedUserIds.length} nouvelle(s) mention(s) dans commentaire modifié pour tâche "${task.title}"`,
            );
            (async () => {
              try {
                const db = mongoose.connection.db;
                if (!db) return;

                const authorData = await db.collection("user").findOne({
                  _id: new mongoose.Types.ObjectId(user.id),
                });
                const authorName =
                  authorData?.name ||
                  user?.name ||
                  user?.email ||
                  "Un membre de l'équipe";
                const authorImage =
                  authorData?.image ||
                  authorData?.avatar ||
                  authorData?.profile?.profilePicture ||
                  null;

                const board = await Board.findById(task.boardId);
                const boardName = board?.title || "Tableau sans nom";
                const commentExcerpt = (content || "")
                  .replace(/<[^>]*>/g, "")
                  .substring(0, 150);

                const mentionedIds = newMentionedUserIds
                  .filter((id) => id !== user.id)
                  .map((id) => new mongoose.Types.ObjectId(id));
                const mentionedUsers =
                  mentionedIds.length > 0
                    ? await db
                        .collection("user")
                        .find({ _id: { $in: mentionedIds } })
                        .toArray()
                    : [];
                const mentionedUserMap = new Map(
                  mentionedUsers.map((u) => [u._id.toString(), u]),
                );

                for (const mentionedUserId of newMentionedUserIds) {
                  if (mentionedUserId === user.id) continue;

                  try {
                    const memberData = mentionedUserMap.get(mentionedUserId);
                    if (memberData?.email) {
                      const taskUrl = `${process.env.FRONTEND_URL}/dashboard/outils/kanban/${task.boardId}?task=${task._id}`;
                      const memberPrefs =
                        memberData?.notificationPreferences?.kanban_mention;

                      if (memberPrefs?.email !== false) {
                        await sendMentionEmail(memberData.email, {
                          actorName: authorName,
                          taskTitle: task.title || "Sans titre",
                          boardName: boardName,
                          commentExcerpt: commentExcerpt,
                          taskUrl: taskUrl,
                        });
                      }

                      if (memberPrefs?.push !== false) {
                        try {
                          const notification =
                            await Notification.createMentionNotification({
                              userId: mentionedUserId,
                              workspaceId: finalWorkspaceId,
                              taskId: task._id,
                              taskTitle: task.title || "Sans titre",
                              boardId: task.boardId,
                              boardName: boardName,
                              actorId: user.id,
                              actorName: authorName,
                              actorImage: authorImage,
                              commentExcerpt: commentExcerpt,
                              url: taskUrl,
                            });
                          await publishNotification(notification);
                        } catch (notifError) {
                          logger.error(
                            "❌ [Mention-Update] Erreur notification:",
                            notifError,
                          );
                        }
                      }
                    }
                  } catch (memberError) {
                    logger.error(
                      `❌ [Mention-Update] Erreur pour ${mentionedUserId}:`,
                      memberError,
                    );
                  }
                }
              } catch (error) {
                logger.error(
                  "❌ [Mention-Update] Erreur notifications:",
                  error,
                );
              }
            })();
          }

          return enrichedTask;
        } catch (error) {
          logger.error("Error updating comment:", error);
          throw new Error("Failed to update comment");
        }
      },
    ),

    // Supprimer un commentaire
    deleteComment: withWorkspace(
      async (
        _,
        { taskId, commentId, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          const task = await Task.findOne({
            _id: taskId,
            workspaceId: finalWorkspaceId,
          });
          if (!task) throw new Error("Task not found");

          const comment = task.comments.id(commentId);
          if (!comment) throw new Error("Comment not found");

          // Vérifier que l'utilisateur est le créateur du commentaire
          if (comment.userId !== user.id) {
            throw new Error("Not authorized to delete this comment");
          }

          // Supprimer le commentaire du tableau
          task.comments.pull(commentId);
          await task.save();

          // Enrichir la tâche
          const enrichedTask = await enrichTaskWithUserInfo(task);

          // Publier l'événement
          safePublish(
            `${TASK_UPDATED}_${finalWorkspaceId}_${enrichedTask.boardId}`,
            {
              type: "COMMENT_DELETED",
              task: task,
              taskId: task._id,
              boardId: task.boardId,
              workspaceId: finalWorkspaceId,
            },
            "Commentaire supprimé",
          );

          return enrichedTask;
        } catch (error) {
          logger.error("Error deleting comment:", error);
          throw new Error("Failed to delete comment");
        }
      },
    ),

    // Démarrer le timer
    startTimer: withWorkspace(
      async (
        _,
        { taskId, workspaceId },
        { user, workspaceId: contextWorkspaceId, db },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          const task = await Task.findOne({
            _id: taskId,
            workspaceId: finalWorkspaceId,
          });
          if (!task) throw new Error("Task not found");

          // Vérifier si un timer est déjà en cours
          if (task.timeTracking?.isRunning) {
            throw new Error("Timer is already running");
          }

          // Initialiser timeTracking si nécessaire
          if (!task.timeTracking) {
            task.timeTracking = {
              totalSeconds: 0,
              isRunning: false,
              entries: [],
            };
          }

          // Récupérer les infos complètes de l'utilisateur depuis la base de données
          let userFromDb;
          try {
            userFromDb = await db.collection("user").findOne({
              _id: user.id,
            });
            // Fallback avec ObjectId si l'ID est un hex valide
            if (!userFromDb && /^[0-9a-fA-F]{24}$/.test(user.id)) {
              userFromDb = await db.collection("user").findOne({
                _id: new ObjectId(user.id),
              });
            }
          } catch (e) {
            logger.warn("Could not fetch user from db for timer:", e.message);
          }

          const avatarUrl =
            userFromDb?.image &&
            userFromDb.image !== "null" &&
            userFromDb.image !== ""
              ? userFromDb.image
              : userFromDb?.avatar &&
                  userFromDb.avatar !== "null" &&
                  userFromDb.avatar !== ""
                ? userFromDb.avatar
                : null;

          const userName = userFromDb?.name || user.email;
          const userImage = avatarUrl;

          // Démarrer le timer avec les infos de l'utilisateur
          task.timeTracking.isRunning = true;
          task.timeTracking.currentStartTime = new Date();
          task.timeTracking.startedBy = {
            userId: user.id,
            userName,
            userImage,
          };

          // Ajouter l'activité du timer
          if (!task.activity) task.activity = [];
          task.activity.push({
            userId: user.id,
            userName,
            userImage,
            type: "timer_started",
            description: "a démarré le timer",
            createdAt: new Date(),
          });

          await task.save();

          // Publier l'événement
          safePublish(
            `${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`,
            {
              type: "TIMER_STARTED",
              task: task,
              taskId: task._id,
              boardId: task.boardId,
              workspaceId: finalWorkspaceId,
            },
            "Timer démarré",
          );

          return task;
        } catch (error) {
          logger.error("Error starting timer:", error);
          throw new Error(error.message || "Failed to start timer");
        }
      },
    ),

    // Arrêter le timer
    stopTimer: withWorkspace(
      async (
        _,
        { taskId, workspaceId },
        { user, workspaceId: contextWorkspaceId, db },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          const task = await Task.findOne({
            _id: taskId,
            workspaceId: finalWorkspaceId,
          });
          if (!task) throw new Error("Task not found");

          // Vérifier si un timer est en cours
          if (!task.timeTracking?.isRunning) {
            throw new Error("No timer is running");
          }

          const now = new Date();
          const startTime = task.timeTracking.currentStartTime;
          const duration = Math.floor((now - startTime) / 1000); // en secondes

          // Créer une nouvelle entrée de temps
          const newEntry = {
            startTime: startTime,
            endTime: now,
            duration: duration,
          };

          // Récupérer les infos de l'utilisateur
          let userFromDb;
          try {
            userFromDb = await db.collection("user").findOne({ _id: user.id });
            if (!userFromDb && /^[0-9a-fA-F]{24}$/.test(user.id)) {
              userFromDb = await db
                .collection("user")
                .findOne({ _id: new ObjectId(user.id) });
            }
          } catch (e) {
            logger.warn(
              "Could not fetch user from db for timer stop:",
              e.message,
            );
          }

          const userName = userFromDb?.name || user.email;
          const userImage =
            userFromDb?.image &&
            userFromDb.image !== "null" &&
            userFromDb.image !== ""
              ? userFromDb.image
              : userFromDb?.avatar &&
                  userFromDb.avatar !== "null" &&
                  userFromDb.avatar !== ""
                ? userFromDb.avatar
                : null;

          // Formater la durée pour l'activité
          const hours = Math.floor(duration / 3600);
          const minutes = Math.floor((duration % 3600) / 60);
          const seconds = duration % 60;
          const durationStr =
            hours > 0
              ? `${hours}h ${minutes}m ${seconds}s`
              : minutes > 0
                ? `${minutes}m ${seconds}s`
                : `${seconds}s`;

          // Mettre à jour le timeTracking
          task.timeTracking.isRunning = false;
          task.timeTracking.currentStartTime = null;
          task.timeTracking.startedBy = null;
          task.timeTracking.totalSeconds += duration;
          task.timeTracking.entries.push(newEntry);

          // Ajouter l'activité du timer
          if (!task.activity) task.activity = [];
          task.activity.push({
            userId: user.id,
            userName,
            userImage,
            type: "timer_stopped",
            description: `a arrêté le timer (${durationStr})`,
            createdAt: new Date(),
          });

          await task.save();

          // Publier l'événement
          safePublish(
            `${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`,
            {
              type: "TIMER_STOPPED",
              task: task,
              taskId: task._id,
              boardId: task.boardId,
              workspaceId: finalWorkspaceId,
            },
            "Timer arrêté",
          );

          return task;
        } catch (error) {
          logger.error("Error stopping timer:", error);
          throw new Error(error.message || "Failed to stop timer");
        }
      },
    ),

    // Réinitialiser le timer
    resetTimer: withWorkspace(
      async (
        _,
        { taskId, workspaceId },
        { user, workspaceId: contextWorkspaceId, db },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          const task = await Task.findOne({
            _id: taskId,
            workspaceId: finalWorkspaceId,
          });
          if (!task) throw new Error("Task not found");

          // Récupérer les infos de l'utilisateur
          let userFromDb;
          try {
            userFromDb = await db.collection("user").findOne({ _id: user.id });
            if (!userFromDb && /^[0-9a-fA-F]{24}$/.test(user.id)) {
              userFromDb = await db
                .collection("user")
                .findOne({ _id: new ObjectId(user.id) });
            }
          } catch (e) {
            logger.warn(
              "Could not fetch user from db for timer reset:",
              e.message,
            );
          }

          const userName = userFromDb?.name || user.email;
          const userImage =
            userFromDb?.image &&
            userFromDb.image !== "null" &&
            userFromDb.image !== ""
              ? userFromDb.image
              : userFromDb?.avatar &&
                  userFromDb.avatar !== "null" &&
                  userFromDb.avatar !== ""
                ? userFromDb.avatar
                : null;

          // Arrêter le timer s'il est en cours
          if (task.timeTracking?.isRunning) {
            task.timeTracking.isRunning = false;
            task.timeTracking.currentStartTime = null;
            task.timeTracking.startedBy = null;
          }

          // Réinitialiser le temps et les entrées
          task.timeTracking.totalSeconds = 0;
          task.timeTracking.entries = [];

          // Ajouter l'activité du timer
          if (!task.activity) task.activity = [];
          task.activity.push({
            userId: user.id,
            userName,
            userImage,
            type: "timer_reset",
            description: "a réinitialisé le timer",
            createdAt: new Date(),
          });

          await task.save();

          // Publier l'événement
          safePublish(
            `${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`,
            {
              type: "TIMER_RESET",
              task: task,
              taskId: task._id,
              boardId: task.boardId,
              workspaceId: finalWorkspaceId,
            },
            "Timer réinitialisé",
          );

          return task;
        } catch (error) {
          logger.error("Error resetting timer:", error);
          throw new Error(error.message || "Failed to reset timer");
        }
      },
    ),

    // Mettre à jour les paramètres du timer
    updateTimerSettings: withWorkspace(
      async (
        _,
        { taskId, hourlyRate, roundingOption, workspaceId },
        { user, workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          const task = await Task.findOne({
            _id: taskId,
            workspaceId: finalWorkspaceId,
          });
          if (!task) throw new Error("Task not found");

          // Initialiser timeTracking si nécessaire
          if (!task.timeTracking) {
            task.timeTracking = {
              totalSeconds: 0,
              isRunning: false,
              entries: [],
            };
          }

          // Mettre à jour les paramètres
          if (hourlyRate !== undefined) {
            task.timeTracking.hourlyRate = hourlyRate;
          }
          if (roundingOption !== undefined) {
            task.timeTracking.roundingOption = roundingOption;
          }

          await task.save();

          // Publier l'événement
          safePublish(
            `${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`,
            {
              type: "TIMER_SETTINGS_UPDATED",
              task: task,
              taskId: task._id,
              boardId: task.boardId,
              workspaceId: finalWorkspaceId,
            },
            "Paramètres du timer mis à jour",
          );

          return task;
        } catch (error) {
          logger.error("Error updating timer settings:", error);
          throw new Error(error.message || "Failed to update timer settings");
        }
      },
    ),

    // Ajouter du temps manuellement
    addManualTime: withWorkspace(
      async (
        _,
        { taskId, seconds, description, workspaceId },
        { user, workspaceId: contextWorkspaceId, db },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        try {
          if (!seconds || seconds <= 0) {
            throw new Error("Le temps ajouté doit être supérieur à 0");
          }

          const task = await Task.findOne({
            _id: taskId,
            workspaceId: finalWorkspaceId,
          });
          if (!task) throw new Error("Task not found");

          // Initialiser timeTracking si nécessaire
          if (!task.timeTracking) {
            task.timeTracking = {
              totalSeconds: 0,
              isRunning: false,
              entries: [],
            };
          }

          // Récupérer les infos de l'utilisateur
          let userFromDb;
          try {
            userFromDb = await db.collection("user").findOne({ _id: user.id });
            if (!userFromDb && /^[0-9a-fA-F]{24}$/.test(user.id)) {
              userFromDb = await db
                .collection("user")
                .findOne({ _id: new ObjectId(user.id) });
            }
          } catch (e) {
            logger.warn(
              "Could not fetch user from db for manual time:",
              e.message,
            );
          }

          const userName = userFromDb?.name || user.email;
          const userImage =
            userFromDb?.image &&
            userFromDb.image !== "null" &&
            userFromDb.image !== ""
              ? userFromDb.image
              : userFromDb?.avatar &&
                  userFromDb.avatar !== "null" &&
                  userFromDb.avatar !== ""
                ? userFromDb.avatar
                : null;

          // Créer une entrée de temps manuelle
          const now = new Date();
          const manualEntry = {
            startTime: now,
            endTime: now,
            duration: seconds,
            isManual: true,
          };

          // Mettre à jour le timeTracking
          task.timeTracking.totalSeconds += seconds;
          task.timeTracking.entries.push(manualEntry);

          // Formater la durée pour l'activité
          const hours = Math.floor(seconds / 3600);
          const minutes = Math.floor((seconds % 3600) / 60);
          const durationStr =
            hours > 0
              ? `${hours}h ${minutes > 0 ? minutes + "m" : ""}`
              : `${minutes}m`;

          // Ajouter l'activité
          if (!task.activity) task.activity = [];
          task.activity.push({
            userId: user.id,
            userName,
            userImage,
            type: "manual_time_added",
            description: description || `a ajouté ${durationStr} manuellement`,
            createdAt: now,
          });

          await task.save();

          // Publier l'événement
          safePublish(
            `${TASK_UPDATED}_${finalWorkspaceId}_${task.boardId}`,
            {
              type: "MANUAL_TIME_ADDED",
              task: task,
              taskId: task._id,
              boardId: task.boardId,
              workspaceId: finalWorkspaceId,
            },
            "Temps manuel ajouté",
          );

          return task;
        } catch (error) {
          logger.error("Error adding manual time:", error);
          throw new Error(error.message || "Failed to add manual time");
        }
      },
    ),
  },

  Board: {
    isFavorite: (board, _, { user }) => {
      if (!user) return false;
      return (board.favoritedBy || []).includes(user.id);
    },
    columns: async (board, _, { user }) => {
      if (!user) throw new AuthenticationError("Not authenticated");
      return await Column.find({
        boardId: board.id,
        workspaceId: board.workspaceId,
      })
        .sort({ order: 1 })
        .limit(100);
    },
    tasks: async (parent, _, { user }) => {
      if (!user) return [];

      const cacheKey = boardTasksCacheKey(parent.id, parent.workspaceId);

      // Essayer le cache Redis d'abord
      const cached = await cacheGet(cacheKey);
      if (cached) {
        logger.debug(`🎯 [Kanban] Cache hit pour board ${parent.id}`);
        return cached;
      }

      const tasks = await Task.find({
        boardId: parent.id,
        workspaceId: parent.workspaceId,
      })
        .sort("position")
        .limit(1000)
        .lean();

      // Batch-load les clients pour éviter N+1 queries
      const clientIds = [
        ...new Set(
          tasks.filter((t) => t.clientId).map((t) => t.clientId.toString()),
        ),
      ];
      let clientsMap = {};
      if (clientIds.length > 0) {
        const clients = await Client.find({
          _id: { $in: clientIds },
          workspaceId: parent.workspaceId,
        }).lean();
        clientsMap = Object.fromEntries(
          clients.map((c) => [c._id.toString(), c]),
        );
      }

      // Attacher le client pré-chargé à chaque tâche
      // Normaliser assignedMembers en tableau de strings (lean() bypasse les casts Mongoose)
      const result = tasks.map((task) => ({
        ...task,
        id: task._id?.toString() || task.id,
        assignedMembers: Array.isArray(task.assignedMembers)
          ? task.assignedMembers.map((m) =>
              typeof m === "string"
                ? m
                : m?.userId?.toString() || m?.toString(),
            )
          : [],
        _prefetchedClient: task.clientId
          ? clientsMap[task.clientId.toString()] || null
          : null,
      }));

      // Mettre en cache 30 secondes
      await cacheSet(cacheKey, result, 30);

      return result;
    },
    client: async (board) => {
      if (!board.clientId) return null;
      const Client = mongoose.model("Client");
      return Client.findOne({
        _id: board.clientId,
        workspaceId: board.workspaceId,
      });
    },
    totalBillableAmount: async (board) => {
      // Utiliser une aggregation pipeline pour calculer côté MongoDB
      // Seules les tâches avec hourlyRate > 0 ET (totalSeconds > 0 OU timer en cours) sont pertinentes
      const result = await Task.aggregate([
        {
          $match: {
            boardId: new mongoose.Types.ObjectId(board.id),
            workspaceId: new mongoose.Types.ObjectId(board.workspaceId),
            "timeTracking.hourlyRate": { $gt: 0 },
          },
        },
        {
          $project: {
            hourlyRate: "$timeTracking.hourlyRate",
            totalSeconds: { $ifNull: ["$timeTracking.totalSeconds", 0] },
            isRunning: { $ifNull: ["$timeTracking.isRunning", false] },
            currentStartTime: "$timeTracking.currentStartTime",
            roundingOption: {
              $ifNull: ["$timeTracking.roundingOption", "none"],
            },
          },
        },
        {
          $addFields: {
            // Ajouter le temps écoulé si le timer est en cours
            effectiveSeconds: {
              $cond: {
                if: {
                  $and: [
                    { $eq: ["$isRunning", true] },
                    { $ne: ["$currentStartTime", null] },
                  ],
                },
                then: {
                  $add: [
                    "$totalSeconds",
                    {
                      $max: [
                        0,
                        {
                          $divide: [
                            { $subtract: [new Date(), "$currentStartTime"] },
                            1000,
                          ],
                        },
                      ],
                    },
                  ],
                },
                else: "$totalSeconds",
              },
            },
          },
        },
        { $match: { effectiveSeconds: { $gt: 0 } } },
        {
          $addFields: {
            hours: { $divide: ["$effectiveSeconds", 3600] },
          },
        },
        {
          $addFields: {
            billableHours: {
              $switch: {
                branches: [
                  {
                    case: { $eq: ["$roundingOption", "up"] },
                    then: { $ceil: "$hours" },
                  },
                  {
                    case: { $eq: ["$roundingOption", "down"] },
                    then: { $floor: "$hours" },
                  },
                ],
                default: "$hours",
              },
            },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $multiply: ["$billableHours", "$hourlyRate"] } },
          },
        },
      ]);

      const total = result[0]?.total || 0;
      return total > 0 ? total : null;
    },
    taskCount: async (board) => {
      return Task.countDocuments({
        boardId: new mongoose.Types.ObjectId(board.id),
        workspaceId: new mongoose.Types.ObjectId(board.workspaceId),
      });
    },
    totalTimeSpent: async (board) => {
      const result = await Task.aggregate([
        {
          $match: {
            boardId: new mongoose.Types.ObjectId(board.id),
            workspaceId: new mongoose.Types.ObjectId(board.workspaceId),
          },
        },
        {
          $project: {
            totalSeconds: { $ifNull: ["$timeTracking.totalSeconds", 0] },
            isRunning: { $ifNull: ["$timeTracking.isRunning", false] },
            currentStartTime: "$timeTracking.currentStartTime",
          },
        },
        {
          $addFields: {
            effectiveSeconds: {
              $cond: {
                if: {
                  $and: [
                    { $eq: ["$isRunning", true] },
                    { $ne: ["$currentStartTime", null] },
                  ],
                },
                then: {
                  $add: [
                    "$totalSeconds",
                    {
                      $max: [
                        0,
                        {
                          $divide: [
                            { $subtract: [new Date(), "$currentStartTime"] },
                            1000,
                          ],
                        },
                      ],
                    },
                  ],
                },
                else: "$totalSeconds",
              },
            },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$effectiveSeconds" },
          },
        },
      ]);

      const total = Math.round(result[0]?.total || 0);
      return total > 0 ? total : null;
    },
    boardMembers: (board) => {
      return board.members || [];
    },
    members: async (board) => {
      try {
        const db = mongoose.connection.db;

        // Convertir le workspaceId en ObjectId
        const orgId =
          typeof board.workspaceId === "string"
            ? new mongoose.Types.ObjectId(board.workspaceId)
            : board.workspaceId;

        logger.info(
          `🔍 [Kanban Board.members] Recherche membres pour organisation: ${orgId}`,
        );

        // 1. Récupérer l'organisation
        const organization = await db
          .collection("organization")
          .findOne({ _id: orgId });

        if (!organization) {
          logger.warn(
            `⚠️ [Kanban Board.members] Organisation non trouvée: ${orgId}`,
          );
          return [];
        }

        logger.info(
          `🏢 [Kanban Board.members] Organisation trouvée: ${organization.name}`,
        );

        // 2. Récupérer TOUS les membres via la collection member (Better Auth)
        const members = await db
          .collection("member")
          .find({
            organizationId: orgId,
          })
          .toArray();

        logger.info(
          `📋 [Kanban Board.members] ${members.length} membres trouvés`,
        );

        if (members.length === 0) {
          logger.warn("⚠️ [Kanban Board.members] Aucun membre trouvé");
          return [];
        }

        // 3. Récupérer les IDs utilisateurs
        const userIds = members.map((m) => {
          const userId = m.userId;
          return typeof userId === "string"
            ? new mongoose.Types.ObjectId(userId)
            : userId;
        });

        logger.info(
          `👥 [Kanban Board.members] Recherche de ${userIds.length} utilisateurs`,
        );

        // 4. Récupérer les informations des utilisateurs avec leurs photos
        const users = await db
          .collection("user")
          .find({
            _id: { $in: userIds },
          })
          .toArray();

        logger.info(
          `✅ [Kanban Board.members] ${users.length} utilisateurs trouvés`,
        );

        // 5. Créer le résultat en combinant membres et users
        const result = members
          .map((member) => {
            const memberUserId = member.userId?.toString();
            const user = users.find((u) => u._id.toString() === memberUserId);

            if (!user) {
              logger.warn(
                `⚠️ [Kanban Board.members] Utilisateur non trouvé: ${memberUserId}`,
              );
              return null;
            }

            // Better Auth peut stocker l'image dans différents champs
            const userImage =
              user.image ||
              user.avatar ||
              user.profile?.profilePicture ||
              user.profile?.profilePictureUrl ||
              null;

            logger.info(
              `📸 [Kanban Board.members] Utilisateur: ${user.email}`,
              {
                image: user.image || "null",
                avatar: user.avatar || "null",
                profilePicture: user.profile?.profilePicture || "null",
                profilePictureUrl: user.profile?.profilePictureUrl || "null",
                finalImage: userImage || "null",
              },
            );

            // Construire le nom complet
            let displayName = "";
            if (user.name && user.lastName) {
              displayName = `${user.name} ${user.lastName}`;
            } else if (user.name) {
              displayName = user.name;
            } else if (user.lastName) {
              displayName = user.lastName;
            } else {
              displayName = user.email || "Utilisateur inconnu";
            }

            return {
              id: memberUserId,
              userId: memberUserId,
              name: displayName,
              email: user.email || "",
              image: userImage,
              role: member.role || "member",
            };
          })
          .filter(Boolean); // Retirer les null

        logger.info(
          `✅ [Kanban Board.members] Retour de ${result.length} membres avec photos`,
        );

        return result;
      } catch (error) {
        logger.error("❌ [Kanban Board.members] Erreur:", error);
        logger.error("Stack:", error.stack);
        return [];
      }
    },
  },

  Column: {
    tasks: async (parent) => {
      return await Task.find({
        columnId: parent.id,
        workspaceId: parent.workspaceId,
      })
        .sort("position")
        .limit(500);
    },
  },

  Task: {
    // Résoudre le client assigné à la tâche
    // Utilise le client pré-chargé par Board.tasks si disponible (évite N+1)
    client: async (task) => {
      if (!task.clientId) return null;
      // Si le client a été pré-chargé par Board.tasks, l'utiliser directement
      if (task._prefetchedClient !== undefined) {
        return task._prefetchedClient;
      }
      // Fallback: query individuelle (pour les queries task() directes)
      return Client.findOne({
        _id: task.clientId,
        workspaceId: task.workspaceId,
      });
    },

    // Transformer les images de la tâche pour avoir des IDs corrects
    images: (task) => {
      if (!task.images || task.images.length === 0) return [];
      return task.images.map((img) => {
        const image = img.toObject ? img.toObject() : img;
        return {
          ...image,
          id: image._id?.toString() || image.id,
        };
      });
    },

    // Enrichir les commentaires avec les infos utilisateur dynamiquement
    comments: async (task) => {
      logger.info(
        `🔄 [Task.comments] Enrichissement des commentaires pour la tâche ${task._id || task.id}`,
      );
      if (!task.comments || task.comments.length === 0) return [];

      const db = mongoose.connection.db;

      // Collecter tous les userIds des commentaires (sauf externes)
      const userIds = new Set();
      task.comments.forEach((c) => {
        if (c.userId && !c.userId.startsWith("external_")) {
          userIds.add(c.userId);
        }
      });

      // Récupérer les infos des utilisateurs
      let usersMap = {};
      if (userIds.size > 0) {
        try {
          const userObjectIds = Array.from(userIds).map((id) => {
            try {
              return new mongoose.Types.ObjectId(id);
            } catch {
              return id;
            }
          });

          const users = await db
            .collection("user")
            .find({
              _id: { $in: userObjectIds },
            })
            .toArray();

          users.forEach((u) => {
            // Construire le nom complet
            let displayName = "";
            if (u.name && u.lastName) {
              displayName = `${u.name} ${u.lastName}`;
            } else if (u.name) {
              displayName = u.name;
            } else if (u.lastName) {
              displayName = u.lastName;
            } else {
              displayName = u.email?.split("@")[0] || "Utilisateur";
            }
            usersMap[u._id.toString()] = {
              name: displayName,
              image: u.avatar || u.image || null,
            };
          });
        } catch (error) {
          logger.error(
            "❌ [Task.comments] Erreur récupération utilisateurs:",
            error,
          );
        }
      }

      // Enrichir les commentaires
      return task.comments.map((c) => {
        const comment = c.toObject ? c.toObject() : c;

        // Pour les commentaires externes, garder les infos stockées
        if (comment.userId?.startsWith("external_")) {
          return {
            ...comment,
            id: comment._id?.toString() || comment.id,
            userName: comment.userName || "Invité",
            userImage: comment.userImage || null,
            // Préserver les images du commentaire externe aussi
            images: (comment.images || []).map((img) => ({
              ...img,
              id: img._id?.toString() || img.id,
            })),
          };
        }

        // Pour les utilisateurs normaux, TOUJOURS utiliser les infos dynamiques
        const userInfo = usersMap[comment.userId];

        // Log pour déboguer
        if (!userInfo) {
          logger.warn(
            `⚠️ [Task.comments] Utilisateur non trouvé: ${comment.userId}`,
          );
        }

        return {
          ...comment,
          id: comment._id?.toString() || comment.id,
          // IMPORTANT: Toujours utiliser userInfo en priorité, ignorer comment.userName stocké
          userName: userInfo?.name || "Utilisateur",
          userImage: userInfo?.image || null,
          // Préserver les images du commentaire
          images: (comment.images || []).map((img) => {
            const imgObj = img.toObject ? img.toObject() : img;
            return {
              ...imgObj,
              id: imgObj._id?.toString() || imgObj.id,
            };
          }),
        };
      });
    },

    // Enrichir l'activité avec les infos utilisateur dynamiquement
    activity: async (task) => {
      if (!task.activity || task.activity.length === 0) return [];

      const db = mongoose.connection.db;

      // Collecter tous les userIds de l'activité
      const userIds = new Set();
      task.activity.forEach((a) => {
        if (a.userId) userIds.add(a.userId);
      });

      // Récupérer les infos des utilisateurs
      let usersMap = {};
      if (userIds.size > 0) {
        try {
          const userObjectIds = Array.from(userIds).map((id) => {
            try {
              return new mongoose.Types.ObjectId(id);
            } catch {
              return id;
            }
          });

          const users = await db
            .collection("user")
            .find({
              _id: { $in: userObjectIds },
            })
            .toArray();

          users.forEach((u) => {
            // Construire le nom complet
            let displayName = "";
            if (u.name && u.lastName) {
              displayName = `${u.name} ${u.lastName}`;
            } else if (u.name) {
              displayName = u.name;
            } else if (u.lastName) {
              displayName = u.lastName;
            } else {
              displayName = u.email?.split("@")[0] || "Utilisateur";
            }
            usersMap[u._id.toString()] = {
              name: displayName,
              image: u.avatar || u.image || null,
            };
          });
        } catch (error) {
          logger.error(
            "❌ [Task.activity] Erreur récupération utilisateurs:",
            error,
          );
        }
      }

      // Enrichir l'activité
      return task.activity.map((a) => {
        const activity = a.toObject ? a.toObject() : a;
        const userInfo = usersMap[activity.userId];
        return {
          ...activity,
          id: activity._id?.toString() || activity.id,
          userName: userInfo?.name || activity.userName || "Utilisateur",
          userImage: userInfo?.image || activity.userImage || null,
        };
      });
    },
  },

  Comment: {
    id: (parent) => parent._id || parent.id,
  },

  Activity: {
    id: (parent) => parent._id || parent.id,
  },

  // Resolver pour transformer _id en id pour les images
  TaskImage: {
    id: (image) => image._id?.toString() || image.id,
  },

  Subscription: {
    boardUpdated: {
      subscribe: withWorkspace(
        (_, { workspaceId }, { workspaceId: contextWorkspaceId }) => {
          const finalWorkspaceId = workspaceId || contextWorkspaceId;
          try {
            const pubsub = getPubSub();
            // Utiliser un canal spécifique au workspace pour optimiser les performances
            return pubsub.asyncIterableIterator([
              `${BOARD_UPDATED}_${finalWorkspaceId}`,
            ]);
          } catch (error) {
            logger.error(
              "❌ [Kanban] Erreur subscription boardUpdated:",
              error,
            );
            throw new Error("Subscription failed");
          }
        },
      ),
      resolve: (
        payload,
        { workspaceId },
        { workspaceId: contextWorkspaceId },
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        // Filtrer les événements par workspace
        if (payload.workspaceId === finalWorkspaceId) {
          return payload;
        }
        return null;
      },
    },

    taskUpdated: {
      subscribe: withWorkspace(
        (_, { boardId, workspaceId }, { workspaceId: contextWorkspaceId }) => {
          const finalWorkspaceId = workspaceId || contextWorkspaceId;
          try {
            const pubsub = getPubSub();
            // Utiliser un canal spécifique au workspace et board pour optimiser
            return pubsub.asyncIterableIterator([
              `${TASK_UPDATED}_${finalWorkspaceId}_${boardId}`,
            ]);
          } catch (error) {
            logger.error("❌ [Kanban] Erreur subscription taskUpdated:", error);
            throw new Error("Subscription failed");
          }
        },
      ),
      resolve: (payload) => {
        // Pour les événements VISITOR_PROFILE_UPDATED, retourner le payload avec visitor
        if (payload.type === "VISITOR_PROFILE_UPDATED" && payload.visitor) {
          return {
            type: payload.type,
            task: null,
            taskId: null,
            boardId: payload.boardId,
            workspaceId: payload.workspaceId,
            visitor: payload.visitor,
          };
        }
        // Ignorer les autres événements qui n'ont pas de task
        if (!payload.task) {
          return null;
        }
        // Le filtrage est déjà fait au niveau du subscribe via le canal spécifique
        // Toujours retourner le payload car il vient du bon canal
        return payload;
      },
    },

    columnUpdated: {
      subscribe: withWorkspace(
        (_, { boardId, workspaceId }, { workspaceId: contextWorkspaceId }) => {
          const finalWorkspaceId = workspaceId || contextWorkspaceId;
          try {
            const pubsub = getPubSub();
            // Utiliser un canal spécifique au workspace et board pour optimiser
            return pubsub.asyncIterableIterator([
              `${COLUMN_UPDATED}_${finalWorkspaceId}_${boardId}`,
            ]);
          } catch (error) {
            logger.error(
              "❌ [Kanban] Erreur subscription columnUpdated:",
              error,
            );
            throw new Error("Subscription failed");
          }
        },
      ),
      resolve: (payload) => {
        // Le filtrage est déjà fait au niveau du subscribe via le canal spécifique
        // Toujours retourner le payload car il vient du bon canal
        return payload;
      },
    },
  },
};

export { enrichTaskWithUserInfo };
export default resolvers;
