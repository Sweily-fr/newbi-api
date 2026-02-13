import { isAuthenticated } from "../middlewares/better-auth.js";
import User from "../models/User.js";
import logger from "../utils/logger.js";

// Valeurs par défaut pour les préférences de notifications
const defaultNotificationPreferences = {
  // Facturation
  invoice_overdue: { email: true, push: true },
  payment_received: { email: true, push: true },
  quote_response: { email: true, push: true },
  invoice_due_soon: { email: false, push: true },
  // Abonnement
  payment_failed: { email: true, push: true },
  trial_ending: { email: true, push: true },
  subscription_renewed: { email: true, push: false },
  // Équipe
  invitation_received: { email: true, push: true },
  member_joined: { email: false, push: true },
  document_shared: { email: false, push: true },
  // Kanban
  kanban_task_assigned: { email: true, push: true },
};

const notificationPreferencesResolvers = {
  Query: {
    /**
     * Récupère les préférences de notifications de l'utilisateur
     */
    getNotificationPreferences: isAuthenticated(async (_, __, { user }) => {
      try {
        const dbUser = await User.findById(user._id);

        if (!dbUser) {
          throw new Error("Utilisateur non trouvé");
        }

        // Fusionner les préférences utilisateur avec les valeurs par défaut
        const userPrefs = dbUser.notificationPreferences || {};
        const result = {};

        Object.keys(defaultNotificationPreferences).forEach((key) => {
          result[key] = {
            email:
              userPrefs[key]?.email ??
              defaultNotificationPreferences[key].email,
            push:
              userPrefs[key]?.push ?? defaultNotificationPreferences[key].push,
          };
        });

        return result;
      } catch (error) {
        logger.error(
          "Erreur lors de la récupération des préférences de notifications:",
          error
        );
        throw error;
      }
    }),
  },

  Mutation: {
    /**
     * Met à jour les préférences de notifications de l'utilisateur
     */
    updateNotificationPreferences: isAuthenticated(
      async (_, { input }, { user }) => {
        try {
          // Construire l'objet de mise à jour pour MongoDB
          const updateObj = {};

          Object.keys(input).forEach((key) => {
            if (defaultNotificationPreferences[key]) {
              if (input[key].email !== undefined) {
                updateObj[`notificationPreferences.${key}.email`] =
                  input[key].email;
              }
              if (input[key].push !== undefined) {
                updateObj[`notificationPreferences.${key}.push`] =
                  input[key].push;
              }
            }
          });

          // Utiliser findByIdAndUpdate pour éviter la validation du password
          const result = await User.findByIdAndUpdate(
            user._id,
            { $set: updateObj },
            { new: true, runValidators: false }
          );

          if (!result) {
            return {
              success: false,
              message: "Utilisateur non trouvé",
            };
          }

          logger.info(
            `✅ Préférences de notifications mises à jour pour l'utilisateur ${user._id}`
          );

          return {
            success: true,
            message: "Préférences de notifications mises à jour",
          };
        } catch (error) {
          logger.error(
            "Erreur lors de la mise à jour des préférences de notifications:",
            error
          );
          return {
            success: false,
            message: error.message || "Erreur lors de la mise à jour",
          };
        }
      }
    ),
  },
};

export default notificationPreferencesResolvers;
