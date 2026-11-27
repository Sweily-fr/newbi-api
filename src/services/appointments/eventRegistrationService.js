/**
 * Billetterie des événements (types de rendez-vous `kind: EVENT`).
 *
 * Inscription, dans l'ordre :
 *   1. participant bloqué dans le CRM : refus (« UNAVAILABLE ») ;
 *   2. places réservées de façon ATOMIQUE sur le type : $inc conditionnel
 *      `seatsTaken + quantité <= capacity` (aucun verrou, aucune survente,
 *      même avec plusieurs instances) ;
 *   3. inscription enregistrée (places rendues si l'écriture échoue) ;
 *   4. gratuite : confirmée tout de suite (billets, client CRM, e-mails) ;
 *      payante : `PENDING_PAYMENT` 30 minutes, paiement créé sur le compte
 *      du vendeur (Stripe, PayPal ou SumUp, voir payments/directPayments.js).
 *
 * Un paiement n'est jamais tenu pour acquis sur un simple retour du
 * payeur : il est relu auprès du prestataire (retour, webhook Stripe
 * Connect, notification SumUp, balayage toutes les 5 minutes), et doit
 * correspondre à l'inscription, au compte du vendeur, au montant et à la
 * devise. Un paiement arrivé après l'expiration est confirmé s'il reste des
 * places, sinon remboursé.
 */
import crypto from "crypto";
import mongoose from "mongoose";
import QRCode from "qrcode";
import AppointmentType from "../../models/AppointmentType.js";
import BookingPage from "../../models/BookingPage.js";
import Event from "../../models/Event.js";
import EventRegistration, {
  TICKET_TOKEN_PATTERN,
  amountDueOnSiteOf,
  amountOnlineOf,
  expectedOnlineAmount,
  registrationPaymentModeOf,
  generateTicketNumber,
  generateTicketToken,
  hashToken,
  normalizeTicketNumber,
} from "../../models/EventRegistration.js";
import {
  MANAGE_TOKEN_PATTERN,
  decryptManageToken,
  encryptManageToken,
  generateManageToken,
  hashManageToken,
} from "../../models/Booking.js";
import {
  attachClient,
  findClientByEmail,
  loadBookingParties,
  organizationNameOf,
  pageZone,
} from "./bookingService.js";
import { deliverBookingEmail } from "./bookingEmails.js";
import {
  buildEventCancelledEmail,
  buildEventChangedEmail,
  buildEventConfirmationEmail,
  buildEventHostCancelledEmail,
  buildEventHostNewRegistrationEmail,
  buildEventReminderEmail,
  registrationIcsPath,
  registrationManageUrlFor,
  ticketQrUrlFor,
  ticketUrlFor,
} from "./eventEmails.js";
import {
  DirectPaymentUnavailableError,
  ONLINE_PAYMENT_PROVIDERS,
  closeDirectCheckout,
  createDirectCheckout,
  directStripeAccountIds,
  findSumupAccount,
  isSumupAccountReady,
  readyStripeAccount,
  refundDirectPayment,
  retrieveStripeSession,
  sameAmount,
} from "../payments/directPayments.js";
import {
  PaypalApiError,
  capturePaypalOrder,
  getPaypalCapture,
  getPaypalOrder,
  isPaypalConfigured,
  isPaypalId,
  summarizePaypalOrder,
} from "../paypalService.js";
import {
  getSumupCheckout,
  isSumupCheckoutId,
  isSumupConfigured,
  summarizeSumupCheckout,
} from "../sumupService.js";
import PaypalMerchantAccount from "../../models/PaypalMerchantAccount.js";
import { paymentReturnBase } from "../transferPaymentService.js";
import { isBankTransferAvailable } from "../payments/bankTransfer.js";
import {
  BANK_TRANSFER,
  PENDING_PAYMENT_CAP_MS,
  bankTransferDueAt,
  bankTransferOpenFor,
  bankTransferPayload,
  buildLatePaymentEmail,
  latePaymentReason,
  buildBankTransferPendingEmail,
  buildPaymentExpiredEmail,
  declareBankTransfer,
  newBankReference,
  notifyHostBankDeclared,
  notifyHostRefundNeeded,
} from "./appointmentPayments.js";
import { formatWhen, publicPageUrl } from "./bookingEmails.js";
import { publishCalendarEventsChanged } from "../calendar/CalendarWebhookService.js";
import {
  eventDepositAmountOf,
  eventPaymentModeOf,
  locationLabel,
} from "../../utils/appointmentValidation.js";
import logger from "../../utils/logger.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
export { amountDueOnSiteOf, amountOnlineOf, registrationPaymentModeOf };

// Places bloquées pour une inscription non payée
export const PENDING_TTL_MS = 30 * MINUTE;
// Session Stripe : 30 minutes au moins (exigence Stripe), un peu plus que
// la réservation des places
const STRIPE_SESSION_TTL_S = 31 * 60;
// Jeton de retour du payeur : valable une heure (comme les transferts) ;
// après la première réponse « confirmée », quelques minutes seulement
// (double chargement de la page), puis le lien de gestion prend le relais
export const RETURN_TOKEN_TTL_MS = HOUR;
const RETURN_TOKEN_GRACE_MS = 5 * MINUTE;
// Encaissement PayPal revendiqué : une revendication plus ancienne est
// tenue pour abandonnée (processus arrêté pendant la capture)
const CAPTURE_CLAIM_MS = 2 * MINUTE;
// Inscription expirée : paiement encore relu 24 h (paiement tombé pendant
// la fermeture chez le prestataire)
const EXPIRED_RECHECK_MS = 24 * HOUR;
// Inscription annulée ou expirée qui garde ses places (arrêt entre les deux
// écritures) : places rendues par le balayage au-delà de ce délai
const SEATS_RECONCILE_DELAY_MS = MINUTE;
// Relecture chez le prestataire : au plus une fois par intervalle
const RECHECK_INTERVAL_MS = 15 * 1000;
const FORCED_RECHECK_INTERVAL_MS = 3 * 1000;
const LOG = "[billetterie]";

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));
const isObjectId = (id) =>
  typeof id === "string"
    ? /^[a-f0-9]{24}$/i.test(id)
    : id instanceof mongoose.Types.ObjectId;

