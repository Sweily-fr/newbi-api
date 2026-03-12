import { isAuthenticated } from "../middlewares/better-auth.js";
import InstalledApp from "../models/InstalledApp.js";
import logger from "../utils/logger.js";

const installedAppResolvers = {
  Query: {
    getInstalledApps: isAuthenticated(
      async (_, { organizationId }, { user }) => {
        try {
          const apps = await InstalledApp.find({ organizationId }).lean();
          return apps.map((app) => ({
            ...app,
            id: app._id.toString(),
            organizationId: app.organizationId.toString(),
            installedBy: app.installedBy.toString(),
            createdAt: app.createdAt?.toISOString(),
          }));
        } catch (error) {
          logger.error("Erreur lors de la récupération des apps installées:", error);
          throw error;
        }
      }
    ),
  },

  Mutation: {
    installApp: isAuthenticated(
      async (_, { organizationId, appId }, { user }) => {
        try {
          const app = await InstalledApp.create({
            organizationId,
            appId,
            installedBy: user._id,
          });

          return {
            id: app._id.toString(),
            organizationId: app.organizationId.toString(),
            appId: app.appId,
            installedBy: app.installedBy.toString(),
            createdAt: app.createdAt?.toISOString(),
          };
        } catch (error) {
          if (error.code === 11000) {
            throw new Error("Cette application est déjà installée.");
          }
          logger.error("Erreur lors de l'installation de l'app:", error);
          throw error;
        }
      }
    ),

    uninstallApp: isAuthenticated(
      async (_, { organizationId, appId }, { user }) => {
        try {
          const result = await InstalledApp.deleteOne({
            organizationId,
            appId,
          });
          return result.deletedCount > 0;
        } catch (error) {
          logger.error("Erreur lors de la désinstallation de l'app:", error);
          throw error;
        }
      }
    ),
  },
};

export default installedAppResolvers;
