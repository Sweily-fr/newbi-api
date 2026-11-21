import mongoose from "mongoose";

/**
 * Types d'événements créés par un espace (« Rendez-vous client »,
 * « Réunion d'équipe »…), proposés à la création d'un événement à côté des
 * déclarations Newbi : un type remplit le titre, la couleur et la journée
 * entière. Un document par espace, comme les étiquettes de couleur.
 */
const eventTypeEntrySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    color: { type: String, required: true, trim: true, maxlength: 20 },
    allDay: { type: Boolean, default: false },
  },
  { _id: false },
);

const calendarEventTypeSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      unique: true,
    },
    types: {
      type: [eventTypeEntrySchema],
      validate: {
        validator: (types) =>
          types.length <= 30 &&
          new Set(types.map((type) => type.id)).size === types.length,
        message: "30 types d'événements au plus, chacun avec son identifiant.",
      },
    },
  },
  { timestamps: true },
);

const CalendarEventType =
  mongoose.models.CalendarEventType ||
  mongoose.model("CalendarEventType", calendarEventTypeSchema);

export default CalendarEventType;
