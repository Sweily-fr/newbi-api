/**
 * Rendez-vous payants (créneaux d'un type SLOT avec un prix) : paiement à
 * la réservation, tout ou acompte, par carte (Stripe), PayPal, SumUp ou
 * virement, encaissé directement par l'organisateur.
 *
 * Réservation payante, dans l'ordre :
 *   1. client CRM bloqué : refus (« UNAVAILABLE ») ;
 *   2. réservations échues de l'organisateur expirées (créneaux libérés) ;
 *   3. sous le verrou de l'organisateur : créneau recalculé en direct, puis
 *      réservation `PENDING_PAYMENT` qui TIENT le créneau (comptée occupée
 *      par busyService et appointmentSlots) 30 minutes, ou pour un virement
 *      jusqu'à min(réservation + 3 jours, début) ;
 *   4. paiement créé sur le compte du vendeur, ou coordonnées de virement.
 * Rien n'est écrit dans l'agenda connecté ni dans le Calendrier, aucun
 * client créé, aucun e-mail de confirmation avant le paiement.
 *
 * Un paiement n'est jamais tenu pour acquis sur un simple retour du
 * payeur : il est relu chez le prestataire (retour, webhook Stripe Connect,
 * notification SumUp, balayage toutes les 5 minutes) et doit correspondre
 * à la réservation, au compte du vendeur, au montant et à la devise. Un
 * virement n'est confirmé qu'au repérage bancaire ou par l'organisateur.
 * À la confirmation : tout ce que fait une réservation gratuite
 * (finalizeBooking). Paiement arrivé après expiration : confirmé si le
 * créneau est encore libre, sinon remboursé (Stripe, SumUp) ou signalé à
 * l'organisateur « à rembourser à la main ». Jamais deux rendez-vous sur un
 * même créneau.
 */
import crypto from "crypto";
import mongoose from "mongoose";
import AppointmentType from "../../models/AppointmentType.js";
import Booking, {
  encryptManageToken,
  generateManageToken,
  hashManageToken,
} from "../../models/Booking.js";
import BookingPage from "../../models/BookingPage.js";
import { hashToken } from "../../models/EventRegistration.js";
import {
  BookingError,
  acquireHostLock,
  attachClient,
  assertSlotAvailable,
  bookingAmountsFor,
  finalizeBooking,
  findClientByEmail,
  guestBookingPayload,
  loadHost,
  loadOrganization,
  manageTokenOf,
  organizationNameOf,
  pageZone,
  releaseHostLock,
} from "./bookingService.js";
import {
  deliverBookingEmail,
  formatWhen,
  manageUrlFor,
  publicPageUrl,
} from "./bookingEmails.js";
import {
  BANK_TRANSFER,
  ONLINE_HOLD_MS,
  PENDING_PAYMENT_CAP_MS,
  bankTransferDueAt,
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
import {
  eventPaymentMethods,
  typePaymentMethods,
} from "./eventRegistrationService.js";
import {
  DirectPaymentUnavailableError,
  ONLINE_PAYMENT_PROVIDERS,
  closeDirectCheckout,
  createDirectCheckout,
  directStripeAccountIds,
  findSumupAccount,
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
import { paymentReturnBase } from "../transferPaymentService.js";
import { slotPaymentModeOf } from "../../utils/appointmentValidation.js";
import logger from "../../utils/logger.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// Session Stripe : 30 minutes au moins (exigence Stripe)
const STRIPE_SESSION_TTL_S = 31 * 60;
export const RETURN_TOKEN_TTL_MS = HOUR;
const RETURN_TOKEN_GRACE_MS = 5 * MINUTE;
const CAPTURE_CLAIM_MS = 2 * MINUTE;
const EXPIRED_RECHECK_MS = 24 * HOUR;
const RECHECK_INTERVAL_MS = 15 * 1000;
const FORCED_RECHECK_INTERVAL_MS = 3 * 1000;
const SWEEP_MIN_AGE_MS = 2 * MINUTE;
const SWEEP_PENDING_WINDOW_MS = 7 * 24 * HOUR;
const LOG = "[rendez-vous]";
// Réservations par virement en attente par adresse et par organisateur
export const MAX_PENDING_TRANSFERS_PER_GUEST = 2;

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));
const isObjectId = (id) =>
  typeof id === "string"
    ? /^[a-f0-9]{24}$/i.test(id)
    : id instanceof mongoose.Types.ObjectId;
const iso = (date) => (date ? new Date(date).toISOString() : null);

const sumupPrefix = (bookingId) => `newbi-rdv-${bookingId}-`;
const paypalCustomId = (bookingId) => `rdv-${bookingId}`;

/** Montant attendu chez le prestataire (tout ou acompte), en centimes. */
export const expectedBookingAmount = (booking) =>
  Number(booking?.amountOnline) || 0;

/** Réservation payante (montant enregistré ou paiement lancé). */
export const isPaidBooking = (booking) =>
  Number(booking?.amount) > 0 || Boolean(booking?.payment?.provider);

/** Même règle que les inscriptions : NONE, REFUNDED ou MANUAL. */
export function bookingRefundStatus(booking) {
  const payment = booking?.payment;
  if (!payment?.paidAt || booking.status === "CONFIRMED") return "NONE";
  if (payment.refundedAt) return "REFUNDED";
  return "MANUAL";
}

/**
 * Champs de paiement vus par l'invité (réservation, retour, gestion). Vide
 * pour un rendez-vous gratuit : la réponse garde sa forme d'avant.
 */
export async function bookingPaymentFields(booking) {
  if (!isPaidBooking(booking)) return {};
  return {
    status: booking.status,
    amount: booking.amount || 0,
    currency: booking.currency || "EUR",
    paymentMode: booking.paymentMode || null,
    amountOnline: Number(booking.amountOnline) || 0,
    amountDueOnSite: Number(booking.amountDueOnSite) || 0,
    onSitePaidAt: iso(booking.onSitePaidAt),
    paymentProvider: booking.payment?.provider || null,
    expiresAt:
      booking.status === "PENDING_PAYMENT" ? iso(booking.expiresAt) : null,
    bankTransfer: await bankTransferPayload(booking, {
      amountCents: expectedBookingAmount(booking),
      currency: booking.currency,
      startAt: booking.startAt,
    }),
    refundStatus: bookingRefundStatus(booking),
  };
}

/** Réservation renvoyée à l'invité, avec son paiement. */
export async function bookingPayload(booking, { host }) {
  return {
    ...guestBookingPayload(booking, { host }),
    ...(await bookingPaymentFields(booking)),
  };
}

