import crypto from "crypto";
import mongoose from "mongoose";
import {
  EVENT_PAYMENT_MODES,
  LOCATION_KINDS,
} from "../utils/appointmentValidation.js";

export const BOOKING_STATUSES = [
  "CONFIRMED",
  "CANCELLED",
  "PENDING_PAYMENT",
  "EXPIRED",
];

/**
 * Réservation d'un créneau sur une page de rendez-vous.
 *
 * Le type, la durée et le lieu sont recopiés au moment de la réservation :
 * modifier ou supprimer le type ne change pas un rendez-vous déjà pris.
 *
 * L'invité gère son rendez-vous sans compte, avec un jeton remis par e-mail.
 * Le jeton n'est jamais stocké en clair (même principe que les liens
 * d'abonnement au calendrier, voir CalendarFeedToken.js) :
 *   - `manageTokenHash` (SHA-256) retrouve la réservation ;
 *   - `manageTokenEncrypted` (AES-256-GCM) permet de remettre le lien de
 *     gestion dans les rappels envoyés par le cron.
 *
 * Deux réservations confirmées ne peuvent pas commencer au même instant pour
 * un même organisateur (index unique partiel) : dernier rempart quand le
 * verrou Redis n'est pas disponible.
 */
const bookingSchema = new mongoose.Schema(
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
    },
    appointmentTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AppointmentType",
      default: null,
    },
    hostUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    // Instantané du type au moment de la réservation
    typeName: { type: String, required: true },
    durationMinutes: { type: Number, required: true },
    location: {
      kind: { type: String, enum: LOCATION_KINDS, required: true },
      value: { type: String, default: null },
    },
    guest: {
      firstName: { type: String, required: true, trim: true, maxlength: 100 },
      lastName: { type: String, required: true, trim: true, maxlength: 100 },
      email: { type: String, required: true, trim: true, lowercase: true },
      phone: { type: String, trim: true, default: null },
      message: { type: String, trim: true, maxlength: 2000, default: null },
      timezone: { type: String, default: null },
    },
    // PENDING_PAYMENT : rendez-vous payant qui attend son paiement, créneau
    // tenu (compté occupé) jusqu'à `expiresAt` ; EXPIRED : jamais payé
    status: {
      type: String,
      enum: BOOKING_STATUSES,
      default: "CONFIRMED",
    },
    cancelledBy: { type: String, enum: ["GUEST", "HOST", null], default: null },
    cancelReason: { type: String, trim: true, maxlength: 1000, default: null },
    cancelledAt: { type: Date, default: null },
    rescheduleHistory: [
      {
        _id: false,
        fromStartAt: Date,
        toStartAt: Date,
        at: { type: Date, default: Date.now },
        by: { type: String, enum: ["GUEST", "HOST"] },
      },
    ],
    manageTokenHash: { type: String, required: true },
    manageTokenEncrypted: { type: String, default: null },
    // Événement Newbi (Calendrier) et événement de l'agenda connecté
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      default: null,
    },
    calendarConnectionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CalendarConnection",
      default: null,
    },
    externalEventId: { type: String, default: null },
    meetingUrl: { type: String, default: null },
    // Lien de visioconférence non créé : explication pour l'organisateur
    meetingWarning: { type: String, default: null },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
    },
    reminders: {
      h24SentAt: { type: Date, default: null },
      h1SentAt: { type: Date, default: null },
    },

    // ─── Rendez-vous payant ────────────────────────────────────────────
    // AUCUNE valeur par défaut : une réservation gratuite (et toutes celles
    // d'avant) ne gagne aucun de ces champs. Lecture avec repli : absent =
    // gratuit (montants 0, mode null). Montants en centimes.
    paymentMode: { type: String, enum: EVENT_PAYMENT_MODES },
    amount: { type: Number, min: 0 },
    currency: { type: String },
    amountOnline: { type: Number, min: 0 },
    amountDueOnSite: { type: Number, min: 0 },
    onSitePaidAt: { type: Date },
    onSitePaidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Fin de la tenue du créneau d'une réservation non payée
    expiresAt: { type: Date },
    // Passage en EXPIRED : le paiement est encore relu 24 h après (filet)
    expiredAt: { type: Date },
    payment: {
      provider: {
        type: String,
        enum: ["stripe", "paypal", "sumup", "bank_transfer"],
      },
      // Session Stripe, commande PayPal ou paiement SumUp
      reference: { type: String },
      // Compte Stripe ou code marchand SumUp du vendeur
      accountId: { type: String },
      // open | pending | capturing | paid | failed | expired
      status: { type: String },
      paymentId: { type: String },
      captureId: { type: String },
      refundReference: { type: String },
      paidAt: { type: Date },
      paidAmount: { type: Number },
      payerEmail: { type: String },
      checkedAt: { type: Date },
      captureClaimedAt: { type: Date },
      returnTokenHash: { type: String },
      returnTokenExpiresAt: { type: Date },
      returnTokenConsumedAt: { type: Date },
      refundedAt: { type: Date },
      refundError: { type: String },
      // Virement : référence NB-XXXXXX, annonce du payeur, marquage manuel
      bankReference: { type: String },
      declaredAt: { type: Date },
      // Virement repéré après la garde ou le début : NON confirmé, gardé
      // pour l'organisateur qui décide (« Marquer comme payé » ou
      // remboursement)
      receivedAt: { type: Date },
      receivedAmount: { type: Number },
      receivedPaymentId: { type: String },
      markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    },
  },
  { timestamps: true, collection: "bookings" },
);

