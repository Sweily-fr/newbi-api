import crypto from "crypto";
import mongoose from "mongoose";
import {
  EVENT_PAYMENT_MODES,
  LOCATION_KINDS,
} from "../utils/appointmentValidation.js";

/**
 * Inscription à un événement (type de rendez-vous `kind: EVENT`) :
 * billetterie de la prise de rendez-vous.
 *
 * Une inscription porte de 1 à 10 billets au nom de l'acheteur. Les places
 * sont réservées sur le type (compteur `seatsTaken`) AVANT l'enregistrement,
 * y compris en attente de paiement ; une inscription non payée expire
 * après 30 minutes et rend ses places.
 *
 * Jetons (même principe que Booking.js) : jamais en clair en base.
 *   - gestion : `manageTokenHash` retrouve l'inscription, la version
 *     chiffrée sert aux rappels et à la page de retour ;
 *   - billet : `tickets.tokenHash` retrouve le billet (QR code), la version
 *     chiffrée sert aux e-mails et à la page de gestion ;
 *   - retour de paiement : `payment.returnTokenHash`.
 */

export const REGISTRATION_STATUSES = [
  "PENDING_PAYMENT",
  "CONFIRMED",
  "CANCELLED",
  "EXPIRED",
];

const ticketSchema = new mongoose.Schema(
  {
    // « EVT-7K3M9Q », unique (index ci-dessous)
    number: { type: String, required: true },
    tokenHash: { type: String, required: true },
    tokenEncrypted: { type: String, default: null },
    attendeeName: { type: String, required: true, trim: true, maxlength: 201 },
    checkedInAt: { type: Date, default: null },
    checkedInBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { _id: true },
);

const eventRegistrationSchema = new mongoose.Schema(
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
      required: true,
    },
    hostUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Instantané de l'événement (mis à jour quand l'organisateur le modifie)
    event: {
      name: { type: String, required: true },
      startAt: { type: Date, required: true },
      endAt: { type: Date, required: true },
      location: {
        kind: { type: String, enum: LOCATION_KINDS, required: true },
        value: { type: String, default: null },
      },
      timezone: { type: String, default: null },
    },
    buyer: {
      firstName: { type: String, required: true, trim: true, maxlength: 100 },
      lastName: { type: String, required: true, trim: true, maxlength: 100 },
      email: { type: String, required: true, trim: true, lowercase: true },
      phone: { type: String, trim: true, default: null },
      timezone: { type: String, default: null },
    },
    quantity: { type: Number, required: true, min: 1, max: 10 },
    // Montants en centimes (0 = gratuit)
    unitAmount: { type: Number, required: true, min: 0, default: 0 },
    amount: { type: Number, required: true, min: 0, default: 0 },
    currency: { type: String, default: "EUR" },
    // Paiement d'un événement payant (inscriptions créées après l'ajout de
    // l'acompte ; AUCUNE valeur par défaut, lecture avec repli : voir
    // amountOnlineOf et amountDueOnSiteOf dans eventRegistrationService.js).
    // amountOnline : payé en ligne (acompte ou total, 0 sur place) ;
    // amountDueOnSite : reste à régler sur place (amount - amountOnline)
    paymentMode: { type: String, enum: EVENT_PAYMENT_MODES },
    amountOnline: { type: Number, min: 0 },
    amountDueOnSite: { type: Number, min: 0 },
    // Reste réglé sur place, marqué par l'organisateur
    onSitePaidAt: { type: Date },
    onSitePaidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    status: {
      type: String,
      enum: REGISTRATION_STATUSES,
      required: true,
    },
    // Places encore comptées dans seatsTaken du type (rendues une seule fois)
    seatsHeld: { type: Boolean, default: true },
    // Fin de la réservation des places d'une inscription non payée
    expiresAt: { type: Date, default: null },
    // Passage en EXPIRED : le paiement est encore relu 24 h après (filet)
    expiredAt: { type: Date, default: null },
    payment: {
      provider: {
        type: String,
        enum: ["stripe", "paypal", "sumup", "bank_transfer", null],
        default: null,
      },
      // Session Stripe, commande PayPal ou paiement SumUp
      reference: { type: String, default: null },
      // Compte Stripe ou code marchand SumUp du vendeur
      accountId: { type: String, default: null },
      // open | pending | paid | failed
      status: { type: String, default: null },
      // PaymentIntent Stripe, capture PayPal, paiement SumUp
      paymentId: { type: String, default: null },
      captureId: { type: String, default: null },
      // Transaction SumUp (remboursement)
      refundReference: { type: String, default: null },
      paidAt: { type: Date, default: null },
      paidAmount: { type: Number, default: null },
      payerEmail: { type: String, default: null },
      checkedAt: { type: Date, default: null },
      // PayPal : encaissement revendiqué (une seule capture à la fois, et
      // jamais sur une inscription expirée ou annulée entre-temps)
      captureClaimedAt: { type: Date, default: null },
      returnTokenHash: { type: String, default: null },
      returnTokenExpiresAt: { type: Date, default: null },
      // Première réponse « confirmée » au retour : le jeton ne sert plus
      // que quelques minutes, ensuite le lien de gestion prend le relais
      returnTokenConsumedAt: { type: Date, default: null },
      // Paiement arrivé sans place disponible : remboursé
      refundedAt: { type: Date, default: null },
      refundError: { type: String, default: null },
      // Virement (sans valeur par défaut : les inscriptions d'avant n'en
      // gagnent aucun) : référence NB-XXXXXX, annonce « J'ai fait le
      // virement », marquage « payé » par l'organisateur
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
    manageTokenHash: { type: String, required: true },
    manageTokenEncrypted: { type: String, default: null },
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
    },
    tickets: { type: [ticketSchema], default: [] },
    cancelledBy: { type: String, enum: ["GUEST", "HOST", null], default: null },
    cancelReason: { type: String, trim: true, maxlength: 1000, default: null },
    cancelledAt: { type: Date, default: null },
    reminders: {
      h24SentAt: { type: Date, default: null },
    },
    // E-mails de confirmation envoyés (jamais deux fois)
    confirmationSentAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "event_registrations" },
);