/** Page, type, organisation et organisateur d'une réservation. */
async function bookingContext(booking) {
  const [page, type, organization, host] = await Promise.all([
    BookingPage.findById(booking.bookingPageId).lean(),
    booking.appointmentTypeId
      ? AppointmentType.findById(booking.appointmentTypeId).lean()
      : null,
    loadOrganization(booking.workspaceId),
    loadHost(booking.hostUserId),
  ]);
  return {
    page,
    type,
    organization,
    host: host || { name: "", email: null },
    organizationName: organizationNameOf(organization) || host?.name || "",
  };
}

const whenTextOf = (booking) => {
  const when = formatWhen(
    booking.startAt,
    booking.endAt,
    booking.guest?.timezone,
  );
  return `${when.date} à ${when.start}`;
};

const guestNameOf = (booking) =>
  `${booking.guest?.firstName || ""} ${booking.guest?.lastName || ""}`.trim();

// ─── Réservation payante ─────────────────────────────────────────────────

/**
 * Réserve un créneau payé à la réservation (ONLINE ou DEPOSIT).
 *
 * @param {object} params - comme createBooking, plus :
 * @param {string} params.provider - stripe, paypal, sumup ou bank_transfer
 * @param {string|null} params.returnOrigin - en-tête Origin (hors prod)
 * @returns {Promise<{ booking, token, paymentUrl?, bankTransfer?, emails? }>}
 * @throws {BookingError} UNAVAILABLE, SLOT_TAKEN, PAYMENT_METHOD_UNAVAILABLE,
 *   PAYMENT_START_FAILED
 */
export async function createPaidBooking({
  context,
  type,
  start,
  guest,
  timezone,
  provider,
  returnOrigin = null,
  now = new Date(),
}) {
  const { page } = context;
  const mode = slotPaymentModeOf(type);
  if (mode !== "ONLINE" && mode !== "DEPOSIT") {
    throw new Error("rendez-vous sans paiement à la réservation");
  }
  const methods = await typePaymentMethods(
    type,
    await eventPaymentMethods(page.workspaceId),
  );
  if (!provider || !methods.includes(provider)) {
    throw new BookingError("PAYMENT_METHOD_UNAVAILABLE", 409);
  }

  // 1. Client bloqué dans le CRM
  const existingClient = await findClientByEmail(page.workspaceId, guest.email);
  if (existingClient?.isBlocked) {
    throw new BookingError("UNAVAILABLE", 403);
  }

  // 2. Réservations échues : créneaux libérés avant le calcul (en base
  // seulement, la relecture chez les prestataires reste au balayage)
  await expireOverdueBookings({ hostUserId: page.userId, now, recheck: false });

  const bank = provider === BANK_TRANSFER;
  const startAt = new Date(start);
  // Virement : aucun délai minimum (virement instantané), créneau gardé
  // jusqu'à min(réservation + 3 jours, début)
  const bankReference = bank ? await newBankReference(page.workspaceId) : null;
  const endAt = new Date(startAt.getTime() + type.durationMinutes * MINUTE);
  const token = generateManageToken();
  const amounts = bookingAmountsFor(type);

  // 3. Créneau tenu, sous le verrou de l'organisateur
  let booking;
  const lock = await acquireHostLock(page.userId);
  try {
    // Au plus deux réservations par virement en attente par adresse chez
    // un même organisateur (créneaux gardés 3 jours)
    if (
      bank &&
      (await Booking.countDocuments({
        hostUserId: page.userId,
        "guest.email": guest.email,
        status: "PENDING_PAYMENT",
        "payment.provider": BANK_TRANSFER,
      })) >= MAX_PENDING_TRANSFERS_PER_GUEST
    ) {
      throw new BookingError("TOO_MANY_PENDING_TRANSFERS", 409);
    }
    await assertSlotAvailable({ page, type, start: startAt, now });
    booking = await Booking.create({
      workspaceId: page.workspaceId,
      bookingPageId: page._id,
      appointmentTypeId: type._id,
      hostUserId: page.userId,
      startAt,
      endAt,
      typeName: type.name,
      durationMinutes: type.durationMinutes,
      location: {
        kind: type.location.kind,
        value: type.location.value || null,
      },
      guest: {
        firstName: guest.firstName,
        lastName: guest.lastName,
        email: guest.email,
        phone: guest.phone || null,
        message: guest.message || null,
        timezone: timezone || pageZone(page),
      },
      status: "PENDING_PAYMENT",
      manageTokenHash: hashManageToken(token),
      manageTokenEncrypted: encryptManageToken(token),
      ...amounts,
      expiresAt: bank
        ? bankTransferDueAt(startAt, now)
        : new Date(now.getTime() + ONLINE_HOLD_MS),
      payment: bank
        ? { provider: BANK_TRANSFER, status: "open", bankReference }
        : { provider, status: "starting" },
    }).catch((error) => {
      // Index unique des créneaux tenus ou confirmés : dernier rempart
      if (error?.code === 11000) throw new BookingError("SLOT_TAKEN", 409);
      throw error;
    });
  } finally {
    await releaseHostLock(lock);
  }

  logger.info(
    `${LOG} réservation payante ${booking._id} en attente (${provider}, ${amounts.amountOnline} centimes, organisateur ${page.userId}, ${startAt.toISOString()})`,
  );

  // 4a. Virement : coordonnées à l'écran et par e-mail
  if (bank) {
    const emails = sendBankTransferPendingEmail(booking, token);
    return { booking, token, bankTransfer: true, emails };
  }

  // 4b. Paiement chez le prestataire, sur le compte du vendeur
  const returnToken = crypto.randomBytes(32).toString("base64url");
  const back = `${paymentReturnBase(returnOrigin)}/rdv/${page.slug}/${type.slug}/retour?rt=${returnToken}&provider=${provider}&kind=slot`;
  const when = formatWhen(startAt, endAt, pageZone(page));
  let started;
  try {
    started = await createDirectCheckout({
      provider,
      workspaceId: page.workspaceId,
      amount: amounts.amountOnline / 100,
      currency: amounts.currency,
      name: `${mode === "DEPOSIT" ? "Acompte" : "Rendez-vous"} : ${String(type.name).slice(0, 200)}`,
      description: `${when.date} à ${when.start}`,
      metadata: {
        type: "appointment_booking",
        bookingId: String(booking._id),
        workspaceId: String(page.workspaceId),
      },
      returnUrl: back,
      cancelUrl: `${back}&canceled=1`,
      stripeExpiresAt: Math.floor(now.getTime() / 1000) + STRIPE_SESSION_TTL_S,
      idempotencyKey: `appointment-booking-${booking._id}`,
      sumupReference: `${sumupPrefix(booking._id)}${returnToken.slice(0, 12)}`,
      paypalCustomId: paypalCustomId(booking._id),
      brandName: organizationNameOf(context.organization) || null,
    });
  } catch (error) {
    if (!(error instanceof DirectPaymentUnavailableError)) {
      logger.error(
        `${LOG} paiement ${provider} de la réservation ${booking._id} non lancé : ${error.message}`,
      );
    }
    // Créneau libéré tout de suite
    await Booking.updateOne(
      { _id: booking._id, status: "PENDING_PAYMENT" },
      { $set: { status: "EXPIRED", expiredAt: new Date() } },
    );
    if (
      error instanceof DirectPaymentUnavailableError ||
      (error instanceof PaypalApiError &&
        String(error.issue || "").startsWith("PAYEE_"))
    ) {
      throw new BookingError("PAYMENT_METHOD_UNAVAILABLE", 409);
    }
    throw new BookingError("PAYMENT_START_FAILED", 502);
  }

  booking = await Booking.findByIdAndUpdate(
    booking._id,
    {
      $set: {
        "payment.provider": started.attempt.provider,
        "payment.reference": started.attempt.reference,
        ...(started.attempt.accountId
          ? { "payment.accountId": started.attempt.accountId }
          : {}),
        "payment.status": "open",
        "payment.returnTokenHash": hashToken(returnToken),
        "payment.returnTokenExpiresAt": new Date(
          now.getTime() + RETURN_TOKEN_TTL_MS,
        ),
      },
    },
    { new: true },
  );
  return { booking, token, paymentUrl: started.url };
}

