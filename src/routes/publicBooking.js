import express from "express";
import AppointmentType from "../models/AppointmentType.js";
import { decryptManageToken, generateManageToken } from "../models/Booking.js";
import { hashToken } from "../models/EventRegistration.js";
import {
  BookingError,
  availableSlots,
  cancelBooking,
  createBooking,
  findBookingByToken,
  loadBookingParties,
  loadManageContext,
  loadPublicPage,
  loadPublicType,
  managePayload,
  publicPagePayload,
  rescheduleBooking,
} from "../services/appointments/bookingService.js";
import {
  bookingIcs,
  manageUrlFor,
} from "../services/appointments/bookingEmails.js";
import { recordAttempt } from "../utils/attemptLimiter.js";
import { verifyTurnstileToken } from "../utils/turnstile.js";
import { addDays, daysBetween, localDayOf } from "../utils/appointmentSlots.js";
import {
  DEFAULT_TIMEZONE,
  isValidDay,
  isValidTimezone,
  locationLabel,
  phoneRequired,
} from "../utils/appointmentValidation.js";
import logger from "../utils/logger.js";
import {
  EventRegistrationError,
  abandonPayment,
  cancelRegistration,
  declareRegistrationBankTransfer,
  findRegistrationByManageToken,
  findTicketByToken,
  guestCanCancel,
  handlePaymentReturn,
  isEvent,
  paymentModeOf,
  publicEventDetail,
  publicEventSummary,
  registerForEvent,
  registrationPayload,
  ticketPagePayload,
  ticketQrPng,
} from "../services/appointments/eventRegistrationService.js";
import {
  registrationIcs,
  registrationManageUrlFor,
} from "../services/appointments/eventEmails.js";
import { ONLINE_PAYMENT_PROVIDERS } from "../services/payments/directPayments.js";
import {
  abandonBookingPayment,
  bookingPaymentFields,
  bookingPayload,
  createPaidBooking,
  declareBookingBankTransfer,
  expireOverdueBookings,
  handleBookingPaymentReturn,
} from "../services/appointments/bookingPaymentService.js";
import {
  slotDepositAmountOf,
  slotPaymentModeOf,
} from "../utils/appointmentValidation.js";
import { appointmentPaymentMethods } from "../services/appointments/eventRegistrationService.js";
import { bankTransferOpenFor } from "../services/appointments/appointmentPayments.js";

// Moyens acceptés à la réservation et à l'inscription (virement compris)
const PAYMENT_PROVIDERS = [...ONLINE_PAYMENT_PROVIDERS, "bank_transfer"];

/**
 * Prise de rendez-vous, routes publiques (sans compte) montées sous
 * /api/public/booking :
 *
 *   GET  /:slug                         page et types actifs
 *   GET  /:slug/:typeSlug               page et type
 *   GET  /:slug/:typeSlug/slots         créneaux libres (?from&to&excludeToken)
 *   POST /:slug/:typeSlug/book          réservation
 *   GET  /manage/:token                 rendez-vous de l'invité
 *   POST /manage/:token/cancel          annulation par l'invité
 *   POST /manage/:token/reschedule      déplacement par l'invité
 *   GET  /manage/:token/ics             fichier .ics
 *   POST /manage/:token/bank-transfer   « J'ai fait le virement » (créneau payant)
 *   POST /bookings/return               retour du payeur d'un créneau payant
 *   POST /bookings/return/cancel        abandon : paiement fermé, créneau libéré
 *
 * Billetterie (types `kind: EVENT`, voir eventRegistrationService.js) :
 *   POST /:slug/:typeSlug/register      inscription (gratuite ou payante)
 *   POST /registrations/return          retour du payeur (paiement relu)
 *   POST /registrations/return/cancel   abandon : paiement fermé, places rendues
 *   GET  /registrations/:token          inscription du participant
 *   POST /registrations/:token/cancel   annulation (gratuite seulement)
 *   POST /registrations/:token/bank-transfer  « J'ai fait le virement »
 *   GET  /registrations/:token/ics      fichier .ics
 *   GET  /tickets/:token                billet (page du QR code)
 *   GET  /tickets/:token/qr.png         QR code du billet (e-mails)
 *
 * Page inconnue, inactive, type inactif, organisation sans abonnement actif
 * ou en lecture seule : même 404 { error: "NOT_FOUND" }, rien n'est révélé.
 * Limites par adresse IP (Redis, repli en mémoire) : lectures 60/min,
 * réservations 5/min et 20/h, gestion 10/min ; au-delà 429 RATE_LIMITED.
 */