// Pas deux rendez-vous confirmés au même instant pour un organisateur
bookingSchema.index(
  { hostUserId: 1, startAt: 1 },
  { unique: true, partialFilterExpression: { status: "CONFIRMED" } },
);
// Pas deux rendez-vous confirmés ou tenus (en attente de paiement) au même
// instant pour un organisateur. Index distinct de l'existant (nom propre) :
// dernier rempart derrière le verrou de l'organisateur
bookingSchema.index(
  { hostUserId: 1, startAt: 1 },
  {
    name: "host_start_active_unique",
    unique: true,
    partialFilterExpression: {
      status: { $in: ["CONFIRMED", "PENDING_PAYMENT"] },
    },
  },
);
// Tableau de bord : réservations d'un organisateur dans un espace
bookingSchema.index({ workspaceId: 1, hostUserId: 1, startAt: -1 });
bookingSchema.index({ manageTokenHash: 1 }, { unique: true });
// Rappels (cron toutes les 5 minutes)
bookingSchema.index({ status: 1, startAt: 1 });
bookingSchema.index({ appointmentTypeId: 1, status: 1, startAt: 1 });
// Paiements : retour du payeur, expiration et balayage (index clairsemés :
// les réservations gratuites n'y figurent pas)
bookingSchema.index({ "payment.returnTokenHash": 1 }, { sparse: true });
bookingSchema.index({ "payment.reference": 1 }, { sparse: true });
bookingSchema.index(
  { status: 1, expiresAt: 1 },
  { partialFilterExpression: { expiresAt: { $exists: true } } },
);
bookingSchema.index(
  { workspaceId: 1, "payment.bankReference": 1 },
  { partialFilterExpression: { "payment.bankReference": { $exists: true } } },
);

// ─── Jeton de gestion ─────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const PREFIX = "v1";

export const MANAGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Clé lue à l'usage : une variable absente ne casse que les rappels
function encryptionKey() {
  const raw =
    process.env.CALENDAR_ENCRYPTION_KEY || process.env.SMTP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CALENDAR_ENCRYPTION_KEY (ou SMTP_ENCRYPTION_KEY) doit être défini pour les liens de gestion des rendez-vous",
    );
  }
  return crypto
    .createHmac("sha256", raw)
    .update("booking-manage-token")
    .digest();
}

/** Jeton aléatoire de 256 bits, en base64url (43 caractères). */
export function generateManageToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashManageToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/** Format : v1:iv:tag:données (base64url). Null si la clé manque. */
export function encryptManageToken(token) {
  try {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey(), iv);
    const data = Buffer.concat([
      cipher.update(String(token), "utf8"),
      cipher.final(),
    ]);
    return [
      PREFIX,
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      data.toString("base64url"),
    ].join(":");
  } catch {
    return null;
  }
}

/** Jeton en clair, ou null si la valeur est illisible (clé changée…). */
export function decryptManageToken(value) {
  try {
    const [prefix, iv, tag, data] = String(value || "").split(":");
    if (prefix !== PREFIX || !iv || !tag || !data) return null;
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      encryptionKey(),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export default mongoose.models.Booking ||
  mongoose.model("Booking", bookingSchema);