// ─── Confirmation ────────────────────────────────────────────────────────

function paidSetOf(payment, booking) {
  return {
    "payment.status": "paid",
    "payment.paymentId": payment.paymentId || `paid:${booking._id}`,
    ...(payment.captureId ? { "payment.captureId": payment.captureId } : {}),
    ...(payment.refundReference
      ? { "payment.refundReference": payment.refundReference }
      : {}),
    "payment.paidAt": new Date(),
    "payment.paidAmount": payment.amountCents,
    ...(payment.payerEmail ? { "payment.payerEmail": payment.payerEmail } : {}),
    ...(payment.markedBy ? { "payment.markedBy": payment.markedBy } : {}),
    ...(payment.accountId ? { "payment.accountId": payment.accountId } : {}),
  };
}

/** Lien fourni par l'organisateur : posé à la confirmation. */
const meetingUrlSet = (booking) =>
  booking.location?.kind === "CUSTOM_LINK" && booking.location.value
    ? { meetingUrl: booking.location.value }
    : {};

/**
 * Passe la réservation en CONFIRMED depuis `fromStatus` (atomique).
 * @returns {Promise<object|null|"TAKEN">} null si l'état a changé, TAKEN si
 *   un autre rendez-vous confirmé commence au même instant (index unique)
 */
async function confirmFrom(booking, fromStatus, set, extraFilter = {}) {
  try {
    return await Booking.findOneAndUpdate(
      { _id: booking._id, status: fromStatus, ...extraFilter },
      { $set: { status: "CONFIRMED", ...meetingUrlSet(booking), ...set } },
      { new: true },
    );
  } catch (error) {
    if (error?.code === 11000) return "TAKEN";
    throw error;
  }
}

/** Après confirmation : agendas, client, e-mails (jamais d'erreur). */
async function afterBookingConfirmed(booking) {
  try {
    const context = await bookingContext(booking);
    if (!context.page) {
      logger.error(
        `${LOG} réservation ${booking._id} confirmée sans page : suite non faite`,
      );
      return booking;
    }
    const result = await finalizeBooking({
      booking,
      context,
      token: manageTokenOf(booking),
    });
    await result.emails;
    return result.booking;
  } catch (error) {
    logger.error(
      `${LOG} suite de la réservation payée ${booking._id} : ${error.message}`,
    );
    return booking;
  }
}

/**
 * Réservation expirée payée : confirmée si son créneau passe encore le
 * calcul complet des créneaux (agendas, marges, horaires, préavis, date
 * passée), la réservation elle-même exclue. Le verrou de l'organisateur
 * doit être tenu par l'appelant.
 * @returns {Promise<object|null>} la réservation confirmée, sinon null
 */
async function confirmIfSlotFree(booking, set, extraFilter = {}) {
  if (booking.status !== "EXPIRED") return null;
  if (new Date(booking.startAt) <= new Date()) return null;
  const [page, storedType] = await Promise.all([
    BookingPage.findById(booking.bookingPageId).lean(),
    booking.appointmentTypeId
      ? AppointmentType.findById(booking.appointmentTypeId).lean()
      : null,
  ]);
  if (!page) return null;
  // Règles du type actuel, durée réservée conservée (comme un déplacement)
  const type = {
    ...(storedType || { _id: booking.appointmentTypeId }),
    durationMinutes: booking.durationMinutes,
  };
  try {
    await assertSlotAvailable({
      page,
      type,
      start: new Date(booking.startAt),
      now: new Date(),
      excludeBooking: booking,
    });
  } catch (error) {
    if (error instanceof BookingError) return null;
    throw error;
  }
  const confirmed = await confirmFrom(booking, "EXPIRED", set, extraFilter);
  return confirmed && confirmed !== "TAKEN" ? confirmed : null;
}