const router = express.Router();

export const RATE_LIMITS = {
  read: [{ window: 60, max: 60 }],
  book: [
    { window: 60, max: 5 },
    { window: 3600, max: 20 },
  ],
  manage: [{ window: 60, max: 10 }],
  // Billetterie : inscriptions groupées possibles derrière une même adresse
  // (entreprise, école, wifi d'un salon)
  register: [
    { window: 60, max: 30 },
    { window: 3600, max: 300 },
  ],
  // Retour de paiement : le site relit toutes les 5 s pendant une minute.
  // Compté par jeton (un payeur) et, plus largement, par adresse
  paymentReturnToken: [{ window: 60, max: 30 }],
  paymentReturnIp: [{ window: 60, max: 120 }],
  // Virement : place ou créneau gardé jusqu'à 3 jours, donc compté à part
  bankTransfer: [{ window: 86400, max: 5 }],
};

/**
 * Réservations ou inscriptions par virement depuis cette adresse IP :
 * au-delà de la limite du jour, refus `429 BANK_TRANSFER_LIMIT`.
 * @returns {Promise<boolean>} true si la limite est dépassée
 */
async function overBankTransferLimit(req) {
  try {
    for (const { window, max } of RATE_LIMITS.bankTransfer) {
      const count = await recordAttempt(
        `booking:bankTransfer:${window}:${clientIp(req)}`,
        window,
      );
      if (count > max) return true;
    }
  } catch (error) {
    logger.warn(`[rendez-vous] limitation indisponible : ${error.message}`);
  }
  return false;
}
// Plage de créneaux demandée en une fois (jours, bornes comprises)
export const MAX_RANGE_DAYS = 42;

const MINUTE = 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[\d\s.()-]{6,30}$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const notFound = (res) => res.status(404).json({ error: "NOT_FOUND" });
const validation = (res, fields) =>
  res.status(400).json({ error: "VALIDATION", fields });

function privateHeaders(res) {
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  });
}

const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";

/**
 * Limite par adresse IP, ou par la clé que renvoie `keyOf(req)` (jeton de
 * retour…) ; une clé absente retombe sur l'adresse IP.
 */
function rateLimit(kind, keyOf = null) {
  return async (req, res, next) => {
    privateHeaders(res);
    const key = (keyOf && keyOf(req)) || clientIp(req);
    try {
      for (const { window, max } of RATE_LIMITS[kind]) {
        const count = await recordAttempt(
          `booking:${kind}:${window}:${key}`,
          window,
        );
        if (count > max) {
          res.set("Retry-After", String(window));
          return res.status(429).json({ error: "RATE_LIMITED" });
        }
      }
    } catch (error) {
      // Compteur indisponible : on laisse passer plutôt que bloquer la page
      logger.warn(`[rendez-vous] limitation indisponible : ${error.message}`);
    }
    return next();
  };
}

function serverError(res, error, where) {
  logger.error(`[rendez-vous] ${where} : ${error.message}`);
  return res.status(500).json({ error: "SERVER_ERROR" });
}

