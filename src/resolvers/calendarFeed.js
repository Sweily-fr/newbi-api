import mongoose from "mongoose";
import { requireWorkspaceLevel } from "../middlewares/rbac.js";
import { isAuthenticated } from "../middlewares/better-auth.js";
import {
  disableCalendarFeed,
  getCalendarFeedState,
  regenerateCalendarFeed,
} from "../services/calendar/calendarFeedService.js";
import { DIGEST_PREFERENCE_KEY } from "../services/calendar/weeklyDigestService.js";

// Lien d'abonnement au calendrier : personnel (utilisateur × espace), il
// ne donne à lire que ce que le rôle voit déjà dans l'application, d'où le
// seul droit « Voir » du calendrier, pour le lire comme pour le gérer
const requireCalendarRead = requireWorkspaceLevel("calendar", "read");

const ownerOf = ({ user, workspaceId }) => ({
  userId: user.id || user._id?.toString(),
  workspaceId,
});

// Préférence du récap du lundi : notificationPreferences.<clé>.email
const DIGEST_EMAIL_PATH = `notificationPreferences.${DIGEST_PREFERENCE_KEY}.email`;
const userObjectId = (user) =>
  new mongoose.Types.ObjectId(String(user._id || user.id));

const calendarFeedResolvers = {
  Query: {
    calendarFeedLink: requireCalendarRead(async (_, __, context) =>
      getCalendarFeedState(ownerOf(context)),
    ),
    // Réglage personnel (tous les espaces de l'utilisateur), lu à part des
    // autres préférences pour que le site reste utilisable avant la mise à
    // jour de l'API
    calendarWeeklyDigest: isAuthenticated(async (_, __, { user }) => {
      const doc = await mongoose.connection.db
        .collection("user")
        .findOne(
          { _id: userObjectId(user) },
          { projection: { [DIGEST_EMAIL_PATH]: 1 } },
        );
      return (
        doc?.notificationPreferences?.[DIGEST_PREFERENCE_KEY]?.email === true
      );
    }),
  },
  Mutation: {
    regenerateCalendarFeedLink: requireCalendarRead(async (_, __, context) =>
      regenerateCalendarFeed(ownerOf(context)),
    ),
    disableCalendarFeedLink: requireCalendarRead(async (_, __, context) =>
      disableCalendarFeed(ownerOf(context)),
    ),
    setCalendarWeeklyDigest: isAuthenticated(
      async (_, { enabled }, { user }) => {
        const value = enabled === true;
        await mongoose.connection.db
          .collection("user")
          .updateOne(
            { _id: userObjectId(user) },
            { $set: { [DIGEST_EMAIL_PATH]: value } },
          );
        return value;
      },
    ),
  },
};

export default calendarFeedResolvers;
