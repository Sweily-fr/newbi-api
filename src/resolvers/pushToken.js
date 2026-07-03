import { isAuthenticated } from "../middlewares/better-auth-jwt.js";
import User from "../models/User.js";
import logger from "../utils/logger.js";

const pushTokenResolvers = {
  Mutation: {
    /**
     * Enregistre (ou rafraîchit) le token push Expo de l'appareil courant.
     * On retire d'abord toute occurrence existante du même token (sur ce user)
     * pour éviter les doublons, puis on l'ajoute avec sa date de mise à jour.
     */
    registerPushToken: isAuthenticated(
      async (_, { token, platform }, { user }) => {
        try {
          if (!token || typeof token !== "string") {
            return { success: false, message: "Token invalide" };
          }

          await User.findByIdAndUpdate(
            user._id,
            { $pull: { expoPushTokens: { token } } },
            { runValidators: false },
          );

          await User.findByIdAndUpdate(
            user._id,
            {
              $push: {
                expoPushTokens: {
                  token,
                  platform: platform || "unknown",
                  updatedAt: new Date(),
                },
              },
            },
            { runValidators: false },
          );

          logger.info(
            `🔔 [PushToken] Token enregistré pour l'utilisateur ${user._id} (${platform || "unknown"})`,
          );

          return { success: true, message: "Token enregistré" };
        } catch (error) {
          logger.error("❌ [PushToken] Erreur registerPushToken:", error);
          return {
            success: false,
            message:
              error.message || "Erreur lors de l'enregistrement du token",
          };
        }
      },
    ),

    /**
     * Supprime un token push (ex: déconnexion ou désactivation).
     */
    removePushToken: isAuthenticated(async (_, { token }, { user }) => {
      try {
        await User.findByIdAndUpdate(
          user._id,
          { $pull: { expoPushTokens: { token } } },
          { runValidators: false },
        );

        logger.info(
          `🔔 [PushToken] Token supprimé pour l'utilisateur ${user._id}`,
        );

        return { success: true, message: "Token supprimé" };
      } catch (error) {
        logger.error("❌ [PushToken] Erreur removePushToken:", error);
        return {
          success: false,
          message: error.message || "Erreur lors de la suppression du token",
        };
      }
    }),
  },
};

export default pushTokenResolvers;