function bookingErrorResponse(res, error) {
  if (error instanceof BookingError) {
    return res.status(error.status).json({ error: error.code });
  }
  return null;
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** Instant ISO-8601 (avec fuseau) envoyé par le site. */
function parseInstant(value) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Contrôle du formulaire de réservation.
 * @returns {{ fields: object|null, start, guest, timezone }}
 */
export function validateBookingBody(body, type) {
  const fields = {};
  const start = parseInstant(body?.start);
  if (!start) fields.start = "Créneau invalide.";

  const raw = body?.guest && typeof body.guest === "object" ? body.guest : {};
  const guest = {
    firstName: text(raw.firstName),
    lastName: text(raw.lastName),
    email: text(raw.email).toLowerCase(),
    phone: text(raw.phone) || null,
    message: text(raw.message) || null,
  };
  if (!guest.firstName) fields.firstName = "Indiquez votre prénom.";
  else if (guest.firstName.length > 100)
    fields.firstName = "Prénom trop long (100 caractères au plus).";
  if (!guest.lastName) fields.lastName = "Indiquez votre nom.";
  else if (guest.lastName.length > 100)
    fields.lastName = "Nom trop long (100 caractères au plus).";
  if (
    !guest.email ||
    guest.email.length > 254 ||
    !EMAIL_PATTERN.test(guest.email)
  ) {
    fields.email = "Adresse e-mail invalide.";
  }
  if (guest.phone) {
    const digits = guest.phone.replace(/\D/g, "").length;
    if (!PHONE_PATTERN.test(guest.phone) || digits < 6) {
      fields.phone = "Numéro de téléphone invalide.";
    }
  } else if (phoneRequired(type)) {
    fields.phone = "Indiquez votre numéro de téléphone.";
  }
  if (guest.message && guest.message.length > 2000) {
    fields.message = "Message trop long (2 000 caractères au plus).";
  }
  const timezone = text(body?.timezone);
  if (timezone && !isValidTimezone(timezone))
    fields.timezone = "Fuseau horaire invalide.";
  // Créneau payé à la réservation (tout ou acompte) : moyen obligatoire
  const provider = text(body?.provider) || null;
  if (slotPaysOnline(type)) {
    if (!provider) fields.provider = "Choisissez un moyen de paiement.";
    else if (!PAYMENT_PROVIDERS.includes(provider))
      fields.provider = "Moyen de paiement inconnu.";
  }

  return {
    fields: Object.keys(fields).length ? fields : null,
    start,
    guest,
    timezone: timezone || null,
    provider: slotPaysOnline(type) ? provider : null,
  };
}

/** Créneau payé à la réservation (tout ou acompte). */
const slotPaysOnline = (type) => {
  const mode = slotPaymentModeOf(type);
  return mode === "ONLINE" || mode === "DEPOSIT";
};

/**
 * Paiement d'un créneau payant pour la page publique (absent si gratuit).
 * `methods` : moyens proposés (détail du type seulement).
 */
function slotPaymentPayload(type, methods) {
  const mode = slotPaymentModeOf(type);
  if (!mode) return {};
  const amount = type.priceAmount;
  const amountOnline =
    mode === "ONLINE"
      ? amount
      : mode === "DEPOSIT"
        ? slotDepositAmountOf(type) || amount
        : 0;
  return {
    payment: {
      price: { amount, currency: type.currency || "EUR" },
      paymentMode: mode,
      depositAmount: slotDepositAmountOf(type),
      amountOnline,
      amountDueOnSite: amount - amountOnline,
      ...(methods
        ? {
            paymentMethods: methods,
            // Virement : seulement pour un créneau qui commence dans 48 h
            // au moins (voir slots[].bankTransferAvailable)
            bankTransferMinLeadHours: 48,
          }
        : {}),
    },
  };
}

const publicType = (type) => ({
  slug: type.slug,
  name: type.name,
  description: type.description || null,
  durationMinutes: type.durationMinutes,
  locationKind: type.location?.kind || null,
  requirePhone: phoneRequired(type),
  kind: isEvent(type) ? "EVENT" : "SLOT",
  event: isEvent(type) ? publicEventSummary(type) : null,
  ...(isEvent(type) ? {} : slotPaymentPayload(type)),
});

/** Événement terminé : plus affiché. */
/** Événement payé en ligne (tout ou acompte) : un moyen de paiement est choisi. */
const paysOnline = (type) => {
  const mode = paymentModeOf(type);
  return mode === "ONLINE" || mode === "DEPOSIT";
};

const isPastEvent = (type, now = new Date()) =>
  isEvent(type) && (!type.endAt || new Date(type.endAt) <= now);

function eventErrorResponse(res, error) {
  if (error instanceof EventRegistrationError) {
    return res
      .status(error.status)
      .json({ error: error.code, ...(error.extra || {}) });
  }
  return null;
}

/**
 * Contrôle du formulaire d'inscription à un événement.
 * @returns {{ fields: object|null, buyer, quantity, timezone, provider }}
 */
export function validateRegistrationBody(body, type) {
  const fields = {};
  const raw = body?.buyer && typeof body.buyer === "object" ? body.buyer : {};
  const buyer = {
    firstName: text(raw.firstName),
    lastName: text(raw.lastName),
    email: text(raw.email).toLowerCase(),
    phone: text(raw.phone) || null,
  };
  if (!buyer.firstName) fields.firstName = "Indiquez votre prénom.";
  else if (buyer.firstName.length > 100)
    fields.firstName = "Prénom trop long (100 caractères au plus).";
  if (!buyer.lastName) fields.lastName = "Indiquez votre nom.";
  else if (buyer.lastName.length > 100)
    fields.lastName = "Nom trop long (100 caractères au plus).";
  if (
    !buyer.email ||
    buyer.email.length > 254 ||
    !EMAIL_PATTERN.test(buyer.email)
  ) {
    fields.email = "Adresse e-mail invalide.";
  }
  if (buyer.phone) {
    const digits = buyer.phone.replace(/\D/g, "").length;
    if (!PHONE_PATTERN.test(buyer.phone) || digits < 6) {
      fields.phone = "Numéro de téléphone invalide.";
    }
  } else if (type.requirePhone) {
    fields.phone = "Indiquez votre numéro de téléphone.";
  }
  const max = Math.max(1, Math.min(type.maxPerOrder || 5, 10));
  const quantity = Number(body?.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > max) {
    fields.quantity =
      max === 1
        ? "Une seule place par inscription."
        : `Choisissez entre 1 et ${max} places.`;
  }
  const timezone = text(body?.timezone);
  if (timezone && !isValidTimezone(timezone))
    fields.timezone = "Fuseau horaire invalide.";
  const provider = text(body?.provider) || null;
  if (provider && !PAYMENT_PROVIDERS.includes(provider)) {
    fields.provider = "Moyen de paiement inconnu.";
  } else if (paysOnline(type) && !provider) {
    fields.provider = "Choisissez un moyen de paiement.";
  }
  return {
    fields: Object.keys(fields).length ? fields : null,
    buyer,
    quantity,
    timezone: timezone || null,
    provider,
  };
}

// ─── Gestion par l'invité (avant /:slug pour ne pas être prise pour une page)

router.get("/manage/:token", rateLimit("manage"), async (req, res) => {
  try {
    const booking = await findBookingByToken(req.params.token);
    if (!booking) return notFound(res);
    const context = await loadManageContext(booking);
    return res.json({
      ...managePayload(booking, context),
      ...(await bookingPaymentFields(booking)),
    });
  } catch (error) {
    return serverError(res, error, "lecture d'un rendez-vous");
  }
});

router.post(
  "/manage/:token/bank-transfer",
  rateLimit("manage"),
  async (req, res) => {
    try {
      const booking = await findBookingByToken(req.params.token);
      if (!booking) return notFound(res);
      const result = await declareBookingBankTransfer(booking, {
        cancel: req.body?.cancel === true,
      });
      if (!result) return res.status(409).json({ error: "NOT_ALLOWED" });
      return res.json({
        declaredAt: result.declaredAt
          ? new Date(result.declaredAt).toISOString()
          : null,
      });
    } catch (error) {
      return serverError(res, error, "annonce d'un virement de rendez-vous");
    }
  },
);

router.post("/manage/:token/cancel", rateLimit("manage"), async (req, res) => {
  try {
    const booking = await findBookingByToken(req.params.token);
    if (!booking) return notFound(res);
    if (booking.status === "CANCELLED")
      return res.json({ status: "CANCELLED" });
    const context = await loadManageContext(booking);
    if (!context.canCancel)
      return res.status(409).json({ error: "NOT_ALLOWED" });
    const reason = text(req.body?.reason).slice(0, 1000) || null;
    const { booking: updated } = await cancelBooking({
      booking,
      by: "GUEST",
      reason,
    });
    return res.json({ status: updated?.status || "CANCELLED" });
  } catch (error) {
    return (
      bookingErrorResponse(res, error) || serverError(res, error, "annulation")
    );
  }
});

router.post(
  "/manage/:token/reschedule",
  rateLimit("manage"),
  async (req, res) => {
    try {
      const booking = await findBookingByToken(req.params.token);
      if (!booking) return notFound(res);
      const start = parseInstant(req.body?.start);
      if (!start) return validation(res, { start: "Créneau invalide." });
      if (
        !(await verifyTurnstileToken(req.body?.turnstileToken, clientIp(req)))
      ) {
        return validation(res, {
          turnstileToken:
            "Vérification anti-robot échouée. Veuillez réessayer.",
        });
      }
      const { booking: updated } = await rescheduleBooking({
        booking,
        token: req.params.token,
        start,
      });
      const context = await loadManageContext(updated);
      return res.json({
        ...managePayload(updated, context),
        ...(await bookingPaymentFields(updated)),
      });
    } catch (error) {
      return (
        bookingErrorResponse(res, error) ||
        serverError(res, error, "déplacement")
      );
    }
  },
);

router.get("/manage/:token/ics", rateLimit("manage"), async (req, res) => {
  try {
    const booking = await findBookingByToken(req.params.token);
    // Rendez-vous pas (ou jamais) confirmé : pas de fichier
    if (!booking || ["PENDING_PAYMENT", "EXPIRED"].includes(booking.status))
      return notFound(res);
    const { host, organizationName } = await loadBookingParties(booking);
    const ics = bookingIcs(booking, {
      method: "PUBLISH",
      host,
      organizationName,
    });
    res.set({
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="rendez-vous.ics"',
    });
    return res.status(200).send(ics);
  } catch (error) {
    return serverError(res, error, "fichier .ics");
  }
});

// ─── Billetterie : retour de paiement, inscription, billets ──────────────
// (avant /:slug pour ne pas être prises pour une page)

// Jeton de retour haché dans la clé du compteur (jamais en clair dans Redis)
const returnTokenKey = (req) =>
  typeof req.body?.returnToken === "string" && req.body.returnToken
    ? `rt:${hashToken(req.body.returnToken).slice(0, 32)}`
    : null;

/** Réponse commune du retour et de l'abandon de paiement. */
async function paymentReturnResponse(res, { registration, paymentStatus }) {
  const payload = await registrationPayload(registration);
  return res.json({
    paymentStatus,
    refundStatus: payload.refundStatus,
    registration: payload,
    manageUrl:
      registration.status === "CONFIRMED"
        ? manageUrlOfRegistration(registration)
        : null,
  });
}

router.post(
  "/registrations/return/cancel",
  rateLimit("paymentReturnIp"),
  rateLimit("paymentReturnToken", returnTokenKey),
  async (req, res) => {
    try {
      const result = await abandonPayment({
        returnToken: req.body?.returnToken,
      });
      if (!result) return notFound(res);
      return paymentReturnResponse(res, result);
    } catch (error) {
      return serverError(res, error, "abandon d'un paiement d'inscription");
    }
  },
);

router.post(
  "/registrations/return",
  rateLimit("paymentReturnIp"),
  rateLimit("paymentReturnToken", returnTokenKey),
  async (req, res) => {
    try {
      const sessionId =
        typeof req.body?.sessionId === "string" ? req.body.sessionId : null;
      const orderId =
        typeof req.body?.orderId === "string" ? req.body.orderId : null;
      const result = await handlePaymentReturn({
        returnToken: req.body?.returnToken,
        sessionId,
        orderId,
      });
      if (!result) return notFound(res);
      return paymentReturnResponse(res, result);
    } catch (error) {
      return serverError(res, error, "retour de paiement d'une inscription");
    }
  },
);

// ─── Rendez-vous payants : retour de paiement ────────────────────────────

/** Réponse commune du retour et de l'abandon de paiement d'un créneau. */
async function bookingReturnResponse(res, { booking, paymentStatus }) {
  const host = (await loadBookingParties(booking)).host;
  const payload = await bookingPayload(booking, { host });
  const token =
    booking.status === "CONFIRMED"
      ? decryptManageToken(booking.manageTokenEncrypted)
      : null;
  return res.json({
    paymentStatus,
    refundStatus: payload.refundStatus || "NONE",
    booking: payload,
    manageUrl: token ? manageUrlFor(token) : null,
    icsUrl: token ? `/api/public/booking/manage/${token}/ics` : null,
  });
}

router.post(
  "/bookings/return/cancel",
  rateLimit("paymentReturnIp"),
  rateLimit("paymentReturnToken", returnTokenKey),
  async (req, res) => {
    try {
      const result = await abandonBookingPayment({
        returnToken: req.body?.returnToken,
      });
      if (!result) return notFound(res);
      return bookingReturnResponse(res, result);
    } catch (error) {
      return serverError(res, error, "abandon d'un paiement de rendez-vous");
    }
  },
);

router.post(
  "/bookings/return",
  rateLimit("paymentReturnIp"),
  rateLimit("paymentReturnToken", returnTokenKey),
  async (req, res) => {
    try {
      const result = await handleBookingPaymentReturn({
        returnToken: req.body?.returnToken,
        sessionId:
          typeof req.body?.sessionId === "string" ? req.body.sessionId : null,
        orderId:
          typeof req.body?.orderId === "string" ? req.body.orderId : null,
      });
      if (!result) return notFound(res);
      return bookingReturnResponse(res, result);
    } catch (error) {
      return serverError(res, error, "retour de paiement d'un rendez-vous");
    }
  },
);

router.get("/registrations/:token", rateLimit("manage"), async (req, res) => {
  try {
    const registration = await findRegistrationByManageToken(req.params.token);
    if (!registration) return notFound(res);
    return res.json(
      await registrationPayload(registration, {
        manageToken: req.params.token,
      }),
    );
  } catch (error) {
    return serverError(res, error, "lecture d'une inscription");
  }
});

router.post(
  "/registrations/:token/cancel",
  rateLimit("manage"),
  async (req, res) => {
    try {
      const registration = await findRegistrationByManageToken(
        req.params.token,
      );
      if (!registration) return notFound(res);
      if (registration.status === "CANCELLED") {
        return res.json({ status: "CANCELLED" });
      }
      if (!guestCanCancel(registration)) {
        return res.status(409).json({ error: "NOT_ALLOWED" });
      }
      const reason = text(req.body?.reason).slice(0, 1000) || null;
      const { registration: updated } = await cancelRegistration({
        registration,
        by: "GUEST",
        reason,
      });
      return res.json({ status: updated?.status || "CANCELLED" });
    } catch (error) {
      return serverError(res, error, "annulation d'une inscription");
    }
  },
);

router.post(
  "/registrations/:token/bank-transfer",
  rateLimit("manage"),
  async (req, res) => {
    try {
      const registration = await findRegistrationByManageToken(
        req.params.token,
      );
      if (!registration) return notFound(res);
      const result = await declareRegistrationBankTransfer(registration, {
        cancel: req.body?.cancel === true,
      });
      if (!result) return res.status(409).json({ error: "NOT_ALLOWED" });
      return res.json({
        declaredAt: result.declaredAt
          ? new Date(result.declaredAt).toISOString()
          : null,
      });
    } catch (error) {
      return serverError(res, error, "annonce d'un virement d'inscription");
    }
  },
);

router.get(
  "/registrations/:token/ics",
  rateLimit("manage"),
  async (req, res) => {
    try {
      const registration = await findRegistrationByManageToken(
        req.params.token,
      );
      if (!registration) return notFound(res);
      const { host, organizationName } = await loadBookingParties(registration);
      const ics = registrationIcs(registration, {
        method: registration.status === "CANCELLED" ? "CANCEL" : "PUBLISH",
        host,
        organizationName,
      });
      res.set({
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="evenement.ics"',
      });
      return res.status(200).send(ics);
    } catch (error) {
      return serverError(res, error, "fichier .ics d'une inscription");
    }
  },
);

router.get("/tickets/:token/qr.png", rateLimit("read"), async (req, res) => {
  try {
    const found = await findTicketByToken(req.params.token);
    if (!found) return notFound(res);
    const png = await ticketQrPng(req.params.token);
    res.set({
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=86400",
    });
    return res.status(200).send(png);
  } catch (error) {
    return serverError(res, error, "QR code d'un billet");
  }
});

router.get("/tickets/:token", rateLimit("read"), async (req, res) => {
  try {
    const found = await findTicketByToken(req.params.token);
    if (!found) return notFound(res);
    return res.json(
      await ticketPagePayload(
        found.registration,
        found.ticket,
        req.params.token,
      ),
    );
  } catch (error) {
    return serverError(res, error, "billet");
  }
});

// ─── Pages publiques ──────────────────────────────────────────────────────

router.get("/:slug", rateLimit("read"), async (req, res) => {
  try {
    const context = await loadPublicPage(req.params.slug);
    if (!context) return notFound(res);
    const types = await AppointmentType.find({
      bookingPageId: context.page._id,
      isActive: true,
    })
      .sort({ position: 1, createdAt: 1 })
      .lean();
    return res.json({
      page: publicPagePayload(context),
      types: types.filter((type) => !isPastEvent(type)).map(publicType),
    });
  } catch (error) {
    return serverError(res, error, "page publique");
  }
});

router.get("/:slug/:typeSlug", rateLimit("read"), async (req, res) => {
  try {
    const context = await loadPublicPage(req.params.slug);
    if (!context) return notFound(res);
    const type = await loadPublicType(context.page, req.params.typeSlug);
    if (!type || isPastEvent(type)) return notFound(res);
    return res.json({
      page: publicPagePayload(context),
      type: {
        ...publicType(type),
        locationLabel:
          isEvent(type) && type.location?.kind === "CUSTOM_LINK"
            ? "En ligne"
            : locationLabel(type.location),
        maxDaysAhead: type.maxDaysAhead,
        event: isEvent(type) ? await publicEventDetail(type) : null,
        ...(!isEvent(type) && slotPaymentModeOf(type)
          ? slotPaymentPayload(
              type,
              await appointmentPaymentMethods(type.workspaceId),
            )
          : {}),
      },
    });
  } catch (error) {
    return serverError(res, error, "type de rendez-vous");
  }
});

router.get("/:slug/:typeSlug/slots", rateLimit("read"), async (req, res) => {
  try {
    const context = await loadPublicPage(req.params.slug);
    if (!context) return notFound(res);
    const type = await loadPublicType(context.page, req.params.typeSlug);
    if (!type || isEvent(type)) return notFound(res);

    const zone = isValidTimezone(context.page.timezone)
      ? context.page.timezone
      : DEFAULT_TIMEZONE;
    const from =
      typeof req.query.from === "string" && req.query.from
        ? req.query.from
        : localDayOf(new Date(), zone);
    let to =
      typeof req.query.to === "string" && req.query.to
        ? req.query.to
        : addDays(from, MAX_RANGE_DAYS - 1);
    const fields = {};
    if (!isValidDay(from)) fields.from = "Date de début invalide (AAAA-MM-JJ).";
    if (!isValidDay(to)) fields.to = "Date de fin invalide (AAAA-MM-JJ).";
    if (!fields.from && !fields.to && to < from) {
      fields.to = "La date de fin doit suivre la date de début.";
    }
    if (Object.keys(fields).length) return validation(res, fields);
    // Plage bornée à 42 jours
    if (daysBetween(from, to) > MAX_RANGE_DAYS - 1) {
      to = addDays(from, MAX_RANGE_DAYS - 1);
    }

    // Déplacement en cours : la réservation de l'invité ne bloque pas
    let excludeBooking = null;
    if (typeof req.query.excludeToken === "string" && req.query.excludeToken) {
      const booking = await findBookingByToken(req.query.excludeToken);
      if (
        booking?.status === "CONFIRMED" &&
        String(booking.hostUserId) === String(context.page.userId)
      ) {
        excludeBooking = booking;
      }
    }

    const slots = await availableSlots({
      page: context.page,
      type,
      from,
      to,
      excludeBooking,
    });
    // Créneau payable par virement : indiqué créneau par créneau
    const bankOffered =
      slotPaysOnline(type) &&
      (await appointmentPaymentMethods(type.workspaceId)).includes(
        "bank_transfer",
      );
    const now = new Date();
    return res.json({
      timezone: zone,
      slots: slots.map((slot) => ({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
        ...(bankOffered
          ? { bankTransferAvailable: bankTransferOpenFor(slot.start, now) }
          : {}),
      })),
    });
  } catch (error) {
    return serverError(res, error, "créneaux");
  }
});

router.post("/:slug/:typeSlug/book", rateLimit("book"), async (req, res) => {
  try {
    // Pot de miel : réponse factice, rien n'est enregistré
    if (req.body?.website) {
      logger.warn(`[rendez-vous] pot de miel déclenché (${clientIp(req)})`);
      const start = parseInstant(req.body?.start) || new Date();
      const token = generateManageToken();
      return res.status(201).json({
        booking: {
          startAt: start.toISOString(),
          endAt: new Date(start.getTime() + 30 * MINUTE).toISOString(),
          typeName: "Rendez-vous",
          locationKind: null,
          locationLabel: "",
          meetingUrl: null,
          hostName: null,
          timezone: text(req.body?.timezone) || DEFAULT_TIMEZONE,
        },
        manageUrl: manageUrlFor(token),
        icsUrl: `/api/public/booking/manage/${token}/ics`,
      });
    }

    const context = await loadPublicPage(req.params.slug);
    if (!context) return notFound(res);
    const type = await loadPublicType(context.page, req.params.typeSlug);
    if (!type || isEvent(type)) return notFound(res);

    const { fields, start, guest, timezone, provider } = validateBookingBody(
      req.body,
      type,
    );
    if (fields) return validation(res, fields);
    if (
      !(await verifyTurnstileToken(req.body?.turnstileToken, clientIp(req)))
    ) {
      return validation(res, {
        turnstileToken: "Vérification anti-robot échouée. Veuillez réessayer.",
      });
    }

    // Créneau payé à la réservation : tenu jusqu'au paiement
    if (slotPaysOnline(type)) {
      if (provider === "bank_transfer" && (await overBankTransferLimit(req))) {
        res.set("Retry-After", "86400");
        return res.status(429).json({ error: "BANK_TRANSFER_LIMIT" });
      }
      const result = await createPaidBooking({
        context,
        type,
        start,
        guest,
        timezone,
        provider,
        returnOrigin: req.get("origin") || null,
      });
      if (result.paymentUrl) {
        return res.status(201).json({
          status: "PENDING_PAYMENT",
          paymentUrl: result.paymentUrl,
          expiresAt: new Date(result.booking.expiresAt).toISOString(),
        });
      }
      return res.status(201).json({
        status: "PENDING_PAYMENT",
        booking: await bookingPayload(result.booking, { host: context.host }),
        manageUrl: manageUrlFor(result.token),
        icsUrl: null,
        expiresAt: new Date(result.booking.expiresAt).toISOString(),
      });
    }

    // Réservations payantes échues de l'organisateur : créneaux libérés
    // (en base seulement, la relecture des paiements reste au balayage)
    await expireOverdueBookings({
      hostUserId: context.page.userId,
      recheck: false,
    });
    const { booking, token } = await createBooking({
      context,
      type,
      start,
      guest,
      timezone,
    });
    return res.status(201).json({
      status: booking.status,
      booking: await bookingPayload(booking, { host: context.host }),
      manageUrl: manageUrlFor(token),
      icsUrl: `/api/public/booking/manage/${token}/ics`,
    });
  } catch (error) {
    return (
      bookingErrorResponse(res, error) || serverError(res, error, "réservation")
    );
  }
});

router.post(
  "/:slug/:typeSlug/register",
  rateLimit("register"),
  async (req, res) => {
    try {
      // Pot de miel : réponse factice, rien n'est enregistré
      if (req.body?.website) {
        logger.warn(`[billetterie] pot de miel déclenché (${clientIp(req)})`);
        return res.status(201).json({
          status: "CONFIRMED",
          registration: {
            status: "CONFIRMED",
            quantity: 1,
            amount: 0,
            currency: "EUR",
            paymentMode: null,
            amountOnline: 0,
            amountDueOnSite: 0,
            onSitePaidAt: null,
            buyer: { firstName: "", lastName: "", email: "" },
            event: null,
            page: null,
            typeSlug: null,
            tickets: [],
            icsUrl: null,
            canCancel: false,
            cancelledAt: null,
          },
          manageUrl: registrationManageUrlFor(generateManageToken()),
        });
      }

      const context = await loadPublicPage(req.params.slug);
      if (!context) return notFound(res);
      const type = await loadPublicType(context.page, req.params.typeSlug);
      if (!type || !isEvent(type) || isPastEvent(type)) return notFound(res);

      const { fields, buyer, quantity, timezone, provider } =
        validateRegistrationBody(req.body, type);
      if (fields) return validation(res, fields);
      if (
        !(await verifyTurnstileToken(req.body?.turnstileToken, clientIp(req)))
      ) {
        return validation(res, {
          turnstileToken:
            "Vérification anti-robot échouée. Veuillez réessayer.",
        });
      }

      if (
        paysOnline(type) &&
        provider === "bank_transfer" &&
        (await overBankTransferLimit(req))
      ) {
        res.set("Retry-After", "86400");
        return res.status(429).json({ error: "BANK_TRANSFER_LIMIT" });
      }
      const result = await registerForEvent({
        context,
        type,
        buyer,
        quantity,
        timezone,
        // Sur place (ou gratuit) : moyen de paiement ignoré
        provider: paysOnline(type) ? provider : null,
        returnOrigin: req.get("origin") || null,
      });
      if (result.paymentUrl) {
        return res.status(201).json({
          status: "PENDING_PAYMENT",
          paymentUrl: result.paymentUrl,
          expiresAt: result.registration.expiresAt
            ? new Date(result.registration.expiresAt).toISOString()
            : null,
        });
      }
      // Virement : coordonnées bancaires et lien de l'inscription
      if (result.bankTransfer) {
        return res.status(201).json({
          status: "PENDING_PAYMENT",
          registration: await registrationPayload(result.registration, {
            manageToken: result.manageToken,
          }),
          manageUrl: registrationManageUrlFor(result.manageToken),
          expiresAt: new Date(result.registration.expiresAt).toISOString(),
        });
      }
      return res.status(201).json({
        status: result.registration.status,
        registration: await registrationPayload(result.registration, {
          tickets: result.tickets,
          manageToken: result.manageToken,
        }),
        manageUrl: registrationManageUrlFor(result.manageToken),
      });
    } catch (error) {
      return (
        eventErrorResponse(res, error) ||
        serverError(res, error, "inscription à un événement")
      );
    }
  },
);

/** Lien de gestion d'une inscription (jeton déchiffré), ou null. */
function manageUrlOfRegistration(registration) {
  const token = decryptManageToken(registration.manageTokenEncrypted);
  return token ? registrationManageUrlFor(token) : null;
}

export default router;