export class EventRegistrationError extends Error {
  /**
   * @param {string} code - NOT_FOUND, REGISTRATION_CLOSED, SOLD_OUT,
   *   PAYMENT_METHOD_UNAVAILABLE, PAYMENT_START_FAILED, UNAVAILABLE, NOT_ALLOWED
   * @param {number} status - statut HTTP de la route publique
   * @param {object} [extra] - champs ajoutés à la réponse (seatsLeft…)
   */
  constructor(code, status, extra = {}) {
    super(code);
    this.name = "EventRegistrationError";
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

// ─── Événement : état public ──────────────────────────────────────────────

export const isEvent = (type) => type?.kind === "EVENT";

/** Places restantes (null = illimité). */
export function seatsLeftOf(type) {
  if (type?.capacity == null) return null;
  return Math.max(0, type.capacity - (type.seatsTaken || 0));
}

export const registrationClosesAtOf = (type) =>
  type.registrationClosesAt || type.startAt;

/** Inscriptions ouvertes (actif, avant la clôture, places restantes). */
export function registrationOpen(type, now = new Date()) {
  if (!isEvent(type) || type.isActive === false) return false;
  const closes = registrationClosesAtOf(type);
  if (!closes || new Date(closes) <= now) return false;
  const left = seatsLeftOf(type);
  return left == null || left > 0;
}

export const priceOf = (type) =>
  type?.priceAmount > 0
    ? { amount: type.priceAmount, currency: type.currency || "EUR" }
    : null;

/** Mode de paiement d'un événement (null s'il est gratuit, ONLINE par défaut). */
export const paymentModeOf = (type) => eventPaymentModeOf(type);

/** Montant d'une place payé en ligne : prix, acompte ou 0 (sur place). */
export function onlineUnitAmountOf(type) {
  const mode = eventPaymentModeOf(type);
  if (mode === "ONLINE") return type.priceAmount;
  if (mode === "DEPOSIT") return eventDepositAmountOf(type) || type.priceAmount;
  return 0;
}

/**
 * Moyens de paiement prêts pour encaisser un billet ou un rendez-vous
 * (sous-ensemble de stripe, paypal, sumup, bank_transfer, dans cet ordre ;
 * virement : IBAN de l'entreprise renseigné).
 */
export async function eventPaymentMethods(workspaceId) {
  const orgId = workspaceId ? String(workspaceId) : null;
  if (!orgId) return [];
  const [stripe, paypal, sumup, bank] = await Promise.all([
    readyStripeAccount(orgId),
    isPaypalConfigured()
      ? PaypalMerchantAccount.findOne({ organizationId: orgId })
          .select("email")
          .lean()
      : null,
    isSumupConfigured() ? findSumupAccount(orgId) : null,
    isBankTransferAvailable(orgId),
  ]);
  const methods = [];
  if (stripe) methods.push("stripe");
  if (paypal?.email) methods.push("paypal");
  if (
    isSumupAccountReady(sumup) &&
    (!sumup.currency || String(sumup.currency).toUpperCase() === "EUR")
  ) {
    methods.push("sumup");
  }
  if (bank) methods.push("bank_transfer");
  return methods;
}

/** Alias : mêmes moyens pour les créneaux payants. */
export const appointmentPaymentMethods = eventPaymentMethods;

const iso = (date) => (date ? new Date(date).toISOString() : null);

/** Résumé d'un événement pour la liste de la page publique. */
export function publicEventSummary(type, now = new Date()) {
  if (!isEvent(type)) return null;
  const left = seatsLeftOf(type);
  return {
    startAt: iso(type.startAt),
    endAt: iso(type.endAt),
    imageUrl: type.imageUrl || null,
    coverImageUrl: type.coverImageUrl || null,
    price: priceOf(type),
    paymentMode: paymentModeOf(type),
    depositAmount: eventDepositAmountOf(type),
    seatsLeft: left,
    soldOut: left === 0,
    registrationOpen: registrationOpen(type, now),
  };
}

/** Détail d'un événement pour sa page publique. */
export async function publicEventDetail(type, now = new Date()) {
  const left = seatsLeftOf(type);
  const price = priceOf(type);
  const methods = price ? await eventPaymentMethods(type.workspaceId) : [];
  return {
    ...publicEventSummary(type, now),
    details: type.details || null,
    address:
      type.location?.kind === "IN_PERSON" ? type.location.value || null : null,
    capacity: type.capacity ?? null,
    maxPerOrder: Math.max(
      1,
      left == null
        ? type.maxPerOrder || 5
        : Math.min(type.maxPerOrder || 5, Math.max(left, 1)),
    ),
    registrationClosesAt: iso(registrationClosesAtOf(type)),
    paymentMethods: methods,
    // Virement proposé (moyen connecté et début à 48 h au moins)
    bankTransferAvailable:
      methods.includes(BANK_TRANSFER) && bankTransferOpenFor(type.startAt, now),
  };
}

// ─── Places ───────────────────────────────────────────────────────────────

/**
 * Réserve `quantity` places, atomiquement. Null si l'événement n'a plus
 * assez de places (ou n'est plus actif).
 */
export async function reserveSeats(typeId, quantity) {
  return AppointmentType.findOneAndUpdate(
    {
      _id: typeId,
      kind: "EVENT",
      $or: [
        { capacity: null },
        {
          $expr: {
            $lte: [
              { $add: [{ $ifNull: ["$seatsTaken", 0] }, quantity] },
              "$capacity",
            ],
          },
        },
      ],
    },
    { $inc: { seatsTaken: quantity } },
    { new: true },
  );
}

async function giveBackSeats(typeId, quantity) {
  await AppointmentType.updateOne(
    { _id: typeId, seatsTaken: { $gte: quantity } },
    { $inc: { seatsTaken: -quantity } },
  );
}

/**
 * Rend les places d'une inscription, une seule fois (seatsHeld basculé
 * atomiquement). @returns {Promise<boolean>}
 */
export async function releaseSeats(registration) {
  const flipped = await EventRegistration.findOneAndUpdate(
    { _id: registration._id, seatsHeld: true },
    { $set: { seatsHeld: false } },
  );
  if (!flipped) return false;
  await giveBackSeats(registration.appointmentTypeId, registration.quantity);
  return true;
}

// ─── Billets ──────────────────────────────────────────────────────────────

const attendeeNameOf = (buyer) =>
  `${buyer.firstName} ${buyer.lastName}`.trim().slice(0, 201);

/** Billets neufs (jetons en clair renvoyés à part, jamais stockés). */
function newTickets(registration) {
  const plain = [];
  const stored = [];
  for (let i = 0; i < registration.quantity; i += 1) {
    const token = generateTicketToken();
    const number = generateTicketNumber();
    const attendeeName = attendeeNameOf(registration.buyer);
    const _id = new mongoose.Types.ObjectId();
    stored.push({
      _id,
      number,
      tokenHash: hashToken(token),
      tokenEncrypted: encryptManageToken(token),
      attendeeName,
      checkedInAt: null,
      checkedInBy: null,
    });
    plain.push({ _id, number, token, attendeeName, checkedInAt: null });
  }
  return { plain, stored };
}

/** Jetons en clair des billets (déchiffrés), pour les e-mails et la page de gestion. */
export function plainTickets(registration) {
  return (registration.tickets || []).map((ticket) => ({
    _id: ticket._id,
    number: ticket.number,
    attendeeName: ticket.attendeeName,
    checkedInAt: ticket.checkedInAt || null,
    token: ticket.tokenEncrypted
      ? decryptManageToken(ticket.tokenEncrypted)
      : null,
  }));
}

/**
 * Passe l'inscription en CONFIRMED (depuis `fromStatus`) et crée ses
 * billets. Numéro de billet en doublon (très rare) : nouveau tirage.
 * @returns {Promise<{registration, tickets}|null>} null si l'état a changé entre-temps
 */
async function confirmWithTickets(
  registration,
  fromStatuses,
  extraSet = {},
  extraFilter = {},
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { plain, stored } = newTickets(registration);
    try {
      const updated = await EventRegistration.findOneAndUpdate(
        {
          _id: registration._id,
          status: { $in: fromStatuses },
          ...extraFilter,
        },
        {
          $set: {
            status: "CONFIRMED",
            tickets: stored,
            expiresAt: null,
            ...extraSet,
          },
        },
        { new: true },
      );
      if (!updated) return null;
      return { registration: updated, tickets: plain };
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  throw new Error("numéros de billet en doublon répétés");
}

// ─── Contexte (page, organisateur) ────────────────────────────────────────

async function registrationContext(registration) {
  const [page, type, parties] = await Promise.all([
    BookingPage.findById(registration.bookingPageId).lean(),
    AppointmentType.findById(registration.appointmentTypeId).lean(),
    loadBookingParties(registration),
  ]);
  return { page, type, ...parties };
}

const pagePayload = (page, organizationName) =>
  page
    ? {
        slug: page.slug,
        title: page.title,
        accentColor: page.accentColor || null,
        organizationName: organizationName || null,
      }
    : null;

function eventPayload(registration, type, page, { confirmed }) {
  const event = registration.event;
  const location = event.location || {};
  return {
    name: event.name,
    startAt: iso(event.startAt),
    endAt: iso(event.endAt),
    timezone: event.timezone || pageZone(page),
    locationKind: location.kind || null,
    locationLabel:
      location.kind === "CUSTOM_LINK" ? "En ligne" : locationLabel(location),
    address: location.kind === "IN_PERSON" ? location.value || null : null,
    link:
      location.kind === "CUSTOM_LINK" && confirmed
        ? location.value || null
        : null,
    coverImageUrl: type?.coverImageUrl || null,
    imageUrl: type?.imageUrl || null,
  };
}

const ticketPayload = (ticket) => ({
  number: ticket.number,
  attendeeName: ticket.attendeeName,
  token: ticket.token,
  url: ticket.token ? ticketUrlFor(ticket.token) : null,
  qrUrl: ticket.token ? ticketQrUrlFor(ticket.token) : null,
  checkedInAt: iso(ticket.checkedInAt),
});

/**
 * Le participant peut-il annuler lui-même ? (rien payé en ligne : gratuite
 * ou sur place ; confirmée, à venir)
 */
export const guestCanCancel = (registration, now = new Date()) =>
  registration.status === "CONFIRMED" &&
  !(amountOnlineOf(registration) > 0) &&
  new Date(registration.event.startAt) > now;

/**
 * Inscription renvoyée au participant (confirmation, retour de paiement,
 * page de gestion). `tickets` : billets en clair (sinon déchiffrés).
 */
export async function registrationPayload(
  registration,
  { tickets, manageToken, context } = {},
) {
  const ctx = context || (await registrationContext(registration));
  const confirmed = registration.status === "CONFIRMED";
  const list = confirmed ? tickets || plainTickets(registration) : [];
  const token =
    manageToken ||
    (registration.manageTokenEncrypted
      ? decryptManageToken(registration.manageTokenEncrypted)
      : null);
  return {
    status: registration.status,
    quantity: registration.quantity,
    amount: registration.amount || 0,
    currency: registration.currency || "EUR",
    ...paymentFieldsOf(registration),
    buyer: {
      firstName: registration.buyer.firstName,
      lastName: registration.buyer.lastName,
      email: registration.buyer.email,
    },
    event: eventPayload(registration, ctx.type, ctx.page, { confirmed }),
    page: pagePayload(ctx.page, ctx.organizationName),
    typeSlug: ctx.type?.slug || null,
    tickets: list.map(ticketPayload),
    icsUrl: token ? registrationIcsPath(token) : null,
    canCancel: guestCanCancel(registration),
    cancelledAt: iso(registration.cancelledAt),
    refundStatus: refundStatusOf(registration),
    paymentProvider: registration.payment?.provider || null,
    expiresAt:
      registration.status === "PENDING_PAYMENT"
        ? iso(registration.expiresAt)
        : null,
    bankTransfer: await bankTransferPayload(registration, {
      amountCents: expectedOnlineAmount(registration),
      currency: registration.currency,
    }),
  };
}

/** Paiement d'une inscription vu par le participant (acompte, sur place). */
export const paymentFieldsOf = (registration) => ({
  paymentMode: registrationPaymentModeOf(registration),
  amountOnline: amountOnlineOf(registration),
  amountDueOnSite: amountDueOnSiteOf(registration),
  onSitePaidAt: iso(registration.onSitePaidAt),
});

/**
 * État du remboursement d'une inscription payée mais non confirmée
 * (annulée, ou payée après expiration sans place) :
 *   - REFUNDED : remboursée automatiquement ;
 *   - MANUAL : à rembourser à la main (remboursement automatique impossible
 *     ou annulée par l'organisateur après paiement) ;
 *   - NONE : rien à rembourser.
 */
export function refundStatusOf(registration) {
  const payment = registration?.payment;
  if (!payment?.paidAt || registration.status === "CONFIRMED") return "NONE";
  if (payment.refundedAt) return "REFUNDED";
  return "MANUAL";
}

// ─── E-mails ──────────────────────────────────────────────────────────────

async function sendConfirmationEmails(registration, tickets, manageToken) {
  // Une seule fois, même si le paiement est vu au retour et au webhook
  const claimed = await EventRegistration.findOneAndUpdate(
    { _id: registration._id, confirmationSentAt: null },
    { $set: { confirmationSentAt: new Date() } },
  );
  if (!claimed) return { guest: false, host: false };
  const { page, type, host, organizationName } =
    await registrationContext(registration);
  const token =
    manageToken || decryptManageToken(registration.manageTokenEncrypted);
  const guestEmail = buildEventConfirmationEmail({
    registration,
    tickets,
    organizationName,
    host,
    manageUrl: token ? registrationManageUrlFor(token) : null,
  });
  const hostEmail = buildEventHostNewRegistrationEmail({
    registration,
    type,
    pageTimezone: pageZone(page),
  });
  const [guest, hostSent] = await Promise.all([
    deliverBookingEmail({
      to: registration.buyer.email,
      replyTo: host.email || undefined,
      organizationName,
      ...guestEmail,
    }),
    host.email
      ? deliverBookingEmail({
          to: host.email,
          replyTo: registration.buyer.email,
          organizationName,
          ...hostEmail,
        })
      : false,
  ]);
  return { guest, host: hostSent };
}

/** Après confirmation : client CRM, e-mails (jamais d'erreur). */
async function afterConfirmation(registration, tickets, manageToken) {
  try {
    const page = await BookingPage.findById(registration.bookingPageId).lean();
    if (page && !registration.clientId) {
      const { host } = await loadBookingParties(registration);
      const clientId = await attachClient({
        booking: {
          _id: registration._id,
          typeName: registration.event.name,
          guest: registration.buyer,
          startAt: registration.event.startAt,
        },
        page,
        host,
        description: `s'est inscrit à l'événement « ${registration.event.name} »`,
        createdDescription: `Client créé par l'inscription à l'événement « ${registration.event.name} »`,
      });
      if (clientId) {
        await EventRegistration.updateOne(
          { _id: registration._id },
          { $set: { clientId } },
        );
      }
    }
  } catch (error) {
    logger.error(
      `${LOG} client CRM non rattaché à l'inscription ${registration._id} : ${error.message}`,
    );
  }
  try {
    return await sendConfirmationEmails(registration, tickets, manageToken);
  } catch (error) {
    logger.error(
      `${LOG} e-mails de confirmation de l'inscription ${registration._id} : ${error.message}`,
    );
    return { guest: false, host: false };
  }
}

// ─── Inscription ──────────────────────────────────────────────────────────

const PROVIDER_SUMUP_PREFIX = (registrationId) =>
  `newbi-evt-${registrationId}-`;
const paypalCustomId = (registrationId) => `evt-${registrationId}`;

/**
 * Inscrit un participant.
 *
 * @param {object} params
 * @param {object} params.context - { page, organization, host } (loadPublicPage)
 * @param {object} params.type - événement actif (lean)
 * @param {object} params.buyer - { firstName, lastName, email, phone }
 * @param {number} params.quantity
 * @param {string|null} params.timezone - fuseau du participant
 * @param {string|null} params.provider - moyen de paiement (payant)
 * @param {string|null} params.returnOrigin - en-tête Origin (hors prod)
 * @returns {Promise<{ registration, manageToken, tickets?, paymentUrl?, emails? }>}
 * @throws {EventRegistrationError}
 */
export async function registerForEvent({
  context,
  type,
  buyer,
  quantity,
  timezone = null,
  provider = null,
  returnOrigin = null,
  now = new Date(),
}) {
  const { page } = context;
  if (!registrationOpen(type, now)) {
    // Complet : peut-être des inscriptions échues à libérer d'abord
    const closes = registrationClosesAtOf(type);
    if (
      type.isActive === false ||
      !closes ||
      new Date(closes) <= now ||
      seatsLeftOf(type) !== 0
    ) {
      throw new EventRegistrationError("REGISTRATION_CLOSED", 409);
    }
  }

  const price = priceOf(type);
  const mode = paymentModeOf(type);
  // Sur place : comme un gratuit, aucun prestataire ni moyen exigé
  const online = Boolean(price) && mode !== "ON_SITE";
  if (online) {
    const methods = await eventPaymentMethods(type.workspaceId);
    if (!provider || !methods.includes(provider)) {
      throw new EventRegistrationError("PAYMENT_METHOD_UNAVAILABLE", 409);
    }
  }
  if (online && provider === BANK_TRANSFER) {
    // Virement : début à 48 h au moins (le virement doit pouvoir arriver)
    if (!bankTransferOpenFor(type.startAt, now)) {
      throw new EventRegistrationError("BANK_TRANSFER_TOO_LATE", 409);
    }
    // Une seule inscription par virement en attente par adresse et par
    // événement (places gardées 3 jours)
    if (
      await EventRegistration.exists({
        appointmentTypeId: type._id,
        "buyer.email": buyer.email,
        status: "PENDING_PAYMENT",
        "payment.provider": BANK_TRANSFER,
      })
    ) {
      throw new EventRegistrationError("TOO_MANY_PENDING_TRANSFERS", 409);
    }
  }

  // 1. Participant bloqué dans le CRM
  const existingClient = await findClientByEmail(page.workspaceId, buyer.email);
  if (existingClient?.isBlocked) {
    throw new EventRegistrationError("UNAVAILABLE", 403);
  }

  // 2. Places (une inscription échue libère les siennes avant un refus)
  let reserved = await reserveSeats(type._id, quantity);
  if (!reserved) {
    const freed = await expireOverdueRegistrations({
      typeId: type._id,
      now,
    });
    if (freed > 0) reserved = await reserveSeats(type._id, quantity);
  }
  if (!reserved) {
    const fresh = await AppointmentType.findById(type._id).lean();
    throw new EventRegistrationError("SOLD_OUT", 409, {
      seatsLeft: seatsLeftOf(fresh) ?? 0,
    });
  }

  // 3. Inscription (virement : référence propre, places gardées 3 jours)
  const manageToken = generateManageToken();
  const amount = price ? price.amount * quantity : 0;
  const amountOnline = online ? onlineUnitAmountOf(type) * quantity : 0;
  const bank = online && provider === BANK_TRANSFER;
  let bankReference = null;
  let registration;
  try {
    if (bank) bankReference = await newBankReference(page.workspaceId);
    registration = await EventRegistration.create({
      workspaceId: page.workspaceId,
      bookingPageId: page._id,
      appointmentTypeId: type._id,
      hostUserId: page.userId,
      event: {
        name: type.name,
        startAt: type.startAt,
        endAt: type.endAt,
        location: {
          kind: type.location.kind,
          value: type.location.value || null,
        },
        timezone: pageZone(page),
      },
      buyer: {
        firstName: buyer.firstName,
        lastName: buyer.lastName,
        email: buyer.email,
        phone: buyer.phone || null,
        timezone: timezone || pageZone(page),
      },
      quantity,
      unitAmount: price ? price.amount : 0,
      amount,
      currency: price ? price.currency : "EUR",
      // Payante seulement : une gratuite garde la forme d'avant l'acompte
      ...(price
        ? {
            paymentMode: mode,
            amountOnline,
            amountDueOnSite: amount - amountOnline,
          }
        : {}),
      status: "PENDING_PAYMENT",
      seatsHeld: true,
      // Gratuit aussi : une confirmation interrompue expire et rend ses
      // places. Virement : 3 jours
      expiresAt: bank
        ? bankTransferDueAt(type.startAt, now)
        : new Date(now.getTime() + PENDING_TTL_MS),
      ...(bank
        ? {
            payment: {
              provider: BANK_TRANSFER,
              status: "open",
              bankReference,
            },
          }
        : {}),
      manageTokenHash: hashManageToken(manageToken),
      manageTokenEncrypted: encryptManageToken(manageToken),
    });
  } catch (error) {
    await giveBackSeats(type._id, quantity);
    throw error;
  }

  logger.info(
    `${LOG} inscription ${registration._id} (événement ${type._id}, ${quantity} place(s), ${amount} centimes)`,
  );

  // 4a. Gratuit ou sur place : confirmé tout de suite
  if (!online) {
    let confirmed = null;
    try {
      confirmed = await confirmWithTickets(registration, ["PENDING_PAYMENT"]);
    } catch (error) {
      logger.error(
        `${LOG} inscription sans paiement en ligne ${registration._id} non confirmée : ${error.message}`,
      );
    }
    if (!confirmed) {
      await expireRegistration(registration);
      throw new Error("inscription sans paiement en ligne non confirmée");
    }
    const emails = afterConfirmation(
      confirmed.registration,
      confirmed.tickets,
      manageToken,
    );
    return {
      registration: confirmed.registration,
      manageToken,
      tickets: confirmed.tickets,
      emails,
    };
  }

  // 4b. Virement : coordonnées à l'écran et par e-mail, rien de confirmé
  if (bank) {
    logger.info(
      `${LOG} inscription ${registration._id} en attente du virement ${bankReference}`,
    );
    const emails = sendBankTransferPendingEmail(registration, manageToken);
    return { registration, manageToken, bankTransfer: true, emails };
  }

  // 4c. Payant : paiement sur le compte du vendeur
  const returnToken = crypto.randomBytes(32).toString("base64url");
  const back = `${paymentReturnBase(returnOrigin)}/rdv/${page.slug}/${type.slug}/retour?rt=${returnToken}&provider=${provider}`;
  const seats = `${quantity} place${quantity > 1 ? "s" : ""}`;
  const name = `${mode === "DEPOSIT" ? "Acompte" : "Billet"} : ${String(type.name).slice(0, 200)}`;
  const metadata = {
    type: "event_registration",
    eventRegistrationId: String(registration._id),
    workspaceId: String(page.workspaceId),
  };
  let started;
  try {
    started = await createDirectCheckout({
      provider,
      workspaceId: page.workspaceId,
      // Acompte ou total : le montant vérifié ensuite chez le prestataire
      amount: amountOnline / 100,
      currency: price.currency,
      name,
      description: seats,
      metadata,
      returnUrl: back,
      cancelUrl: `${back}&canceled=1`,
      stripeExpiresAt: Math.floor(now.getTime() / 1000) + STRIPE_SESSION_TTL_S,
      idempotencyKey: `event-registration-${registration._id}`,
      sumupReference: `${PROVIDER_SUMUP_PREFIX(registration._id)}${returnToken.slice(0, 12)}`,
      paypalCustomId: paypalCustomId(registration._id),
      brandName: organizationNameOf(context.organization) || null,
    });
  } catch (error) {
    if (!(error instanceof DirectPaymentUnavailableError)) {
      logger.error(
        `${LOG} paiement ${provider} de l'inscription ${registration._id} non lancé : ${error.message}`,
      );
    }
    await EventRegistration.updateOne(
      { _id: registration._id, status: "PENDING_PAYMENT" },
      { $set: { status: "EXPIRED", expiresAt: null } },
    );
    await releaseSeats(registration);
    if (
      error instanceof DirectPaymentUnavailableError ||
      (error instanceof PaypalApiError &&
        String(error.issue || "").startsWith("PAYEE_"))
    ) {
      throw new EventRegistrationError("PAYMENT_METHOD_UNAVAILABLE", 409);
    }
    throw new EventRegistrationError("PAYMENT_START_FAILED", 502);
  }

  registration = await EventRegistration.findByIdAndUpdate(
    registration._id,
    {
      $set: {
        payment: {
          ...started.attempt,
          returnTokenHash: hashToken(returnToken),
          returnTokenExpiresAt: new Date(now.getTime() + RETURN_TOKEN_TTL_MS),
        },
      },
    },
    { new: true },
  );
  return { registration, manageToken, paymentUrl: started.url };
}

// ─── Paiement : confirmation ─────────────────────────────────────────────

async function refundLatePayment(registration, payment) {
  try {
    const refunded = await refundDirectPayment({
      provider: payment.provider,
      paymentId: payment.paymentId,
      accountId: payment.accountId,
      refundReference: payment.refundReference,
      workspaceId: registration.workspaceId,
      metadata: {
        type: "event_registration",
        eventRegistrationId: String(registration._id),
      },
      idempotencyKey: `event-refund-${registration._id}`,
      reason: "requested_by_customer",
    });
    if (refunded) {
      await EventRegistration.updateOne(
        { _id: registration._id },
        { $set: { "payment.refundedAt": new Date() } },
      );
      logger.warn(
        `${LOG} paiement ${payment.paymentId} de l'inscription ${registration._id} arrivé sans place : remboursé`,
      );
      await sendLatePaymentEmail(registration, payment, true);
      return true;
    }
    throw new Error("remboursement automatique non pris en charge");
  } catch (error) {
    await EventRegistration.updateOne(
      { _id: registration._id },
      { $set: { "payment.refundError": String(error.message).slice(0, 500) } },
    );
    logger.error(
      `${LOG} ANOMALIE : paiement ${payment.provider} ${payment.paymentId} de l'inscription ${registration._id} arrivé sans place, NON remboursé (${error.message}) : à rembourser à la main`,
    );
    // Jamais perdu en silence : l'organisateur et le payeur sont prévenus
    await notifyHostRefundNeeded({
      hostUserId: registration.hostUserId,
      workspaceId: registration.workspaceId,
      payerName: attendeeNameOf(registration.buyer),
      payerEmail: registration.buyer?.email,
      amountCents: payment.amountCents ?? expectedOnlineAmount(registration),
      currency: registration.currency,
      provider: payment.provider,
      reference: registration.payment?.bankReference || null,
      label: `l'événement « ${registration.event?.name} »`,
      reason: latePaymentReason(registration, registration.event?.startAt),
    }).catch((notifyError) =>
      logger.error(
        `${LOG} avis de remboursement de l'inscription ${registration._id} : ${notifyError.message}`,
      ),
    );
    await sendLatePaymentEmail(registration, payment, false);
    return false;
  }
}

/** Au payeur : paiement arrivé sans place (remboursé ou à rembourser). */
async function sendLatePaymentEmail(registration, payment, refunded) {
  try {
    const { host, organizationName } = await loadBookingParties(registration);
    await deliverBookingEmail({
      to: registration.buyer.email,
      replyTo: host.email || undefined,
      organizationName,
      ...buildLatePaymentEmail({
        firstName: registration.buyer.firstName,
        title: registration.event.name,
        amountCents: payment.amountCents ?? expectedOnlineAmount(registration),
        currency: registration.currency,
        refunded,
        reason: latePaymentReason(registration, registration.event?.startAt),
        organizationName,
      }),
    });
  } catch (error) {
    logger.error(
      `${LOG} e-mail de paiement tardif de l'inscription ${registration._id} : ${error.message}`,
    );
  }
}

/**
 * Paiement vérifié auprès du prestataire : confirme l'inscription (une
 * seule fois). Expirée : confirmée s'il reste des places, sinon remboursée.
 * Annulée par l'organisateur avant le paiement : remboursée.
 * @returns {Promise<{status: "paid"}>}
 */
export async function markRegistrationPaid(registration, payment) {
  const paidSet = {
    "payment.status": "paid",
    "payment.paymentId": payment.paymentId || null,
    "payment.captureId": payment.captureId || null,
    "payment.refundReference": payment.refundReference || null,
    "payment.paidAt": new Date(),
    "payment.paidAmount": payment.amountCents,
    "payment.payerEmail": payment.payerEmail || null,
    ...(payment.markedBy ? { "payment.markedBy": payment.markedBy } : {}),
  };
  const current = await EventRegistration.findById(registration._id);
  if (!current) return { status: "paid" };
  if (current.status === "CONFIRMED") return { status: "paid" };
  // Événement commencé : jamais de billets, paiement rendu
  const started = new Date(current.event.startAt) <= new Date();

  if (current.status === "PENDING_PAYMENT" && started) {
    const closed = await EventRegistration.findOneAndUpdate(
      { _id: current._id, status: "PENDING_PAYMENT", "payment.paidAt": null },
      {
        $set: {
          ...paidSet,
          status: "EXPIRED",
          expiredAt: new Date(),
          expiresAt: null,
          "payment.provider": payment.provider,
          "payment.accountId":
            payment.accountId || current.payment?.accountId || null,
        },
      },
      { new: true },
    );
    if (!closed) return markRegistrationPaid(registration, payment);
    await releaseSeats(closed);
    await refundLatePayment(closed, {
      provider: payment.provider,
      paymentId: payment.paymentId,
      accountId: closed.payment?.accountId,
      refundReference: payment.refundReference,
      amountCents: payment.amountCents,
    });
    return { status: "paid" };
  }

  if (current.status === "PENDING_PAYMENT") {
    const confirmed = await confirmWithTickets(
      current,
      ["PENDING_PAYMENT"],
      paidSet,
    );
    if (confirmed) {
      logger.info(
        `${LOG} inscription ${current._id} payée (${payment.provider}, ${payment.amountCents} centimes)`,
      );
      await afterConfirmation(confirmed.registration, confirmed.tickets);
      return { status: "paid" };
    }
    return markRegistrationPaid(registration, payment);
  }

  // Paiement tardif (inscription expirée ou annulée) : revendiqué une
  // seule fois, puis confirmé s'il reste des places, sinon remboursé
  const claimed = await EventRegistration.findOneAndUpdate(
    { _id: current._id, status: current.status, "payment.paidAt": null },
    {
      $set: {
        ...paidSet,
        "payment.provider": payment.provider,
        "payment.accountId":
          payment.accountId || current.payment?.accountId || null,
      },
    },
    { new: true },
  );
  if (!claimed) return { status: "paid" };

  if (claimed.status === "EXPIRED" && !started) {
    // Places encore tenues (arrêt pendant l'expiration) : rendues d'abord
    if (claimed.seatsHeld) await releaseSeats(claimed);
    const reserved = await reserveSeats(
      claimed.appointmentTypeId,
      claimed.quantity,
    );
    if (reserved) {
      // Places de l'expiration déjà rendues (seatsHeld à false) : sinon
      // elles seraient comptées deux fois
      const confirmed = await confirmWithTickets(
        claimed,
        ["EXPIRED"],
        { seatsHeld: true },
        { seatsHeld: false },
      );
      if (confirmed) {
        logger.info(
          `${LOG} inscription ${claimed._id} payée après expiration : confirmée (places encore libres)`,
        );
        await afterConfirmation(confirmed.registration, confirmed.tickets);
        return { status: "paid" };
      }
      await giveBackSeats(claimed.appointmentTypeId, claimed.quantity);
    }
  }
  await refundLatePayment(claimed, {
    provider: payment.provider,
    paymentId: payment.paymentId,
    accountId: claimed.payment?.accountId,
    refundReference: payment.refundReference,
    amountCents: payment.amountCents,
  });
  return { status: "paid" };
}

async function setPaymentStatus(registration, status, extra = {}) {
  await EventRegistration.updateOne(
    { _id: registration._id },
    {
      $set: {
        "payment.status": status,
        ...Object.fromEntries(
          Object.entries(extra).map(([key, value]) => [
            `payment.${key}`,
            value,
          ]),
        ),
      },
    },
  );
}

/**
 * Applique une session Checkout (retour, webhook, balayage) : elle doit
 * venir du compte Stripe du vendeur et correspondre à l'inscription, au
 * montant et à la devise.
 */
export async function applyStripeSessionToRegistration(
  registration,
  session,
  accountId,
) {
  if (
    !session ||
    session.metadata?.eventRegistrationId !== String(registration._id)
  ) {
    logger.warn(
      `${LOG} session ${session?.id} étrangère à l'inscription ${registration._id}`,
    );
    return { status: "unpaid" };
  }
  const allowed = new Set(
    [
      registration.payment?.accountId,
      ...(await directStripeAccountIds(registration.workspaceId)),
    ].filter(Boolean),
  );
  if (!accountId || !allowed.has(accountId)) {
    logger.warn(
      `${LOG} session ${session.id} venue du compte ${accountId}, étranger à l'inscription ${registration._id}`,
    );
    return { status: "unpaid" };
  }
  if (session.payment_status === "paid") {
    const currency = String(session.currency || "").toUpperCase();
    // Acompte ou total : jamais un autre montant (ni le total d'un acompte)
    const expected = expectedOnlineAmount(registration);
    if (
      !(expected > 0) ||
      session.amount_total !== expected ||
      currency !== String(registration.currency || "EUR").toUpperCase()
    ) {
      logger.error(
        `${LOG} ANOMALIE : session ${session.id} payée ${session.amount_total} ${currency} pour l'inscription ${registration._id} (${expected} ${registration.currency}) : non appliquée`,
      );
      return { status: "unpaid" };
    }
    return markRegistrationPaid(registration, {
      provider: "stripe",
      paymentId: session.payment_intent || session.id,
      amountCents: session.amount_total,
      payerEmail: session.customer_details?.email,
      accountId,
    });
  }
  if (session.status === "complete") {
    await setPaymentStatus(registration, "pending");
    return { status: "pending" };
  }
  if (session.status === "expired") {
    await setPaymentStatus(registration, "failed");
  }
  return { status: "unpaid" };
}

async function verifyStripe(registration, sessionId) {
  const payment = registration.payment || {};
  const reference =
    typeof sessionId === "string" &&
    /^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)
      ? sessionId
      : payment.reference;
  if (!reference) return { status: "unpaid" };
  const accounts = [
    ...new Set(
      [
        payment.accountId,
        ...(await directStripeAccountIds(registration.workspaceId)),
      ].filter(Boolean),
    ),
  ];
  const found = await retrieveStripeSession(reference, accounts, LOG);
  if (!found) return { status: "unpaid" };
  return applyStripeSessionToRegistration(
    registration,
    found.session,
    found.accountId,
  );
}

async function applyPaypalSummary(registration, summary) {
  if (summary.customId !== paypalCustomId(registration._id)) {
    logger.warn(
      `${LOG} commande PayPal ${summary.orderId} étrangère à l'inscription ${registration._id}`,
    );
    return { status: "unpaid" };
  }
  if (summary.captureStatus === "COMPLETED") {
    const expected = expectedOnlineAmount(registration);
    if (
      !(expected > 0) ||
      !sameAmount(summary.amount, expected / 100) ||
      String(summary.currency || "").toUpperCase() !==
        String(registration.currency || "EUR").toUpperCase()
    ) {
      logger.error(
        `${LOG} ANOMALIE : capture PayPal ${summary.captureId} de ${summary.amount} ${summary.currency} pour l'inscription ${registration._id} : non appliquée`,
      );
      return { status: "unpaid" };
    }
    return markRegistrationPaid(registration, {
      provider: "paypal",
      paymentId: summary.captureId,
      captureId: summary.captureId,
      amountCents: expected,
      payerEmail: summary.payerEmail,
    });
  }
  if (summary.captureStatus === "PENDING") {
    await setPaymentStatus(registration, "pending", {
      captureId: summary.captureId,
    });
    return { status: "pending" };
  }
  if (
    ["DECLINED", "FAILED"].includes(summary.captureStatus) ||
    summary.orderStatus === "VOIDED"
  ) {
    await setPaymentStatus(registration, "failed");
  }
  return { status: "unpaid" };
}

/** Revendique l'encaissement PayPal (inscription toujours en attente). */
function claimPaypalCapture(registration, now = new Date()) {
  return EventRegistration.findOneAndUpdate(
    {
      _id: registration._id,
      status: "PENDING_PAYMENT",
      "payment.paidAt": null,
      $or: [
        { "payment.status": { $ne: "capturing" } },
        {
          "payment.captureClaimedAt": {
            $lte: new Date(now.getTime() - CAPTURE_CLAIM_MS),
          },
        },
      ],
    },
    {
      $set: { "payment.status": "capturing", "payment.captureClaimedAt": now },
    },
    { new: true },
  );
}

/** Capture non aboutie : revendication levée. */
async function releasePaypalClaim(registration) {
  await EventRegistration.updateOne(
    { _id: registration._id, "payment.status": "capturing" },
    { $set: { "payment.status": "open", "payment.captureClaimedAt": null } },
  );
}

/** Encaissement PayPal en cours (revendication récente). */
const isCapturing = (registration, now = new Date()) =>
  registration?.payment?.status === "capturing" &&
  registration.payment.captureClaimedAt &&
  now.getTime() - new Date(registration.payment.captureClaimedAt).getTime() <
    CAPTURE_CLAIM_MS;

async function verifyPaypal(registration, orderId) {
  if (!isPaypalConfigured()) return { status: "unpaid" };
  const payment = registration.payment || {};
  try {
    if (payment.status === "pending" && payment.captureId) {
      const capture = await getPaypalCapture(payment.captureId);
      return applyPaypalSummary(registration, {
        orderId: payment.reference,
        customId: capture?.custom_id || paypalCustomId(registration._id),
        captureId: capture?.id,
        captureStatus: capture?.status,
        amount: Number(capture?.amount?.value),
        currency: capture?.amount?.currency_code,
      });
    }
    // Seule la commande créée pour cette inscription compte
    const reference = payment.reference;
    if (!isPaypalId(reference)) return { status: "unpaid" };
    if (orderId && orderId !== reference) {
      logger.warn(
        `${LOG} retour PayPal ${orderId} différent de la commande ${reference} de l'inscription ${registration._id}`,
      );
    }
    let summary = summarizePaypalOrder(await getPaypalOrder(reference));
    // Commande approuvée : encaissée seulement si l'inscription attend
    // encore son paiement. Expirée ou annulée, elle n'est jamais encaissée
    // (le payeur n'est pas débité, PayPal ne permet pas à Newbi de
    // rembourser pour le vendeur)
    if (
      summary.orderStatus === "APPROVED" &&
      summary.customId === paypalCustomId(registration._id)
    ) {
      // Revendication atomique sur l'état EN BASE (pas sur l'instantané de
      // l'appelant) : une inscription expirée ou annulée entre-temps n'est
      // jamais encaissée, et une seule capture à la fois
      const claimed = await claimPaypalCapture(registration);
      if (!claimed) {
        const fresh = await EventRegistration.findById(registration._id)
          .select("status payment.status")
          .lean();
        return {
          status:
            fresh?.status === "PENDING_PAYMENT" &&
            fresh.payment?.status === "capturing"
              ? "pending"
              : "unpaid",
        };
      }
      try {
        summary = summarizePaypalOrder(await capturePaypalOrder(reference));
      } catch (error) {
        await releasePaypalClaim(registration);
        throw error;
      }
      const result = await applyPaypalSummary(claimed, summary);
      if (result.status !== "paid") await releasePaypalClaim(registration);
      return result;
    }
    return applyPaypalSummary(registration, summary);
  } catch (error) {
    logger.warn(
      `${LOG} vérification PayPal de l'inscription ${registration._id} : ${error.message}`,
    );
    return { status: "unpaid" };
  }
}

async function verifySumup(registration) {
  if (!isSumupConfigured()) return { status: "unpaid" };
  const payment = registration.payment || {};
  if (payment.provider !== "sumup" || !isSumupCheckoutId(payment.reference)) {
    return { status: "unpaid" };
  }
  const account = await findSumupAccount(registration.workspaceId);
  if (!account) return { status: "unpaid" };
  try {
    const summary = summarizeSumupCheckout(
      await getSumupCheckout(account, payment.reference),
    );
    return applySumupSummary(registration, summary, account);
  } catch (error) {
    logger.warn(
      `${LOG} vérification SumUp de l'inscription ${registration._id} : ${error.message}`,
    );
    return { status: "unpaid" };
  }
}

export async function applySumupSummary(registration, summary, account) {
  const expectedMerchant =
    registration.payment?.accountId || account?.merchantCode || null;
  if (
    !summary?.reference ||
    !summary.reference.startsWith(PROVIDER_SUMUP_PREFIX(registration._id)) ||
    (summary.merchantCode &&
      expectedMerchant &&
      summary.merchantCode !== expectedMerchant)
  ) {
    logger.warn(
      `${LOG} paiement SumUp ${summary?.id} étranger à l'inscription ${registration._id}`,
    );
    return { status: "unpaid" };
  }
  if (summary.status === "PAID") {
    const currency = String(summary.currency || "").toUpperCase();
    const expected = expectedOnlineAmount(registration);
    if (
      !(expected > 0) ||
      !sameAmount(summary.amount, expected / 100) ||
      currency !== String(registration.currency || "EUR").toUpperCase()
    ) {
      logger.error(
        `${LOG} ANOMALIE : paiement SumUp ${summary.id} de ${summary.amount} ${currency} pour l'inscription ${registration._id} : non appliqué`,
      );
      return { status: "unpaid" };
    }
    return markRegistrationPaid(registration, {
      provider: "sumup",
      paymentId: summary.id,
      amountCents: expected,
      accountId: expectedMerchant || undefined,
      refundReference: summary.transactionId || undefined,
    });
  }
  if (summary.status === "FAILED" || summary.status === "EXPIRED") {
    await setPaymentStatus(registration, "failed");
  }
  return { status: "unpaid" };
}

/**
 * Relit le paiement de l'inscription chez le prestataire.
 * @returns {Promise<{status: "paid"|"pending"|"unpaid"|"free"}>}
 */
export async function refreshRegistrationPayment(
  registration,
  { force = false, sessionId, orderId } = {},
) {
  // Gratuite ou sur place : rien à relire
  if (!(expectedOnlineAmount(registration) > 0)) return { status: "free" };
  const payment = registration.payment || {};
  if (payment.paidAt) return { status: "paid" };
  if (!ONLINE_PAYMENT_PROVIDERS.includes(payment.provider)) {
    return { status: "unpaid" };
  }
  if (!payment.reference) return { status: "unpaid" };
  const elapsed = payment.checkedAt
    ? Date.now() - new Date(payment.checkedAt).getTime()
    : Infinity;
  if (elapsed < (force ? FORCED_RECHECK_INTERVAL_MS : RECHECK_INTERVAL_MS)) {
    return { status: payment.status === "pending" ? "pending" : "unpaid" };
  }
  await EventRegistration.updateOne(
    { _id: registration._id },
    { $set: { "payment.checkedAt": new Date() } },
  );
  try {
    const result =
      payment.provider === "stripe"
        ? await verifyStripe(registration, sessionId)
        : payment.provider === "sumup"
          ? await verifySumup(registration)
          : await verifyPaypal(registration, orderId);
    return { status: result.status };
  } catch (error) {
    logger.error(
      `${LOG} vérification de l'inscription ${registration._id} : ${error.message}`,
    );
    return { status: "unpaid" };
  }
}

/** Notification SumUp : relit le paiement d'une inscription. */
export async function handleSumupEventNotification(checkoutId) {
  if (!isSumupCheckoutId(checkoutId)) return { status: "ignored" };
  const registration = await EventRegistration.findOne({
    "payment.provider": "sumup",
    "payment.reference": checkoutId,
  });
  if (!registration) return { status: "ignored" };
  const result = await refreshRegistrationPayment(registration, {
    force: true,
  });
  return { status: result.status };
}

/** Webhook Stripe Connect : session d'une inscription. */
export async function applyEventSessionEvent(type, session, accountId) {
  const id = session?.metadata?.eventRegistrationId;
  if (!isObjectId(id)) {
    return { status: "ignored", message: "Inscription absente de la session" };
  }
  const registration = await EventRegistration.findById(id);
  if (!registration) {
    return { status: "error", message: "Inscription introuvable" };
  }
  if (type === "checkout.session.async_payment_failed") {
    await setPaymentStatus(registration, "failed");
    return { status: "ignored", message: "Paiement différé refusé" };
  }
  const result = await applyStripeSessionToRegistration(
    registration,
    session,
    accountId,
  );
  return {
    status: result.status === "paid" ? "success" : "ignored",
    message: `Inscription ${result.status}`,
  };
}

// ─── Retour du payeur ────────────────────────────────────────────────────

/**
 * Retour du payeur sur le site : paiement relu chez le prestataire.
 * @returns {Promise<{paymentStatus, registration, manageToken}|null>} null si jeton inconnu ou périmé
 */
export async function handlePaymentReturn({
  returnToken,
  sessionId,
  orderId,
  now = new Date(),
}) {
  let registration = await findByReturnToken(returnToken);
  if (!returnTokenUsable(registration, now)) return null;
  let paymentStatus = "unpaid";
  if (registration.payment?.paidAt) {
    paymentStatus = "paid";
  } else {
    const result = await refreshRegistrationPayment(registration, {
      force: true,
      sessionId,
      orderId,
    });
    paymentStatus = result.status === "free" ? "paid" : result.status;
    registration = await EventRegistration.findById(registration._id);
  }
  // Confirmée : le jeton de retour ne sert plus que quelques minutes
  if (
    registration.status === "CONFIRMED" &&
    !registration.payment?.returnTokenConsumedAt
  ) {
    await EventRegistration.updateOne(
      { _id: registration._id, "payment.returnTokenConsumedAt": null },
      { $set: { "payment.returnTokenConsumedAt": now } },
    );
  }
  return { paymentStatus, registration };
}

/** Jeton de retour encore valable (une heure, quelques minutes après confirmation). */
function returnTokenUsable(registration, now = new Date()) {
  const payment = registration?.payment;
  if (!payment?.returnTokenExpiresAt) return false;
  if (new Date(payment.returnTokenExpiresAt) <= now) return false;
  if (
    payment.returnTokenConsumedAt &&
    now.getTime() - new Date(payment.returnTokenConsumedAt).getTime() >
      RETURN_TOKEN_GRACE_MS
  ) {
    return false;
  }
  return true;
}

async function findByReturnToken(returnToken) {
  if (
    typeof returnToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(returnToken)
  ) {
    return null;
  }
  return EventRegistration.findOne({
    "payment.returnTokenHash": hashToken(returnToken),
  });
}

/**
 * Le payeur abandonne (annulation chez Stripe, PayPal ou SumUp) : paiement
 * fermé chez le prestataire, relu une dernière fois, puis inscription
 * expirée et places rendues s'il est bien impayé.
 * @returns {Promise<{paymentStatus, registration}|null>} null si jeton inconnu ou périmé
 */
export async function abandonPayment({ returnToken, now = new Date() }) {
  const registration = await findByReturnToken(returnToken);
  if (!returnTokenUsable(registration, now)) return null;
  if (registration.status !== "PENDING_PAYMENT") {
    return {
      paymentStatus: registration.payment?.paidAt ? "paid" : "unpaid",
      registration,
    };
  }
  await closeDirectCheckout(
    registration.payment,
    registration.workspaceId,
    LOG,
  );
  // Relecture immédiate, même juste après une autre
  await EventRegistration.updateOne(
    { _id: registration._id },
    { $set: { "payment.checkedAt": null } },
  );
  const fresh = await EventRegistration.findById(registration._id);
  const result = await refreshRegistrationPayment(fresh, { force: true });
  if (result.status === "paid" || result.status === "pending") {
    return {
      paymentStatus: result.status,
      registration: await EventRegistration.findById(registration._id),
    };
  }
  const expired = await expireRegistration(fresh, { now });
  const after = await EventRegistration.findById(registration._id);
  return {
    paymentStatus:
      !expired && after.status === "PENDING_PAYMENT" ? "pending" : "unpaid",
    registration: after,
  };
}

// ─── Expiration et balayage ──────────────────────────────────────────────

/**
 * Passe une inscription échue en EXPIRED et rend ses places. Jamais pendant
 * un encaissement PayPal en cours ni un paiement en confirmation. Le
 * paiement reste relu 24 h (payment.status « expired »).
 */
async function expireRegistration(
  registration,
  { now = new Date(), pendingCapped = false } = {},
) {
  const expired = await EventRegistration.findOneAndUpdate(
    {
      _id: registration._id,
      status: "PENDING_PAYMENT",
      "payment.paidAt": null,
      // Paiement en confirmation : seulement au-delà du plafond (7 jours ou
      // début de l'événement)
      ...(pendingCapped ? {} : { "payment.status": { $ne: "pending" } }),
      $or: [
        { "payment.status": { $ne: "capturing" } },
        {
          "payment.captureClaimedAt": {
            $lte: new Date(now.getTime() - CAPTURE_CLAIM_MS),
          },
        },
      ],
    },
    {
      $set: {
        status: "EXPIRED",
        expiredAt: now,
        ...(registration.payment?.reference
          ? {
              // Paiement encore en confirmation : relu 7 jours (filet)
              "payment.status": pendingCapped ? "expired_pending" : "expired",
            }
          : {}),
      },
    },
    { new: true },
  );
  if (!expired) return false;
  await releaseSeats(expired);
  await closeDirectCheckout(expired.payment, expired.workspaceId, LOG);
  // Virement non reçu en 3 jours : le participant est prévenu
  if (expired.payment?.provider === BANK_TRANSFER) {
    await sendExpiredEmail(expired).catch((error) =>
      logger.error(
        `${LOG} e-mail d'expiration de l'inscription ${expired._id} : ${error.message}`,
      ),
    );
  }
  return true;
}

/**
 * Inscriptions en attente échues : dernière vérification du paiement, puis
 * EXPIRED (places rendues). @returns {Promise<number>} nombre d'expirées
 */
export async function expireOverdueRegistrations({
  typeId = null,
  now = new Date(),
  limit = 100,
} = {}) {
  // Paiements en confirmation et encaissements en cours exclus : ils ne
  // bloquent pas la tête de liste (relus par le balayage)
  const capped = {
    "payment.status": "pending",
    $or: [
      { createdAt: { $lte: new Date(now.getTime() - PENDING_PAYMENT_CAP_MS) } },
      { "event.startAt": { $lte: now } },
    ],
  };
  const filter = {
    status: "PENDING_PAYMENT",
    $or: [
      {
        expiresAt: { $lte: now },
        "payment.status": { $nin: ["pending", "capturing"] },
      },
      // Paiement en confirmation : plafonné à min(7 jours, début)
      capped,
    ],
  };
  if (typeId) filter.appointmentTypeId = typeId;
  const overdue = await EventRegistration.find(filter)
    .sort({ expiresAt: 1 })
    .limit(limit);
  let count = 0;
  for (const registration of overdue) {
    try {
      const pendingCapped =
        registration.payment?.status === "pending" &&
        (new Date(registration.createdAt).getTime() <=
          now.getTime() - PENDING_PAYMENT_CAP_MS ||
          new Date(registration.event.startAt) <= now);
      const result = await refreshRegistrationPayment(registration, {
        force: true,
      });
      if (result.status === "paid") continue;
      if (result.status === "pending" && !pendingCapped) continue;
      if (await expireRegistration(registration, { now, pendingCapped }))
        count += 1;
    } catch (error) {
      logger.error(
        `${LOG} expiration de l'inscription ${registration._id} : ${error.message}`,
      );
    }
  }
  return count;
}

// Paiement ouvert depuis moins longtemps : le payeur est peut-être encore
// sur la page du prestataire
const SWEEP_MIN_AGE_MS = 2 * MINUTE;
// Paiement en confirmation chez le prestataire : revérifié 7 jours
const SWEEP_PENDING_WINDOW_MS = 7 * 24 * HOUR;

/**
 * Balayage (toutes les 5 minutes, instance 0) : paiements ouverts
 * revérifiés, inscriptions échues expirées.
 * @returns {Promise<{checked: number, expired: number}>}
 */
export async function sweepEventRegistrations({ now = new Date() } = {}) {
  const minAge = new Date(now.getTime() - SWEEP_MIN_AGE_MS);
  const open = await EventRegistration.find({
    "payment.reference": { $ne: null },
    "payment.paidAt": null,
    $or: [
      // En attente : paiements ouverts, en confirmation ou en encaissement
      {
        status: "PENDING_PAYMENT",
        "payment.status": { $in: ["open", "pending", "capturing"] },
        createdAt: {
          $lte: minAge,
          $gte: new Date(now.getTime() - SWEEP_PENDING_WINDOW_MS),
        },
      },
      // Expirées depuis moins de 24 h : paiement tombé pendant la fermeture
      {
        status: "EXPIRED",
        "payment.status": "expired",
        expiredAt: { $gte: new Date(now.getTime() - EXPIRED_RECHECK_MS) },
      },
      // Expirées avec un paiement encore en confirmation : relues 7 jours
      {
        status: "EXPIRED",
        "payment.status": "expired_pending",
        expiredAt: { $gte: new Date(now.getTime() - PENDING_PAYMENT_CAP_MS) },
      },
    ],
  })
    // Les moins récemment relues d'abord : aucune ne bloque les autres
    .sort({ "payment.checkedAt": 1, createdAt: 1 })
    .limit(100);
  let checked = 0;
  for (const registration of open) {
    checked += 1;
    try {
      await refreshRegistrationPayment(registration);
    } catch (error) {
      logger.error(
        `${LOG} balayage de l'inscription ${registration._id} : ${error.message}`,
      );
    }
  }
  const expired = await expireOverdueRegistrations({ now });
  if (expired) logger.info(`${LOG} ${expired} inscription(s) expirée(s)`);
  const reconciled = await reconcileHeldSeats({ now });
  return { checked, expired, reconciled };
}

/**
 * Inscriptions annulées ou expirées qui tiennent encore leurs places
 * (processus arrêté entre les deux écritures) : places rendues.
 * @returns {Promise<number>}
 */
export async function reconcileHeldSeats({ now = new Date() } = {}) {
  const stuck = await EventRegistration.find({
    status: { $in: ["EXPIRED", "CANCELLED"] },
    seatsHeld: true,
    updatedAt: { $lte: new Date(now.getTime() - SEATS_RECONCILE_DELAY_MS) },
  })
    .select("_id appointmentTypeId quantity")
    .limit(100)
    .lean();
  let count = 0;
  for (const registration of stuck) {
    if (await releaseSeats(registration)) count += 1;
  }
  if (count) logger.warn(`${LOG} places rendues par réconciliation : ${count}`);
  return count;
}

// ─── Gestion ──────────────────────────────────────────────────────────────

export async function findRegistrationByManageToken(token) {
  if (typeof token !== "string" || !MANAGE_TOKEN_PATTERN.test(token)) {
    return null;
  }
  return EventRegistration.findOne({ manageTokenHash: hashManageToken(token) });
}

/**
 * Annule une inscription (participant ou organisateur) : places rendues,
 * e-mail(s). Payante : pas de remboursement automatique en V1.
 */
export async function cancelRegistration({ registration, by, reason = null }) {
  const now = new Date();
  const updated = await EventRegistration.findOneAndUpdate(
    {
      _id: registration._id,
      $or: [
        { status: "CONFIRMED" },
        // En attente : jamais pendant un encaissement PayPal en cours
        {
          status: "PENDING_PAYMENT",
          $or: [
            { "payment.status": { $ne: "capturing" } },
            {
              "payment.captureClaimedAt": {
                $lte: new Date(now.getTime() - CAPTURE_CLAIM_MS),
              },
            },
          ],
        },
      ],
    },
    {
      $set: {
        status: "CANCELLED",
        cancelledBy: by,
        cancelReason: reason,
        cancelledAt: new Date(),
        expiresAt: null,
      },
    },
    { new: true },
  );
  if (!updated) {
    const current = await EventRegistration.findById(registration._id);
    if (isCapturing(current, now)) {
      throw new EventRegistrationError("PAYMENT_IN_PROGRESS", 409);
    }
    return { registration: current, emails: Promise.resolve(null) };
  }
  await releaseSeats(updated);
  if (registration.status === "PENDING_PAYMENT") {
    await closeDirectCheckout(updated.payment, updated.workspaceId, LOG);
  }
  logger.info(`${LOG} inscription ${updated._id} annulée (${by})`);
  const emails = (async () => {
    if (registration.status !== "CONFIRMED") return null;
    const { page, host, organizationName } = await registrationContext(updated);
    const sends = [
      deliverBookingEmail({
        to: updated.buyer.email,
        replyTo: host.email || undefined,
        organizationName,
        ...buildEventCancelledEmail({
          registration: updated,
          organizationName,
          host,
        }),
      }),
    ];
    if (by === "GUEST" && host.email) {
      sends.push(
        deliverBookingEmail({
          to: host.email,
          replyTo: updated.buyer.email,
          organizationName,
          ...buildEventHostCancelledEmail({
            registration: updated,
            pageTimezone: pageZone(page),
          }),
        }),
      );
    }
    return Promise.all(sends);
  })().catch((error) => {
    logger.error(`${LOG} e-mails d'annulation : ${error.message}`);
    return null;
  });
  return { registration: updated, emails };
}

// ─── Billets : page publique et QR code ──────────────────────────────────

/** Billet d'un jeton (et son inscription), ou null. */
export async function findTicketByToken(token) {
  if (typeof token !== "string" || !TICKET_TOKEN_PATTERN.test(token)) {
    return null;
  }
  const tokenHash = hashToken(token);
  const registration = await EventRegistration.findOne({
    "tickets.tokenHash": tokenHash,
  });
  if (!registration) return null;
  const ticket = registration.tickets.find((t) => t.tokenHash === tokenHash);
  return ticket ? { registration, ticket } : null;
}

const ticketStatus = (registration, ticket) => {
  if (registration.status === "PENDING_PAYMENT") return "NOT_PAID";
  if (registration.status !== "CONFIRMED") return "CANCELLED";
  return ticket.checkedInAt ? "CHECKED_IN" : "VALID";
};

/** Réponse de la page billet (GET /tickets/:token). */
export async function ticketPagePayload(registration, ticket, token) {
  const context = await registrationContext(registration);
  return {
    status: ticketStatus(registration, ticket),
    number: ticket.number,
    attendeeName: ticket.attendeeName,
    checkedInAt: iso(ticket.checkedInAt),
    currency: registration.currency || "EUR",
    ...paymentFieldsOf(registration),
    event: eventPayload(registration, context.type, context.page, {
      confirmed: registration.status === "CONFIRMED",
    }),
    page: pagePayload(context.page, context.organizationName),
    typeSlug: context.type?.slug || null,
    url: ticketUrlFor(token),
    qrUrl: ticketQrUrlFor(token),
  };
}

/** QR code PNG de l'URL d'un billet. */
export function ticketQrPng(token) {
  return QRCode.toBuffer(ticketUrlFor(token), {
    type: "png",
    width: 400,
    margin: 2,
    errorCorrectionLevel: "M",
  });
}

// ─── Contrôle à l'entrée ─────────────────────────────────────────────────

/**
 * Code lu ou saisi : URL du billet, jeton seul ou numéro.
 * @returns {{ token?: string, number?: string }|null}
 */
export function parseTicketCode(code) {
  const value = String(code || "").trim();
  if (!value || value.length > 500) return null;
  const fromUrl = value.match(/\/rdv\/billet\/([A-Za-z0-9_-]{43})(?:[/?#]|$)/);
  if (fromUrl) return { token: fromUrl[1] };
  if (TICKET_TOKEN_PATTERN.test(value)) return { token: value };
  const number = normalizeTicketNumber(value);
  return number ? { number } : null;
}

/**
 * Contrôle d'un billet par l'organisateur à l'entrée de l'événement
 * `typeId`. `scope` : { workspaceId, hostUserId } de l'organisateur.
 * Marquage atomique : deux scans simultanés donnent VALID puis
 * ALREADY_CHECKED_IN.
 */
export async function checkInTicket({
  scope,
  typeId,
  code,
  userId,
  now = new Date(),
}) {
  const parsed = parseTicketCode(code);
  if (!parsed) return { result: "UNKNOWN" };
  const match = parsed.token
    ? { "tickets.tokenHash": hashToken(parsed.token) }
    : { "tickets.number": parsed.number };
  const registration = await EventRegistration.findOne({
    ...match,
    workspaceId: scope.workspaceId,
    hostUserId: scope.hostUserId,
  });
  if (!registration) return { result: "UNKNOWN" };
  const ticket = registration.tickets.find((t) =>
    parsed.token
      ? t.tokenHash === hashToken(parsed.token)
      : t.number === parsed.number,
  );
  if (!ticket) return { result: "UNKNOWN" };
  if (String(registration.appointmentTypeId) !== String(typeId)) {
    return { result: "OTHER_EVENT", otherEventName: registration.event.name };
  }
  if (registration.status === "PENDING_PAYMENT") {
    return { result: "NOT_PAID", ticket, registration };
  }
  if (registration.status !== "CONFIRMED") {
    return { result: "CANCELLED", ticket, registration };
  }
  const updated = await EventRegistration.findOneAndUpdate(
    {
      _id: registration._id,
      status: "CONFIRMED",
      tickets: { $elemMatch: { _id: ticket._id, checkedInAt: null } },
    },
    {
      $set: {
        "tickets.$.checkedInAt": now,
        "tickets.$.checkedInBy": userId ? toObjectId(userId) : null,
      },
    },
    { new: true },
  );
  if (!updated) {
    const fresh = await EventRegistration.findById(registration._id);
    const freshTicket = fresh?.tickets.id(ticket._id) || ticket;
    if (fresh && fresh.status !== "CONFIRMED") {
      return { result: "CANCELLED", ticket: freshTicket, registration: fresh };
    }
    return {
      result: "ALREADY_CHECKED_IN",
      ticket: freshTicket,
      registration: fresh || registration,
    };
  }
  return {
    result: "VALID",
    ticket: updated.tickets.id(ticket._id),
    registration: updated,
  };
}

/** Retire le marquage « présent » d'un billet de l'organisateur. */
export async function undoTicketCheckIn({ scope, ticketId }) {
  if (!isObjectId(String(ticketId))) return null;
  const updated = await EventRegistration.findOneAndUpdate(
    {
      workspaceId: scope.workspaceId,
      hostUserId: scope.hostUserId,
      "tickets._id": toObjectId(ticketId),
    },
    {
      $set: { "tickets.$.checkedInAt": null, "tickets.$.checkedInBy": null },
    },
    { new: true },
  );
  return updated ? updated.tickets.id(ticketId) : null;
}

// ─── Reste réglé sur place ───────────────────────────────────────────────

/**
 * Marque (paid) ou démarque le reste dû sur place d'une inscription
 * confirmée de l'organisateur. `scope` : { workspaceId, hostUserId }.
 * @returns {Promise<{registration}|{error: "NOT_FOUND"|"NOT_CONFIRMED"|"NOTHING_DUE"}>}
 */
export async function markRegistrationPaidOnSite({
  scope,
  registrationId,
  paid,
  userId,
  now = new Date(),
}) {
  if (!isObjectId(String(registrationId))) return { error: "NOT_FOUND" };
  const filter = {
    _id: toObjectId(registrationId),
    workspaceId: scope.workspaceId,
    hostUserId: scope.hostUserId,
  };
  const registration = await EventRegistration.findOne(filter);
  if (!registration) return { error: "NOT_FOUND" };
  if (registration.status !== "CONFIRMED") return { error: "NOT_CONFIRMED" };
  if (!(amountDueOnSiteOf(registration) > 0)) return { error: "NOTHING_DUE" };
  // Déjà dans l'état demandé : rien n'est réécrit (date du premier marquage)
  if (Boolean(registration.onSitePaidAt) === Boolean(paid)) {
    return { registration };
  }
  const updated = await EventRegistration.findOneAndUpdate(
    { ...filter, status: "CONFIRMED", amountDueOnSite: { $gt: 0 } },
    paid
      ? {
          $set: {
            onSitePaidAt: now,
            onSitePaidBy: userId ? toObjectId(userId) : null,
          },
        }
      : { $unset: { onSitePaidAt: "", onSitePaidBy: "" } },
    { new: true },
  );
  if (!updated) {
    const fresh = await EventRegistration.findOne(filter);
    if (!fresh) return { error: "NOT_FOUND" };
    return { error: "NOT_CONFIRMED" };
  }
  logger.info(
    `${LOG} inscription ${updated._id} : reste sur place ${paid ? "réglé" : "de nouveau dû"}`,
  );
  return { registration: updated };
}

// ─── Virement ────────────────────────────────────────────────────────────

const whenTextOf = (registration) => {
  const when = formatWhen(
    registration.event.startAt,
    registration.event.endAt,
    registration.buyer?.timezone || registration.event?.timezone,
  );
  return `${when.date} à ${when.start}`;
};

/** E-mail « virement en attente » au participant (jamais d'erreur). */
async function sendBankTransferPendingEmail(registration, manageToken) {
  try {
    const bank = await bankTransferPayload(registration, {
      amountCents: expectedOnlineAmount(registration),
      currency: registration.currency,
    });
    if (!bank) return false;
    const { host, organizationName } = await loadBookingParties(registration);
    return await deliverBookingEmail({
      to: registration.buyer.email,
      replyTo: host.email || undefined,
      organizationName,
      ...buildBankTransferPendingEmail({
        kind: "event",
        firstName: registration.buyer.firstName,
        title: registration.event.name,
        whenText: whenTextOf(registration),
        bank,
        organizationName,
        manageUrl: manageToken ? registrationManageUrlFor(manageToken) : null,
      }),
    });
  } catch (error) {
    logger.error(
      `${LOG} e-mail de virement en attente de l'inscription ${registration._id} : ${error.message}`,
    );
    return false;
  }
}

/** E-mail « réservation expirée » au participant. */
async function sendExpiredEmail(registration) {
  const { page, type, host, organizationName } =
    await registrationContext(registration);
  return deliverBookingEmail({
    to: registration.buyer.email,
    replyTo: host.email || undefined,
    organizationName,
    ...buildPaymentExpiredEmail({
      kind: "event",
      firstName: registration.buyer.firstName,
      title: registration.event.name,
      bankTransfer: registration.payment?.provider === BANK_TRANSFER,
      organizationName,
      rebookUrl:
        page && type?.isActive ? publicPageUrl(page.slug, type.slug) : null,
    }),
  });
}

/**
 * « J'ai fait le virement » (ou son retrait) par le participant, avec son
 * jeton de gestion. L'organisateur est prévenu à la première annonce ;
 * l'inscription reste en attente (jamais confirmée ici).
 * @returns {Promise<{declaredAt: Date|null}|null>} null si le virement n'est plus attendu
 */
export async function declareRegistrationBankTransfer(
  registration,
  { cancel = false } = {},
) {
  const result = await declareBankTransfer(EventRegistration, registration, {
    cancel,
  });
  if (!result) return null;
  const { doc, firstDeclaration } = result;
  if (firstDeclaration) {
    logger.info(`${LOG} virement annoncé pour l'inscription ${doc._id}`);
    await notifyHostBankDeclared({
      hostUserId: doc.hostUserId,
      workspaceId: doc.workspaceId,
      payerName: attendeeNameOf(doc.buyer),
      payerEmail: doc.buyer.email,
      amountCents: expectedOnlineAmount(doc),
      currency: doc.currency,
      reference: doc.payment.bankReference,
      label: `l'événement « ${doc.event.name} »`,
    }).catch((error) =>
      logger.error(
        `${LOG} annonce du virement de l'inscription ${doc._id} : ${error.message}`,
      ),
    );
  }
  return { declaredAt: doc.payment?.declaredAt || null };
}

/**
 * « Marquer comme payé » par l'organisateur : virement reçu hors repérage
 * automatique. Inscription en attente, ou expirée s'il reste des places.
 * `scope` : { workspaceId, hostUserId }.
 * @returns {Promise<{registration}|{error: "NOT_FOUND"|"NOT_PENDING"|"NO_SEATS"}>}
 */
export async function markRegistrationPaidByHost({
  scope,
  registrationId,
  userId,
}) {
  if (!isObjectId(String(registrationId))) return { error: "NOT_FOUND" };
  const filter = {
    _id: toObjectId(registrationId),
    workspaceId: scope.workspaceId,
    hostUserId: scope.hostUserId,
  };
  const registration = await EventRegistration.findOne(filter);
  if (!registration) return { error: "NOT_FOUND" };
  if (registration.payment?.provider !== BANK_TRANSFER) {
    return { error: "NOT_PENDING" };
  }
  // Déjà confirmée par ce virement (double clic, repérage entre-temps)
  if (registration.status === "CONFIRMED") return { registration };
  if (
    !["PENDING_PAYMENT", "EXPIRED"].includes(registration.status) ||
    registration.payment?.paidAt
  ) {
    return { error: "NOT_PENDING" };
  }
  // Événement commencé : plus confirmable (l'organisateur rembourse)
  if (new Date(registration.event.startAt) <= new Date()) {
    return { error: "STARTED" };
  }
  const payment = {
    provider: BANK_TRANSFER,
    paymentId: `manual:${userId}`,
    amountCents: expectedOnlineAmount(registration),
    markedBy: userId ? toObjectId(userId) : undefined,
  };
  if (registration.status === "PENDING_PAYMENT") {
    await markRegistrationPaid(registration, payment);
  } else {
    // Expirée : places reprises d'abord, sinon rien n'est marqué
    if (registration.seatsHeld) await releaseSeats(registration);
    const reserved = await reserveSeats(
      registration.appointmentTypeId,
      registration.quantity,
    );
    if (!reserved) return { error: "NO_SEATS" };
    const confirmed = await confirmWithTickets(
      registration,
      ["EXPIRED"],
      {
        seatsHeld: true,
        "payment.status": "paid",
        "payment.paymentId": payment.paymentId,
        "payment.paidAt": new Date(),
        "payment.paidAmount": payment.amountCents,
        ...(payment.markedBy ? { "payment.markedBy": payment.markedBy } : {}),
      },
      { seatsHeld: false, "payment.paidAt": null },
    );
    if (!confirmed) {
      await giveBackSeats(
        registration.appointmentTypeId,
        registration.quantity,
      );
      return { error: "NOT_PENDING" };
    }
    await afterConfirmation(confirmed.registration, confirmed.tickets);
  }
  const updated = await EventRegistration.findOne(filter);
  if (updated?.status !== "CONFIRMED") return { error: "NOT_PENDING" };
  logger.info(
    `${LOG} inscription ${updated._id} marquée payée par l'organisateur`,
  );
  return { registration: updated };
}

// ─── Rappels de la veille ────────────────────────────────────────────────

const MAX_REMINDERS_PER_RUN = 500;

/**
 * Rappel aux participants, 24 h avant le début (inscription prise plus de
 * 24 h avant). Revendiqué avant l'envoi : jamais deux fois.
 */
export async function runEventReminders(now = new Date()) {
  let sent = 0;
  let failed = 0;
  while (sent + failed < MAX_REMINDERS_PER_RUN) {
    const registration = await EventRegistration.findOneAndUpdate(
      {
        status: "CONFIRMED",
        "event.startAt": {
          $gt: now,
          $lte: new Date(now.getTime() + 24 * HOUR),
        },
        "reminders.h24SentAt": null,
        $expr: {
          $lt: ["$createdAt", { $subtract: ["$event.startAt", 24 * HOUR] }],
        },
      },
      { $set: { "reminders.h24SentAt": now } },
      { new: true, sort: { "event.startAt": 1 } },
    );
    if (!registration) break;
    try {
      const { host, organizationName } = await loadBookingParties(registration);
      const token = decryptManageToken(registration.manageTokenEncrypted);
      const email = buildEventReminderEmail({
        registration,
        tickets: plainTickets(registration).filter((t) => t.token),
        organizationName,
        manageUrl: token ? registrationManageUrlFor(token) : null,
      });
      const ok = await deliverBookingEmail({
        to: registration.buyer.email,
        replyTo: host.email || undefined,
        organizationName,
        ...email,
      });
      if (ok) sent += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      logger.error(
        `${LOG} rappel de l'inscription ${registration._id} non envoyé : ${error.message}`,
      );
    }
  }
  if (sent || failed) {
    logger.info(`${LOG} rappels : ${sent} envoyé(s), ${failed} en échec`);
  }
  return { sent, failed };
}

// ─── Calendrier de l'organisateur ────────────────────────────────────────

/**
 * Entrée du Calendrier Newbi de l'organisateur pour un événement (une
 * seule, mise à jour à chaque modification, retirée à la suppression).
 * Jamais d'erreur.
 */
export async function syncEventCalendarEntry(type, { remove = false } = {}) {
  try {
    if (remove || !isEvent(type)) {
      if (type?.calendarEventId) {
        await Event.deleteOne({ _id: type.calendarEventId });
        publishCalendarEventsChanged(String(type.userId));
      }
      return null;
    }
    const fields = {
      title: type.name,
      description: type.description || "",
      start: type.startAt,
      end: type.endAt,
      allDay: false,
      color: "violet",
      location:
        type.location?.kind === "IN_PERSON"
          ? type.location.value
          : type.location?.value || "En ligne",
      type: "APPOINTMENT",
      source: "newbi",
      visibility: "private",
      workspaceId: type.workspaceId,
      userId: type.userId,
    };
    let eventId = type.calendarEventId;
    if (eventId) {
      const result = await Event.updateOne({ _id: eventId }, { $set: fields });
      if (!result.matchedCount) eventId = null;
    }
    if (!eventId) {
      const created = await Event.create(fields);
      eventId = created._id;
      await AppointmentType.updateOne(
        { _id: type._id },
        { $set: { calendarEventId: eventId } },
      );
    }
    publishCalendarEventsChanged(String(type.userId));
    return eventId;
  } catch (error) {
    logger.error(
      `${LOG} entrée du Calendrier de l'événement ${type?._id} : ${error.message}`,
    );
    return null;
  }
}

/** Instantané des inscriptions après une modification de l'événement. */
export async function refreshRegistrationSnapshots(
  type,
  { startChanged = false } = {},
) {
  await EventRegistration.updateMany(
    { appointmentTypeId: type._id },
    {
      $set: {
        "event.name": type.name,
        "event.startAt": type.startAt,
        "event.endAt": type.endAt,
        "event.location": {
          kind: type.location.kind,
          value: type.location.value || null,
        },
        // Début déplacé : le rappel de la veille sera renvoyé
        ...(startChanged ? { "reminders.h24SentAt": null } : {}),
      },
    },
  );
}

/**
 * Date, heure ou lieu changés : e-mail aux inscrits confirmés d'un
 * événement à venir (pas pour le nom ni la description).
 * @returns {Promise<{sent: number, failed: number}>}
 */
export async function notifyEventChanged(type, diff) {
  if (!diff?.schedule && !diff?.location) return { sent: 0, failed: 0 };
  if (!type.endAt || new Date(type.endAt) <= new Date()) {
    return { sent: 0, failed: 0 };
  }
  const registrations = await EventRegistration.find({
    appointmentTypeId: type._id,
    status: "CONFIRMED",
  });
  if (!registrations.length) return { sent: 0, failed: 0 };
  const { host, organizationName } = await loadBookingParties(registrations[0]);
  let sent = 0;
  let failed = 0;
  for (const registration of registrations) {
    const token = decryptManageToken(registration.manageTokenEncrypted);
    const ok = await deliverBookingEmail({
      to: registration.buyer.email,
      replyTo: host.email || undefined,
      organizationName,
      ...buildEventChangedEmail({
        registration,
        organizationName,
        host,
        changes: diff,
        manageUrl: token ? registrationManageUrlFor(token) : null,
      }),
    });
    if (ok) sent += 1;
    else failed += 1;
  }
  logger.info(
    `${LOG} événement ${type._id} modifié : ${sent} inscrit(s) prévenu(s), ${failed} en échec`,
  );
  return { sent, failed };
}
