import { withFilter } from "graphql-subscriptions";
import { isAuthenticated } from "../middlewares/better-auth.js";
import { getActiveOrganization } from "../middlewares/org-resolver.js";
import Notification from "../models/Notification.js";
import logger from "../utils/logger.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import { getPubSub } from "../config/redis.js";

const NOTIFICATION_RECEIVED = "NOTIFICATION_RECEIVED";

// Identifiant de l'utilisateur de la connexion WebSocket (document Mongoose
// côté serveur, objet simple dans les tests)
const subscriberId = (context) =>
  String(context?.user?._id || context?.user?.id || "");

/**
 * Une notification publiée sur le canal de l'espace ne part qu'à son
 * destinataire.
 */
export const isNotificationForSubscriber = (payload, context) => {
  const recipientId = payload?.notificationReceived?.userId;
  const userId = subscriberId(context);
  return !!recipientId && !!userId && String(recipientId) === userId;
};

const notificationResolvers = {
  Query: {
    getNotifications: isAuthenticated(
      async (
        _,
        { workspaceId, limit = 50, offset = 0, unreadOnly = false },
        { user },
      ) => {
        try {
          const query = {
            userId: user._id,
            workspaceId,
          };

          if (unreadOnly) {
            query.read = false;
          }

          const [notifications, totalCount, unreadCount] = await Promise.all([
            Notification.find(query)
              .sort({ createdAt: -1 })
              .skip(offset)
              .limit(limit)
              .lean(),
            Notification.countDocuments({ userId: user._id, workspaceId }),
            Notification.countDocuments({
              userId: user._id,
              workspaceId,
              read: false,
            }),
          ]);

          return {
            notifications: notifications.map((n) => ({
              ...n,
              id: n._id.toString(),
              userId: n.userId.toString(),
              workspaceId: n.workspaceId.toString(),
              data: n.data
                ? {
                    ...n.data,
                    taskId: n.data.taskId?.toString(),
                    boardId: n.data.boardId?.toString(),
                    actorId: n.data.actorId?.toString(),
                  }
                : null,
              createdAt: n.createdAt?.toISOString(),
              updatedAt: n.updatedAt?.toISOString(),
              readAt: n.readAt?.toISOString(),
            })),
            totalCount,
            unreadCount,
          };
        } catch (error) {
          logger.error(
            "Erreur lors de la récupération des notifications:",
            error,
          );
          throw error;
        }
      },
    ),

    getUnreadNotificationsCount: isAuthenticated(
      async (_, { workspaceId }, { user }) => {
        try {
          const count = await Notification.countDocuments({
            userId: user._id,
            workspaceId,
            read: false,
          });
          return count;
        } catch (error) {
          logger.error(
            "Erreur lors du comptage des notifications non lues:",
            error,
          );
          throw error;
        }
      },
    ),
  },

  Mutation: {
    markNotificationAsRead: isAuthenticated(async (_, { id }, { user }) => {
      try {
        const notification = await Notification.findOneAndUpdate(
          { _id: id, userId: user._id },
          { read: true, readAt: new Date() },
          { new: true },
        );

        if (!notification) {
          return {
            success: false,
            message: "Notification non trouvée",
          };
        }

        return {
          success: true,
          message: "Notification marquée comme lue",
        };
      } catch (error) {
        logger.error("Erreur lors du marquage de la notification:", error);
        return {
          success: false,
          message: error.message,
        };
      }
    }),

    markAllNotificationsAsRead: isAuthenticated(
      async (_, { workspaceId }, { user }) => {
        try {
          await Notification.updateMany(
            { userId: user._id, workspaceId, read: false },
            { read: true, readAt: new Date() },
          );

          return {
            success: true,
            message: "Toutes les notifications ont été marquées comme lues",
          };
        } catch (error) {
          logger.error("Erreur lors du marquage des notifications:", error);
          return {
            success: false,
            message: error.message,
          };
        }
      },
    ),

    deleteNotification: isAuthenticated(async (_, { id }, { user }) => {
      try {
        const result = await Notification.deleteOne({
          _id: id,
          userId: user._id,
        });

        if (result.deletedCount === 0) {
          return {
            success: false,
            message: "Notification non trouvée",
          };
        }

        return {
          success: true,
          message: "Notification supprimée",
        };
      } catch (error) {
        logger.error(
          "Erreur lors de la suppression de la notification:",
          error,
        );
        return {
          success: false,
          message: error.message,
        };
      }
    }),
  },

  Subscription: {
    notificationReceived: {
      // 🔐 Le canal est celui de l'espace : sans contrôle, n'importe quel
      // client WebSocket (même anonyme) connaissant un workspaceId recevait
      // les titres et messages des notifications de tous ses membres.
      // On exige un utilisateur membre de l'espace, puis on ne lui transmet
      // que ses propres notifications.
      subscribe: withFilter(
        async (_, { workspaceId }, context) => {
          if (!context?.user) {
            throw new AppError(
              "Vous devez être connecté pour effectuer cette action",
              ERROR_CODES.UNAUTHENTICATED,
            );
          }
          // Sans espace demandé, getActiveOrganization retomberait sur
          // l'espace par défaut de l'utilisateur
          const org = workspaceId
            ? await getActiveOrganization(subscriberId(context), workspaceId)
            : null;
          if (!org) {
            throw new AppError(
              "Vous n'êtes pas membre de cette organisation.",
              ERROR_CODES.FORBIDDEN,
            );
          }
          const pubsub = getPubSub();
          return pubsub.asyncIterableIterator([
            `${NOTIFICATION_RECEIVED}_${workspaceId}`,
          ]);
        },
        (payload, _args, context) =>
          isNotificationForSubscriber(payload, context),
      ),
    },
  },
};

// Fonction utilitaire pour publier une notification
export const publishNotification = async (notification) => {
  const pubsub = getPubSub();
  const workspaceId = notification.workspaceId.toString();
  pubsub.publish(`${NOTIFICATION_RECEIVED}_${workspaceId}`, {
    notificationReceived: {
      ...notification.toObject(),
      id: notification._id.toString(),
      userId: notification.userId.toString(),
      workspaceId: notification.workspaceId.toString(),
      data: notification.data
        ? {
            ...notification.data,
            taskId: notification.data.taskId?.toString(),
            boardId: notification.data.boardId?.toString(),
            actorId: notification.data.actorId?.toString(),
          }
        : null,
      createdAt: notification.createdAt?.toISOString(),
      updatedAt: notification.updatedAt?.toISOString(),
    },
  });
};

export default notificationResolvers;
