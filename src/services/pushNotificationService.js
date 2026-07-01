import { Expo } from "expo-server-sdk";
import User from "../models/User.js";
import logger from "../utils/logger.js";

// Client Expo (un seul accès token optionnel via EXPO_ACCESS_TOKEN si défini)
const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
});

/**
 * Envoie une notification push à tous les appareils d'un utilisateur.
 * - Filtre les tokens invalides.
 * - Supprime automatiquement les tokens « DeviceNotRegistered » de la base.
 *
 * @param {string} userId - ID Mongo de l'utilisateur destinataire.
 * @param {object} payload
 * @param {string} payload.title - Titre de la notification.
 * @param {string} payload.body - Corps du message.
 * @param {object} [payload.data] - Données embarquées (deep-link, ids, etc.).
 */
export async function sendPushToUser(userId, { title, body, data = {} }) {
  try {
    const user = await User.findById(userId).select("expoPushTokens").lean();

    const tokens = (user?.expoPushTokens || [])
      .map((entry) => entry?.token)
      .filter((token) => Expo.isExpoPushToken(token));

    if (tokens.length === 0) {
      return;
    }

    const messages = tokens.map((to) => ({
      to,
      sound: "default",
      title,
      body,
      data,
      priority: "high",
      channelId: "default",
    }));

    const chunks = expo.chunkPushNotifications(messages);
    const invalidTokens = [];

    for (const chunk of chunks) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        tickets.forEach((ticket, index) => {
          if (ticket.status === "error") {
            logger.warn(
              `🔔 [Push] Ticket en erreur: ${ticket.message || "inconnu"}`,
            );
            if (ticket.details?.error === "DeviceNotRegistered") {
              invalidTokens.push(chunk[index].to);
            }
          }
        });
      } catch (chunkError) {
        logger.error("❌ [Push] Erreur d'envoi d'un chunk:", chunkError);
      }
    }

    // Nettoyage des tokens devenus invalides
    if (invalidTokens.length > 0) {
      await User.findByIdAndUpdate(userId, {
        $pull: { expoPushTokens: { token: { $in: invalidTokens } } },
      });
      logger.info(
        `🔔 [Push] ${invalidTokens.length} token(s) invalide(s) supprimé(s) pour ${userId}`,
      );
    }
  } catch (error) {
    logger.error("❌ [Push] Erreur sendPushToUser:", error);
  }
}

export default { sendPushToUser };
