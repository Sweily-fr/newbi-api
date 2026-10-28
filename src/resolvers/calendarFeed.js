import { requireWorkspaceLevel } from "../middlewares/rbac.js";
import {
  disableCalendarFeed,
  getCalendarFeedState,
  regenerateCalendarFeed,
} from "../services/calendar/calendarFeedService.js";

// Lien d'abonnement au calendrier : personnel (utilisateur × espace), il
// ne donne à lire que ce que le rôle voit déjà dans l'application, d'où le
// seul droit « Voir » du calendrier, pour le lire comme pour le gérer
const requireCalendarRead = requireWorkspaceLevel("calendar", "read");

const ownerOf = ({ user, workspaceId }) => ({
  userId: user.id || user._id?.toString(),
  workspaceId,
});

const calendarFeedResolvers = {
  Query: {
    calendarFeedLink: requireCalendarRead(async (_, __, context) =>
      getCalendarFeedState(ownerOf(context)),
    ),
  },
  Mutation: {
    regenerateCalendarFeedLink: requireCalendarRead(async (_, __, context) =>
      regenerateCalendarFeed(ownerOf(context)),
    ),
    disableCalendarFeedLink: requireCalendarRead(async (_, __, context) =>
      disableCalendarFeed(ownerOf(context)),
    ),
  },
};

export default calendarFeedResolvers;