async function refundLateBookingPayment(booking, payment) {
  const reason = latePaymentReason(booking, booking.startAt);
  try {
    const refunded = await refundDirectPayment({
      provider: payment.provider,
      paymentId: payment.paymentId,
      accountId: payment.accountId,
      refundReference: payment.refundReference,
      workspaceId: booking.workspaceId,
      metadata: {
        type: "appointment_booking",
        bookingId: String(booking._id),
      },
      idempotencyKey: `appointment-refund-${booking._id}`,
      reason: "requested_by_customer",
    });
    if (refunded) {
      await Booking.updateOne(
        { _id: booking._id },
        { $set: { "payment.refundedAt": new Date() } },
      );
      logger.warn(
        `${LOG} paiement ${payment.paymentId} de la réservation ${booking._id} arrivé sans créneau : remboursé`,
      );
      await sendLatePaymentEmail(booking, payment, true, reason);
      return true;
    }
    throw new Error("remboursement automatique non pris en charge");
  } catch (error) {
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { "payment.refundError": String(error.message).slice(0, 500) } },
    );
    logger.error(
      `${LOG} ANOMALIE : paiement ${payment.provider} ${payment.paymentId} de la réservation ${booking._id} arrivé sans créneau, NON remboursé (${error.message}) : à rembourser à la main`,
    );
    await notifyHostRefundNeeded({
      hostUserId: booking.hostUserId,
      workspaceId: booking.workspaceId,
      payerName: guestNameOf(booking),
      payerEmail: booking.guest?.email,
      amountCents: payment.amountCents ?? expectedBookingAmount(booking),
      currency: booking.currency,
      provider: payment.provider,
      reference: booking.payment?.bankReference || null,
      label: `le rendez-vous « ${booking.typeName} » du ${whenTextOf(booking)}`,
      reason,
    }).catch((notifyError) =>
      logger.error(
        `${LOG} avis de remboursement de la réservation ${booking._id} : ${notifyError.message}`,
      ),
    );
    await sendLatePaymentEmail(booking, payment, false, reason);
    return false;
  }
}

/** Au payeur : paiement arrivé sans créneau (remboursé ou à rembourser). */
async function sendLatePaymentEmail(booking, payment, refunded, reason) {
  try {
    const { host, organizationName } = await bookingContext(booking);
    await deliverBookingEmail({
      to: booking.guest.email,
      replyTo: host.email || undefined,
      organizationName,
      ...buildLatePaymentEmail({
        firstName: booking.guest.firstName,
        title: booking.typeName,
        amountCents: payment.amountCents ?? expectedBookingAmount(booking),
        currency: booking.currency,
        refunded,
        reason,
        organizationName,
      }),
    });
  } catch (error) {
    logger.error(
      `${LOG} e-mail de paiement tardif de la réservation ${booking._id} : ${error.message}`,
    );
  }
}

/** Paiement à rendre : réservation passée EXPIRED avec son paiement. */
async function closeAndRefund(current, set, payment) {
  const closed = await Booking.findOneAndUpdate(
    { _id: current._id, status: "PENDING_PAYMENT", "payment.paidAt": null },
    {
      $set: {
        status: "EXPIRED",
        expiredAt: new Date(),
        ...set,
        "payment.provider": payment.provider,
      },
    },
    { new: true },
  );
  if (closed) {
    await refundLateBookingPayment(closed, {
      ...payment,
      accountId: payment.accountId || closed.payment?.accountId,
    });
  }
  return closed;
}

/**
 * Paiement vérifié : confirme la réservation (une seule fois).
 * - début passé : jamais confirmée, paiement rendu ;
 * - expirée : confirmée si le créneau passe encore le calcul complet,
 *   sinon remboursée ou signalée « à rembourser à la main » ;
 * - annulée : remboursée ou signalée.
 * @param {object} payment - { provider, paymentId, amountCents, captureId,
 *   refundReference, payerEmail, accountId, markedBy }
 * @returns {Promise<{status: "paid"|"pending"}>} pending : verrou de
 *   l'organisateur indisponible, rien d'enregistré (réessayé au balayage)
 */
export async function markBookingPaid(booking, payment, depth = 0) {
  const current = await Booking.findById(booking._id);
  if (!current || current.status === "CONFIRMED") return { status: "paid" };
  const set = paidSetOf(payment, current);
  const started = new Date(current.startAt) <= new Date();

  if (current.status === "PENDING_PAYMENT") {
    if (started) {
      const closed = await closeAndRefund(current, set, payment);
      if (closed) return { status: "paid" };
    } else {
      const confirmed = await confirmFrom(current, "PENDING_PAYMENT", set);
      if (confirmed && confirmed !== "TAKEN") {
        logger.info(
          `${LOG} réservation ${current._id} payée (${payment.provider}, ${payment.amountCents} centimes)`,
        );
        await afterBookingConfirmed(confirmed);
        return { status: "paid" };
      }
      // Créneau pris malgré la tenue (dernier rempart) : paiement à rendre
      if (confirmed === "TAKEN") {
        await closeAndRefund(current, set, payment);
        return { status: "paid" };
      }
    }
    // État changé entre-temps (expirée, annulée) : nouvel essai
    return depth < 3
      ? markBookingPaid(booking, payment, depth + 1)
      : { status: "paid" };
  }

  // Paiement tardif : sous le verrou de l'organisateur, revendiqué une
  // seule fois. Verrou indisponible : rien n'est enregistré, le paiement
  // est relu au prochain passage (jamais de contrôle sans verrou)
  const lock = await acquireHostLock(current.hostUserId).catch(() => null);
  if (!lock) {
    logger.warn(
      `${LOG} paiement tardif de la réservation ${current._id} : verrou indisponible, réessayé plus tard`,
    );
    return { status: "pending" };
  }
  let claimed = null;
  let confirmed = null;
  try {
    claimed = await Booking.findOneAndUpdate(
      { _id: current._id, status: current.status, "payment.paidAt": null },
      { $set: { ...set, "payment.provider": payment.provider } },
      { new: true },
    );
    if (claimed && !started) confirmed = await confirmIfSlotFree(claimed, {});
  } finally {
    await releaseHostLock(lock);
  }
  if (!claimed) return { status: "paid" };
  if (confirmed) {
    logger.info(
      `${LOG} réservation ${claimed._id} payée après expiration : confirmée (créneau encore libre)`,
    );
    await afterBookingConfirmed(confirmed);
    return { status: "paid" };
  }
  await refundLateBookingPayment(claimed, {
    ...payment,
    accountId: payment.accountId || claimed.payment?.accountId,
  });
  return { status: "paid" };
}

// ─── Vérification chez le prestataire ────────────────────────────────────

