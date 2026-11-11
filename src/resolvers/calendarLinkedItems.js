import { requireWorkspaceLevel } from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import {
  getCalendarLinkedItems,
  getCalendarOverdueItems,
  validateRange,
} from "../services/calendar/linkedItemsService.js";
import { getCalendarTreasury } from "../services/calendar/treasuryService.js";

function assertRange(from, to) {
  const rangeError = validateRange(from, to);
  if (rangeError) {
    throw new AppError(rangeError, ERROR_CODES.VALIDATION_ERROR);
  }
}

// Échéances des autres pages affichées dans le calendrier (lecture seule),
// chaque source filtrée par le droit « Voir » de sa page
const calendarLinkedItemsResolvers = {
  Query: {
    calendarLinkedItems: requireWorkspaceLevel(
      "calendar",
      "read",
    )(async (_, { from, to }, { user, workspaceId, permissions, db }) => {
      assertRange(from, to);
      return getCalendarLinkedItems({
        workspaceId,
        userId: user.id || user._id?.toString(),
        permissions,
        db,
        from,
        to,
      });
    }),

    // Tout ce qui est en retard, quelle que soit la date (bouton
    // « En retard » du calendrier)
    calendarOverdueItems: requireWorkspaceLevel(
      "calendar",
      "read",
    )(async (_, __, { user, workspaceId, permissions, db }) =>
      getCalendarOverdueItems({
        workspaceId,
        userId: user.id || user._id?.toString(),
        permissions,
        db,
      }),
    ),

    calendarTreasury: requireWorkspaceLevel(
      "calendar",
      "read",
    )(async (_, { from, to }, { user, workspaceId, permissions, db }) => {
      assertRange(from, to);
      return getCalendarTreasury({
        workspaceId,
        userId: user.id || user._id?.toString(),
        permissions,
        db,
        from,
        to,
      });
    }),
  },
};

export default calendarLinkedItemsResolvers;
