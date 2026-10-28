import mongoose from "mongoose";
import {
  DEFAULT_ACCENT_COLOR,
  DEFAULT_AVAILABILITY,
  DEFAULT_TIMEZONE,
} from "../utils/appointmentValidation.js";

/**
 * Page de réservation (Communication > Prise de rendez-vous) : une par
 * utilisateur et par espace, publiée sur www.newbi.fr/rdv/<slug>.
 *
 * Les horaires sont exprimés dans le fuseau de la page (`timezone`) :
 * semaine type (jours ISO, 1 = lundi) et exceptions par date (liste vide =
 * jour fermé). Les créneaux sont calculés par utils/appointmentSlots.js.
 */
const intervalSchema = new mongoose.Schema(
  {
    start: { type: String, required: true },
    end: { type: String, required: true },
  },
  { _id: false },
);

const availabilityDaySchema = new mongoose.Schema(
  {
    dayOfWeek: { type: Number, required: true, min: 1, max: 7 },
    intervals: { type: [intervalSchema], default: [] },
  },
  { _id: false },
);

const dateOverrideSchema = new mongoose.Schema(
  {
    date: { type: String, required: true },
    intervals: { type: [intervalSchema], default: [] },
  },
  { _id: false },
);

const bookingPageSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    // Organisateur (une seule personne en V1)
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Adresse publique, unique sur tout Newbi
    slug: { type: String, required: true, trim: true, lowercase: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: null },
    accentColor: { type: String, default: DEFAULT_ACCENT_COLOR },
    // Vide : logo de l'organisation côté public
    avatarUrl: { type: String, default: null },
    timezone: { type: String, default: DEFAULT_TIMEZONE },
    isActive: { type: Boolean, default: true },
    availability: {
      type: [availabilityDaySchema],
      default: () => DEFAULT_AVAILABILITY.map((day) => ({ ...day })),
    },
    dateOverrides: { type: [dateOverrideSchema], default: [] },
    // Agenda où écrire les rendez-vous (null : première connexion active,
    // Google puis Microsoft puis Apple)
    writeConnectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CalendarConnection",
      default: null,
    },
    // Agendas lus pour les créneaux occupés (vide : toutes les connexions
    // actives de l'organisateur)
    busyConnectionIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "CalendarConnection" },
    ],
  },
  { timestamps: true, collection: "booking_pages" },
);

bookingPageSchema.index({ slug: 1 }, { unique: true });
bookingPageSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

export default mongoose.models.BookingPage ||
  mongoose.model("BookingPage", bookingPageSchema);