eventRegistrationSchema.index({ manageTokenHash: 1 }, { unique: true });
// Billets créés à la confirmation : une inscription en attente n'en a pas
// (filtre partiel, un tableau vide ne compte pas comme doublon)
eventRegistrationSchema.index(
  { "tickets.number": 1 },
  {
    unique: true,
    partialFilterExpression: { "tickets.number": { $exists: true } },
  },
);
eventRegistrationSchema.index(
  { "tickets.tokenHash": 1 },
  {
    unique: true,
    partialFilterExpression: { "tickets.tokenHash": { $exists: true } },
  },
);
eventRegistrationSchema.index(
  { "payment.returnTokenHash": 1 },
  { sparse: true },
);
eventRegistrationSchema.index({ "payment.reference": 1 }, { sparse: true });
// Repérage des virements (synchronisation bancaire)
eventRegistrationSchema.index(
  { workspaceId: 1, "payment.bankReference": 1 },
  { partialFilterExpression: { "payment.bankReference": { $exists: true } } },
);
// Tableau de bord : inscrits d'un événement
eventRegistrationSchema.index({
  workspaceId: 1,
  hostUserId: 1,
  appointmentTypeId: 1,
  createdAt: -1,
});
// Expiration et balayage des paiements
eventRegistrationSchema.index({ status: 1, expiresAt: 1 });
// Rappels de la veille
eventRegistrationSchema.index({ status: 1, "event.startAt": 1 });

// ─── Numéros et jetons ─────────────────────────────────────────────────────

// Sans 0/O ni 1/I pour éviter les erreurs de saisie
const NUMBER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const TICKET_NUMBER_PATTERN = /^EVT-[A-HJ-NP-Z2-9]{6}$/;
export const TICKET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateTicketNumber() {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += NUMBER_ALPHABET[crypto.randomInt(NUMBER_ALPHABET.length)];
  }
  return `EVT-${code}`;
}

/** Jeton aléatoire de 256 bits en base64url (43 caractères). */
export const generateTicketToken = () =>
  crypto.randomBytes(32).toString("base64url");

export const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

/**
 * Numéro saisi à la main : « evt 7k3m9q », « 7K3M9Q », « EVT-7K3M9Q ».
 * @returns {string|null} numéro canonique ou null
 */
export function normalizeTicketNumber(value) {
  const compact = String(value || "")
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
  const code = compact.startsWith("EVT") ? compact.slice(3) : compact;
  const number = `EVT-${code}`;
  return TICKET_NUMBER_PATTERN.test(number) ? number : null;
}

// ─── Inscription : montants (lecture avec repli) ──────────────────────────

/**
 * Montant payé (ou à payer) en ligne. Inscriptions d'avant l'acompte :
 * le total si un paiement en ligne a été lancé, sinon 0.
 */
export function amountOnlineOf(registration) {
  if (Number.isFinite(registration?.amountOnline)) {
    return registration.amountOnline;
  }
  return registration?.payment?.provider ? registration.amount || 0 : 0;
}

/** Reste à régler sur place (le dû, réglé ou non ; 0 avant l'acompte). */
export const amountDueOnSiteOf = (registration) =>
  Number.isFinite(registration?.amountDueOnSite)
    ? registration.amountDueOnSite
    : 0;

/** Mode de paiement d'une inscription (ONLINE avant l'acompte si payante). */
export const registrationPaymentModeOf = (registration) =>
  registration?.paymentMode || (registration?.amount > 0 ? "ONLINE" : null);

/**
 * Montant attendu chez le prestataire pour une inscription : l'acompte ou
 * le total (inscriptions d'avant l'acompte : le total).
 */
export const expectedOnlineAmount = (registration) =>
  Number.isFinite(registration?.amountOnline)
    ? registration.amountOnline
    : registration.amount || 0;

export default mongoose.models.EventRegistration ||
  mongoose.model("EventRegistration", eventRegistrationSchema);