async function setPaymentStatus(booking, status, extra = {}) {
  await Booking.updateOne(
    { _id: booking._id },
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

const sameCurrency = (a, booking) =>
  String(a || "").toUpperCase() ===
  String(booking.currency || "EUR").toUpperCase();

/** Session Checkout (retour, webhook, balayage) : compte, montant, devise. */
export async function applyStripeSessionToBooking(booking, session, accountId) {
  if (!session || session.metadata?.bookingId !== String(booking._id)) {
    logger.warn(
      `${LOG} session ${session?.id} étrangère à la réservation ${booking._id}`,
    );
    return { status: "unpaid" };
  }
  const allowed = new Set(
    [
      booking.payment?.accountId,
      ...(await directStripeAccountIds(booking.workspaceId)),
    ].filter(Boolean),
  );
  if (!accountId || !allowed.has(accountId)) {
    logger.warn(
      `${LOG} session ${session.id} venue du compte ${accountId}, étranger à la réservation ${booking._id}`,
    );
    return { status: "unpaid" };
  }
  if (session.payment_status === "paid") {
    const expected = expectedBookingAmount(booking);
    if (
      !(expected > 0) ||
      session.amount_total !== expected ||
      !sameCurrency(session.currency, booking)
    ) {
      logger.error(
        `${LOG} ANOMALIE : session ${session.id} payée ${session.amount_total} ${session.currency} pour la réservation ${booking._id} (${expected} ${booking.currency}) : non appliquée`,
      );
      return { status: "unpaid" };
    }
    return markBookingPaid(booking, {
      provider: "stripe",
      paymentId: session.payment_intent || session.id,
      amountCents: session.amount_total,
      payerEmail: session.customer_details?.email,
      accountId,
    });
  }
  if (session.status === "complete") {
    await setPaymentStatus(booking, "pending");
    return { status: "pending" };
  }
  if (session.status === "expired") await setPaymentStatus(booking, "failed");
  return { status: "unpaid" };
}

async function verifyStripe(booking, sessionId) {
  const payment = booking.payment || {};
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
        ...(await directStripeAccountIds(booking.workspaceId)),
      ].filter(Boolean),
    ),
  ];
  const found = await retrieveStripeSession(reference, accounts, LOG);
  if (!found) return { status: "unpaid" };
  return applyStripeSessionToBooking(booking, found.session, found.accountId);
}

async function applyPaypalSummary(booking, summary) {
  if (summary.customId !== paypalCustomId(booking._id)) {
    logger.warn(
      `${LOG} commande PayPal ${summary.orderId} étrangère à la réservation ${booking._id}`,
    );
    return { status: "unpaid" };
  }
  if (summary.captureStatus === "COMPLETED") {
    const expected = expectedBookingAmount(booking);
    if (
      !(expected > 0) ||
      !sameAmount(summary.amount, expected / 100) ||
      !sameCurrency(summary.currency, booking)
    ) {
      logger.error(
        `${LOG} ANOMALIE : capture PayPal ${summary.captureId} de ${summary.amount} ${summary.currency} pour la réservation ${booking._id} : non appliquée`,
      );
      return { status: "unpaid" };
    }
    return markBookingPaid(booking, {
      provider: "paypal",
      paymentId: summary.captureId,
      captureId: summary.captureId,
      amountCents: expected,
      payerEmail: summary.payerEmail,
    });
  }
  if (summary.captureStatus === "PENDING") {
    await setPaymentStatus(booking, "pending", {
      captureId: summary.captureId,
    });
    return { status: "pending" };
  }
  if (
    ["DECLINED", "FAILED"].includes(summary.captureStatus) ||
    summary.orderStatus === "VOIDED"
  ) {
    await setPaymentStatus(booking, "failed");
  }
  return { status: "unpaid" };
}

