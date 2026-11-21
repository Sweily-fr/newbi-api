import CalendarEventType from "../models/CalendarEventType.js";
import {
  checkSubscriptionActive,
  requireWorkspaceLevel,
} from "../middlewares/rbac.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";

const MAX_TYPES = 30;

const toResponse = (types, message) => ({
  success: true,
  message,
  types: (types || []).map(({ id, name, color, allDay }) => ({
    id,
    name,
    color,
    allDay: Boolean(allDay),
  })),
});

const calendarEventTypesResolvers = {
  Query: {
    getCalendarEventTypes: requireWorkspaceLevel(
      "calendar",
      "read",
    )(async (_, __, { workspaceId }) => {
      const doc = await CalendarEventType.findOne({ workspaceId }).lean();
      return toResponse(doc?.types, "Types d'événements récupérés");
    }),
  },

  Mutation: {
    updateCalendarEventTypes: requireWorkspaceLevel(
      "calendar",
      "write",
    )(async (_, { types }, context) => {
      await checkSubscriptionActive(context);
      const cleaned = types.map(({ id, name, color, allDay }) => ({
        id: String(id).trim(),
        name: String(name).trim(),
        color: String(color).trim(),
        allDay: Boolean(allDay),
      }));
      if (cleaned.length > MAX_TYPES) {
        throw new AppError(
          `${MAX_TYPES} types d'événements au plus.`,
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      if (cleaned.some((type) => !type.id || !type.name || !type.color)) {
        throw new AppError(
          "Chaque type d'événement a besoin d'un nom et d'une couleur.",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      const doc = await CalendarEventType.findOneAndUpdate(
        { workspaceId: context.workspaceId },
        { types: cleaned },
        { upsert: true, new: true, runValidators: true },
      ).lean();
      return toResponse(doc.types, "Types d'événements mis à jour");
    }),
  },
};

export default calendarEventTypesResolvers;
