import InstalledApp from "../models/InstalledApp.js";
import AbbyAccount from "../models/AbbyAccount.js";
import QontoAccount from "../models/QontoAccount.js";
import PennylaneAccount from "../models/PennylaneAccount.js";
import logger from "../utils/logger.js";
import {
  checkSubscriptionActive,
  resolveWorkspaceId,
  withOrganization,
} from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";

/**
 * Intégrations dont le lien vit dans une collection à part, une entrée par
 * organisation (clé API ou jeton chiffré + préférences de synchronisation).
 *
 * Désinstaller l'application doit couper le lien : les crons ne regardent que
 * ces collections, jamais InstalledApp. Sans cascade, une intégration
 * désinstallée continue de synchroniser et d'importer alors que sa carte a
 * disparu de « Mes applications » — plus personne ne peut la voir ni l'arrêter.
 */
const APP_INTEGRATIONS = {
  abby: { label: "Abby", model: AbbyAccount },
  qonto: { label: "Qonto", model: QontoAccount },
  pennylane: { label: "Pennylane", model: PennylaneAccount },
};

function isOwnerOrAdmin(userRole) {
  const normalized = userRole?.toLowerCase();
  return normalized === "owner" || normalized === "admin";
}

const installedAppResolvers = {
  Query: {
    getInstalledApps: async (_, args, context) => {
      const organizationId = resolveWorkspaceId(
        args.organizationId,
        context.organizationId,
      );
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
        logger.error(
          "Erreur lors de la récupération des apps installées:",
          error,
        );
        throw error;
      }
    },
  },

  Mutation: {
    installApp: async (_, args, context) => {
      const organizationId = resolveWorkspaceId(
        args.organizationId,
        context.organizationId,
      );
      try {
        const app = await InstalledApp.create({
          organizationId,
          appId: args.appId,
          installedBy: context.user._id,
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
    },

    uninstallApp: async (_, args, context) => {
      // La mutation supprime des identifiants d'intégration : on prend
      // l'organisation validée par RBAC, jamais l'argument brut du client.
      const organizationId = resolveWorkspaceId(
        args.organizationId,
        context.organizationId,
      );
      const { appId } = args;

      if (!isOwnerOrAdmin(context.userRole)) {
        throw new AppError(
          "Seuls les propriétaires et administrateurs peuvent désinstaller une application",
          ERROR_CODES.FORBIDDEN,
        );
      }

      try {
        const result = await InstalledApp.deleteOne({
          organizationId,
          appId,
        });

        // Cascade : désinstaller, c'est déconnecter
        const integration = APP_INTEGRATIONS[appId];
        let disconnected = false;
        if (integration) {
          const { deletedCount } = await integration.model.deleteOne({
            organizationId,
          });
          disconnected = deletedCount > 0;
          if (disconnected) {
            logger.info(
              `${integration.label} déconnecté par la désinstallation de l'application:`,
              { organizationId, userId: context.user._id?.toString() },
            );
          }
        }

        // Un compte resté connecté sans ligne InstalledApp (désinstallation
        // antérieure à cette cascade) compte aussi comme une désinstallation.
        return result.deletedCount > 0 || disconnected;
      } catch (error) {
        logger.error("Erreur lors de la désinstallation de l'app:", error);
        throw error;
      }
    },
  },
};

// ✅ Phase A.4 — Subscription check on installApp mutation (exclude uninstallApp)
const INSTALLED_APP_BLOCK = ["installApp"];
INSTALLED_APP_BLOCK.forEach((name) => {
  const original = installedAppResolvers.Mutation[name];
  if (original) {
    installedAppResolvers.Mutation[name] = async (
      parent,
      args,
      context,
      info,
    ) => {
      await checkSubscriptionActive(context);
      return original(parent, args, context, info);
    };
  }
});

// organizationId / userRole vérifiés en base par RBAC (withOrganization en
// position externe), jamais lus depuis les arguments client. Même schéma qu'Abby.
installedAppResolvers.Query.getInstalledApps = withOrganization(
  installedAppResolvers.Query.getInstalledApps,
);
["installApp", "uninstallApp"].forEach((name) => {
  installedAppResolvers.Mutation[name] = withOrganization(
    installedAppResolvers.Mutation[name],
  );
});

export default installedAppResolvers;