/** Encaissement PayPal revendiqué (réservation toujours en attente). */
function claimPaypalCapture(booking, now = new Date()) {
  return Booking.findOneAndUpdate(
    {
      _id: booking._id,
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

async function releasePaypalClaim(booking) {
  await Booking.updateOne(
    { _id: booking._id, "payment.status": "capturing" },
    { $set: { "payment.status": "open", "payment.captureClaimedAt": null } },
  );
}

async function verifyPaypal(booking, orderId) {
  if (!isPaypalConfigured()) return { status: "unpaid" };
  const payment = booking.payment || {};
  try {
    if (payment.status === "pending" && payment.captureId) {
      const capture = await getPaypalCapture(payment.captureId);
      return applyPaypalSummary(booking, {
        orderId: payment.reference,
        customId: capture?.custom_id || paypalCustomId(booking._id),
        captureId: capture?.id,
        captureStatus: capture?.status,
        amount: Number(capture?.amount?.value),
        currency: capture?.amount?.currency_code,
      });
    }
    const reference = payment.reference;
    if (!isPaypalId(reference)) return { status: "unpaid" };
    if (orderId && orderId !== reference) {
      logger.warn(
        `${LOG} retour PayPal ${orderId} différent de la commande ${reference} de la réservation ${booking._id}`,
      );
    }
    let summary = summarizePaypalOrder(await getPaypalOrder(reference));
    // Commande approuvée : encaissée seulement si la réservation attend
    // encore son paiement (expirée ou annulée : jamais encaissée)
    if (
      summary.orderStatus === "APPROVED" &&
      summary.customId === paypalCustomId(booking._id)
    ) {
      const claimed = await claimPaypalCapture(booking);
      if (!claimed) {
        const fresh = await Booking.findById(booking._id)
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
        await releasePaypalClaim(booking);
        throw error;
      }
      const result = await applyPaypalSummary(claimed, summary);
      if (result.status !== "paid") await releasePaypalClaim(booking);
      return result;
    }
    return applyPaypalSummary(booking, summary);
  } catch (error) {
    logger.warn(
      `${LOG} vérification PayPal de la réservation ${booking._id} : ${error.message}`,
    );
    return { status: "unpaid" };
  }
}

export async function applySumupSummaryToBooking(booking, summary, account) {
  const expectedMerchant =
    booking.payment?.accountId || account?.merchantCode || null;
  if (
    !summary?.reference ||
    !summary.reference.startsWith(sumupPrefix(booking._id)) ||
    (summary.merchantCode &&
      expectedMerchant &&
      summary.merchantCode !== expectedMerchant)
  ) {
    logger.warn(
      `${LOG} paiement SumUp ${summary?.id} étranger à la réservation ${booking._id}`,
    );
    return { status: "unpaid" };
  }
  if (summary.status === "PAID") {
    const expected = expectedBookingAmount(booking);
    if (
      !(expected > 0) ||
      !sameAmount(summary.amount, expected / 100) ||
      !sameCurrency(summary.currency, booking)
    ) {
      logger.error(
        `${LOG} ANOMALIE : paiement SumUp ${summary.id} de ${summary.amount} ${summary.currency} pour la réservation ${booking._id} : non appliqué`,
      );
      return { status: "unpaid" };
    }
    return markBookingPaid(booking, {
      provider: "sumup",
      paymentId: summary.id,
      amountCents: expected,
      accountId: expectedMerchant || undefined,
      refundReference: summary.transactionId || undefined,
    });
  }
  if (summary.status === "FAILED" || summary.status === "EXPIRED") {
    await setPaymentStatus(booking, "failed");
  }
  return { status: "unpaid" };
}

async function verifySumup(booking) {
  if (!isSumupConfigured()) return { status: "unpaid" };
  const payment = booking.payment || {};
  if (payment.provider !== "sumup" || !isSumupCheckoutId(payment.reference)) {
    return { status: "unpaid" };
  }
  const account = await findSumupAccount(booking.workspaceId);
  if (!account) return { status: "unpaid" };
  try {
    const summary = summarizeSumupCheckout(
      await getSumupCheckout(account, payment.reference),
    );
    return applySumupSummaryToBooking(booking, summary, account);
  } catch (error) {
    logger.warn(
      `${LOG} vérification SumUp de la réservation ${booking._id} : ${error.message}`,
    );
    return { status: "unpaid" };
  }
}

/**
 * Relit le paiement de la réservation chez le prestataire (virement : rien
 * à relire, voir appointmentBankDetection.js).
 * @returns {Promise<{status: "paid"|"pending"|"unpaid"|"free"}>}
 */
export async function refreshBookingPayment(
  booking,
  { force = false, sessionId, orderId } = {},
) {
  if (!(expectedBookingAmount(booking) > 0)) return { status: "free" };
  const payment = booking.payment || {};
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
  await Booking.updateOne(
    { _id: booking._id },
    { $set: { "payment.checkedAt": new Date() } },
  );
  try {
    const result =
      payment.provider === "stripe"
        ? await verifyStripe(booking, sessionId)
        : payment.provider === "sumup"
          ? await verifySumup(booking)
          : await verifyPaypal(booking, orderId);
    return { status: result.status };
  } catch (error) {
    logger.error(
      `${LOG} vérification de la réservation ${booking._id} : ${error.message}`,
    );
    return { status: "unpaid" };
  }
}

/** Notification SumUp : relit le paiement d'une réservation. */
export async function handleSumupBookingNotification(checkoutId) {
  if (!isSumupCheckoutId(checkoutId)) return { status: "ignored" };
  const booking = await Booking.findOne({
    "payment.provider": "sumup",
    "payment.reference": checkoutId,
  });
  if (!booking) return { status: "ignored" };
  const result = await refreshBookingPayment(booking, { force: true });
  return { status: result.status };
}

/** Webhook Stripe Connect : session d'une réservation. */
export async function applyBookingSessionEvent(type, session, accountId) {
  const id = session?.metadata?.bookingId;
  if (!isObjectId(id)) {
    return { status: "ignored", message: "Réservation absente de la session" };
  }
  const booking = await Booking.findById(id);
  if (!booking) return { status: "error", message: "Réservation introuvable" };
  if (type === "checkout.session.async_payment_failed") {
    await setPaymentStatus(booking, "failed");
    return { status: "ignored", message: "Paiement différé refusé" };
  }
  const result = await applyStripeSessionToBooking(booking, session, accountId);
  return {
    status: result.status === "paid" ? "success" : "ignored",
    message: `Réservation ${result.status}`,
  };
}

// ─── Retour du payeur ────────────────────────────────────────────────────

function returnTokenUsable(booking, now = new Date()) {
  const payment = booking?.payment;
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
  return Booking.findOne({ "payment.returnTokenHash": hashToken(returnToken) });
}

/**
 * Retour du payeur sur le site : paiement relu chez le prestataire.
 * @returns {Promise<{paymentStatus, booking}|null>} null si jeton inconnu ou périmé
 */
export async function handleBookingPaymentReturn({
  returnToken,
  sessionId,
  orderId,
  now = new Date(),
}) {
  let booking = await findByReturnToken(returnToken);
  if (!returnTokenUsable(booking, now)) return null;
  let paymentStatus = "unpaid";
  if (booking.payment?.paidAt) {
    paymentStatus = "paid";
  } else {
    const result = await refreshBookingPayment(booking, {
      force: true,
      sessionId,
      orderId,
    });
    paymentStatus = result.status === "free" ? "paid" : result.status;
    booking = await Booking.findById(booking._id);
  }
  if (
    booking.status === "CONFIRMED" &&
    !booking.payment?.returnTokenConsumedAt
  ) {
    await Booking.updateOne(
      { _id: booking._id, "payment.returnTokenConsumedAt": null },
      { $set: { "payment.returnTokenConsumedAt": now } },
    );
  }
  return { paymentStatus, booking };
}

/**
 * Le payeur abandonne : paiement fermé, relu une dernière fois, puis
 * réservation expirée (créneau libéré) s'il est bien impayé.
 */
export async function abandonBookingPayment({ returnToken, now = new Date() }) {
  const booking = await findByReturnToken(returnToken);
  if (!returnTokenUsable(booking, now)) return null;
  if (booking.status !== "PENDING_PAYMENT") {
    return {
      paymentStatus: booking.payment?.paidAt ? "paid" : "unpaid",
      booking,
    };
  }
  await closeDirectCheckout(booking.payment, booking.workspaceId, LOG);
  await Booking.updateOne(
    { _id: booking._id },
    { $set: { "payment.checkedAt": null } },
  );
  const fresh = await Booking.findById(booking._id);
  const result = await refreshBookingPayment(fresh, { force: true });
  if (result.status === "paid" || result.status === "pending") {
    return {
      paymentStatus: result.status,
      booking: await Booking.findById(booking._id),
    };
  }
  // Abandon volontaire : pas d'e-mail d'expiration
  const expired = await expireBooking(fresh, { now, notify: false });
  const after = await Booking.findById(booking._id);
  return {
    paymentStatus:
      !expired && after.status === "PENDING_PAYMENT" ? "pending" : "unpaid",
    booking: after,
  };
}

// ─── Expiration et balayage ──────────────────────────────────────────────

/**
 * Réservation échue : EXPIRED, créneau libéré, paiement fermé, e-mail au
 * participant. Jamais pendant un encaissement PayPal ni un paiement en
 * confirmation.
 */
async function expireBooking(
  booking,
  {
    now = new Date(),
    notify = true,
    pendingCapped = false,
    closeCheckout = true,
  } = {},
) {
  const expired = await Booking.findOneAndUpdate(
    {
      _id: booking._id,
      status: "PENDING_PAYMENT",
      "payment.paidAt": null,
      // Paiement en confirmation : seulement au-delà du plafond
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
        ...(booking.payment?.reference
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
  // Sans appel au prestataire (réservation d'un invité) : la session se
  // ferme seule, un paiement tardif suit la règle du paiement tardif
  if (closeCheckout) {
    await closeDirectCheckout(expired.payment, expired.workspaceId, LOG);
  }
  logger.info(`${LOG} réservation ${expired._id} expirée : créneau libéré`);
  // Virement reçu après la garde : pas d'avis d'expiration, l'organisateur
  // décide
  if (notify && !expired.payment?.receivedAt) {
    await sendBookingExpiredEmail(expired).catch((error) =>
      logger.error(
        `${LOG} e-mail d'expiration de la réservation ${expired._id} : ${error.message}`,
      ),
    );
  }
  return true;
}

const isPendingCapped = (booking, now) =>
  booking.payment?.status === "pending" &&
  (new Date(booking.createdAt).getTime() <=
    now.getTime() - PENDING_PAYMENT_CAP_MS ||
    new Date(booking.startAt) <= now);

/**
 * Réservations en attente échues (d'un organisateur, ou toutes), puis
 * EXPIRED. `recheck` : dernière vérification chez le prestataire (balayage) ;
 * sans elle (réservation d'un invité), expiration en base seulement, un
 * paiement arrivé ensuite suit la règle du paiement tardif. Paiement en
 * confirmation chez le prestataire : expiré au plus tard à min(7 jours,
 * début). @returns {Promise<number>}
 */
export async function expireOverdueBookings({
  hostUserId = null,
  now = new Date(),
  limit = 100,
  recheck = true,
} = {}) {
  const overdueFilter = {
    expiresAt: { $lte: now },
    "payment.status": { $nin: ["pending", "capturing"] },
  };
  const filter = {
    status: "PENDING_PAYMENT",
    $or: recheck
      ? [
          overdueFilter,
          {
            "payment.status": "pending",
            $or: [
              {
                createdAt: {
                  $lte: new Date(now.getTime() - PENDING_PAYMENT_CAP_MS),
                },
              },
              { startAt: { $lte: now } },
            ],
          },
        ]
      : [overdueFilter],
  };
  if (hostUserId) filter.hostUserId = hostUserId;
  const overdue = await Booking.find(filter)
    .sort({ expiresAt: 1 })
    .limit(limit);
  let count = 0;
  for (const booking of overdue) {
    try {
      const pendingCapped = isPendingCapped(booking, now);
      if (recheck) {
        const result = await refreshBookingPayment(booking, { force: true });
        if (result.status === "paid") continue;
        if (result.status === "pending" && !pendingCapped) continue;
      }
      if (
        await expireBooking(booking, {
          now,
          pendingCapped,
          closeCheckout: recheck,
        })
      )
        count += 1;
    } catch (error) {
      logger.error(
        `${LOG} expiration de la réservation ${booking._id} : ${error.message}`,
      );
    }
  }
  return count;
}

/**
 * Balayage (toutes les 5 minutes, instance 0) : paiements ouverts
 * revérifiés, réservations échues expirées.
 */
export async function sweepAppointmentBookings({ now = new Date() } = {}) {
  const minAge = new Date(now.getTime() - SWEEP_MIN_AGE_MS);
  const open = await Booking.find({
    "payment.reference": { $type: "string" },
    "payment.paidAt": null,
    $or: [
      {
        status: "PENDING_PAYMENT",
        "payment.status": { $in: ["open", "pending", "capturing"] },
        createdAt: {
          $lte: minAge,
          $gte: new Date(now.getTime() - SWEEP_PENDING_WINDOW_MS),
        },
      },
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
    .sort({ "payment.checkedAt": 1, createdAt: 1 })
    .limit(100);
  let checked = 0;
  for (const booking of open) {
    checked += 1;
    try {
      await refreshBookingPayment(booking);
    } catch (error) {
      logger.error(
        `${LOG} balayage de la réservation ${booking._id} : ${error.message}`,
      );
    }
  }
  const expired = await expireOverdueBookings({ now });
  if (expired) logger.info(`${LOG} ${expired} réservation(s) expirée(s)`);
  return { checked, expired };
}

// ─── E-mails au participant ──────────────────────────────────────────────

async function sendBankTransferPendingEmail(booking, token) {
  try {
    const bank = await bankTransferPayload(booking, {
      amountCents: expectedBookingAmount(booking),
      currency: booking.currency,
      startAt: booking.startAt,
    });
    if (!bank) return false;
    const { host, organizationName } = await bookingContext(booking);
    return await deliverBookingEmail({
      to: booking.guest.email,
      replyTo: host.email || undefined,
      organizationName,
      ...buildBankTransferPendingEmail({
        kind: "slot",
        firstName: booking.guest.firstName,
        title: booking.typeName,
        whenText: whenTextOf(booking),
        bank,
        organizationName,
        manageUrl: token ? manageUrlFor(token) : null,
      }),
    });
  } catch (error) {
    logger.error(
      `${LOG} e-mail de virement en attente de la réservation ${booking._id} : ${error.message}`,
    );
    return false;
  }
}

async function sendBookingExpiredEmail(booking) {
  const { page, type, host, organizationName } = await bookingContext(booking);
  return deliverBookingEmail({
    to: booking.guest.email,
    replyTo: host.email || undefined,
    organizationName,
    ...buildPaymentExpiredEmail({
      kind: "slot",
      firstName: booking.guest.firstName,
      title: booking.typeName,
      bankTransfer: booking.payment?.provider === BANK_TRANSFER,
      organizationName,
      rebookUrl:
        page && type?.isActive ? publicPageUrl(page.slug, type.slug) : null,
    }),
  });
}

// ─── Virement : annonce du participant ───────────────────────────────────

/**
 * « J'ai fait le virement » (ou son retrait) par l'invité, avec son jeton
 * de gestion. Rien n'est confirmé.
 * @returns {Promise<{declaredAt: Date|null}|null>} null si plus attendu
 */
export async function declareBookingBankTransfer(
  booking,
  { cancel = false } = {},
) {
  const result = await declareBankTransfer(Booking, booking, { cancel });
  if (!result) return null;
  const { doc, firstDeclaration } = result;
  if (firstDeclaration) {
    logger.info(`${LOG} virement annoncé pour la réservation ${doc._id}`);
    await notifyHostBankDeclared({
      hostUserId: doc.hostUserId,
      workspaceId: doc.workspaceId,
      payerName: guestNameOf(doc),
      payerEmail: doc.guest.email,
      amountCents: expectedBookingAmount(doc),
      currency: doc.currency,
      reference: doc.payment.bankReference,
      label: `le rendez-vous « ${doc.typeName} » du ${whenTextOf(doc)}`,
    }).catch((error) =>
      logger.error(
        `${LOG} annonce du virement de la réservation ${doc._id} : ${error.message}`,
      ),
    );
  }
  return { declaredAt: doc.payment?.declaredAt || null };
}

// ─── Organisateur ────────────────────────────────────────────────────────

/**
 * Rendez-vous déjà commencé, confirmé par l'organisateur : il est libre de
 * valider un virement à tout moment. Ni contrôle ni écriture d'agenda
 * (rendez-vous passé ou en cours), aucun e-mail « confirmé » au
 * participant ; seul le client CRM est rattaché. Refusé seulement si un
 * autre rendez-vous confirmé occupe déjà le même début (index unique).
 * @returns {Promise<object|"TAKEN"|null>}
 */
async function confirmStartedBooking(booking, set) {
  const confirmed = await confirmFrom(booking, booking.status, set, {
    "payment.paidAt": null,
  });
  if (!confirmed || confirmed === "TAKEN") return confirmed;
  try {
    const context = await bookingContext(booking);
    if (context.page && !confirmed.clientId) {
      const clientId = await attachClient({
        booking: confirmed,
        page: context.page,
        host: context.host,
      });
      if (clientId) {
        await Booking.updateOne({ _id: confirmed._id }, { $set: { clientId } });
      }
    }
  } catch (error) {
    logger.error(
      `${LOG} client CRM non rattaché à la réservation ${booking._id} : ${error.message}`,
    );
  }
  return confirmed;
}

/**
 * « Marquer comme payé » (virement reçu) par l'organisateur, libre à tout
 * moment, comme pour les transferts. `scope` : { workspaceId, hostUserId }.
 * - en attente, avant le début : confirmé (agenda, e-mails), même après
 *   l'échéance de la garde si le balayage ne l'a pas encore expirée ;
 * - expirée, avant le début : confirmée si le créneau passe encore le
 *   calcul complet (sinon SLOT_TAKEN) ;
 * - début passé (en attente ou expirée) : confirmée sans agenda ni e-mail
 *   (voir confirmStartedBooking).
 * Virement repéré après la garde (payment.receivedAt) : ses montant et
 * identifiant bancaires sont repris.
 * @returns {Promise<{booking}|{error: "NOT_FOUND"|"NOT_PENDING"|"SLOT_TAKEN"|"BUSY"}>}
 */
export async function markBookingPaidByHost({
  scope,
  bookingId,
  userId,
  now = new Date(),
}) {
  if (!isObjectId(String(bookingId))) return { error: "NOT_FOUND" };
  const filter = {
    _id: toObjectId(bookingId),
    workspaceId: scope.workspaceId,
    hostUserId: scope.hostUserId,
  };
  const booking = await Booking.findOne(filter);
  if (!booking) return { error: "NOT_FOUND" };
  if (booking.payment?.provider !== BANK_TRANSFER) {
    return { error: "NOT_PENDING" };
  }
  if (booking.status === "CONFIRMED") return { booking };
  if (
    !["PENDING_PAYMENT", "EXPIRED"].includes(booking.status) ||
    booking.payment?.paidAt
  ) {
    return { error: "NOT_PENDING" };
  }
  const received = booking.payment?.receivedAt ? booking.payment : null;
  const payment = {
    provider: BANK_TRANSFER,
    paymentId: received?.receivedPaymentId || `manual:${userId}`,
    amountCents: received?.receivedAmount ?? expectedBookingAmount(booking),
    markedBy: userId ? toObjectId(userId) : undefined,
  };
  const started = new Date(booking.startAt) <= now;
  if (started) {
    const confirmed = await confirmStartedBooking(
      booking,
      paidSetOf(payment, booking),
    );
    if (confirmed === "TAKEN") return { error: "SLOT_TAKEN" };
    if (confirmed) {
      logger.info(
        `${LOG} réservation ${booking._id} commencée, marquée payée par l'organisateur (sans agenda ni e-mail)`,
      );
    }
  } else if (booking.status === "PENDING_PAYMENT") {
    await markBookingPaid(booking, payment);
  } else {
    // Expirée : confirmée seulement si le créneau passe encore le calcul
    // complet, sous le verrou (rien n'est marqué sinon)
    const lock = await acquireHostLock(booking.hostUserId).catch(() => null);
    if (!lock) return { error: "BUSY" };
    let confirmed;
    try {
      confirmed = await confirmIfSlotFree(
        booking,
        paidSetOf(payment, booking),
        { "payment.paidAt": null },
      );
    } finally {
      await releaseHostLock(lock);
    }
    if (!confirmed) return { error: "SLOT_TAKEN" };
    await afterBookingConfirmed(confirmed);
  }
  const updated = await Booking.findOne(filter);
  if (updated?.status !== "CONFIRMED") return { error: "NOT_PENDING" };
  logger.info(
    `${LOG} réservation ${updated._id} marquée payée par l'organisateur`,
  );
  return { booking: updated };
}

/**
 * Marque (paid) ou démarque le reste dû sur place d'un rendez-vous
 * confirmé de l'organisateur.
 * @returns {Promise<{booking}|{error: "NOT_FOUND"|"NOT_CONFIRMED"|"NOTHING_DUE"}>}
 */
export async function markBookingPaidOnSite({
  scope,
  bookingId,
  paid,
  userId,
  now = new Date(),
}) {
  if (!isObjectId(String(bookingId))) return { error: "NOT_FOUND" };
  const filter = {
    _id: toObjectId(bookingId),
    workspaceId: scope.workspaceId,
    hostUserId: scope.hostUserId,
  };
  const booking = await Booking.findOne(filter);
  if (!booking) return { error: "NOT_FOUND" };
  if (booking.status !== "CONFIRMED") return { error: "NOT_CONFIRMED" };
  if (!(Number(booking.amountDueOnSite) > 0)) return { error: "NOTHING_DUE" };
  if (Boolean(booking.onSitePaidAt) === Boolean(paid)) return { booking };
  const updated = await Booking.findOneAndUpdate(
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
    return (await Booking.exists(filter))
      ? { error: "NOT_CONFIRMED" }
      : { error: "NOT_FOUND" };
  }
  return { booking: updated };
}
