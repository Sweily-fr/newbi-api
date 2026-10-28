import mongoose from "mongoose";
import {
  DEFAULT_SLOT_INTERVAL,
  LOCATION_KINDS,
  SLOT_INTERVALS,
} from "../utils/appointmentValidation.js";

/**
 * Type de rendez-vous d'une page de réservation (« Rendez-vous de 30 min »,
 * « Démonstration »…), publié sur /rdv/<page>/<type>.
 *
 * Lieu : GOOGLE_MEET et TEAMS créent le lien avec l'agenda connecté de
 * l'organisateur ; CUSTOM_LINK porte une adresse https ; IN_PERSON une
 * adresse postale ; PHONE signifie « l'organisateur appelle » (téléphone de
 * l'invité obligatoire).
 */
const appointmentTypeSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    bookingPageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BookingPage",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Unique dans la page
    slug: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: null },
    durationMinutes: { type: Number, required: true, min: 5, max: 480 },
    slotIntervalMinutes: {
      type: Number,
      enum: SLOT_INTERVALS,
      default: DEFAULT_SLOT_INTERVAL,
    },
    location: {
      kind: { type: String, enum: LOCATION_KINDS, required: true },
      value: { type: String, default: null },
    },
    bufferBeforeMinutes: { type: Number, min: 0, max: 240, default: 0 },
    bufferAfterMinutes: { type: Number, min: 0, max: 240, default: 0 },
    // Préavis : pas de réservation moins de 4 h avant par défaut
    minNoticeMinutes: { type: Number, min: 0, default: 240 },
    // Horizon : réservable jusqu'à 60 jours à l'avance par défaut
    maxDaysAhead: { type: Number, min: 1, max: 365, default: 60 },
    // Réservations de ce type par jour (jour de la page) ; null = illimité
    maxPerDay: { type: Number, min: 1, default: null },
    color: { type: String, default: null },
    position: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    requirePhone: { type: Boolean, default: false },
    // Réservés au paiement en ligne (V2), jamais lus en V1
    priceAmount: { type: Number, default: null },
    currency: { type: String, default: null },
  },
  { timestamps: true, collection: "appointment_types" },
);

appointmentTypeSchema.index({ bookingPageId: 1, slug: 1 }, { unique: true });
appointmentTypeSchema.index({ workspaceId: 1, userId: 1 });

export default mongoose.models.AppointmentType ||
  mongoose.model("AppointmentType", appointmentTypeSchema);
