import { requireWorkspaceLevel } from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import {
  getCalendarLinkedItems,
  validateRange,
} from "../services/calendar/linkedItemsService.js";

// Échéances des autres pages affichées dans le calendrier (lecture seule),
// chaque source filtrée par le droit « Voir » de sa page
const calendarLinkedItemsResolvers = {
  Query: {
    calendarLinkedItems: requireWorkspaceLevel(
      "calendar",
      "read",
    )(async (_, { from, to }, { user, workspaceId, permissions, db }) => {
      const rangeError = validateRange(from, to);
      if (rangeError) {
        throw new AppError(rangeError, ERROR_CODES.VALIDATION_ERROR);
      }
      return getCalendarLinkedItems({
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
