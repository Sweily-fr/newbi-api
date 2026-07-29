import DocumentSettings from "../models/DocumentSettings.js";
import { UserInputError } from "apollo-server-express";
import {
  withOrganization,
  checkSubscriptionActive,
} from "../middlewares/rbac.js";

const documentSettingsResolvers = {
  Query: {
    // Récupérer les paramètres d'un type de document (facture ou devis).
    // 🔐 Scopé par workspace (org validée par RBAC) et non plus par createdBy :
    // évite qu'un utilisateur multi-org croise les mentions légales entre entités,
    // et qu'un ex-membre reste propriétaire des paramètres.
    getDocumentSettings: withOrganization(
      async (_, { documentType }, { workspaceId }) => {
        const settings = await DocumentSettings.findOne({
          documentType,
          workspaceId,
        });

        return settings;
      },
    ),
  },

  Mutation: {
    // Créer ou mettre à jour les paramètres d'un document
    saveDocumentSettings: withOrganization(
      async (_, { input }, { user, workspaceId }) => {
        await checkSubscriptionActive({ workspaceId });
        const { documentType, ...settingsData } = input;
        const userId = user.id || user._id;

        try {
          // Paramètres scopés par workspace (index unique { workspaceId, documentType })
          const settings = await DocumentSettings.findOneAndUpdate(
            { documentType, workspaceId },
            { ...settingsData, workspaceId, createdBy: userId },
            { new: true, upsert: true, runValidators: true },
          );

          return settings;
        } catch (error) {
          console.error("Erreur lors de la sauvegarde des paramètres:", error);
          throw new UserInputError(
            "Erreur lors de la sauvegarde des paramètres",
            {
              invalidArgs: Object.keys(error.errors || {}),
            },
          );
        }
      },
    ),
  },
};

// Le contrôle d'abonnement est fait à l'intérieur de saveDocumentSettings,
// APRÈS l'enrichissement RBAC (context.workspaceId validé), plutôt que via un
// wrapper externe qui lisait l'org depuis un header client non vérifié.

export default documentSettingsResolvers;
